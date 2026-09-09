# Size and history (not Findings)

> Moved from the current root `README.md`'s "Size and history (not Findings)" section (2026-09-09, README compression pass 2). This combines the two halves that section originally covered — the `history` command's semantics, and what "protected" means for a resource — since both describe things the Doctor records and narrates but never turns into a verdict. Wording unchanged from the source.

## History

**History** derives events from a series of snapshots. It is not a listing. "When something increased / disappeared / changed / drift began or resolved / a session went stale / a runtime's version changed." Event dates mean "this happened between these two points," and periods that weren't observed are shown explicitly as gaps. Increases or decreases are never treated as good or bad in themselves.

```bash
node dist/cli.js history [--dir snapshots]   # derives when things increased / disappeared / drifted / when a session went stale
```

The bar for "done" isn't "can we build a complete environment model" — it's "can we trust the Findings it reports." Remaining work toward completeness is tracked in Issues, and only gets pulled forward if it's shown to cause a false positive or false negative in an actual Finding (real example: plugin agent definitions. `codex:codex-rescue` turned out to be an agent, not a skill, causing a false positive `missing_target` — so it was added to what's collected).

## What "protected" means

"Protected" stops proposals like "it's big, cut it" or "unused, delete it" — it does not lower the severity of a fact-based diagnosis (e.g. a missing reference target). A Finding on a protected resource keeps its full severity; `report --llm`'s `protected_handling` adds "wholesale changes or removal are not recommended" for it.

Every `scan` lists, under `no findings for:`, **things that are large but were not turned into a Finding** (deferred MCP servers, invisibility that's expected in another runtime's territory, disabled plugins, skills with no invocation record, protected memory). Detectors that had no input to evaluate against show up as `not evaluated`. It never silently passes.

`report --llm` is the shape handed to the LLM doing the fixing (Emma / Claude / Codex — design doc [llm-report-format-v0.1.md](./llm-report-format-v0.1.md)). Each Finding carries fully expanded evidence, affected resources, `doctor_did_not_conclude`, `human_decision_needed`, `unknowns`, prefixed with `doctor_actions` (the Doctor changed nothing) and a `handoff_contract`. **It never writes the fix itself.** Just what happened, why it was judged that way, and how confident it is.
