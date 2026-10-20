#!/bin/sh
# app 参考镜像入口（design D7）：ADR-0010 的部署前提是服务以 umask 007 启动，
# 它建的文件与目录才对同组的 omp 用户保留组写位、对其他人不开放。
set -eu
umask 007
exec node /app/server/dist/server.js
