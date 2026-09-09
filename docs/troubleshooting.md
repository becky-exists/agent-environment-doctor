# Troubleshooting / Known limitations

> Moved from the current root `README.md`'s "Troubleshooting / Known limitations" section, plus the "Continuous Integration" section (2026-09-09, README compression pass 2). The two are combined here because most of the known limitations below are exactly what CI is built to catch or to route around; wording is unchanged from the source.

- **Windows' case-folding rule is not confirmed** (the primary-source implementation and its commit message disagree). It only narrows down by cross-checking against enumeration results, and never bets on a single rule. See [os-differences.md](./os-differences.md) for details
- **Load average / swap are not available on Windows** (`os.loadavg()` always returns `[0,0,0]`. Recorded as `unsupported`, never reported as `0`)
- **The `live` judgment under `--probe` is a heuristic.** Linking a session to a process only happens when the runtime matches, start times are within 5 seconds of each other, and there's exactly one candidate from both sides. Everything else stays `ambiguous` / `unmapped` (never guessed into one match)
- **Codex-side skill/agent listings, MCP connection status, and API errors are not obtainable even with `--probe`.** There is currently no equivalent structural record obtainable from rollouts without reading conversation content (only claude-code can be observed this way via `--probe`)
- **The version shown in `agent-doctor scan`'s `agent-doctor <version>` banner may be out of sync with `package.json`'s version** (the internal `TOOL_VERSION` constant and `package.json#version` are maintained separately). Check `package.json` or the commit hash to know which build you actually have — don't rely on the banner
- **`test/packaging.test.ts`'s fresh-checkout check auto-skips outside a git working tree** (e.g. somewhere a distributed ZIP was merely extracted). This is by design — a distributed ZIP has no `.git` to compare against. The alternate gate is the CI `release-zip-smoke` job, which actually extracts the ZIP and smoke-tests the CLI
- **`npm run release:zip` depends on the host OS having a `zip` command.** macOS ships with one by default. Windows sometimes doesn't, so CI installs it via `choco install zip` when it's missing (see `.github/workflows/ci.yml`)
- The Doctor itself has no `--fix`. If something feels wrong, start with `scan --coverage` to check whether it's even in scope to be looked at

## Continuous Integration

`.github/workflows/ci.yml` runs two independent gates:

1. **`test`** — `npm ci` / typecheck / build / full `npm test`, on macOS + Windows native, across a matrix of the Node 20 line and the exact version the maintainers develop with.
2. **`release-zip-smoke`** — builds the official runtime ZIP (`scripts/build-runtime-zip.ts`) and smoke-tests the *packaged* artifact (extract → `npm ci --omit=dev` → run the compiled CLI), separately from the source-tree tests in job 1. This is the gate that catches packaging regressions the source-tree tests can't see (a file present in `src/` but missing from the built `dist/`).

This runs as GitHub Actions on every push to `main` and on pull requests — see [github.com/becky-exists/agent-environment-doctor/actions](https://github.com/becky-exists/agent-environment-doctor/actions) for current runs.

**Known, documented skips** (the workflow file's own header comments carry the reasoning for each):

- Linux is not in the OS matrix. macOS + Windows native are the two supported platforms; Linux is unverified and out of scope for v1.0. There is no alternate gate for this — it is genuinely untested.
- `test/packaging.test.ts`'s "fresh checkout from git archive" regression self-skips only when it is not run inside a git working tree (e.g. someone running the tests from an extracted release ZIP, which has no `.git`). Under `actions/checkout` in this workflow it always has a git working tree, so it runs for real in CI. The alternate gate for the ZIP-without-`.git` case is the `release-zip-smoke` job above, which starts from the ZIP itself.
