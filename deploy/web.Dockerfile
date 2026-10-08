FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci
RUN PORT=18670 BASE_PATH=/ NODE_ENV=production npm run build --workspace=@workspace/dryrun-visualizer

FROM caddy:2-alpine AS runtime

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/artifacts/dryrun-visualizer/dist/public /srv
EXPOSE 80 443 443/udp
