FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts ./scripts
COPY services ./services

ARG OPENCAE_CORE_CACHE_BUST=6d84498
RUN echo "OpenCAE Core cache bust ${OPENCAE_CORE_CACHE_BUST}" && pnpm ensure:core
RUN pnpm --dir /opencae-core install --frozen-lockfile --prod=false
RUN pnpm --dir /opencae-core --filter @opencae/core build
RUN pnpm --dir /opencae-core --filter @opencae/solver-cpu build
RUN pnpm --dir /opencae-core --filter @opencae/core-cloud build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends gmsh ca-certificates \
  && gmsh --version \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opencae-core/services/opencae-core-cloud/package.json ./services/opencae-core-cloud/package.json
COPY --from=build /opencae-core/services/opencae-core-cloud/dist ./services/opencae-core-cloud/dist

EXPOSE 8080

CMD ["node", "services/opencae-core-cloud/dist/server.bundle.js"]
