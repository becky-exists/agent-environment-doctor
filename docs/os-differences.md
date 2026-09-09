# OS differences — enumeration is truth, encoding only narrows down

> Moved verbatim from the current root `README.md`'s "OS differences — enumeration is truth, encoding only narrows down" section (2026-09-09, README compression pass 2). No wording changed from the source.

The encoding rule for `~/.claude/projects/<slug>` differs by OS (`/Volumes/SSD2TB/foo` → `-Volumes-SSD2TB-foo` vs. `C:\Users\foo.bar\gsd` → `c--…`). The old implementation only had the Mac rule, and **Memory would silently come back as 0 on Windows**.

The fix isn't "add one more rule for Windows."

- **Enumeration is treated as ground truth.** A scan always starts from `readdir`. Encoding cwd → slug is only used to narrow down to "just the current project"
- **Encoding is non-reversible**, so the original path is never reconstructed from a slug (a `-` in the original path would break it)
- Windows' case-folding rule is **not confirmed** (the primary-source implementation and its commit message disagree). So it **doesn't bet on one rule — it produces candidates and cross-checks them against enumeration results**. On Windows, the cross-check is case-insensitive
- When the cross-check fails, it **never goes quiet as a count of zero — it's recorded as a failed cross-check, and narrowing is abandoned**
- Memory / project path extraction is separator-agnostic (`[/\\]`). A hardcoded `/` matched nothing on Windows and silently drove cost to 0

The rule is now unified in `src/ir/slug.ts` (it used to be duplicated across `probe/transcript.ts` and `observe/context-cost.ts`). A Windows-format project tree lives in `fixtures/windows-projects/` and runs in Mac CI.

## Related, platform-specific behavior tracked elsewhere

These are the other Windows-vs-macOS differences the Doctor has to be honest about. Each one is also listed in [troubleshooting.md](./troubleshooting.md) as a known limitation:

- Windows load average and swap are `unsupported`, never reported as `0` (`os.loadavg()` always returns `[0,0,0]` on Windows) — see [coverage.md](./coverage.md)
- `test/packaging.test.ts`'s fresh-checkout regression self-skips outside a git working tree, which matters for anyone testing from an extracted ZIP rather than a clone
- `npm run release:zip` depends on the host having a `zip` command; Windows CI installs one via `choco install zip` when it's missing
