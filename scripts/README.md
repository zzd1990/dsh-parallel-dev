# scripts/

## bsk-auto-browser.sh — 给浏览器自动化开独立 profile

### 为什么需要它

`bsk` 驱动的是你**日常那个 Chrome**——带你的登录态、书签、正在看的页面。两个后果：

1. **互相干扰**：agent 的 Agent Window 和你自己的操作在同一个浏览器里。实测中我的标签页被外部导航走了两次（先是 `127.0.0.1:8100` 的上线审批页，再是 `127.0.0.1:8899` 的 Office 预览原型），导致我没法完成 UI 验证。
2. **权限过大**：agent 能碰到你所有网站的登录态。做演示、跑别人的项目时这不是你想要的。

这个脚本用独立的 `--user-data-dir` 启动第二个 Chrome：登录态、Cookie、扩展、标签页全部独立，
但连的是**同一个 bsk 守护进程**，所以会作为**另一个浏览器实例**出现，可以精确指定。

### 用法

```bash
./bsk-auto-browser.sh              # 启动（首次会给安装引导）
./bsk-auto-browser.sh --status     # 看 bsk 认到了哪些浏览器实例
```

指定用哪个浏览器（在 DSH 会话里）：

```
browser_session action=start browser=<实例ID 或 label>
```

> **建议起个名字。** 实例 ID 每次重连都会变，label 不会。在扩展的 popup 里给它起名（比如 `auto`），
> 之后 `browser=auto` 就能一直用。不起名的话每次要先跑 `--status` 拿当前 ID。

### 首次安装：需要你手动做一次

Chrome 155 已经**彻底禁用**了命令行加载扩展：

- `--load-extension` 不再生效
- 历史上用来绕过的 `--disable-features=DisableLoadExtensionCommandLineSwitch` **也已失效**（实测确认）
- 而且 `chrome://extensions` 页面本身不允许被自动化操作

所以这一步只能人工。脚本会自动打开扩展页并打印指引：

1. 打开右上角「开发者模式 / Developer mode」
2. 点「加载已解压的扩展程序 / Load unpacked」
3. 选择 `~/.dsh/bsk-extension`（脚本已经从你已安装的 Chrome 扩展复制好了）

   > **这一步会卡在"选不到隐藏目录"。** `~/.dsh` 以 `.` 开头，文件选择器默认不显示。
   > - macOS：按 `Command+Shift+G`（前往文件夹），粘贴路径，回车；或按 `Command+Shift+.` 显示隐藏文件
   > - Windows：在选择器地址栏直接粘贴路径，回车
   >
   > 想彻底避开，启动脚本前设 `BSK_EXT_DIR=~/bsk-extension`，扩展副本就放在显眼位置。

4. 点工具栏上的 BrowserSkill 图标，等它显示 connected

**只需要做一次**——扩展留在那个 profile 里。之后脚本会自己检测到并跳过引导。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BSK_AUTO_PROFILE` | `~/.dsh/bsk-chrome` | 独立 profile 目录 |
| `BSK_EXT_DIR` | `~/.dsh/bsk-extension` | 扩展副本目录 |
| `BSK_CHROME` | 自动探测 | Chrome/Edge 可执行文件 |

### Windows（给同事）

脚本已包含 Windows 的 Chrome 查找路径（`/c/Program Files/Google/Chrome/Application/chrome.exe` 等），
在 Git Bash / WSL 下可直接跑。如果用的是 PowerShell，等价命令是：

```powershell
$profile = "$env:USERPROFILE\.dsh\bsk-chrome"
$ext     = "$env:USERPROFILE\.dsh\bsk-extension"

# 先从已安装的 Chrome 扩展目录复制一份出来，然后：
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --user-data-dir="$profile" `
  --load-extension="$ext" `
  --no-first-run --no-default-browser-check `
  --new-window "chrome://extensions/"
```

已安装扩展的位置通常在：

```
%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\hhcmgoofomhgciiibhipgmgkgnoenaoi\<版本>_0\
```

**注意**：Windows 上 `--load-extension` 同样受 Chrome 155 的限制，首次仍需手动「加载已解压的扩展程序」。
另外 Windows 不需要 `--disable-features=MacAppCodeSignClone`（那是 macOS 专属的既定要求，
带上也无副作用）。

### 排查

```bash
bsk doctor      # 诊断 + 修复建议（会报告扩展连接、协议兼容性等）
bsk status      # 守护进程状态
bsk browsers    # 已连接的浏览器实例
```
