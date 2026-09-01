#!/usr/bin/env bash
# Install the pipeline-mode agent preset into DSH's user preset root.
# Usage: ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/preset"
ROOT="${DSH_HOME:-$HOME/.dsh}"
DEST="$ROOT/.agent-presets/pipeline"

if [ ! -d "$SRC" ]; then
  echo "错误：未找到 $SRC。请从发布目录（包含 preset/ 的目录）运行本脚本。" >&2
  exit 1
fi

if [ -d "$DEST" ]; then
  echo "目标目录已存在: $DEST"
  read -r -p "覆盖其中的文件？[y/N] " ans
  case "$ans" in
    y | Y) ;;
    *) echo "已取消。"; exit 0 ;;
  esac
fi

mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
echo "✅ 已安装到 $DEST"
echo "现在可以在 DSH GUI 中新建会话，模式选择「流水线模式」。"
