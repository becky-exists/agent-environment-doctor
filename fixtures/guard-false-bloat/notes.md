# guard-false-bloat — 由来

**期待値は `findings: []`。この fixture が 1 件でも Finding を出したビルドは、他が全部通っていても不合格。**

実運用環境で「数が大きい」「使っていない」「見えない」のに問題ではなかったものを集めた。

| fixture の要素 | 由来 | 守る原則 |
|---|---|---|
| MCP server 12 本 | 実環境の MCP tool 141 本。deferred で固定費ほぼゼロ | 数が大きい = 悪 にしない |
| `MEMORY.md`（約 49 KB） | 実環境の MEMORY.md 25,798 B。identity として protected | 重い = 悪 にしない |
| `never-fired` | 3 か月発火ゼロの skill 群 | 使ってない = 不要 にしない |
| `codex-only` / `claude-only` | `discovered=false` 73 件のうち 72 件は他 runtime の領域に在るだけだった | 見えない = 異常 にしない |
| `retired@fixture-marketplace`（enabled=false） | Codex 側に `vercel` plugin の `enabled = false` が残っていた | 墓標は Phase 2 の Observation。自己宣言は参照ではない |
| SessionStart hook 1 本 | 正常な hook 登録 | 登録されている = 増幅 ではない |

## `ir_preconditions` の意味

Finding が未実装の今は、Finding を出さないことを直接は検証できない。
代わりに「Finding 側が見るであろう IR の事実」を固定し、IR の側でこれらが**正しく Observation として表現されている**ことを回帰で押さえる。
Finding が入った時点で `findings: []` の検証を追加する（`test/fixtures.test.ts` にその場所を空けてある）。
