# Promo assets (v1.1.0)

Three images that can stand on their own in a post. Each one is a real run on a real machine (macOS, Claude Code 2.1.266, Codex CLI installed, ~60 user-level skills). Nothing was staged: the drift, the unreachable references and the timing are what Doctor found on the author's own environment on 2026-09-09.

What was changed for publication, and nothing else:

- `$HOME` is shown as `~` (Doctor's own default redaction).
- The project directory was an empty throwaway (`/private/tmp/agent-doctor-public-demo/project`) so no project-level paths appear.
- Long finding bodies were collapsed to one or two lines in `03` and the right pane of `01` (`… 10 findings`). Every number and every sentence that remains is verbatim CLI output.
- The `/skill-doctor` table (82 rows) was cut to 14 representative rows, marked `… 21 more rows`; the highlighted `finish` row and the verdict lines are verbatim.
- In `01` the trailing `not evaluated` block (SESSION_STALENESS / HOOK_AMPLIFICATION: not observed, run with --probe) was replaced by one line, `Static scan only. Running sessions not compared (add --probe).` A first-time reader saw `HOOK_AMPLIFICATION … 1` and `HOOK_AMPLIFICATION: not observed` on the same screen and asked "so did it look or not?" The static case (one command registered on several events) and the dynamic case (firings) are different checks; the CLI wording that makes this clear is a v1.2 candidate. `03` keeps the block verbatim.

| File | Shows | Source command |
|---|---|---|
| `01-skill-doctor-vs-agent-doctor.png` | Claude Code's built-in `/skill-doctor` (v2.1.252+, run non-interactively with `-p`) next to Doctor's `scan` on the same machine in the same minute. `/skill-doctor` reports the skills loaded in *this* session, their per-turn context cost and usage, and flags 25 never-invoked skills to disable. Doctor reports the *next* session across both runtimes: the same `finish` skill that `/skill-doctor` counts at 155 uses today is, on the Codex side, a copy three months older that differs in 205 lines. Doctor does not report unused as a finding. Two tools, two questions. | `claude -p "/skill-doctor"` / `npx agent-environment-doctor@1.1.0 scan --project .` |
| `02-cross-runtime-drift.png` | One CROSS_RUNTIME_DRIFT finding in full: the same skill name (`frontend-design`) discovered by Claude Code from `~/.claude/skills` and by Codex from `~/.agents/skills`, content differing in 2 lines (`Claude is capable…` vs `Codex is capable…`). Doctor reports the difference and explicitly does not decide which side is canonical. | `npx agent-environment-doctor@1.1.0 report --llm --finding F-014 --format md` |
| `03-npx-scan-timing.png` | `npx … scan --project .` from an empty npm cache (download included): 203 resources, 479 observations, 17 findings, `real 4.16` seconds. | `/usr/bin/time -p npx --yes agent-environment-doctor@1.1.0 scan --project .` |

The `.html` files next to each image are the exact sources the PNGs were rendered from (terminal-styled HTML, Playwright screenshot at 2x). Diff them against the CLI output if you want to check nothing was added.
