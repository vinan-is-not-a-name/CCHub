# cchub

在浏览器里使用 Claude Code CLI。

[English](./README.md)

![cchub 里并排跑两个 Claude Code 会话](docs/screenshots/hero.png)

cchub 是一个本地 Web 服务器，把 [Claude Code](https://github.com/anthropics/claude-code) CLI 装进浏览器终端。设计围绕三个理念：**轻量**（单个 JSON 配置文件，没有账号，没有数据库）、**易用**（`npm start`，打开页面，开工）、**和外部工具良好衔接**（VS Code、XShell、XFTP、SSH 隧道、MCP servers）。

## 核心功能一览

- **多会话统一管理** —— 一个实例里同时开任意多个 Claude Code CLI 会话，标签页或者 2/3 列网格并排，pane 可拖拽重排，WebSocket 断连后从服务端 scrollback 恢复。
- **本地 + SSH 远程会话** —— 一个实例同时驱动本机 `claude` 和任意数量 SSH 主机上的 `claude`，走同一条 WebSocket 管道。
- **TUI 到 Web 完整映射** —— xterm.js 直连真实 PTY：键盘透传、鼠标追踪（可点击 slash 菜单）、bracketed paste、alt-screen、IME。
- **第三方 LLM 供应商** —— Anthropic、OpenRouter、本地 LiteLLM、Ollama，任何 OpenAI 兼容端点。
- **CLI 配置搬到 UI** —— 主模型、子代理模型、`--dangerously-skip-permissions`、续接模式，全部打包成 preset。
- **外部工具集成** —— 把工作目录交给 VS Code、XShell、XFTP、cmd、PowerShell，各自做各自最擅长的事。
- **任务完成通知** —— 会话从 processing 回到 idle 且你没在看时触发浏览器桌面通知（启发式、尽力而为）。
- **补强读图能力** —— MCP `feed_image` 工具绕开 [anthropics/claude-code#18588](https://github.com/anthropics/claude-code/issues/18588)，让 CLI 读本地图片，或者让浏览器自动化 agent 自截自看。

## 功能文档

### All-in-one 多会话管理

一个 cchub 实例可以同时管理任意数量的 Claude Code CLI 会话。可切 tab，也可拆成 2 列或 3 列网格并排，pane 可拖拽重排。每个会话是独立 PTY，带独立 profile / preset —— 一个 pane 可以接 Anthropic 官方的 Opus，同时旁边的 pane 接自建 OpenAI 兼容端点的 Sonnet。WebSocket 断连后会话不会丢：重连时从服务端 scrollback 恢复画面。底层用 `claude --continue`，即使 cchub 服务器完整重启，也能续上之前的对话。

![两个 Claude Code 会话在 2 列网格里并排](docs/screenshots/multi-session.png)

### 本地会话与远程（SSH）会话

一个 cchub 实例可以同时驱动本机的 `claude` 和 SSH 主机上的 `claude`，全部在同一个浏览器网格里。远程 Claude 需要出站网络访问某个只有 cchub 侧才能触达的 provider 时，可为它挂一条 SSH 反向隧道 proxy，让流量经 cchub 侧的 HTTP proxy 出去。

### TUI 到 Web 的完整映射（键盘 + 鼠标）

浏览器里的终端是 xterm.js 直连真实 PTY —— CLI 画出来什么，你就看到什么，包括 alt-screen、光标样式、颜色、mid-turn spinner。键盘输入原样透传：Ctrl+C、ESC、Tab 补全、方向键选菜单都能用。鼠标追踪开着，你可以直接点击 Claude Code 的菜单，不用一个个方向键翻，还能拖选文本、滚轮翻页。Bracketed paste 已协商 —— 多行粘贴会作为一整块交给 Claude，而不是被逐行执行。IME 通过 DOM composition 事件完整支持输入法。

### 第三方 LLM API 管理

Profile 是一等对象：每个 profile 带 `baseUrl` / `authToken` / `model`，Settings 对话框在保存前会先探测端点（`POST /v1/chat/completions` 发一个 token 的 ping），以便及早暴露配置错误。任何 OpenAI 兼容端点都能用 —— Anthropic 官方 API、OpenRouter、本地 LiteLLM、Ollama，都行。Profile 与 preset 解耦：换 preset 用的 API 不需要重建 preset。环境变量遵循 CLI 惯例（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`），cchub 不引入任何私有协议。

![Profile 编辑器带 base URL、auth token、model 字段](docs/screenshots/profile-editor.png)

### Claude Code CLI 配置

Preset 编辑器把常用的 CLI 开关摆到 UI 上，不再靠脑子记：主模型（`ANTHROPIC_MODEL`）、子代理模型（`CLAUDE_CODE_SUBAGENT_MODEL`），以及 `--dangerously-skip-permissions` —— 在你已经信任当前 Claude 会话在做什么的时候，跳过每次危险操作的确认提示。Preset 打包了 server + profile + cwd + 续接模式，「起一个和上次一样的会话」是一次点击的事。对于 SSH 目标，还可选一个反向隧道 proxy，让远程的 `claude` 走到 cchub 这一侧的 HTTP proxy。

![Preset 编辑器展示服务器 / profile / cwd / 续接 / 跳过确认字段](docs/screenshots/preset-editor.png)

### 和外部工具的集成（各自做好各自的事）

cchub 有意不去做文件编辑器、SFTP 客户端或 Windows 终端。你需要其中之一的时候，把工作目录直接交给真正做得好的那个工具 —— 点击 pane 标题栏上括号里的 cwd，弹出 reveal 菜单：

- **VS Code** —— 本地打开 `<cwd>`；当会话是 SSH-backed 时，通过 Remote-SSH 打开。
- **XShell** —— 打开一个 SSH 新 tab 并落在 `<cwd>`，通过一个一次性 `.xsh` 文件加 `ssh://user:password@host` URL 覆写，不再弹密码提示。
- **XFTP** —— 打开同一主机同一目录用于文件浏览（`sftp://user:password@host:port/cwd` 命令行参数）。
- **本地 shell** —— `cmd.exe`、`PowerShell`，或者它们的管理员（UAC 提权）版本，落在会话 cwd。非 Windows 平台改为唤起系统文件浏览器。

外部可执行程序的路径在 Settings 里配置，带一键自动检测（扫描常见安装位置），第一次上手大概花一分钟。

![Reveal 菜单包含文件浏览器 / VS Code / cmd / PowerShell 入口](docs/screenshots/reveal-menu.png)

### 任务完成通知（尽力而为）

当一个会话从 processing 回到 idle 而你没在看它时，cchub 可以触发浏览器桌面通知。判定依赖对终端输出的字符启发式分析（而不是任何来自 Claude 的结构化事件），**它会误报，偶尔也会漏报**。长时间的批量命令可能中途看起来像 idle；CLI spinner 的格式变化会绕过检测器。Settings 里有开关（默认关闭）。长远方案是接 Claude Code 的 hook 或结构化完成事件，在那之前这个能用，但别指望它承担关键路径。

![通知设置面板](docs/screenshots/settings-notifications.png)

### 补强 Claude Code 的读图能力

Claude Code CLI 目前无法在终端里原生读取图片（见 [anthropics/claude-code#18588](https://github.com/anthropics/claude-code/issues/18588) —— 新版 CLI 可能已经加了支持，以你实际的版本为准）或某些 LLM 转发 API 不支持。cchub 通过一个焊进每个会话 MCP config 的 `feed_image` 工具补上这一块（前提是你接的 LLM API 支持多模态）：

- **指定读图** —— 让 Agent 使用 feed_image mcp 读某张图片，feed_image 会模拟人工向会话中插入图片的操作自动粘贴和提交图片，Agent 在对话里看到 `[Image #N]`，可以对像素做推理。
- **Agent 自主喂图** —— cchub 搭配浏览器自动化 MCP（Playwright、Puppeteer），Claude 可以自己截自己 dev server 的屏，把截图喂回给自己看，再迭代。这就把前端开发闭环补齐了：改代码 → 截图 → 看真实渲染 → 再改。

喂进来的图在浏览器终端里以可点击的 `[Image #N]` chip 展示，但是如果是从历史中恢复的图片不支持查看。

![对话中内联可点击的 [Image #N] chip](docs/screenshots/image-chip.png)

## 环境要求

- Node.js **≥ 18**
- [Claude Code CLI](https://github.com/anthropics/claude-code)（`npm install -g @anthropic-ai/claude-code`）
- Windows

## 安装与启动

```bash
git clone https://github.com/vinan-is-not-a-name/CCHub.git cchub
cd cchub
npm install
npm run build
npm start
```

浏览器打开 <http://127.0.0.1:3000>。用 `CCHUB_PORT` 换端口。配置文件位于 `~/.cchub/config.json`，可用 `CCHUB_CONFIG=/path/to/config.json` 覆盖。

## 远程访问

cchub 是单用户本地优先（single-user local-first）工具。服务器拒绝非 loopback 连接；没有账号系统，任何能连到端口的客户端都能操作所有会话。想在手机或另一台机器上使用，请打一条 SSH 隧道到跑 cchub 的机器，再在客户端本地访问隧道端口：

```bash
ssh -L 3000:127.0.0.1:3000 you@your-workstation
# 然后在客户端浏览器：
http://127.0.0.1:3000
```

SSH 负责认证和传输加密，不需要对外开放端口。

## 配置

配置是一个 JSON 文件：`~/.cchub/config.json`（Windows：`%USERPROFILE%\.cchub\config.json`）。应用里的 Settings 与 Presets Config 对话框会代你编辑它。字段：

- **servers** —— 本地或 SSH 目标。SSH 目标带 host / port / username / auth（密码或私钥路径）。
- **profiles** —— 可复用的 provider 配置：`baseUrl`、`authToken`、`model`，可选 proxy 引用。
- **presets** —— 命名的启动配置（server + profile + cwd + 续接模式）。顶栏「+ 新建会话」按 preset 建会话。
- **proxies** —— 可选的出站 HTTP proxy 定义，SSH 会话经反向隧道使用。

## 开发

```bash
npm run dev          # 监听模式：server + client 文件变化自动重建
npm run typecheck    # 对 server 和 client 分别跑 tsc --noEmit
npm test             # Playwright —— unit + integration + e2e
```

只跑单测：`npx playwright test --project=unit`。

## 安全模型

- Fastify 绑 `127.0.0.1`，任何非 loopback 请求返回 403，并附带 SSH 隧道使用说明。
- 另有一层 origin guard 拒绝跨源 WebSocket / HTTP 请求，拦截 socket-level 检查看不到的浏览器 CSWSH 攻击。
- SSH 凭据保存在配置文件里，请靠操作系统的文件权限保护它。
- 能连到 loopback 端口的进程对服务器有完全控制权。**不要**把端口暴露到 LAN 或经公共反向代理对外。

## 许可证

[MIT](./LICENSE) —— 详见 LICENSE 文件。
