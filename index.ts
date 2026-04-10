const UNIFI_API = "https://api.ui.com/v1";
const CF_API = "https://api.cloudflare.com/client/v4";

const env = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
};

const UNIFI_API_KEY = env("UNIFI_API_KEY");
const CF_TOKEN = env("CLOUDFLARE_API_TOKEN");
const DOMAIN = env("DOMAIN");
const CRON = process.env.CRON || "*/5 * * * *";
const SUBDOMAIN = process.env.SUBDOMAIN || "";
let cfZoneId: string;

// --- UniFi API ---

interface UnifiWan {
  type: string;
  plugged: boolean;
  ipv4?: string;
  ipv6?: string;
}

interface UnifiHost {
  id: string;
  ipAddress: string;
  reportedState?: {
    hostname?: string;
    name?: string;
    wans?: UnifiWan[];
  };
}

interface UnifiResponse<T> {
  data: T[];
  httpStatusCode: number;
  nextToken?: string;
}

async function unifiGet<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let nextToken: string | undefined;
  do {
    const url = new URL(`${UNIFI_API}${path}`);
    url.searchParams.set("pageSize", "200");
    if (nextToken) url.searchParams.set("nextToken", nextToken);
    const res = await fetch(url, {
      headers: { "X-API-KEY": UNIFI_API_KEY, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`UniFi ${path}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as UnifiResponse<T>;
    items.push(...json.data);
    nextToken = json.nextToken;
  } while (nextToken);
  return items;
}

// --- Cloudflare API ---

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

async function cfFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const json = (await res.json()) as { success: boolean; result: T; errors?: any[] };
  if (!json.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

async function resolveZoneId(domain: string): Promise<string> {
  const zones = await cfFetch<{ id: string; name: string }[]>(
    `/zones?name=${encodeURIComponent(domain)}&per_page=1`
  );
  if (!zones.length) throw new Error(`No Cloudflare zone found for "${domain}"`);
  return zones[0].id;
}

async function listDnsRecords(): Promise<CfDnsRecord[]> {
  const [a, aaaa] = await Promise.all([
    cfFetch<CfDnsRecord[]>(`/zones/${cfZoneId}/dns_records?type=A&per_page=500`),
    cfFetch<CfDnsRecord[]>(`/zones/${cfZoneId}/dns_records?type=AAAA&per_page=500`),
  ]);
  return [...a, ...aaaa];
}

async function upsertRecord(records: CfDnsRecord[], fqdn: string, type: "A" | "AAAA", ip: string) {
  const existing = records.find((r) => r.name === fqdn && r.type === type);
  if (existing && existing.content === ip) {
    console.log(`  ✓ ${fqdn} ${type} → ${ip}`);
    return;
  }
  const body = JSON.stringify({ type, name: fqdn, content: ip, ttl: 1, proxied: false });
  if (existing) {
    await cfFetch(`/zones/${cfZoneId}/dns_records/${existing.id}`, { method: "PUT", body });
    console.log(`  ↻ ${fqdn} ${type} → ${ip} (was ${existing.content})`);
  } else {
    await cfFetch(`/zones/${cfZoneId}/dns_records`, { method: "POST", body });
    console.log(`  + ${fqdn} ${type} → ${ip}`);
  }
}

// --- IP helpers ---

function isPublicV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return false;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16.0.0/12
  if (a === 192 && b === 168) return false;             // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return false;  // 100.64.0.0/10 CGNAT
  if (a === 127) return false;                          // loopback
  if (a === 169 && b === 254) return false;             // link-local
  return true;
}

function isPublicV6(ip: string): boolean {
  if (!ip || !ip.includes(":")) return false;
  const lower = ip.toLowerCase();
  if (lower.startsWith("fe80")) return false;   // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // ULA
  if (lower === "::1") return false;            // loopback
  return true;
}

// --- Main ---

async function sync() {
  console.log(`[${new Date().toISOString()}] Syncing...`);

  if (!cfZoneId) cfZoneId = await resolveZoneId(DOMAIN);

  const hosts = await unifiGet<UnifiHost>("/hosts");
  const dnsRecords = await listDnsRecords();

  console.log(`  ${hosts.length} hosts`);

  for (const h of hosts) {
    const name = h.reportedState?.hostname || h.reportedState?.name;
    if (!name) {
      console.log(`  ⚠ host ${h.id}: no name`);
      continue;
    }

    const wans = h.reportedState?.wans?.filter((w) => w.plugged) ?? [];
    const v4 = wans.map((w) => w.ipv4).find((ip) => ip && isPublicV4(ip));
    const v6 = wans.map((w) => w.ipv6).find((ip) => ip && isPublicV6(ip));
    const fallbackV6 = !v6 && isPublicV6(h.ipAddress) ? h.ipAddress : undefined;

    if (!v4 && !v6 && !fallbackV6) {
      console.log(`  ⚠ "${name}": no public IP`);
      continue;
    }

    const base = SUBDOMAIN ? `${SUBDOMAIN}.${DOMAIN}` : DOMAIN;
    const fqdn = `${sanitize(name)}.${base}`;
    if (v4) await upsertRecord(dnsRecords, fqdn, "A", v4);
    if (v6 || fallbackV6) await upsertRecord(dnsRecords, fqdn, "AAAA", (v6 || fallbackV6)!);
  }

  console.log(`  Done.\n`);
}

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const suffix = SUBDOMAIN ? `${SUBDOMAIN}.${DOMAIN}` : DOMAIN;
console.log(`bunfi: syncing UniFi hosts → *.${suffix} on "${CRON}"`);
sync().catch(console.error);
Bun.cron(CRON, () => sync().catch(console.error));
