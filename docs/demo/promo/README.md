# Promo assets (v1.1.0)

Three images that can stand on their own in a post. Each one is a real run on a real machine (macOS, Claude Code 2.1.266, Codex CLI installed, ~60 user-level skills). Nothing was staged: the drift, the unreachable references and the timing are what Doctor found on the author's own environment on 2026-09-09.

What was changed for publication, and nothing else:

- `$HOME` is shown as `~` (Doctor's own default redaction).
- The project directory was an empty throwaway (`/private/tmp/agent-doctor-public-demo/project`) so no project-level paths appear.
- Long finding bodies were collapsed to one or two lines in `01` and `03` (`… 10 findings`). Every number and every sentence that remains is verbatim CLI output.
- The `claude doctor` install path had the username replaced with `~`.

| File | Shows | Source command |
|---|---|---|
| `01-claude-doctor-vs-agent-doctor.png` | `claude doctor` (installation health, "No installation issues found.") next to Doctor's `scan` on the same machine in the same minute: 4 ERROR / 13 WARN across UNREACHABLE_REFERENCE, CROSS_RUNTIME_DRIFT, HOOK_AMPLIFICATION, plus the "no findings for" and "not evaluated" blocks. Same machine, two different questions. | `claude doctor` / `npx agent-environment-doctor@1.1.0 scan --project .` |
| `02-cross-runtime-drift.png` | One CROSS_RUNTIME_DRIFT finding in full: the same skill name (`frontend-design`) discovered by Claude Code from `~/.claude/skills` and by Codex from `~/.agents/skills`, content differing in 2 lines (`Claude is capable…` vs `Codex is capable…`). Doctor reports the difference and explicitly does not decide which side is canonical. | `npx agent-environment-doctor@1.1.0 report --llm --finding F-014 --format md` |
| `03-npx-scan-timing.png` | `npx … scan --project .` from an empty npm cache (download included): 203 resources, 479 observations, 17 findings, `real 4.16` seconds. | `/usr/bin/time -p npx --yes agent-environment-doctor@1.1.0 scan --project .` |

The `.html` files next to each image are the exact sources the PNGs were rendered from (terminal-styled HTML, Playwright screenshot at 2x). Diff them against the CLI output if you want to check nothing was added.
