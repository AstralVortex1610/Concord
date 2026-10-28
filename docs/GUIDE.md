# Concord guide (0.3.0 beta)
Many AI coding agents, any model from any lab, one project. Shared memory, a live board, and edits that never overwrite each other, even in the same file.

> **Public beta.** Concord is ready to use on real projects, and we want your feedback (the speech-bubble button, bottom left). It takes automatic checkpoints, but please keep your project in your own git repo too.

## Run it (Windows)
Requirements: Windows 10/11 x64. Recommended: [Git for Windows](https://git-scm.com) (turns on automatic checkpoints). Everything runs on your PC; only model calls go to the providers you choose (or nowhere, with Ollama / LM Studio).

1. Unzip `Concord-0.3.0-beta.1-win.zip`, open the folder, double-click `Concord.exe` (SmartScreen: More info > Run anyway; the app is unsigned).
2. Open a project folder.
3. Agents tab: Connect a model (pick a lab, paste key, Test, Save), add agents and give each a model.
4. Board: add tasks, or type a goal in Live > "Plan it". Press Start team.
5. Connect tab: copy the snippet for Claude Code, Codex, Cursor, Cline, Gemini CLI, VS Code or Windsurf so outside agents join the same board and memory. Add CONCORD.md so they use Concord's tools for edits.

## Safety: undo, checkpoints, commands
- **Undo a file.** Files → pick a file → Restore on any revision. Revision history is saved in `.concord/` and survives restarts.
- **Checkpoints.** Concord snapshots the whole project when the team starts and after every finished task, in a private history (`.concord/history.git`). It never touches your own repo, branch or staging area, and works in folders without git. Safety → Restore puts the project back; it snapshots first, so a restore can be undone.
- **Commands.** Built-in agents can run tests, builds and linters to check their own work. Agents → Commands: *Off*, *Safe list* (default: `npm test`, `pytest`, `go test`, `cargo build`, `tsc`, `eslint`, read-only git…, one command at a time, 2-minute limit) or *Anything* (except a blocked list: wiping drives, `git push`, `curl | sh`…). Outside agents never get this tool.
- **Local only.** The server listens on 127.0.0.1, refuses other hosts, and refuses requests from web pages (CSRF guard). API keys are encrypted with Windows DPAPI.
- **Crash safe.** Tasks that were in progress go back to the board after a restart. Logs: feedback button → Open log folder.
- **Resilient model calls.** Rate limits, overloaded servers and dropped connections are retried with backoff; agents stuck repeating the same action are stopped and the task marked blocked.

## How the no-overwrite editing works
- The coordinator inside the app is the only writer to your project folder. It keeps every file's text and a revision number.
- Agents reserve a function, a line range or a whole file. Reservations follow the code as it moves and expire after 10 minutes idle.
- Every edit says which revision it was made on. If other agents changed other lines since, Concord merges both (3-way merge). If the same lines changed, or the lines are reserved by someone else, the edit is rejected with the fresh file so the agent redoes it. Nothing is ever silently overwritten.
- Edits made outside Concord (your editor, git) are picked up as new revisions.

## Token saver (on by default)
Many agents usually means many tokens. Concord cuts that without changing results:
- **Delta re-reads.** When an agent reads a file it already read, it gets only the lines that changed since its revision (or "unchanged").
- **Outline first.** Long files open as a list of functions with line ranges; the agent then reads just the function it needs (`read_file` with `symbol`).
- **Focused bounces.** A rejected edit returns only what other agents changed since the agent's base revision, not the whole file.
- **Prompt caching.** Anthropic models get cache breakpoints on the system prompt and newest turn; OpenAI gets a stable cache key; other providers cache the stable prefix automatically.
- **Lean history.** Old file views that a newer read replaced are folded into one line, cut rarely and deeply so the cache stays valid.

In the built-in benchmark (`node test/token-bench.js`: 6 agents, one 400-line file, forced clashes) the same job used 69% fewer prompt tokens, and 91% fewer tokens that could not come from cache. Live score shows a token meter with the cached share. Turn it off under Agents → Token saver. External MCP agents can ask for deltas too with `read_file { sinceRev }`.

## Models
25 presets: OpenAI, Anthropic (native Messages API), Google Gemini, xAI, Mistral, Groq, Together, Fireworks, OpenRouter, Perplexity, Cohere, DeepSeek, Moonshot Kimi, Zhipu GLM, Alibaba Qwen, Baidu Qianfan, ByteDance Doubao (Volcengine Ark), Tencent Hunyuan, MiniMax, StepFun, 01.AI Yi, Ollama, LM Studio, plus Custom OpenAI-compatible and Custom Anthropic-compatible. Keys are encrypted with Windows DPAPI and never shown to the dashboard. Smart routing sends planning, small edits and review to different models.

## Known limits in the beta
- Unsigned app: SmartScreen asks once (More info → Run anyway).
- Windows only for now. No auto-update yet: download new versions from the release page.
- Small local models (under ~7B) often loop or misuse tools; Concord stops them, but use a capable model for real work.
- Files over 2 MB and binary files are not edited.

## For developers
- `npm start` runs the app. `npm run serve -- <folder>` runs a headless coordinator with the dashboard in your browser.
- MCP: `http://127.0.0.1:4317/mcp` (Streamable HTTP). Stdio bridge: `src/server/mcp-stdio.js` (or `Concord.exe` with `ELECTRON_RUN_AS_NODE=1`).
- REST: `POST /api/tool/<tool>` with `{ agent, args }`; `GET /api/snapshot`; live events at `GET /api/events` (SSE).
- Tests: `npm test` (merge stress test with 6 agents on one file, 4 OS processes over MCP, built-in agents against mock OpenAI and Anthropic servers, token benchmark, beta hardening: restart persistence, undo, checkpoints, command policy, CSRF). Live check against a real model: `LIVE_BASE=http://127.0.0.1:11434/v1 LIVE_MODEL=qwen2.5:7b node test/live-model.js` (any OpenAI-compatible or Anthropic endpoint via `LIVE_STYLE`/`LIVE_KEY`). Screenshots: `electron --no-sandbox --ozone-platform=headless test/shot.js`.
- Data: project state in `<project>/.concord/state.json` (git-ignored); app settings in `%APPDATA%\Concord\settings.json`.
