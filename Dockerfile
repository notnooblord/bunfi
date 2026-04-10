FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY index.ts ./

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/index.ts ./
ENV BUN_JSC_forceRAMSize=33554432
CMD ["bun", "run", "index.ts"]
