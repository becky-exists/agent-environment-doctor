# cross-runtime-drift — 由来

実運用環境では Claude Code（`~/.claude/skills/`）と Codex（`~/.agents/skills/`）に同名 skill が 26 組あった。
うち 16 組は normalized_hash が一致、10 組は差分あり。最大は `finish` で 202 行差（Claude 側 2026-09-07 更新 / Codex 側 2026-06-08 のまま）。
この 26 / 16 / 10 は手作業計測と Gate A の実測で一致している（Golden Snapshot `test/golden/phase0-baseline.json`）。

| fixture の要素 | 由来 |
|---|---|
| `finish`（rev 3 vs rev 1） | 上記の最大 drift を最小化したもの |
| `same` | 16 組の「同名・同内容」。drift ではない側の対照 |
| `crlf-twin` | 正規化規則（改行統一・行末空白・末尾空行）が偽陽性を吸収することの対照。`.gitattributes` で `-text` にして CRLF を保っている |

## Doctor が言わないこと

どちらを正本にすべきかは言わない。2 つの版と、どちらが新しいかまで。
