FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY index.ts ./
RUN bun build --compile --minify --target=bun index.ts --outfile=bunfi

FROM gcr.io/distroless/static-debian12
COPY --from=build /app/bunfi /bunfi
ENV BUN_JSC_forceRAMSize=33554432
ENTRYPOINT ["/bunfi"]
