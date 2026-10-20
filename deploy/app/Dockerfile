# app 参考镜像（browser-runtime「参考部署镜像」；design D7）：app + omp + Chromium + 字体，部署方自建、不发布。
# 以仓库根为上下文：docker build -f deploy/app/Dockerfile .（Apple 芯片加 --platform linux/amd64：omp-fetch.sh 只认 Linux x86_64）。
# 运行时的隔离（只读根、三个挂载、capability）在 compose.yml；忽略清单在 Dockerfile.dockerignore（BuildKit）。
FROM node:24.13.1-bookworm AS build
WORKDIR /src
COPY . .
RUN npm ci \
  && npm run build --workspace web \
  && npm run build --workspace server \
  && bash scripts/omp-fetch.sh \
  && rm -rf node_modules server/node_modules web/node_modules \
  && npm ci --omit=dev --workspace server

FROM node:24.13.1-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-dejavu-core \
    sudo \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# 两个 uid 同主组 workbuddy（ADR-0010），数值钉死：宿主挂载目录与 converter 的 WORKBUDDY_UID/GID 按它对齐。
# sudoers 恰两行；/usr/bin/setpriv 来自基底的 util-linux。
RUN groupadd --gid 10001 workbuddy \
  && useradd --uid 10001 -g workbuddy -M -s /usr/sbin/nologin workbuddy \
  && useradd --uid 10002 -g workbuddy -M -s /usr/sbin/nologin omp \
  && printf '%s\n' \
    'workbuddy ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- /opt/workbuddy/omp *' \
    'Defaults>omp umask=0007' > /etc/sudoers.d/workbuddy-omp \
  && chmod 0440 /etc/sudoers.d/workbuddy-omp \
  && visudo -c \
  && mkdir -p /srv/workbuddy/sandbox /srv/workbuddy/omp-state /srv/workbuddy/private
COPY --from=build --chmod=0755 /src/var/omp/omp /opt/workbuddy/omp
# repoRoot 是 dist/server.js 往上两级；server/package.json 的 "type": "module" 须随 dist。
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/server/package.json /app/server/package.json
COPY --from=build /src/server/dist /app/server/dist
COPY --from=build /src/web/dist /app/web/dist
COPY --chmod=0755 deploy/app/entrypoint.sh /app/entrypoint.sh
# 缺省指向仓库根的六个键全部钉到挂载或镜像内；上游地址、密钥、认证由部署方运行时给出。
ENV OMP_USER=omp \
  OMP_BIN=/opt/workbuddy/omp \
  BROWSER_BIN=/usr/bin/chromium \
  SANDBOX_ROOT=/srv/workbuddy/sandbox \
  OMP_STATE_DIR=/srv/workbuddy/omp-state \
  DB_PATH=/srv/workbuddy/private/app.db \
  PREVIEW_CACHE_DIR=/srv/workbuddy/private/preview-cache \
  STATIC_ROOT=/app/web/dist \
  HOST=0.0.0.0 \
  PORT=3000 \
  PREVIEW_PORT=3001
USER workbuddy
ENTRYPOINT ["/app/entrypoint.sh"]
