FROM node:24-bookworm-slim AS build

WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5000
WORKDIR /app
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
EXPOSE 5000
USER node
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
