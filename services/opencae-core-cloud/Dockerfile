FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts ./scripts
COPY apps ./apps
COPY libs ./libs
COPY services ./services
COPY runners ./runners

RUN pnpm ensure:core
RUN pnpm --dir /opencae-core install --frozen-lockfile --prod=false
RUN pnpm install --no-frozen-lockfile --prod=false
RUN pnpm --dir /opencae-core add -Dw @types/node@22.19.17
RUN mkdir -p services/opencae-core-cloud/node_modules/.bin services/opencae-core-cloud/node_modules/@types services/opencae-core-cloud/node_modules/@opencae \
  && ln -s /opencae-core/node_modules/.bin/tsc services/opencae-core-cloud/node_modules/.bin/tsc \
  && ln -s /opencae-core/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild services/opencae-core-cloud/node_modules/.bin/esbuild \
  && ln -s /opencae-core/node_modules/typescript services/opencae-core-cloud/node_modules/typescript \
  && ln -s /opencae-core/node_modules/@types/node services/opencae-core-cloud/node_modules/@types/node \
  && ln -s /opencae-core/packages/core services/opencae-core-cloud/node_modules/@opencae/core \
  && ln -s /opencae-core/packages/solver-cpu services/opencae-core-cloud/node_modules/@opencae/solver-cpu
RUN pnpm --dir /opencae-core --filter @opencae/core build
RUN pnpm --dir /opencae-core --filter @opencae/solver-cpu build
RUN pnpm --filter @opencae/core-cloud build
RUN mkdir -p node_modules/@opencae \
  && ln -s /opencae-core/packages/core node_modules/@opencae/core \
  && ln -s /opencae-core/packages/solver-cpu node_modules/@opencae/solver-cpu

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

RUN corepack enable

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/opencae-core-cloud ./services/opencae-core-cloud
COPY --from=build /opencae-core/packages/core /opencae-core/packages/core
COPY --from=build /opencae-core/packages/solver-cpu /opencae-core/packages/solver-cpu

EXPOSE 8080

CMD ["node", "services/opencae-core-cloud/dist/server.bundle.js"]
