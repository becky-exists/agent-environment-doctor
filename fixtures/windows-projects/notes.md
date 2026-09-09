# windows-projects — 由来

`~/.claude/projects/<slug>` の符号化規則が OS で違うことで、**Windows で memory が静かに 0 件になっていた**（#64）。
これは inspector が 2026-06-26 に踏み、Doctor にもそのまま残っていたバグ。Mac で開発している限り絶対に現れない。

| fixture の要素 | 何を守るか |
|---|---|
| `c--users-foo-bar-gsd` | 一次情報の**コード**の規則（`/ \ : .` を `-` にして全体 lowercase）。drive letter・`.` を含む username を含む |
| `c--Users-Foo-Bar-Mixed` | 一次情報の**コメント / コミットメッセージ**の規則（drive letter だけ lowercase）。実装と食い違っている |
| `-Volumes-SSD2TB-posix-project` | Mac / Linux 規則（大文字が残る）。片方の規則で他方を落とさない |
| `d--data-no-memory` | memory を**持たない** project。「無い」と「読めなかった」を混同しないための対照 |

## なぜ 1 本の slug に決めないのか

一次情報（`claude-config-inspector` commit b48baf6）で **実装とコミットメッセージが食い違っている**。

```
コード:       cwd.replace(/[/\\:.]/g, '-').toLowerCase()   → c--users-foo-bar-gsd
メッセージ:   C:\Users\foo.bar\gsd → c--Users-foo-bar-gsd  （Users の U が大文字のまま）
```

どちらが実際の Claude Code の挙動かは、Windows 機で `~/.claude/projects` を列挙するまで確定しない。
だから Doctor は **候補を複数出して列挙結果と突き合わせる**（`src/ir/slug.ts`）。
突合できなかった時は 0 件として黙らず、`access` に突合失敗として残す。

**列挙が正。符号化は絞り込みだけ。符号化は非可逆なので、slug から元パスを復元しない。**
