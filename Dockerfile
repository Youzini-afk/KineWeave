FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /workspace

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm run build:types && pnpm run build:web
RUN pnpm --filter=@kineweave/web deploy --prod --legacy /opt/kineweave

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=8080
ENV KINEWEAVE_PROJECT_DIR=/data/project
ENV KINEWEAVE_OUTPUT_DIR=/data/outputs
WORKDIR /app

RUN apk add --no-cache ffmpeg \
  && mkdir -p /data \
  && chown node:node /data /app
COPY --from=build --chown=node:node /opt/kineweave/ ./

USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server.js"]
