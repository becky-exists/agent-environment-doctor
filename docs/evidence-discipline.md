# Evidence discipline

> Moved from the current root `README.md`'s "Evidence discipline" section and "Never reporting 'couldn't get it' as a count of zero" section (2026-09-09, README compression pass 2). Wording unchanged from the source; the two sections are combined here because both describe the same discipline — a Finding's evidence must trace back to a real, honestly-labeled observation, never to a guess or a silently-swallowed failure.

## The rule

- Every Finding carries `evidence_refs`. An empty one is not allowed. "Looked but found nothing" is kept as an `absence`, listing every place that was checked
- Anything that can't be determined statically is marked `confidence: probe_required`. No guessing
- Different measurement methods are kept as separate, coexisting observations (no crude `chars/4` token estimate — it's off by 2–3x for Japanese)
- **Every report declares its observation scope up front.** The default is "the next session you launch." A session already running keeps the state it started with. Dropping this declaration looks like a misdiagnosis — "I fixed it and nothing changed"

## Never reporting "couldn't get it" as a count of zero

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
