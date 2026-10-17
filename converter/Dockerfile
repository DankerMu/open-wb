# 办公文档转换 sidecar 的镜像（office-preview「转换 sidecar 实现与镜像」；design D7）。
# 部署方自建（owner B9）：docker compose -f converter/compose.yml up -d --build。
# 运行时的隔离（无网络、只读根、只挂 spool、零 capability）在 compose.yml，不在这里。
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui \
    libreoffice-calc-nogui \
    libreoffice-impress-nogui \
    fonts-dejavu-core \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
COPY sidecar.mjs healthcheck.mjs /app/
ENV CONVERTER_SPOOL_DIR=/spool
# 非 root 的地板：忘了传 compose 的 `user:` 也不以 root 跑；`node` 是基底镜像自带的用户。
USER node
ENTRYPOINT ["node", "/app/sidecar.mjs"]
