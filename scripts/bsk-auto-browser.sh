#!/usr/bin/env bash
#
# 给浏览器自动化开一个独立 profile。
#
# 为什么需要它：bsk 驱动的是你**日常那个 Chrome**（带你的登录态、书签、正在看的页面）。
# 后果有两个：
#   1. agent 的 Agent Window 和你自己的操作在同一浏览器里，会互相干扰
#      —— 实测中我的标签页被外部导航走了两次（先是上线审批页，再是 Office 预览原型）。
#   2. agent 能碰到你所有网站的登录态。做演示、跑别人的项目时这不是你想要的。
#
# 这个脚本用独立的 user-data-dir 启动第二个 Chrome：登录态、Cookie、扩展、标签页
# 全部独立。它连的是同一个 bsk 守护进程，所以会作为**另一个浏览器实例**出现，
# 用 `browser_session start browser=<实例>` 就能精确指定"这次用自动化那个"。
#
# 用法：
#   ./bsk-auto-browser.sh              启动（已在跑就只是切到前台）
#   ./bsk-auto-browser.sh --status     看它连上没有
#   BSK_AUTO_PROFILE=/path ./bsk-auto-browser.sh   换目录
#
# Windows（给同事）：见同目录 README 的 Windows 段落。

set -euo pipefail

PROFILE_DIR="${BSK_AUTO_PROFILE:-$HOME/.dsh/bsk-chrome}"
EXT_DIR="${BSK_EXT_DIR:-$HOME/.dsh/bsk-extension}"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

# ── 找 Chrome ────────────────────────────────────────────────
find_chrome() {
  local candidates=()
  case "$(uname -s)" in
    Darwin)
      candidates=(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      ) ;;
    Linux)
      candidates=( "$(command -v google-chrome || true)" "$(command -v chromium || true)" "$(command -v microsoft-edge || true)" ) ;;
    MINGW*|MSYS*|CYGWIN*)
      candidates=(
        "/c/Program Files/Google/Chrome/Application/chrome.exe"
        "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
        "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
      ) ;;
  esac
  for c in "${candidates[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# ── 准备扩展目录 ─────────────────────────────────────────────
# 从已安装的 Chrome 扩展里复制一份出来，而不是直接加载原目录：
# Chrome 会自动更新/清理 Extensions 下的版本目录，直接依赖它迟早会失效。
prepare_extension() {
  if [ -f "$EXT_DIR/manifest.json" ]; then return 0; fi
  local src=""
  case "$(uname -s)" in
    Darwin)
      src="$(ls -d "$HOME/Library/Application Support/Google/Chrome"/*/Extensions/hhcmgoofomhgciiibhipgmgkgnoenaoi/*/ 2>/dev/null | sort -V | tail -1)"
      [ -z "$src" ] && src="$(ls -d "$HOME/Library/Application Support/Microsoft Edge"/*/Extensions/hhcmgoofomhgciiibhipgmgkgnoenaoi/*/ 2>/dev/null | sort -V | tail -1)"
      ;;
    *)
      src="$(ls -d "$HOME"/.config/google-chrome/*/Extensions/hhcmgoofomhgciiibhipgmgkgnoenaoi/*/ 2>/dev/null | sort -V | tail -1)"
      ;;
  esac
  [ -n "$src" ] && [ -f "$src/manifest.json" ] \
    || die "没找到 BrowserSkill 扩展。请先在你的浏览器里装好它（见 browser-skill 的安装指引），再跑本脚本。"
  mkdir -p "$EXT_DIR"
  cp -R "$src". "$EXT_DIR"/
  say "已复制扩展 → $EXT_DIR"
}

case "${1:-}" in
  --status)
    export PATH="$HOME/.local/bin:$PATH"
    command -v bsk >/dev/null || die "bsk 不在 PATH 上"
    say "bsk 看到的浏览器实例："
    bsk browsers 2>/dev/null | sed 's/^/  /'
    say ""
    say "说明：INSTANCE 那一列就是可以用 \`browser_session start browser=<值>\` 指定的目标。"
    say "如果 LABEL 是空的，可以在扩展的 popup 里给它起个名字（例如 auto），指定起来更稳 ——"
    say "实例 ID 每次重连都会变，名字不会。"
    exit 0
    ;;
  -h|--help)
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

CHROME="$(find_chrome)" || die "没找到 Chrome/Edge。装了的话用 BSK_CHROME=/path/to/chrome 指定。"
prepare_extension
mkdir -p "$PROFILE_DIR"

# ── 这个 profile 里扩展装好了吗 ──────────────────────────────
# Chrome 把已加载的扩展登记在 Preferences 的 extensions.settings 里。读它来判断，
# 比"启动后问 bsk 有没有第二个实例"更直接 —— 后者会受启动时序影响。
extension_installed() {
  local prefs="$PROFILE_DIR/Default/Preferences"
  [ -f "$prefs" ] || return 1
  python3 - "$prefs" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
settings = d.get("extensions", {}).get("settings", {})
# BrowserSkill 的扩展 ID 是固定的（由公钥决定）
sys.exit(0 if "hhcmgoofomhgciiibhipgmgkgnoenaoi" in settings else 1)
PY
}

OPEN_URL="about:blank"
if extension_installed; then
  say "启动独立自动化浏览器"
  say "  扩展已装好，直接可用。"
else
  OPEN_URL="chrome://extensions/"
  say "启动独立自动化浏览器（还需要一次性手动装扩展）"
fi
say "  Chrome : $CHROME"
say "  profile: $PROFILE_DIR"
say "  扩展   : $EXT_DIR"
say ""
say "这个浏览器和你日常那个完全隔离：独立登录态、独立 Cookie、独立标签页。"
say "第一次启动会有新用户向导，可以跳过 —— 自动化不需要登录任何网站。"

if ! extension_installed; then
  cat <<EOF

────────────────────────────────────────────────────────────
还差一步：把 BrowserSkill 扩展装进这个新 profile（只需一次）
────────────────────────────────────────────────────────────

为什么不能自动装：Chrome 155 已经**彻底禁用**了命令行加载扩展
（--load-extension 及其历史绕过开关 DisableLoadExtensionCommandLineSwitch 都不再生效），
而且 chrome://extensions 页面本身不允许被自动化操作。所以这一步只能由你点。

正在为你打开 chrome://extensions，然后：

  1. 打开右上角的「开发者模式 / Developer mode」
  2. 点「加载已解压的扩展程序 / Load unpacked」
  3. 选择这个目录：

       $EXT_DIR

     ⚠️ 这个目录以 . 开头，文件选择器默认不显示它。两个办法：
        macOS  : 在选择器里按 Command+Shift+G（前往文件夹），粘贴上面这行路径，回车
                 或者按 Command+Shift+.（句号）切换显示隐藏文件
        Windows: 在选择器地址栏直接粘贴上面的路径，回车

  4. 装好后点一下工具栏上的 BrowserSkill 图标，等它显示 connected

做完再跑一次本脚本，或者直接看状态：

  $0 --status

之后这个浏览器就一直可用了 —— 扩展留在 profile 里，不会再要求你重复这一步。
想把它放到显眼位置的话，跑之前设一下 BSK_EXT_DIR 即可。

EOF
fi

# 两个 --disable-features 条目：
#   MacAppCodeSignClone —— 本环境 macOS 上做 Chrome 自动化的既定要求。
# 注：曾经还需要 DisableLoadExtensionCommandLineSwitch 来恢复 --load-extension，
#     但 Chrome 155 已让该开关失效；--load-extension 保留只为在旧版本上仍能生效。
exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT_DIR" \
  --disable-features=MacAppCodeSignClone \
  --no-first-run \
  --no-default-browser-check \
  --new-window "$OPEN_URL"
