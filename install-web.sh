#!/usr/bin/env bash
# 把 dsh-parallel-dev 装进 web profile（团队正式用法）。
# 只做两件事：同步包进 node_modules、把包名加进 profile 的 bundles。
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${1:-web}"
WEB="$HOME/.dsh/profiles/$PROFILE"
PKG="dsh-parallel-dev"

mkdir -p "$WEB/node_modules/$PKG"
rsync -a --delete --exclude node_modules --exclude '.git' --exclude 'docs' "$SRC/" "$WEB/node_modules/$PKG/"

python3 - "$WEB/package.json" "$PKG" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1]); name = sys.argv[2]
d = json.loads(p.read_text(encoding='utf-8'))
b = d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
if name not in b:
    b.append(name)
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding='utf-8')
    print(f"  bundles += {name}")
else:
    print(f"  bundles 已含 {name}")
PY
echo "装好了。重启该 profile 后生效。"
