# bundle-privacy — 由来

他人の環境を診るなら、**持ち出す 1 ファイルに何が混ざりうるか**を先に棚卸ししてから redaction を書く、
という順序のための fixture。「たぶん入っていない」で済ませないための対象物を、混ざりうる場所ごとに 1 つずつ置いてある。

| 仕込んだもの | 置いた場所 | 混ざりうる経路 |
|---|---|---|
| `__PLANTED_ANTHROPIC_KEY__` | `settings.json` の hook command | Finding の `detail.command`、hook 一覧 |
| `__PLANTED_GITHUB_TOKEN__` | memory の**本文** | 本文を読む処理（行数を数える等）から漏れる |
| `__PLANTED_ANTHROPIC_KEY_IN_BODY__` | CLAUDE.md の**本文** | drift の diff 抜粋、evidence の excerpt |
| 顧客名（案件名） | skill 名 / description / project slug | 資源名、パス、`resources_referenced` |
| username `tanaka` | hook command の絶対パス、project slug | パス、slug |

## placeholder にしてある理由

**本物そっくりの鍵をリポジトリに置かない。** これは MIT で配るリポジトリで、走査ツールにも人にも
「本物かもしれないもの」を見せる筋合いは無い。fixture には `__PLANTED_*__` を書いておき、
`test/bundle.test.ts` が一時ディレクトリへ複製したうえで、その場で組み立てた `sk-ant-…` / `ghp_…` の形を差し込む。
検査しているのは**形**なので、これで十分に効く。

**期待値は「1 つも出ない」。** 出たら bundle は書かれない（自己検査で中止する）。
