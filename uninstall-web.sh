#!/usr/bin/env bash
# 从 profile 卸载 dsh-parallel-dev，并还原备份（如有）。
set -euo pipefail
PROFILE="${1:-web}"
WEB="$HOME/.dsh/profiles/$PROFILE"
PKG="dsh-parallel-dev"
rm -rf "$WEB/node_modules/$PKG"
python3 - "$WEB/package.json" "$PKG" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1]); name = sys.argv[2]
d = json.loads(p.read_text(encoding='utf-8'))
b = d.get('dsh', {}).get('profile', {}).get('bundles', [])
if name in b:
    b.remove(name); p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding='utf-8')
    print(f"  bundles -= {name}")
PY
echo "已卸载。"
