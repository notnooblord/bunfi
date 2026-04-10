# bunfi

Dynamic DNS for UniFi consoles. Syncs public WAN IPs from the [UniFi Site Manager API](https://developer.ui.com) to Cloudflare DNS records.

Each UniFi console's hostname becomes a DNS record:

```
ams-pulse.example.com  A     120.110...
ams-pulse.example.com  AAAA  2001:2030:c:6aa:...
lon-core.example.com   A     121.110...
```

- Reads WAN interfaces from each host, picks the first public IPv4/IPv6
- Skips private, CGNAT, and link-local addresses
- Creates missing records, updates changed ones, leaves correct ones alone
- Runs on a cron schedule via `Bun.cron`

## Setup

### 1. Get API keys

- **UniFi API key** — [unifi.ui.com](https://unifi.ui.com) → Settings → API Keys
- **Cloudflare API token** — [dash.cloudflare.com](https://dash.cloudflare.com/profile/api-tokens) → Create Token → Edit zone DNS

### 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `UNIFI_API_KEY` | yes | UniFi Site Manager API key |
| `CLOUDFLARE_API_TOKEN` | yes | Cloudflare API token with DNS edit permission |
| `DOMAIN` | yes | Your domain, e.g. `example.com` |
| `SUBDOMAIN` | no | Optional prefix: `unifi` → `hostname.unifi.example.com` |
| `CRON` | no | Cron schedule (default: `*/5 * * * *`) |

### 3. Run

```bash
bun install
bun run index.ts
```

## Docker

```bash
docker build -t bunfi .
docker run --env-file .env bunfi
```

## Deploy on Railway

1. Push to GitHub
2. New project → Deploy from repo
3. Add environment variables in the Railway dashboard
4. Deploy

No extra config needed — Railway auto-detects the Dockerfile.

## How it works

```
UniFi API                          Cloudflare DNS
GET /v1/hosts                      GET /zones?name=DOMAIN
  → hostname: "ams-pulse"          PUT /dns_records/:id
  → wans[].ipv4: "37.110..."   → ams-pulse.example.com A 37.110...
  → wans[].ipv6: "2001:..."         → ams-pulse.example.com AAAA 2001:...
```

On each tick:
1. Fetches all hosts from UniFi cloud API
2. Extracts public IPs from active WAN interfaces
3. Resolves the Cloudflare zone ID from `DOMAIN` (cached)
4. Creates/updates A and AAAA records per console hostname
