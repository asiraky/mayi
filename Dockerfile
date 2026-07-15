FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/receipts/package.json packages/receipts/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @mayi/server build

FROM node:26-alpine
RUN addgroup -S mayi && adduser -S mayi -G mayi
WORKDIR /app
COPY --from=build --chown=mayi:mayi /app/apps/server/.output ./
USER mayi
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.mjs"]
