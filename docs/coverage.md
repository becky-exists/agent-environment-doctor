# Coverage — what it looks at, and what it doesn't

> Moved verbatim from the current root `README.md`'s "Coverage — what it looks at, and what it doesn't" section (2026-09-09, README compression pass 2). No wording changed from the source.

This is a line-for-line translation of the declaration in `src/coverage.ts` (`collect --coverage` prints the source-of-truth version; a test cross-checks that every line in `src/coverage.ts` has a corresponding entry here, so this can't silently drift out of sync). **No Finding is ever produced from something not listed here.** It does not pretend to diagnose areas it doesn't cover.

Scope: Phase 0 (static, next_session)

## What it collects

- claude-code: `~/.claude/CLAUDE.md`, `<project>/CLAUDE.md` (walking up parent directories is not supported)
- claude-code: `~/.claude/skills/*/SKILL.md` and flat `*.md`, `<project>/.claude/skills`, plugin skills (only the version pointed to by `installed_plugins.json`)
- claude-code: `~/.claude/agents/*.md`, plugin `agents/*.md` (named `<plugin>:<agent>`), `~/.claude/rules/*.md`, `<project>/.claude/rules`, `~/.claude/output-styles/*.md`
- claude-code: `settings.json#hooks` (with array position), plugin `hooks.json` / `.mcp.json`
- claude-code: `~/.claude.json#mcpServers` and `#projects.<path>.mcpServers` (only the necessary keys), `installed_plugins.json` + `settings.json#enabledPlugins`
- claude-code: `~/.claude/projects/<slug>/memory/MEMORY.md` (protected by default), `~/.claude.json#skillUsage` (invocation)
- codex: `$CODEX_HOME/AGENTS.md` and `<project>/AGENTS.md` (`AGENTS.override.md`, hierarchical concatenation, `project_doc_max_bytes` are not supported)
- codex: `~/.agents/skills/*/SKILL.md` (symlinks record `real_path`), `$CODEX_HOME/skills` (undocumented, low confidence), `config.toml`'s `[[skills.config]]` path
- codex: `$CODEX_HOME/agents/*.toml`, `$CODEX_HOME/hooks.json`, `config.toml`'s `[mcp_servers.*]` / `[plugins.*]`
- codex: `$CODEX_HOME/rules/*.rules` (kind=exec_policy. Presence and line count only; the DSL itself is not parsed)
- common: an explicitly declared launch script's (`--launcher`) `--append-system-prompt "$(cat <path>)"` is collected as an `append_system_prompt` Binding
- common: `~/.agents/skills` from claude-code, and `~/.claude/skills` from codex, are each collected as "outside the standard search location" (for cross-runtime drift comparisons)
- common: the outcome of a lookup itself (read successfully / didn't exist / no permission / failed / not applicable) is recorded as an access record. **Something that couldn't be read is never reported as a count of 0**

## What gets added with `--probe`

(only reads records already on disk. Does not launch anything, does not spend tokens, does not write anything)

- active runtime: from claude-code transcripts — the set of skill / agent / deferred tool / MCP instruction names, and start time (message bodies are not read)
- active runtime: from codex session rollouts — start time, cli_version, and a fingerprint of the launch-time instruction body (the body itself is not kept)
- active runtime: from `ps` argv — a fingerprint of what a launch script actually injected, and its launch time
- active runtime: from claude-code transcript deltas — per-MCP-server connection status (connected/failed/intermittent) and API errors such as 429s (#69)
- active runtime: pid ↔ session_id mapping (only when it can be linked with high confidence, #69), system-wide load average/memory/swap, and agent process CPU%/RSS (#69)

## What it does not collect

(never feeds into a Finding)

- Anything not recorded in a session transcript: what a claude-code instruction body (CLAUDE.md / rules / memory) actually was inside a running session. Only mtime comparison is possible
- Linking a session record to a process (pid ↔ session_id) with `--probe` is only done when the runtime matches, the start times are within 5 seconds of each other, and there's exactly one candidate from both sides (#69). Anything else (multiple candidates, times far apart) is left as `ambiguous` / `unmapped` — never guessed into a single match. The `live` judgment itself remains a heuristic based on record file modification time
- Codex-side skill/agent listing (rollouts don't record it). Conversely, Claude-side instruction bodies aren't available either
- Codex-side MCP connection status / API errors (there's currently no equivalent structural record obtainable from rollouts without reading conversation content; claude-code is observed via `--probe`, #69)
- Automatic discovery of shell config (`.zshrc` etc.), launchd plists, or cron. Launch scripts are only considered when passed via `--launcher`
- claude-code: walking up parent directories for CLAUDE.md, Enterprise deployments other than managed-settings, cross-checking against `settings.json#outputStyle`
- codex: `AGENTS.override.md`, hierarchical concatenation from the project root to cwd, `project_doc_max_bytes`, `<project>/.codex/{agents,hooks.json,config.toml}`, inline `[hooks]`, plugin-bundled hooks, hook trust state, admin/system skill placement
- codex: collecting multiple `CODEX_HOME`s in one run (one home per run), MCP `enabled=false`, semantic evaluation of the rules DSL
- Actual token measurement via tiktoken vs. the `chars/4` estimate — the crude estimate is never used
- Ingesting the official `/skill-doctor`, connecting to MCP servers
- Temporal identity of Observations (multiple points in time for the same kind/method within one snapshot are not retained)
- Windows load average (Node's `os.loadavg()` always returns `[0,0,0]`, so it's `unsupported`) and swap (not implemented, `unsupported`) — confirmed on native Windows during v1.0 acceptance testing
- Disk I/O, the official Anthropic / OpenAI status pages (bundle generation prioritizes never reaching the network; provider outages are something the recipient checks separately)
