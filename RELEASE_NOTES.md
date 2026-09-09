# Agent Environment Doctor — Release Notes

## 1.1.1

Fixed a privacy defect in `bundle`: when the diagnosed project directory was located **inside the home directory**, the project's real folder name could survive redaction — at `--redact strict` as well — and the bundle's own self-check still reported `passed`. Reported by a third-party reviewer who ran v1.1.0 on their own Windows environment; reproduced here on macOS before fixing. If you generated a bundle from a project under your home directory with 1.0.0–1.1.0 and shared it, that bundle may contain the project's folder name. No file contents, secrets, usernames or home paths were affected; the leak was limited to the project directory name.

Three paths were involved, each one a form of the project path that was never a substitution key. The first was the reported one; the other two were found while verifying the fix, one on the author's own environment and one on the Windows CI runner:

- Report text is folded to `~/…` before redaction, but project substitution only matched the absolute path. The folded form passed through untouched, and the later `~` → `$HOME` step turned it back into `$HOME/<real name>/…`.
- A project with no memory directory under `.claude/projects` never had its encoded slug candidates registered, so the real name survived inside the "could not be narrowed down (tried: …)" explanation.
- On Windows, where the collected home and a resource's resolved `real_path` can spell the same directory differently (short name vs long name), neither the home nor the project key matched. A later substitution then split the path in two, and the last-resort absolute-path pass stopped at that marker instead of swallowing the rest. The last net now spans placeholders it produced itself, and separator variants (`\` and `/`) of the project root are registered as keys.

Also in this release:

- `redaction.projects_anonymised` now counts projects **whose name was actually replaced**, not ids that were merely assigned. The new `redaction.project_ids_assigned` field carries the previous meaning. In the reported case the old field read `1` while nothing had been replaced.
- The bundle self-check now verifies the project roots and slugs that `redaction.rules[]` promises to remove, matching them as whole tokens so that both `$HOME/<name>/…` and slug-encoded `-Users-<user>-<name>` forms are caught. Project names that collide with structural directory names or with the Doctor's own prose vocabulary are still replaced but are deliberately not used as self-check needles, to keep the check free of false alarms.

Worth recording: on the third path, the new self-check did its job — it named the leaking field and the bundle would have been refused rather than written. Failing closed is what it is for.

Regression coverage: 10 new tests pin the reported reproduction, all three leak paths, the honesty of the summary counters, the self-check's ability to catch the pre-fix output, and its silence on the Doctor's own prose. Full suite 201 passing / 1 skipped, green on macOS and Windows across Node 20 and 24.

## 1.1.0

Added npm/npx as an additional distribution channel (`npx agent-environment-doctor@latest`), alongside the existing Release ZIP, which remains fully supported. The npm package ships only `dist/`, `README.md`, and `LICENSE` — the same runtime, none of the repo's dev/test/docs files. Also closed two zero-file-discovery gaps in the build pipeline: the test runner and the build-asset copy step could each silently report success while finding nothing to run or copy.

## 1.0.1

Fixed a READ ONLY contract violation in Codex runtime detection. The Doctor previously invoked `codex --version`, and the Codex CLI could create temporary files under `$CODEX_HOME` as a side effect. Version detection no longer executes the Codex CLI, and regression coverage now verifies subprocess-induced patient writes.

## 1.0.0

Diagnose the effective runtime state of AI agent environments (Claude Code, Codex). READ ONLY.

### Supported

- **OS**: macOS, Windows (native). Linux/WSL are not supported in this release.
- **Runtimes**: Claude Code, Codex.
- **Node.js**: `>=20`. Tested against Node 20 (oldest supported major) and Node 24.14.1 (the version this project is developed against) on both macOS and Windows native CI.

### Tested environment

- Native CI (GitHub Actions): macOS + Windows, Node 20 + 24.14.1 — `npm ci` / typecheck / build / full test suite (191 tests) + a separate release-zip smoke gate that extracts the built runtime ZIP and exercises the compiled CLI. All green.
- Manual RC acceptance on a fresh macOS machine and a fresh Windows machine (with an existing Codex install and rollout history), each using the identical release ZIP and SHA-256, following only the README: checksum verify → extract → `npm ci --omit=dev` → `scan` / `scan --probe` / `report --llm` / `snapshot` + `diff` + `history` / `bundle --redact strict` (self-check) / `ui`. Patient environment files were hashed before and after every run and confirmed byte-identical.
- A controlled adversarial test of the privacy self-check (synthetic secrets only, no production code changed): confirmed the self-check independently detects leaked secret shapes, and that on failure the CLI exits non-zero and does not write the requested output file.
- 1.0.0 is a version-only step up from 1.0.0-rc.2 — the compiled `dist/` payload, README, and LICENSE are byte-identical between the two release ZIPs; only `package.json`/`package-lock.json`'s version field changed. A minimal smoke pass (version banner, `scan`, `bundle --redact strict` self-check, runtime asset presence) was re-run against the final 1.0.0 ZIP.

### Privacy / strict bundle

- `bundle --out <file>` is the only artifact meant to leave the machine. It anonymizes 11 known secret shapes (API keys, tokens, private key blocks, credentials in URLs, etc.), the home directory, the username (including case/separator variants), project roots and slugs, and — at `--redact strict` (the default) — resource names (skill/agent/project names).
- The bundle is self-checked before it is written: the finished bundle is walked again independently of the redaction pass, and if anything resembling a secret, the home path, or the username is still present, the write is aborted (non-zero exit, no file written). This check does not reuse the redactor's own code path.
- `report --llm` and `snapshot` are not the shareable artifact — they are meant to stay on the machine that generated them. `report --llm`'s default redaction only replaces the home path; `snapshot` has no redaction at all.

### READ ONLY

The Doctor only reads. It never writes into the examined environment, never launches an agent session, never makes a network call. `--out`/`--dir` targets that would collide with an existing file in the examined environment are refused (exclusive create) rather than silently overwritten.

### Windows-specific unsupported areas

On Windows, some signals that are available on macOS are reported as `unsupported` rather than silently omitted or reported as zero:

- Host load average
- Swap usage
- BSD-style `ps` process inspection

A permission-denial regression test (`chmod 0o000` to simulate an unreadable directory) is skipped on Windows because NTFS's permission model doesn't map onto POSIX `chmod` the same way; an OS-independent equivalent test covers the same contract instead.

### Known limitations

- Linux/WSL, a standalone binary, and npm/npx registry distribution are explicitly out of scope for v1.0.
- There is no `--fix` and none is planned — the Doctor observes and reports; a human or an LLM the human is using decides what, if anything, to change.
- Coverage of what is and isn't collected is intentionally scoped; see the README's "Coverage" section for the current boundary.

### Update / rollback

There is no in-place auto-update. To update: extract the new version's ZIP into a **separate** directory, run `npm ci --omit=dev`, verify it works, then switch over. Keep the old version's directory around so you can roll back immediately by pointing back at it — nothing is deleted or overwritten in place.

### Checksum

Verify the ZIP before use:

```bash
shasum -a 256 -c agent-doctor-runtime-1.0.0.zip.sha256   # macOS
sha256sum -c agent-doctor-runtime-1.0.0.zip.sha256       # Windows (Git Bash) / Linux
```

`agent-doctor-runtime-1.0.0.zip` — SHA-256: `0585343b4fff56eb130a68fe72d46909e365e753966a5896f2d186eade2966a7`
