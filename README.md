# Agent Environment Doctor

**Diagnoses the *effective* runtime state of AI agent environments (Claude Code, Codex). Read only. It observes, keeps evidence, names symptoms. It does not treat.**

Agent environments drift silently — a skill that never loads because of a format mismatch, a rule that fires in every session instead of the one it was written for, a reference to a plugin that no longer exists. The Doctor finds these by observation, not guesswork: **Observation → Evidence → Symptom**. It never fixes, optimizes, deletes, or rewrites anything itself — that decision is left to a human, or an LLM the human is using.

> Current release: **v1.0.0**. Supports macOS / Windows (native), Claude Code / Codex, Node `>=20`. Published at [github.com/becky-exists/agent-environment-doctor](https://github.com/becky-exists/agent-environment-doctor). See `docs/` for details.

## Credits

Creator: **BECKY**. Published and operated by **Intervention Works**. `BECKY EXISTS` is the public identity (GitHub Organization) this project is published under.

## What it is / What it is not

| This is | This is not |
|---|---|
| A health check that observes the state that actually loads into **the next session you launch** (Effective Runtime State) — not the state of what's installed | An optimizer that lightens your environment. There is no `--fix`, and there won't be one |
| A tool that reports symptoms (Findings) with evidence traceable back to primary facts | A judge of "unnecessary", "wasteful", or "should be optimized" |
| A way to safely carry someone else's environment out as one redacted, self-checked file (`bundle`) | A tool that rewrites config, skills, or rules. It does not execute fixes |
| **READ ONLY.** `test/readonly.test.ts` makes the examined environment read-only, runs every command against it, and checks that not a single byte changed | A tool that sends anything over the network (`bundle` only ever writes locally) |

## Supported

- **OS**: macOS / Windows (native). Linux is untested and out of CI scope (see Continuous Integration below)
- **Runtime**: Claude Code / Codex. You don't need both installed — either one works on its own (narrow with `--runtime claude-code` / `--runtime codex`)
- **Node**: `>=20` (`package.json#engines`). CI verifies both the Node 20 line and the exact version the maintainers actually develop with

## Install

### Quick Start (prebuilt ZIP — recommended)

```bash
# Download agent-doctor-runtime-<version>.zip from https://github.com/becky-exists/agent-environment-doctor/releases
unzip agent-doctor-runtime-<version>.zip -d agent-doctor
cd agent-doctor
npm ci --omit=dev            # installs only production deps, from the bundled package-lock.json
node dist/cli.js scan --project /path/to/your/project
```

The ZIP contains `dist/` (compiled), `package.json`, `package-lock.json`, `README.md` (`LICENSE` / `NOTICE` are included if present, but their absence does not fail the build). `src/` / `test/` / `.git` / `fixtures/` / `node_modules/` are never included (allowlist approach in `scripts/build-runtime-zip.ts`). You can verify integrity with the bundled `.sha256`:

```bash
shasum -a 256 -c agent-doctor-runtime-<version>.zip.sha256   # macOS
sha256sum -c agent-doctor-runtime-<version>.zip.sha256       # Windows (Git Bash) / Linux
```

The public repo is [becky-exists/agent-environment-doctor](https://github.com/becky-exists/agent-environment-doctor).

### From source (development)

```bash
git clone https://github.com/becky-exists/agent-environment-doctor.git
cd agent-environment-doctor
npm ci
npm run build
node dist/cli.js scan --project /path/to/your/project
# during development, npx tsx src/cli.ts scan runs it directly without going through tsc
```

### Update

Extract the new version's ZIP into a separate directory → `npm ci --omit=dev` → verify it works → switch over from the old directory. **Do not overwrite in place** — keep the old version around so you can roll back immediately.

## Continuous Integration

`.github/workflows/ci.yml` (two gates: `test` and `release-zip-smoke`. macOS + Windows native, a matrix of the Node 20 line and the version actually used for development, plus a separate gate that extracts the prebuilt ZIP and smoke-tests it). This runs as GitHub Actions on every push to `main` and on pull requests — see [github.com/becky-exists/agent-environment-doctor/actions](https://github.com/becky-exists/agent-environment-doctor/actions) for current runs. See the comments at the top of the workflow file for the reasoning behind any skips.

---

## Why this exists — the lifestyle disease of AI environments

Agent environments gain weight a little every day. One more skill, one more hook, a plugin tried and then disabled, a rule moved somewhere else. Each change is correct in isolation. Accumulated, **the Installed State drifts away from the Effective Runtime State** — what's actually loaded into a session.

- A skill that's in place but never gets read (wrong format)
- A plugin that's referenced but doesn't exist (a name left behind in an agent definition)
- The same-named skill placed in two runtimes, with only one of them updated
- A rule meant for "specific launch conditions only" that in fact loads into every session
- A config file edited, while a running session keeps the old state

This isn't an acute illness. Nobody notices, and everyone quietly pays a little more per session. That's a lifestyle disease, and this Doctor runs the **checkup**.

## Doctor ≠ Optimizer

This tool is not for making your environment lighter. Its job stops at **observe → evidence → symptom**.

| What the Doctor does | What the Doctor does not do |
|---|---|
| Records what exists (Presence), when it loads (Activation), where it came from (Provenance), and what state it's in (Temporal) | Delete, move, or disable anything |
| Reports symptoms with evidence traceable back to primary facts | Judge things as "unnecessary", "wasteful", or in need of "optimization" |
| Always calls out "large but not a problem" explicitly | Suggest ways to cut tokens |
| Hands back results shaped as **input** to a fix | Perform the fix itself |

**Fixes go to a human, or to an LLM a human is using.** The Doctor never treats on its own. `--fix` does not exist, and won't be added.

## Three "is not"s

The judgment principles that keep the Doctor from sliding into being an Optimizer. The `guard-false-bloat` fixture protects these as a regression test (expected value: `findings: []`. A build that fails here is unacceptable even if everything else passes).

1. **Heavy is not bad.** A 25 KB memory index and 141 MCP tools are not, by themselves, symptoms. Size is recorded as a fact, not treated as a defect. Identity and memory are protected by default.
2. **Unused is not unnecessary.** A skill that hasn't fired in three months is an observation — "hasn't fired in three months" — not a judgment. The judgment is the owner's to make.
3. **Invisible is not abnormal.** Most `discovered=false` cases (72 of 73 observed in practice) simply mean the resource lives in another runtime's territory. Invisibility-by-design is an Observation. It only becomes a symptom when something sits in a place that's supposed to be discovered, in a format that isn't.

## What it observes and stores

Four axes: Presence / Reachability (does it exist, is it reachable), Activation / Scope (when does it load, for whom), Provenance / Lineage (where did it come from, who created the binding), Temporal State (as of when).

What gets stored isn't a graph — it's four plain, hard-to-break kinds of **factual data**.

| Kind | What it is | Lifetime |
|---|---|---|
| **Resource** | What exists. Identity is a content hash (not a path) | Until content changes |
| **Binding** | How this runtime sees it. Carries `discovered` and the `rule_id` that decided it | Depends on runtime version |
| **Observation** | What actually happened. Always carries `method` (evidence grade) and `scope` (next launch vs. currently running) | Append-only |
| **Snapshot** | The three above, at a point in time. Carries `schema_version`; different versions are never compared | Permanent |

The graph is generated at analysis time. References (strings like `vercel:react-best-practices`) are stored **raw, unresolved** — "cannot resolve" is something the analysis side says, not the collection side.

## Evidence discipline

- Every Finding carries `evidence_refs`. An empty one is not allowed. "Looked but found nothing" is kept as an `absence`, listing every place that was checked
- Anything that can't be determined statically is marked `confidence: probe_required`. No guessing
- Different measurement methods are kept as separate, coexisting observations (no crude `chars/4` token estimate — it's off by 2–3x for Japanese)
- **Every report declares its observation scope up front.** The default is "the next session you launch." A session already running keeps the state it started with. Dropping this declaration looks like a misdiagnosis — "I fixed it and nothing changed"

## The Doctor never touches the patient

READ ONLY isn't a policy, it's a test. `test/readonly.test.ts` makes the examined environment read-only, runs every command against it, and verifies that hash / mtime / directory structure don't change by a single byte before and after, and that the only writes are to the snapshot's output destination. If the Doctor ever touches the patient, that build fails.

## Coverage — what it looks at, and what it doesn't

This is a line-for-line translation of the declaration in `src/coverage.ts` (`collect --coverage` prints the source-of-truth version; a test cross-checks that every line in `src/coverage.ts` has a corresponding entry here, so this can't silently drift out of sync). **No Finding is ever produced from something not listed here.** It does not pretend to diagnose areas it doesn't cover.

Scope: Phase 0 (static, next_session)

**What it collects**

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

**What gets added with `--probe`** (only reads records already on disk. Does not launch anything, does not spend tokens, does not write anything)

- active runtime: from claude-code transcripts — the set of skill / agent / deferred tool / MCP instruction names, and start time (message bodies are not read)
- active runtime: from codex session rollouts — start time, cli_version, and a fingerprint of the launch-time instruction body (the body itself is not kept)
- active runtime: from `ps` argv — a fingerprint of what a launch script actually injected, and its launch time
- active runtime: from claude-code transcript deltas — per-MCP-server connection status (connected/failed/intermittent) and API errors such as 429s (#69)
- active runtime: pid ↔ session_id mapping (only when it can be linked with high confidence, #69), system-wide load average/memory/swap, and agent process CPU%/RSS (#69)

**What it does not collect** (never feeds into a Finding)

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

## What you can do today

```bash
npx tsx src/cli.ts bundle --out <file>      # ★ a diagnostic bundle you can hand to someone else (redacted locally, never sent anywhere)
npx tsx src/cli.ts ui       [--port 7333]   # ★ a localhost microscope. Overview → Structure → Evidence (READ ONLY, 127.0.0.1 only)
npx tsx src/cli.ts ui --print               #   prints the same data as the UI once, without starting a server
npx tsx src/cli.ts scan     [--json]        # collect and diagnose (Findings, below)
npx tsx src/cli.ts report --llm [--format md]   # a report for the LLM doing the fixing (JSON by default)
npx tsx src/cli.ts collect  [--json]        # collect Resources / Bindings / Observations
npx tsx src/cli.ts gate-a                   # checks whether the IR holds together on real data (14 checks)
npx tsx src/cli.ts snapshot --out <file>    # save the four kinds of factual data
npx tsx src/cli.ts diff <old> [<new>]       # diff between snapshots
npx tsx src/cli.ts explain <id|path|name>   # shows the source → binding → observation chain
npx tsx src/cli.ts collect --launcher ~/bin/start.sh   # declare a launch script explicitly (`--append-system-prompt "$(cat …)"` becomes a separate Binding)
npx tsx src/cli.ts collect --coverage       # print full coverage / non-coverage
npx tsx src/cli.ts scan --probe             # also reads records of running sessions to compare configured vs. active
npx tsx src/cli.ts scan --probe --self-session <id>   # excludes the Doctor's own session (a mismatch there is expected)
npx tsx src/cli.ts history [--dir snapshots]  # derives when things increased / disappeared / drifted / when a session went stale
npm test                                    # fixtures / read-only / golden / coverage
npm run golden                              # regression check against Phase 0's measured values
```

Binding identity is `(runtime, resource_id, resource_path, mechanism, source_ref)`. The same file loaded into the same runtime through two different mechanisms (rules auto-load and a launch script's `--append-system-prompt`) is kept as two separate Bindings (2026-09-07 independent Codex review, `docs/codex-review-result-phase0.md`).

**Runtime-aware**: with `--probe`, it reads records **already on disk** (session transcripts / rollouts, and `ps`) and compares the configured state against what a currently running session actually has. **It never launches anything, spends no tokens, writes nothing.** It never reads conversation content (only structural record fields). Limits are declared too: claude-code records don't carry instruction bodies, so the most it can say is "changed after the session started." Sessions aren't linked to processes either, so `live` is a heuristic. Details, and the 5 false positives squashed during implementation, are in [docs/session-staleness-2026-09-07.md](docs/session-staleness-2026-09-07.md).

**The difference between `scan` and `scan --probe`**, in one line: `scan` is static — it only looks at on-disk config (CLAUDE.md / AGENTS.md / skills / rules / hooks, etc.) and diagnoses "what will the next launched session look like." `scan --probe` additionally reads **records already on disk** for running sessions (transcript / rollout) and `ps`, and reports where a currently running session has drifted from config (`SESSION_STALENESS`). Neither one launches a new session.

### Two exits

| Exit | Who it's for | What it produces |
|---|---|---|
| `ui` | **A human's microscope** | You can drill from Overview (a plain-language symptom summary) → Structure → Evidence. Pick one resource and one screen shows how both runtimes see it, its binding paths, content matches against same-named resources, its startup cost, related Findings and Evidence, and its change history |
| `report --llm` | **A diagnostic report for the LLM doing the fixing** | Findings + fully expanded Evidence + confidence + unknowns + "what the Doctor did not conclude." It never writes a fix |

`ui` **never produces an overall score (a Health Score)**. A crude single number would undermine the whole philosophy. Large numbers are never colored red.

### Overview — so you don't have to look at what you don't need to

Showing every result from the start is unreadable on first encounter. `ui`'s first screen is **a plain-language symptom summary, not a list of Findings**.

- The heading reads **`N areas need attention`. N is not the count of Findings — it's the count of root causes after clustering** (e.g. 19 Findings → 6 areas)
- **Clustering is only allowed when there's an observed fact tying the cause together.** The keys are things like "points at the same plugin namespace," "same pair of runtimes, same-named content that differs," "same kind of drift happening in the same runtime," "the same command is registered." Anything that can't be safely clustered stays as its own item. **Nothing is clustered by guesswork just to look tidy** — every cluster always shows "why this was grouped"
- Next to it sits **"what was not diagnosed as a problem"**: fixed startup costs, protected resources, skills with no invocation record, invisibility that's expected because it lives in another runtime's territory, checks that weren't evaluated, ranges that weren't looked at. **This is where the Doctor demonstrates, every time, that it is not an Optimizer**
- Differences in what Claude vs. Codex see, and recent changes (a period that was never observed is never treated as "no change"), live on the same screen
- In Structure, each resource's detail is preceded by **1–2 lines of "so what does this mean"**. Example: "Claude sees this file; Codex sees `~/.agents/skills/…`. Same name, different copy, content differs by 8 lines." **Just the plain-language translation of the facts — no fix proposal, no decision about which is canonical**

The expert-level layers (Structure / Findings / Context cost / Hooks / History / Not findings / Coverage) are never removed. Overview is the entry point to them, not a replacement. **Not findings** in particular stays because it *is* the demonstration that something was looked at and not diagnosed as a symptom.

### Diagnosing someone else's environment — the Portable Diagnostic Bundle

For when someone says "my Claude Code has been acting up lately" — a single file to safely capture and hand over their environment.

```bash
# the person being diagnosed runs this once, on their own machine
npx tsx src/cli.ts bundle --out ~/Desktop/bundle.json --probe --symptom "feels heavy lately, seems to be using old instructions"
```

The only thing written is the one file at `--out`. **Nothing ever goes over the network.** The resulting JSON is handed over by the person themselves, of their own volition.

**Not a single line of body text goes in.** transcripts / Memory / CLAUDE.md / AGENTS.md / skill bodies / `source` / `description` / config values (including MCP server `env`) / full hook command text are all excluded. Whatever's needed for comparison is kept as **hash, byte count, line count, diff size, kind, mechanism, timestamp**. `CROSS_RUNTIME_DRIFT` can say "205 lines differ, +135/-70, the claude side is newer" without printing a single line of the actual content.

The shape of secrets (`sk-ant-…` / `ghp_…` / `AKIA…` / Bearer / PRIVATE KEY / `user:pass@` in a URL, etc.) is stripped down to just the kind, home becomes `$HOME`, username becomes `<user>`, project roots and slugs become `<project-N>`, and resource names are anonymized by default as `<skill-7>` (skill / agent / project names are where client and project names live — `--redact standard` keeps the names visible). **The same entity always maps to the same id within one bundle**, so references stay traceable even after anonymization.

And **it never settles for "probably not in there"**: it scans the finished output again for home paths, usernames, secret shapes, and raw resource names, and **if even one is found, it aborts and never writes the file**. The deliberately planted test cases for this live in `fixtures/bundle-privacy/`. Details in [docs/bundle-v0.1.md](docs/bundle-v0.1.md).

**`--redact strict` (default) vs. `--redact standard`**: both always strip home / username / secret shapes. The only difference is resource names — `strict` also anonymizes skill / agent / project names as `<skill-7>` (because that's where client and project names live). `standard` leaves just those names intact (useful when sharing within your own team, where names are needed for identification). Both levels always run the self-check.

### `report`, `snapshot`, and `ui` are not the same thing as the shareable `bundle`

These four commands have wildly different redaction levels, and **only `bundle` is meant to be handed to someone else.**

| Command | Default redaction | Intended destination |
|---|---|---|
| `snapshot --out <file>` | **None.** Absolute paths and real names go in as-is | Local `diff` / `history` use. Not for sharing |
| `ui` | None (it's just unreachable from outside because it binds to `127.0.0.1`) | Your own screen. Not for sharing |
| `report --llm` | Only the home path is replaced with `~` (`--no-redact` prints it raw). Secret shapes / username / project names / resource names are **not looked at** | Handoff to the LLM you personally use (Emma / Claude / Codex, etc.). Not meant to be forwarded to a third party |
| `bundle --out <file>` | Anonymizes 11 secret kinds + home + username + project root/slug + resource names. **Never writes the file if the self-check fails** | The one file meant for a third party. This is the only one built to be shared |

**Never send a raw `report --llm` JSON or a `snapshot` file to someone else.** If you need a primary artifact meant to be sent, build it with `bundle`.

### Never reporting "couldn't get it" as a count of zero

In a third-party environment, **the worst possible failure is displaying something unreadable as a 0** ("Memory: 0" reads as "there is no Memory"). So the outcome of the lookup itself is recorded.

| status | meaning |
|---|---|
| `observed` | Read successfully. **This is the only status that carries a count** |
| `absent` | Read successfully, and it wasn't there (ENOENT). The fact that it doesn't exist |
| `permission_denied` | Couldn't read it — no permission. **Not the same as nonexistence** |
| `failed` | Some other I/O error. **Not the same as nonexistence** |
| `unsupported` | This platform has no such concept (e.g. no BSD-style `ps` on Windows) |
| `not_applicable` | A precondition wasn't met (no project specified, no `--probe`) |
| `unobserved` | Never looked at it in the first place |

`count` is always `null` for anything other than `observed`, enforced by both the type and the generating function — **it is structurally impossible to write a 0**. The same thing appears at the tail of `scan`, in the UI's Coverage tab, and in the bundle's `observation_status`. A failed lookup is never auto-promoted to a Finding. It's reported honestly first.

### OS differences — enumeration is truth, encoding only narrows down

The encoding rule for `~/.claude/projects/<slug>` differs by OS (`/Volumes/SSD2TB/foo` → `-Volumes-SSD2TB-foo` vs. `C:\Users\foo.bar\gsd` → `c--…`). The old implementation only had the Mac rule, and **Memory would silently come back as 0 on Windows**.

The fix isn't "add one more rule for Windows."

- **Enumeration is treated as ground truth.** A scan always starts from `readdir`. Encoding cwd → slug is only used to narrow down to "just the current project"
- **Encoding is non-reversible**, so the original path is never reconstructed from a slug (a `-` in the original path would break it)
- Windows' case-folding rule is **not confirmed** (the primary-source implementation and its commit message disagree). So it **doesn't bet on one rule — it produces candidates and cross-checks them against enumeration results**. On Windows, the cross-check is case-insensitive
- When the cross-check fails, it **never goes quiet as a count of zero — it's recorded as a failed cross-check, and narrowing is abandoned**
- Memory / project path extraction is separator-agnostic (`[/\\]`). A hardcoded `/` matched nothing on Windows and silently drove cost to 0

The rule is now unified in `src/ir/slug.ts` (it used to be duplicated across `probe/transcript.ts` and `observe/context-cost.ts`). A Windows-format project tree lives in `fixtures/windows-projects/` and runs in Mac CI.

### Findings (5 kinds)

| Finding | What it says | What it doesn't say |
|---|---|---|
| `UNREACHABLE_REFERENCE / undiscovered_declaration` | A skill placed in a searched location, in a format that won't be discovered (a flat `.md`) | Something that just lives in another runtime's territory (that's an Observation) |
| `UNREACHABLE_REFERENCE / missing_target` | An `ns:name` reference whose target doesn't exist, reachably, in any runtime. Lists every place it looked | Whether the reference should be removed, or a plugin installed |
| `CROSS_RUNTIME_DRIFT` | A same-named skill whose content differs across runtimes. Both paths, mtimes, diff line count, which side is newer | Which one is canonical |
| `SCOPE_MISMATCH` | A rule whose body describes a launch condition, but ships with no `paths:` so it loads into every session. Also shows the binding if the same file is also loaded via a launcher | What `paths:` should say |
| `SESSION_STALENESS` (`--probe`) | Where config and **the currently running session's** state disagree. Capabilities a session keeps holding, always-loaded files that changed after the session started, body text a launch script still has injected | Whether that session should be restarted |
| `HOOK_AMPLIFICATION` | The same command registered on multiple events / byte-identical bodies injected repeatedly / a hook that applies to both session and subagent with an actual observed injection | Whether the hook should be removed. **Having many hooks, or many firings, is never itself a symptom** (if the injection is 0 bytes, it's never reported no matter how many times it fires) |

### Size and history (not Findings)

**Context cost** reports, as fact, what loads at startup and how much. It splits into `always` (paid every time), `on_demand` (only the description), `deferred` (only the name), and separates protected items out of the total. Tokens are counted with js-tiktoken (**never `chars/4`** — it's off by more than 2x for Japanese). **Large is never treated as bad.** Whether it's a symptom is a separate decision made by Findings.

**History** derives events from a series of snapshots. It is not a listing. "When something increased / disappeared / changed / drift began or resolved / a session went stale / a runtime's version changed." Event dates mean "this happened between these two points," and periods that weren't observed are shown explicitly as gaps. Increases or decreases are never treated as good or bad in themselves.

The bar for "done" isn't "can we build a complete environment model" — it's "can we trust the Findings it reports." Remaining work toward completeness is tracked in Issues, and only gets pulled forward if it's shown to cause a false positive or false negative in an actual Finding (real example: plugin agent definitions. `codex:codex-rescue` turned out to be an agent, not a skill, causing a false positive `missing_target` — so it was added to what's collected).

**What "protected" means** is that it stops proposals like "it's big, cut it" or "unused, delete it" — it does not lower the severity of a fact-based diagnosis (e.g. a missing reference target). A Finding on a protected resource keeps its full severity; `report --llm`'s `protected_handling` adds "wholesale changes or removal are not recommended" for it.

`report --llm` is the shape handed to the LLM doing the fixing (Emma / Claude / Codex — design doc `docs/llm-report-format-v0.1.md`). Each Finding carries fully expanded evidence, affected resources, `doctor_did_not_conclude`, `human_decision_needed`, `unknowns`, prefixed with `doctor_actions` (the Doctor changed nothing) and a `handoff_contract`. **It never writes the fix itself.** Just what happened, why it was judged that way, and how confident it is.

Every `scan` lists, under `no findings for:`, **things that are large but were not turned into a Finding** (deferred MCP servers, invisibility that's expected in another runtime's territory, disabled plugins, skills with no invocation record, protected memory). Detectors that had no input to evaluate against show up as `not evaluated`. It never silently passes.

## Try it

```bash
npm install
npm run ui -- --probe --project /path/to/your/project
# → http://127.0.0.1:7333/
```

Screenshots and measured values from a real environment are in [docs/demo/](docs/demo/README.md).

## Troubleshooting / Known limitations

- **Windows' case-folding rule is not confirmed** (the primary-source implementation and its commit message disagree). It only narrows down by cross-checking against enumeration results, and never bets on a single rule. See "OS differences" above for details
- **Load average / swap are not available on Windows** (`os.loadavg()` always returns `[0,0,0]`. Recorded as `unsupported`, never reported as `0`)
- **The `live` judgment under `--probe` is a heuristic.** Linking a session to a process only happens when the runtime matches, start times are within 5 seconds of each other, and there's exactly one candidate from both sides. Everything else stays `ambiguous` / `unmapped` (never guessed into one match)
- **Codex-side skill/agent listings, MCP connection status, and API errors are not obtainable even with `--probe`.** There is currently no equivalent structural record obtainable from rollouts without reading conversation content (only claude-code can be observed this way via `--probe`)
- **The version shown in `agent-doctor scan`'s `agent-doctor <version>` banner may be out of sync with `package.json`'s version** (the internal `TOOL_VERSION` constant and `package.json#version` are maintained separately). Check `package.json` or the commit hash to know which build you actually have — don't rely on the banner
- **`test/packaging.test.ts`'s fresh-checkout check auto-skips outside a git working tree** (e.g. somewhere a distributed ZIP was merely extracted). This is by design — a distributed ZIP has no `.git` to compare against. The alternate gate is the CI `release-zip-smoke` job, which actually extracts the ZIP and smoke-tests the CLI
- **`npm run release:zip` depends on the host OS having a `zip` command.** macOS ships with one by default. Windows sometimes doesn't, so CI installs it via `choco install zip` when it's missing (see `.github/workflows/ci.yml`)
- The Doctor itself has no `--fix`. If something feels wrong, start with `scan --coverage` to check whether it's even in scope to be looked at

## Reading order

1. `docs/design-review-v0.1.md` — the design of the 4 axes and the 4 kinds of factual data
2. `docs/failure-patterns-v0.1.md` — 14 symptoms generalized from a real environment
3. `docs/phase0-implementation-handoff.md` — the IR schema and discovery rules
4. `fixtures/README.md` — one fixture per symptom, how expected values are written
5. `docs/llm-report-format-v0.1.md` — the shape of the report handed to the fixing LLM
6. `docs/session-staleness-2026-09-07.md` — observing a running session (a probe that reads records), and the false positives it squashed
7. `docs/demo/README.md` — an end-to-end dogfood of a real environment (screens and measured values)
8. `docs/bundle-v0.1.md` — the contents of the bundle handed to someone else, its redaction rules, the shortest path through it

## Origin

This was generalized into a machine-checkable form after spending half a day manually auditing a single real environment (a development machine running Claude Code and Codex side by side) and finding the symptoms by hand. It was not designed from a hypothetical use case. All 14 symptoms have a real, measured example; one of them (a running session holding onto stale state) was found through self-observation while this was being designed.

License: MIT
