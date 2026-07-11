# cchub

Access Claude Code CLI from your browser.

[中文文档](./README.zh-CN.md)

![Two Claude Code sessions running side by side in cchub](docs/screenshots/hero.png)

cchub is a local web server that hosts the [Claude Code](https://github.com/anthropics/claude-code) CLI in a browser terminal. The design leans on three ideas: **stay lightweight** (single JSON config, no accounts, no database), **stay easy to use** (`npm start`, open the tab, work), and **connect cleanly to the tools you already have** (VS Code, XShell, XFTP, SSH tunnels, MCP servers).

## Features at a glance

- **Multi-session management** — an arbitrary number of Claude Code CLI sessions in tabs or a 2- / 3-column grid; drag panes and tabs to reorder; a dropped WebSocket rehydrates state from server-side scrollback.
- **Local + SSH remote sessions** — one instance drives `claude` on the local box and on any number of SSH hosts, all through the same WebSocket pipeline.
- **Full TUI-to-Web mapping** — xterm.js against a real PTY: keyboard passthrough, mouse tracking (click Claude Code's slash menu), bracketed paste, alt-screen, IME.
- **Third-party LLM providers** — Anthropic, OpenRouter, a local LiteLLM, Ollama, any OpenAI-compatible or Anthropic-format endpoint.
- **CLI config in the UI** — main model, subagent model, small-fast model, `--dangerously-skip-permissions`, resume mode, all as a preset; configurable HTTP proxies for outbound API calls.
- **External tool handoff** — hand the working directory to VS Code, XShell, XFTP, cmd, or PowerShell; each does what it's best at.
- **Hook-driven notifications** — Claude Code hooks fire authoritative idle/prompt/stop events; browser desktop notifications when a session goes idle or needs approval while you're away.
- **Image feed for Claude Code** — an MCP `feed_image` tool works around [anthropics/claude-code#18588](https://github.com/anthropics/claude-code/issues/18588): direct the agent at a local image, or let a browser-automation agent screenshot its own dev server.
- **i18n + theming** — English and Chinese UI; 150+ terminal colour themes; font scaling.

## Documentation

### All-in-one multi-session management

One cchub instance runs an arbitrary number of Claude Code CLI sessions side by side. Sessions live in tabs, or you can split the viewport into a 2- or 3-column grid and drag panes to reorder them. Each session is its own PTY with its own profile / preset — one pane can talk to Anthropic's Opus while a neighbouring pane talks to a self-hosted OpenAI-compatible endpoint on Sonnet. Reconnecting a dropped WebSocket rehydrates state from the server-side scrollback rather than dropping the session, and `claude --continue` is wired underneath so a full server restart still gets you back to the previous conversation.

![Two Claude Code sessions in a 2-column grid](docs/screenshots/multi-session.png)

### Local and remote (SSH) sessions

A single cchub instance can drive `claude` running on your local box and on SSH hosts, all in the same browser grid. When the remote Claude needs outbound network to reach a provider that only the cchub side can talk to, an SSH reverse-tunnel proxy definition lets it egress through an HTTP proxy on this side.

### Full TUI-to-Web mapping (keyboard + mouse)

The browser terminal is xterm.js against a real PTY, so what you see is what the CLI drew — including the alt-screen, cursor style, colours, and the mid-turn spinner. Keyboard input is passed through verbatim (Ctrl+C, ESC, tab-completion, arrow-key menu selection). Mouse tracking is on, which means you can click Claude Code's menu instead of arrow-keying through it, drag-select text, and get proper wheel behaviour. Bracketed paste is negotiated so a multi-line paste arrives at Claude as one block rather than being interpreted line-by-line. Full IME support is threaded through the DOM composition events.

### Third-party LLM API management

Profiles are first-class objects: each carries `name` / `baseUrl` / `authToken` / `model` / `subagentModel` / `smallFastModel`, and the Settings dialog probes the endpoint before you save (native Anthropic `POST /v1/messages` for URLs containing `/anthropic`, `POST /v1/chat/completions` for OpenAI-compatible ones) so misconfiguration surfaces immediately. Any OpenAI-compatible endpoint works — Anthropic's own API, OpenRouter, a local LiteLLM, Ollama, whatever. Profiles and presets are decoupled: swap the API a preset points at without rebuilding the preset. Environment vars follow the CLI's conventions (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`), so nothing about the wire protocol is cchub-specific.

![Profile editor with base URL, auth token, and model fields](docs/screenshots/profile-editor.png)

### Claude Code CLI configuration

The preset editor exposes the CLI knobs you'd otherwise have to remember: main model (`ANTHROPIC_MODEL`), subagent model (`CLAUDE_CODE_SUBAGENT_MODEL`), and a `--dangerously-skip-permissions` toggle for sessions where you already trust what Claude is doing. Presets bundle server + profile + cwd + resume mode, so "start a new session that mirrors the last one" is one click. For SSH targets, an optional reverse-tunnel proxy definition lets the remote `claude` reach an HTTP proxy sitting on the cchub side of the connection.

![Preset editor showing server / profile / cwd / resume / skip-permissions fields](docs/screenshots/preset-editor.png)

### External tool integration (each tool does what it's best at)

cchub deliberately doesn't try to be a file editor, an SFTP client, or a Windows terminal. When you want one of those, we hand the working directory to the tool that actually does it well — click the parenthesized cwd on a pane's title bar to bring up the reveal menu:

- **VS Code** — opens `<cwd>` locally, or via Remote-SSH when the session is SSH-backed.
- **XShell** — opens a new SSH tab that lands in `<cwd>`, via a one-shot `.xsh` file plus an `ssh://user:password@host` URL override so no password prompt appears.
- **XFTP** — opens the same host at the same directory for file browsing (`sftp://user:password@host:port/cwd` argv).
- **Local shell** — `cmd.exe`, `PowerShell`, or their admin (UAC-elevated) variants, spawned at the session cwd. On non-Windows platforms this routes to the OS file browser instead.

Paths for the external executables come from the Settings dialog, with an auto-detect button that scans the usual install locations — first-time setup takes about a minute.

![Reveal menu with file browser / VS Code / cmd / PowerShell entries](docs/screenshots/reveal-menu.png)

### Hook-driven notifications

cchub provisions Claude Code hooks (`Notification`, `Stop`, `StopFailure`) per session. The `Notification` hook fires on `idle_prompt` / `permission_prompt` to alert you when a session needs attention; `Stop` and `StopFailure` fire at turn completion. When a hook fires and you're not looking at the session, cchub triggers a browser desktop notification. For remote (SSH) sessions, the hook endpoint is tunneled back through the SSH connection so notifications work transparently. There's a toggle in Settings ("通知 / Notifications"), off by default.

![Notifications settings tab](docs/screenshots/settings-notifications.png)

### Image feed for Claude Code

Claude Code CLI can't natively read images from the terminal ([anthropics/claude-code#18588](https://github.com/anthropics/claude-code/issues/18588) — newer CLI builds may have added support, check your version), and some LLM relay APIs strip images out of the wire. cchub works around this via an MCP `feed_image` tool wired into every session's own MCP config (provided the LLM API the session is pointed at actually supports multimodal input):

- **Directed reads** — point the agent at a specific image through the `feed_image` MCP tool. Under the hood, `feed_image` mimics the manual paste-image UX: it drops the file into a session-scoped tmp dir and injects the same bracketed-paste sequence a Ctrl+V would produce, then submits the frame. The agent sees `[Image #N]` in its transcript and can reason about the pixels.
- **Agent-initiated** — pair cchub with a browser-automation MCP (Playwright, Puppeteer) and Claude can screenshot its own dev server, feed the shot back to itself, and iterate. That closes the loop for front-end work: edit the code → snapshot the render → look at what actually shipped → adjust.

Fed images render as clickable `[Image #N]` chips in the browser terminal — though chips restored from prior-session scrollback are inert, since the underlying image bytes aren't around any more.

![Conversation with clickable [Image #N] chips inline](docs/screenshots/image-chip.png)

## Requirements

- Node.js **≥ 18**
- [Claude Code CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`)
- Windows (core terminal + SSH run cross-platform; external-tool reveal — cmd, PowerShell, XShell, XFTP — is Windows-only)

## Install & Run

```bash
git clone https://github.com/vinan-is-not-a-name/CCHub.git cchub
cd cchub
npm install
npm run build
npm start
```

Open <http://127.0.0.1:3000>. Change the port with `CCHUB_PORT`. Config lives at `~/.cchub/config.json` — override with `CCHUB_CONFIG=/path/to/config.json`.

## Remote access

cchub is single-user and local-first. The server refuses non-loopback connections; there are no user accounts, and any client on the port can drive every session. To use cchub from a phone or another laptop, open an SSH tunnel and browse the tunneled port locally:

```bash
ssh -L 3000:127.0.0.1:3000 you@your-workstation
# then on the client browser:
http://127.0.0.1:3000
```

SSH provides authentication and transport encryption; no port needs to be exposed.

## Configuration

Configuration is a single JSON file at `~/.cchub/config.json` (Windows: `%USERPROFILE%\.cchub\config.json`). The Config dialog has four tabs — LLM Providers, Servers, Proxies, Presets — each with create / edit / copy / delete. Fields:

- **profiles** — Reusable LLM provider configs: `baseUrl`, `authToken`, `model`, `subagentModel`, `smallFastModel`, optional proxy reference.
- **servers** — Local or SSH targets. SSH targets carry host / port / username / auth (password or private-key path).
- **proxies** — HTTP proxy definitions for outbound Claude API calls (bind port on the cchub side, forward to an upstream proxy; used by SSH sessions via reverse tunnel).
- **presets** — Named launch configs (server + profile + cwd + resume mode). The topbar "+ New Session" builds a session from a preset.

## Development

```bash
npm run dev          # Watch mode: server + client rebuild on change
npm run typecheck    # tsc --noEmit on both server and client
npm test             # Playwright — unit + integration + e2e
```

Unit tests only: `npx playwright test --project=unit`.

## Security model

- Fastify binds `127.0.0.1` and rejects non-loopback callers with a 403 pointing at the SSH-tunnel recipe.
- A separate origin guard rejects cross-origin WebSocket / HTTP requests, catching browser CSWSH attempts that the socket-level check can't see.
- SSH credentials live in the config file. Protect it with OS file permissions.
- Anything reachable at the loopback port has full control of the server. Do not expose the port on a LAN or through a public reverse proxy.

## License

[MIT](./LICENSE) — see the LICENSE file.
