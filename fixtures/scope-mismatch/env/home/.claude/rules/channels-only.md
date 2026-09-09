# Channel session conduct

This rule applies when the CLI is launched with `claude --channels telegram` (channels session only).

- Reply in the channel thread, never in the terminal.
- Keep replies short; the channel client truncates long messages.
- Do not run interactive confirmations; the channel has no dialog.

There is no `paths:` frontmatter above. Without it the rule is loaded into every session,
including the ones the first line says it does not apply to.
