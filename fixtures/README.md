# fixtures — 1 fixture 1 症状の最小環境

実環境をコピーしない。各 fixture は `env/home` を HOME に差し替えて実行する合成環境で、
症状 1 つと、その対照例（偽陽性を検出するための正常ケース）だけを含む。

```
fixtures/<name>/
  env/home/…      HOME として差し替える。~/.claude, ~/.agents, ~/.codex を必要な分だけ
  expected.json   期待値（下記スキーマ）
  notes.md        由来。パス名・skill 名は書く。人格・記憶の中身は書かない
```

実行:

```bash
npx tsx src/cli.ts collect --home fixtures/<name>/env/home --project
npx tsx src/cli.ts gate-a  --home fixtures/<name>/env/home --project
npx tsx src/cli.ts collect --home fixtures/scope-mismatch/env/home --project --launcher fixtures/scope-mismatch/env/home/bin/start.sh
#   --project を値なしで渡すと project scope 無し（cwd を読まない）
#   CODEX_HOME / CLAUDE_CONFIG_DIR は unset にして走らせる
```

## 4 本

| fixture | 症状 | 期待 |
|---|---|---|
| `unreachable-reference` | 発見される場所に発見されない形で置かれた skill / 参照先が無い skill 参照 | `UNREACHABLE_REFERENCE` ×2（undiscovered_declaration / missing_target） |
| `cross-runtime-drift` | 同名 skill が runtime 間で内容違い | `CROSS_RUNTIME_DRIFT` ×1（`finish`）。`same` / `crlf-twin` は出ない |
| `scope-mismatch` | 起動条件を本文に書いた rule が `paths:` 無しで常時ロード | `SCOPE_MISMATCH` ×1。`family-scope` は出ない |
| `guard-false-bloat` | 数が大きい / 使っていない / 見えない / 墓標 | **`findings: []`**。ここが落ちたら他が全部通っても不合格 |
| `session-staleness` | 設定と、動いているセッションの状態の食い違い | `SESSION_STALENESS` ×3（capability_present_but_unconfigured ×1 / resource_changed_after_start ×2）+ 同じファイルへの静的 `UNREACHABLE_REFERENCE` ×1。自分自身のセッションと名前衝突は出さない |

## expected.json スキーマ（`agent-doctor-fixture-expectation/1`）

| キー | 意味 |
|---|---|
| `home` / `project` / `runtimes` | 実行条件。`~` は `env/home` に展開して比較する |
| `findings[]` | 将来の Finding runner が出すべきもの。`finding_id` / `subtype` / `severity` / `confidence` / `subject` / `evidence_must_include[]` / `why` |
| `no_findings[]` | 出してはいけないもの。`path` / `name` / `reference`（この raw 文字列を missing_target にしない）のいずれかで指す。**必ず `why` を書く**（何の原則を守るための対照か） |
| `ir_preconditions[]` | Finding 未実装の今、IR がすでに満たしているべき事実。`test/fixtures.test.ts` が実データで検証する |
| `launchers[]` | fixture ディレクトリ相対の起動スクリプト。`CollectContext.launchers` / CLI `--launcher` に渡す。明示分だけ収集する |
| `probe` | active runtime も観測する fixture。`live_window_minutes` を 10 年等にしてチェックアウト時刻に依存させない。`self_session` で Doctor 自身のセッションを指定する |

`evidence_must_include` は「Finding の evidence_refs にこの型・この値を含むこと」。全列挙ではなく最低限。
`findings[].must_not_contain` は summary 文に出してはいけない語（「削除」「どちらが正本か」等）。

## 規約

1. 実環境をコピーしない。1 fixture 1 症状
2. 対照例を必ず入れる（発見される skill / 同一内容の skill / `paths:` 有りの rule）
3. `guard-false-bloat` の期待値は `findings: []`
4. `notes.md` に由来を書く。パス名と skill 名は書いてよい。人格・記憶の中身は書かない
5. 説明文に `~/…` を書かない（path_ref として拾われ、guard fixture に偶発的な参照が混ざる）
6. `.gitattributes` の `* -text` を外さない（`crlf-twin` の CRLF が checkout で潰れる）
7. セッション記録を置く fixture は `probe.live_window_minutes` を大きく取る。ファイルの mtime は checkout 時刻になるので、実時間に依存させない
