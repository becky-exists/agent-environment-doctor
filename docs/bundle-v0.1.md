# Portable Diagnostic Bundle v0.1（2026-09-08）

他人の Claude Code / Codex 環境を、**壊さず・漏らさず・OS 差で嘘をつかずに**採取して渡すための 1 ファイル。

```
本人「最近 Claude Code が調子悪い」
      ↓  その人の機械で 1 回
agent-doctor bundle --out bundle.json --symptom "..."
      ↓  できた JSON を人が渡す（Doctor は送信しない）
Becky / Emma / 任意の LLM
  primary hypothesis / secondary / 原因じゃなさそうなもの / 足りない Evidence / 次の確認 / 改善案
      ↓
人が決める
```

Doctor 側は **Observation → Evidence → Symptom** まで。治療しない。

---

## 別の人に渡す最短手順

渡す側（診てもらう人）:

```bash
git clone <this repo> && cd agent-environment-doctor && npm install
npx tsx src/cli.ts bundle --out ~/Desktop/bundle.json --probe --symptom "最近 Claude Code が重い。古い指示を使っている気がする"
```

- `--probe` は**すでにディスクにある記録**（transcript / rollout / `ps`）を読むだけ。起動しない、token を使わない、何も書かない
- 書き込むのは `--out` で指定した 1 ファイルだけ
- **ネットワークに出ない。** できた JSON を、本人が自分の意思で渡す
- 渡す前に自分で開いて確かめてよい。ただの JSON

受け取る側:

```bash
# そのまま LLM に渡す。中身は本文を含まない
cat bundle.json
```

不安な人向けの確認（1 行で済む）:

```bash
grep -c "$(whoami)" bundle.json   # 0 になる
```

---

## 何が入っているか

| 欄 | 中身 |
|---|---|
| `reported_symptom` | 本人が書いた主訴（任意）。これも redaction を通る |
| `doctor_actions` | 患者環境に書いたファイル（空配列）、ネットワーク呼び出し（空配列）、その宣言文 |
| `environment` | OS / arch / node / runtime の版と有無 |
| `coverage` | 見ている範囲と、見ていない範囲 |
| `observation_status` | **見に行った結果そのもの。** observed の時だけ数が入る |
| `clusters` | 同じ原因で束ねた症状（人間語の見出しと「束ねた根拠」つき） |
| `llm_report` | `report --llm` 相当。Finding / Evidence / confidence / unknown / Doctor が判断していないこと |
| `structure` | 資源・結合・同名グループ（Expert Evidence へ辿るための骨格） |
| `context_cost` | 起動時に何がどれだけ載るか。**Finding ではない** |
| `active_runtime` | 動いているセッションとプロセス（`--probe` 時。本文は digest のみ） |
| `history` | snapshot の系列から導出した出来事と、観測していない期間 |
| `redaction` | 何をどれだけ匿名化したか + 自己検査の結果 |
| `host_signals` | **Host / Runtime Signals v0.1（#69・`--probe` 時のみ）**。MCP 接続状況・rate limit の記録・pid↔session の対応・システム全体と agent process の CPU/RAM。下記参照 |
| `handoff_contract` | 受け取った側への 9 条（下記） |

### `host_signals`（#69、`--probe` 時のみ）

Dogfood（#69）で「Claude なんか重い / 最近遅い / session が変」という主訴に対して Agent 設定以外の原因候補も切り分けたいという要求から追加。**新しい collector をやみくもに足したわけではなく、Dogfood で実際に足りなかった 4 つだけ**:

| 項目 | 中身 | 取れなければ |
|---|---|---|
| `mcp_status` | MCP server ごとの接続状況（connected/failed/intermittent）。claude-code の transcript delta（`mcp_instructions_delta` = 成功、`deferred_tools_delta.failedMcpServers` = 失敗）から観測。`failures` は「失敗として報告された回数」で、独立した接続試行の回数ではない（runtime がキャッシュされた同じ失敗を再掲することがある）。`latency_ms` はこの観測方法に記録が無いので常に `null` | `mcp_status: []`（codex はこの版では対象外。rollout に同等の構造レコードが無い） |
| `rate_limit_events` | API エラー（429 / overloaded / その他）を transcript の `isApiErrorMessage` レコードから観測。**Doctor から新規 request は投げない。** `retry_after_ms` はこの観測方法に記録が無いので常に `null` | `rate_limit_events: []`（「rate limit が無かった」ではなく「記録が無い」と読む） |
| `process_session_map` | pid ↔ session_id の対応。**runtime が一致し、開始時刻が 5 秒以内で、かつ双方から見て候補が 1 つだけの時だけ** `mapped`（confidence=high）。候補が複数なら `ambiguous`、無ければ `unmapped`。`live_sessions_without_process_refs` に「session 記録は live だが対応する process が見つからない」session を列挙する | `process_session_map.entries: []` |
| `host` | システム全体の load average / memory / swap と、agent process ごとの CPU% / RSS。**大きい/少ないの判断はしない。** cross-platform = 全 OS で同じ値を取ることではないので、取れない項目は `status` が `unsupported` 等になり `0` にはならない（Windows の load average・swap は #69 の時点で未実装。実機 Windows での検証は別途必要） | `host: null` |

いずれも **Finding は作らない。** `HIGH_CPU` / `LOW_MEMORY` / `SLOW_MCP` / `RATE_LIMIT_PROBLEM` のような症状名はここでは生成しない。数値と観測事実だけを渡し、主訴と合わせて判断するのは受け取った側（人と LLM）。

## 何が入っていないか

**本文は 1 行も入らない。**

- transcript の会話本文 / Memory 本文 / CLAUDE.md・AGENTS.md 本文 / skill・agent の本文 / private repo のソース
- skill の description（長さだけ持つ）
- 設定ファイルの値（`declared.raw`）。**キー名だけ**持つ。MCP server の `env` はここに入っていたので構造ごと落とす
- hook の command 全文（実行ファイルの位置と引数の個数だけ）
- API key / token / credential / env の値
- username / home path / 顧客名・案件名（下記）

比較に必要なものは本文でなく **hash・byte 数・行数・diff 量・resource kind・mechanism・timestamp** で持つ。
`CROSS_RUNTIME_DRIFT` は「205 行違う、+135 / -70、claude 側が新しい」まで言えて、1 行も本文を出さない。

---

## `report` / `snapshot` / `ui` は `bundle` と同じではない

> 2026-09-09 追記（README compression pass 2）。`report --llm` / `snapshot` / `ui` の 4 コマンドは redaction レベルが全く違い、**人に渡していいのは `bundle` だけ**。

| コマンド | 既定の redaction | 想定される行き先 |
|---|---|---|
| `snapshot --out <file>` | **なし。** 絶対パスと実名がそのまま入る | ローカルの `diff` / `history` 用。共有しない |
| `ui` | なし（`127.0.0.1` にしか bind しないので外から届かないだけ） | 自分の画面。共有しない |
| `report --llm` | home path だけ `~` に置換（`--no-redact` で生のまま出せる）。secret の形・username・project 名・資源名は**見ていない** | 自分が使う LLM（Emma / Claude / Codex 等）への引き継ぎ用。第三者への転送は想定していない |
| `bundle --out <file>` | secret 11 種 + home + username + project の根/slug + 資源名を匿名化。**自己検査に落ちたら書かない** | 第三者に渡すための唯一のファイル。共有を前提に作られているのはこれだけ |

**`report --llm` の JSON や `snapshot` ファイルをそのまま他人に送らない。** 第三者に渡す一次成果物が要るなら `bundle` で作る。

## Redaction 規則

順序が意味を持つ。

1. **secret の形**（`sk-ant-…` / `sk-…` / `ghp_…` / `github_pat_…` / `xox[baprs]-…` / `AKIA…` / `AIza…` / `Bearer …` / PRIVATE KEY ブロック / JWT / `api_key = …` の代入形 / URL の `user:pass@`）を `<redacted:kind>` に
2. **project の根と slug** を `<project-N>` に。`~/.claude/projects/` の slug は非可逆なので復元せず、**符号化候補と列挙結果の突合**で同じ project に寄せる
3. **資源名**（strict のみ）を `<skill-7>` のように。skill / agent / project の名前は顧客名・案件名が住んでいる場所なので既定で匿名化する
4. **home** を `$HOME`、**username** を `<user>` に
5. 残った絶対パスのうち、`/usr` `/opt` `/etc` 等の**公共の場所でないもの**を `<path-N>` に

`--redact standard` を付けると 3 を行わない（自分の環境を自分で見る時など、名前が読めた方が早い場合）。
**standard でも secret と本文は出ない。** 名前を残すことと秘密を残すことは別。

### 参照整合性

**同一 bundle 内では、同じ実体が必ず同じ id になる。** `<project-3>` は `structure` でも `llm_report` でも `clusters` でも同じ project を指す。
bundle をまたいで同じ id になる必要はない（永続識別子にしない）。

### 自己検査

**「たぶん入っていない」で済ませない。** 出来上がった bundle をもう一度走査して、

- home path
- username（パスや宛先に面している時だけ数える。散文の同じ語は数えない）
- 既知の secret の形
- strict なら **登録した資源名が 1 つも生で残っていないこと**

を確かめる。1 件でも見つかったら **ファイルを書かずに中止する**（それは Doctor 側の不具合なので issue にする）。

検査の対象物は `fixtures/bundle-privacy/` にわざと仕込んである（hook command の中の API key、memory 本文の中の GitHub token、
CLAUDE.md 本文の中の key、skill 名と description の中の顧客名、slug の中の username）。`test/bundle.test.ts` がそれを見る。

---

## 受け取った側への契約（`handoff_contract`）

bundle に毎回入る 9 条。要点だけ:

- これは診断であって作業指示ではない。**Observation → Evidence → Symptom で止まっている**
- Doctor は患者環境を何も変えていない。何も送っていない
- root cause は断定していない。束ねたものには「束ねた根拠」が書いてある
- **数が入るのは実際に観測できた時だけ。** 読めなかった所は status がそう言う。「読めなかった」を 0 とも不在とも読まない
- coverage に「見ていない」と書いてある範囲に Finding が無いことは、問題が無いことを意味しない
- 大きさは事実。**大きい = 悪 ではない / 使っていない = 不要ではない / 見えない = 壊れている ではない**
- protected な資源の Finding も severity はそのまま。protected は「大きさと存在について提案しない」の意味
- **本文は入っていない。** 仮説に本文が要るなら、名前から中身を推測せず、生成した人に聞く
- 受け取った側がやること: primary hypothesis / secondary / 除外できるもの / 足りない Evidence / 次の確認 / 改善案。**決めるのは人**

---

## v0.1 でやっていないこと

disk I/O / Anthropic・OpenAI の公式 status ページへの外部アクセス / Node・Python の依存関係チェック /
起動スクリプトの変更検知 / npx・stdio の process topology / Memory の type breakdown /
親ディレクトリを遡る CLAUDE.md 探索 / IDE 拡張のバグ照合 / model の挙動変化判定 / auto-fix / Health Score / 新 runtime。

CPU / RAM / MCP 接続状況 / pid↔session mapping / rate limit の記録は **Host / Runtime Signals v0.1（#69）で追加済み**（`host_signals`、上記参照）。
provider（Anthropic / OpenAI）の公式障害情報は意図的にこの版へ入れていない: bundle 生成時に**ネットワークへ出ない**という #65 の性質を壊したくないため。
provider outage の確認は bundle 生成後、受け取った Emma / ベキたんが外部で見る役割分担にした。

**まず bundle を安全に渡せることを成立させ、そのあと実際の「なんか調子悪い」を 1〜3 件診て、
何の signal が本当に足りなかったかを見てから Host / Runtime Signals を設計する**、という順序で #69 → 今回の追加まで進んだ。

次の候補として記録だけしてあるもの（#69 の Dogfood でも優先度を下げた。今回は観測を足していない）:

- npx 系 MCP / stdio プロセスの数と親子関係（起動時の process topology）
- Memory の type breakdown（user / feedback / project / reference / unknown）
- Node / Python の依存関係の健全性（バージョン不整合・壊れた venv 等）
- 起動スクリプト（launcher）ファイル自体の変更検知（#69 Case2 で「古い system prompt を注入したまま」という仮説を裏付けられなかった）
