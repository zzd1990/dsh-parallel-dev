#!/usr/bin/env bash
# 开发回路：把插件同步进 profile 的 node_modules。
#
# 为什么要复制而不是用 --patch 直接指绝对路径：Node 按**插件自身位置**解析它的
# 裸导入（@deepseek-ai/dsh-tools 等），插件放在 profile 树之外就解析不到。
# 复制进 profile 的 node_modules 后，裸导入沿目录树向上找到 profiles/node_modules，
# 与团队最终的 `dsh plugin add` 安装方式完全一致，没有开发/生产差异。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${1:-pdevdev}"
DST="$HOME/.dsh/profiles/$PROFILE/node_modules/dsh-parallel-dev"

mkdir -p "$DST"
rsync -a --delete --exclude node_modules --exclude '.git' "$SRC/" "$DST/"
echo "synced -> $DST"
