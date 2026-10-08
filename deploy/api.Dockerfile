FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build --workspace=@workspace/api-server

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5000
WORKDIR /app
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
EXPOSE 5000
USER node
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
