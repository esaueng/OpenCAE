FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts ./scripts
COPY apps ./apps
COPY libs ./libs
COPY services ./services
COPY runners ./runners

RUN pnpm ensure:core
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @opencae/core build
RUN pnpm --filter @opencae/solver-cpu build
RUN pnpm --filter @opencae/core-cloud build

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

CMD ["node", "services/opencae-core-cloud/dist/server.js"]
