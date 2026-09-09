# Agent Environment Doctor

**Configured ≠ Loaded ≠ Effective.**
Diagnoses the gap between what exists on disk and what Claude Code / Codex can actually see or use at runtime.
Not a prerequisite checker. Not an optimizer. Read only.

> Current release: **v1.1.0**. Supports macOS / Windows (native), Claude Code / Codex, Node `>=20`. Published at [github.com/becky-exists/agent-environment-doctor](https://github.com/becky-exists/agent-environment-doctor).

Environments drift silently: a skill sitting in the wrong format so it never loads, a rule meant for one launch condition firing in every session, a reference to a plugin that no longer exists. Nobody notices day to day — the "Installed State" (what's on disk) and the "**Effective Runtime State**" (what actually loads into the *next* session you launch) quietly pull apart. That gap is what this tool measures.

## Doctor ≠ Optimizer

This is the one distinction that shapes every design decision below. Read it before anything else.

| What the Doctor does | What the Doctor does not do |
|---|---|
| Records what exists, when it loads, where it came from, what state it's in | Delete, move, or disable anything |
| Reports symptoms (**Findings**) with evidence traceable back to primary facts (**Observation → Evidence → Symptom**) | Judge things as "unnecessary", "wasteful", or "should be optimized" |
| Always calls out "large but not a problem" explicitly | Suggest ways to cut tokens |
| Hands back results shaped as **input** to a fix | Perform the fix itself |

**Fixes go to a human, or to an LLM a human is using.** `--fix` does not exist, and won't be added.

**READ ONLY isn't a policy, it's a test.** `test/readonly.test.ts` makes the examined environment read-only, runs every command against it, and checks that not a single byte changed — including side effects from any runtime CLI the Doctor invokes as a subprocess. v1.0.1 closed a real gap here: a `--version` probe against the real `codex` CLI was letting that CLI's own startup bootstrap write into the diagnosed environment (see [RELEASE_NOTES.md](./RELEASE_NOTES.md)). Version detection for Codex is now non-invasive by design, and the test harness now actually exercises the subprocess path (with fixture doubles) instead of routing around it.

## Supported

- **OS**: macOS / Windows (native). Linux is untested and out of CI scope — see [Continuous Integration](./docs/troubleshooting.md#continuous-integration)
- **Runtime**: Claude Code / Codex — either one works on its own (`--runtime claude-code` / `--runtime codex`)
- **Node**: `>=20`

## Quick Start

```bash
npx agent-environment-doctor@latest scan --project /path/to/your/project
```

That's a static scan: on-disk config only, diagnosing what the *next* session you launch will look like. Add `--probe` to also compare against a **currently running** session (reads existing transcript/rollout records only — never launches anything, spends no tokens):

```bash
npx agent-environment-doctor@latest scan --probe --project /path/to/your/project
```

Agent Environment Doctor itself does not send diagnostic data over the network. `npx` itself downloads the package from the npm registry and writes to the npm cache — that is npm's behavior, not the Doctor's.

### Alternative: Release ZIP (offline-ish install)

```bash
# Download agent-doctor-runtime-<version>.zip from
# https://github.com/becky-exists/agent-environment-doctor/releases
unzip agent-doctor-runtime-<version>.zip -d agent-doctor
cd agent-doctor
npm ci --omit=dev
node dist/cli.js scan --project /path/to/your/project
```

### Building from source, and updating

```bash
git clone https://github.com/becky-exists/agent-environment-doctor.git
cd agent-environment-doctor
npm ci
npm run build
node dist/cli.js scan --project /path/to/your/project
# during development, npx tsx src/cli.ts scan runs it directly without going through tsc
```

To update an existing install: extract the new version's ZIP into a **separate** directory, `npm ci --omit=dev`, verify it works, then switch over. **Do not overwrite in place** — keep the old version around so you can roll back immediately.

## What you get in 3 minutes

### The diagnostic shape: Observation → Evidence → Symptom

Every Finding traces back to primary facts, not inference. Four kinds of stored data make this possible — **Resource** (what exists, keyed by content hash), **Binding** (how a runtime sees it), **Observation** (what actually happened, always carrying a confidence/method), **Snapshot** (all three, at a point in time). Full schema and design rationale: [design-review-v0.1.md](./docs/design-review-v0.1.md).

### Five Findings

| Finding | One line |
|---|---|
| `UNREACHABLE_REFERENCE / undiscovered_declaration` | Placed correctly, wrong format — the loader will never find it |
| `UNREACHABLE_REFERENCE / missing_target` | An `ns:name` reference whose target doesn't exist anywhere reachable |
| `CROSS_RUNTIME_DRIFT` | Same-named skill, different content, across runtimes |
| `SCOPE_MISMATCH` | A rule that reads "conditional" but ships with no scope, so it loads into every session |
| `SESSION_STALENESS` (`--probe`) | Config and a *currently running* session disagree |
| `HOOK_AMPLIFICATION` | The same hook body injected repeatedly across events/subagents |

None of these say what to do about it — that's for `report --llm`'s `human_decision_needed` field, not the Doctor. Full semantics and what each Finding deliberately does *not* claim: see the Findings table inside [failure-patterns-v0.1.md](./docs/failure-patterns-v0.1.md).

### Two exits

| Exit | For | Produces |
|---|---|---|
| `ui [--port 7333]` | A human's microscope | Overview (plain-language symptom summary, clustered by root cause) → Structure → Evidence. `127.0.0.1` only, never a Health Score |
| `report --llm [--format md]` | The LLM doing the fixing | Findings + expanded evidence + confidence + unknowns + "what the Doctor did not conclude" |

### `bundle` — handing your environment to someone else

```bash
node dist/cli.js bundle --out ~/Desktop/bundle.json --probe --symptom "feels heavy lately"
```

One file, written locally, never sent over the network — the person hands it over themselves. Known secret shapes (11 kinds), home path, username, and (by default) resource name are anonymized; the finished output is re-scanned for leftovers and **the file is never written if that self-check fails**. This is the only one of the four report-shaped commands (`snapshot`, `ui`, `report --llm`, `bundle`) that's meant to leave your machine — the other three keep real paths and names by default. Full redaction spec, the `--redact strict` vs `--redact standard` distinction, and the privacy self-check design: [bundle-v0.1.md](./docs/bundle-v0.1.md).

### What it doesn't do (non-coverage)

**No Finding is ever produced from something not listed as collected.** The Doctor does not pretend to diagnose areas outside its declared scope. The short version, verified against `src/coverage.ts` at build time:

- Doesn't read instruction *bodies* inside a running session — CLAUDE.md/rules/memory content changes are only visible as mtime deltas, never as "what it actually said while the session ran"
- Doesn't discover shell config (`.zshrc`), launchd plists, or cron — launch scripts are only considered when passed explicitly via `--launcher`
- Codex-side skill/agent listings, MCP connection status, and API errors are not obtainable even with `--probe` (no equivalent structural record exists in rollouts without reading conversation content)
- Windows load average and swap are `unsupported`, never reported as `0` (`os.loadavg()` always returns `[0,0,0]` on Windows)
- Never estimates tokens with `chars/4` — always the real tokenizer, because the estimate is off by 2–3x for Japanese
- A failed or denied read is never silently reported as a count of zero — `permission_denied` / `failed` / `unsupported` / `not_applicable` are distinct, honest statuses

The full collected/not-collected declaration (this is the actual contract the code is tested against): **[Coverage — full declaration](./docs/coverage.md)**.

## Read more

| Category | What's there |
|---|---|
| **Coverage & Evidence** | [Full coverage declaration](./docs/coverage.md) — the line-for-line collected/not-collected contract, cross-checked against `src/coverage.ts` by a test. [Evidence discipline](./docs/evidence-discipline.md) — why an empty `evidence_refs` is never allowed, how "looked but found nothing" is kept as an `absence`, the 7-status honesty table for failed reads. [Binding identity](./docs/codex-review-result-phase0.md) — the `(runtime, resource_id, resource_path, mechanism, source_ref)` tuple and why the same file loaded two ways counts as two Bindings (independent Codex review, 2026-09-07) |
| **Findings & Failure Patterns** | [14 real symptoms](./docs/failure-patterns-v0.1.md) this was generalized from, one fixture per symptom with measured examples. [The report format for the fixing LLM](./docs/llm-report-format-v0.1.md) — field-by-field spec of `report --llm` |
| **Bundle & Privacy** | [Redaction spec](./docs/bundle-v0.1.md) — the 11 secret kinds stripped, `strict` vs `standard`, the privacy self-check that refuses to write on any leftover, and why `report --llm` / `snapshot` / `ui` are not the same as a shareable `bundle` |
| **Platform notes & History** | [OS differences](./docs/os-differences.md) — why slug-encoding is enumeration-first and never reconstructs a path, the Windows case-folding uncertainty. [History](./docs/history.md) — how `history` derives "increased / disappeared / drift began or resolved / session went stale" from a series of snapshots, and what "protected" means. [`--probe` and session staleness](./docs/session-staleness-2026-09-07.md) — 5 false positives squashed during implementation |
| **Design rationale & Setup** | [Design review](./docs/design-review-v0.1.md) — the 4-axis model, why drift/scope-mismatch/hook-amplification are Findings and not axes, the UI Overview clustering rules, and the project's origin. [Troubleshooting / known limitations](./docs/troubleshooting.md) — version-banner drift, the `live` heuristic's exact matching rule, `test/packaging.test.ts`'s git-worktree skip, CI gates and their documented skips. [IR schema and discovery rules](./docs/phase0-implementation-handoff.md) — implementation handoff doc. [End-to-end dogfood](./docs/demo/README.md) — screens and measured values on a real environment. [Fixture format](./fixtures/README.md) — one fixture per symptom, how expected values are written |

## Credits

Creator: **BECKY**. Published and operated by **Intervention Works**. `BECKY EXISTS` is the public identity (GitHub Organization) this project is published under. License: MIT. The project's origin — a half-day manual audit of one real environment, generalized into 14 measured failure patterns, one of them (a running session holding onto stale state) found through self-observation while this was being designed — is told in full in [design-review-v0.1.md](./docs/design-review-v0.1.md) (§ "付記: この設計の出自").
