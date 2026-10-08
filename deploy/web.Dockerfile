FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN PORT=18670 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/dryrun-visualizer run build

FROM caddy:2-alpine AS runtime

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/artifacts/dryrun-visualizer/dist/public /srv
EXPOSE 80 443 443/udp
