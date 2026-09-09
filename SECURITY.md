# Security Policy

Agent Environment Doctor is a **READ ONLY** diagnostic tool. It observes an AI agent environment (Claude Code, Codex), keeps evidence, and names symptoms. It does not modify, delete, or send anything anywhere on its own. `test/readonly.test.ts` makes the examined environment read-only and runs every command against it to verify that not a single byte changes. That said, a tool that reads config files, session transcripts, and process information across two runtimes has a meaningfully large attack surface, and we take reports about it seriously.

## Reporting a vulnerability

Security vulnerabilities should be reported through GitHub Private Vulnerability Reporting.

This opens a private, maintainer-only report — it is never public by default, and it lets you attach files (logs, a redacted bundle) directly without posting them in a public thread.

- **Do not post vulnerability details in a public GitHub Issue.** Use Private Vulnerability Reporting instead.
- If Private Vulnerability Reporting is somehow unavailable to you, open a note-only placeholder Issue asking to be reached through an out-of-band channel — do not put technical details in that Issue itself.

## Handling reports responsibly

If you're reporting an issue found via this tool's own output (a `bundle`, a raw `report --llm`, or a `snapshot`):

- **Never attach a raw bundle, raw report, or raw snapshot file to a public Issue, PR, or any other public forum.** `bundle --out` is redaction-checked and self-verified before being written, but it is still built from a real environment and is not a substitute for judgment — treat it as sensitive until you've reviewed it yourself. `report --llm` (default redaction only replaces the home path) and `snapshot` (no redaction at all) are **not** meant to leave the machine they were generated on; see the README section "`report`, `snapshot`, and `ui` are not the same thing as the shareable `bundle`" for exactly what each one does and does not redact.
- If a bundle needs to be shared with a maintainer to reproduce a bug, share it through a private channel (not a public Issue), and say so explicitly when you do.
- If you find that a bundle produced by `bundle --out` still contains something that should have been redacted (a home path, a username, a secret shape, a raw resource name under `--redact strict`), that is itself a security bug in this tool — please report it privately using the channel above once available, rather than posting the leaking content publicly to illustrate it.

## What the self-check does and does not guarantee

`bundle --out` runs a self-check after building its output: it re-scans the finished JSON for home paths, usernames, and the shapes of 11 known secret kinds (Anthropic/OpenAI-style API keys, GitHub tokens, Slack tokens, AWS/Google keys, Bearer tokens, PEM private key blocks, JWTs, generic `key: value`-style assigned secrets, and credentials embedded in URLs), and refuses to write the file if it finds any of them.

**This is not a guarantee that zero secrets exist in a bundle.** It is a guarantee that the *known, pattern-matchable* shapes above are checked for and blocked. It cannot catch:

- Secrets in a shape the pattern list doesn't recognize (a new provider's key format, an internal company token scheme, etc.)
- Sensitive information that isn't secret-shaped at all — e.g. a project name, client name, or internal codeword that happens to appear in a resource name (`--redact standard` intentionally leaves resource names visible; `--redact strict`, the default, anonymizes them, but only resource *names* — arbitrary free text is not scanned)
- Anything outside the scope this tool collects in the first place (see the README's "Coverage" section for what is and isn't observed)

If you're about to hand a bundle to someone you don't fully trust, **open the JSON yourself first.** It's plain JSON, not a black box.

## Scope

This tool never sends data over the network by itself (`bundle` only writes to `--out`; there is no telemetry, no phone-home, no update check). Reports about network egress you can observe from this tool that isn't described above are a legitimate security finding.

Reports about the *contents* of an examined environment (e.g. "my CLAUDE.md has a stale rule") are not a security issue in this tool — that's exactly what `scan` / `report --llm` are for. Please use the normal issue tracker for those once it exists.
