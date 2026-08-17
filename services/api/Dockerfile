# Production container for @fiyatucuz/api. Per ADR-0008 (container-first, cloud TBD).
# Multi-stage: dependencies -> build -> runtime.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/validation/package.json ./packages/validation/
COPY packages/config/package.json ./packages/config/
COPY services/api/package.json ./services/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY services/api ./services/api
RUN pnpm --filter @fiyatucuz/types build \
 && pnpm --filter @fiyatucuz/validation build \
 && pnpm --filter @fiyatucuz/config build \
 && pnpm --filter @fiyatucuz/api build

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
COPY --from=build /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml* /repo/package.json ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/services/api ./services/api
RUN pnpm install --prod --frozen-lockfile
USER node
EXPOSE 4000
CMD ["node", "services/api/dist/index.js"]
