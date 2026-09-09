# Agent Environment Doctor v0.1 — Design Review

> 状態: **設計のみ。実装判断は未**。2026-09-07 起草（ゆう構想 → ベッキー設計）。
> **rev.2 (2026-09-07, ゆう修正反映)**: ①4 軸を Presence/Activation/Provenance/Temporal に再定義し、Cross-Agent Drift を軸から Finding へ降格 ②保存形式を Graph から **Resource / Binding / Observation / Snapshot** の 4 種の事実データへ。Graph は分析時に生成 ③`SESSION_STALENESS` を正式な診断項目に昇格
> Phase 0 の実装指示は [phase0-implementation-handoff.md](phase0-implementation-handoff.md)。
> 姉妹文書: [failure-patterns-v0.1.md](failure-patterns-v0.1.md)（14 パターン、全て実測実例つき）
> Vehicle: 未決（Vibe-Guard と同じ IW 直営 OSS が自然だが、ゆう判断待ち）

## 0. 一行

**Installed State ではなく Effective Runtime State を診断する、READ ONLY の agent 環境ドクター。**

## 1. なぜ作るか

エージェント環境のカスタマイズを長く続けると、Skill / Plugin / MCP / hook / CLAUDE.md / AGENTS.md / Memory / Agent 定義 / rules / 共有 skill が積み上がる。**「何が入っているか」は分かるのに「今実際に何が効いているのか」が分からなくなる。**

2026-09-07 に BECKY 環境（Claude Code 2.1.263 + Codex）を人手で棚卸しして、実際に出たもの:

| 症状 | 実測 |
|---|---|
| 80 日間発見されていなかった skill | 平置き `.md` 13 本（loader は `<dir>/SKILL.md` のみ読む） |
| 存在しない plugin への参照 | `vercel:*` を agent 定義が 4 行 + Codex 側 `.toml` にも複製 |
| agent 環境間の版ズレ | 同名 skill 26 本中 10 本が内容差分。最悪 `finish` が diff 202 行 |
| scope の取り違え | `--channels` 専用の rule が全セッションに常時ロード（約 1,200 token） |
| hook の増幅 | 同一 5,322 B を SessionStart + SubagentStart に注入、88% のセッションで適用対象なし |
| 数は多いが実害なし | MCP 141 tool は deferred で固定費ほぼゼロ（**削ってはいけない**） |
| 重いが保護対象 | `MEMORY.md` 25,798 B は identity なので削減禁止 |

**この 7 つを人が半日かけて手で見つけた。** 全部、機械的に検出できる形をしている。

## 2. 芯（4 軸）

観測の軸はこの 4 本。**症状（Finding）ではなく、症状を導くための観測次元**。

| 軸 | 問い | 何を観測するか |
|---|---|---|
| **Presence / Reachability** | それは存在して、**実際に agent から使えるのか** | 宣言の実在 / loader の discovery 規則を通るか / 参照先が解決するか |
| **Activation / Scope** | **いつ、誰に、どの条件で**効くのか | 常時 / 条件付き / 遅延 / never。session か subagent か。`paths` 等の条件 |
| **Provenance / Lineage** | **どこから来て、何経由で**注入・参照されているのか | settings → plugin → hook → stdout の注入連鎖。どの宣言がどれを参照しているか |
| **Temporal State** | **いつ追加・変更・使用され、どう変化したか** | mtime / content hash の変遷 / usage / snapshot 間の差分 |

### 軸ではなく Finding に置くもの

`CROSS_RUNTIME_DRIFT` / `SCOPE_MISMATCH` / `HOOK_AMPLIFICATION` / `CONTEXT_TAX` は**軸から導出される症状**であって観測次元ではない。

理由: drift を軸に据えると、**単一 runtime しか使っていない環境で軸が 1 本死ぬ**。drift の実体は「同じ Resource が複数の Binding を持ち、Observation が食い違っている」という導出結果なので、4 軸（Presence × Provenance × Temporal）の交差から出る。同じく scope mismatch は Activation から、hook amplification は Activation × Temporal から、context tax は Activation × Observation から出る。

### 既存 OSS に対する位置（§3 で確定）

| 軸 | 既存の状況 |
|---|---|
| Presence / Reachability | **空白**。コミュニティ製は「ファイルが存在するか」止まり。到達性判定（loader が読むか / 参照が解決するか）は未確認 |
| Activation / Scope | **空白**。条件付きロードや subagent 継承を扱うものは未確認 |
| Provenance / Lineage | **空白（確定）**。該当ツールなし |
| Temporal State | 部分的にある。skill の usage は公式 `/skill-doctor` が実測、時系列は cclens / context-analyzer。**構成そのものの差分は空白** |

## 3. 既存 OSS の扱い

> 調査完了（2026-09-07、マイケル 2 名の実測 + 公式仕様確認）。判定根拠は「ライセンス / 最終更新 / Installed か Effective か」。

### 3.1 判定の枠

| 区分 | 意味 | 扱い |
|---|---|---|
| **依存として使う** | ライブラリ or 安定した機械可読出力があり、その領域を任せられる | サブプロセス起動 or import。optional dependency にして無ければ自前 fallback |
| **思想だけ参考** | ライセンスが再利用に不適 / 設計が合わない。診断項目や severity の考え方だけ借りる | 参考文献として明記。コードは書かない |
| **コード再利用** | MIT/Apache で、特定ロジック（parser 等）を取り込める | 出典とライセンス表記を残して取り込む |
| **自前実装** | 空白地。ここが本プロジェクトの存在理由 | v0.1 のスコープ |

### 3.2 調査結果（2026-09-07 実測、マイケル 2 名 + 公式仕様確認）

#### A. 依存にできない / 競合しない（判定済み）

| プロジェクト | license | star | 最終 push | Installed / Effective | 判定 |
|---|---|---|---|---|---|
| **cclens** `lambdalisue/cclens` | **なし（LICENSE 不在、API も null）** | 87 | 2026-09-05 | Effective（発火実績） | ⛔ **依存不可。ライセンス未設定＝使用権不明**。思想のみ参考 |
| `millionco/claude-doctor` | なし | 617 | 2026-04-15 | セッション診断（用途違い） | 対象外 |
| `robonuggets/doctor-plus` | CC-BY-4.0 | 70 | 2026-07-31 | Installed（SKILL.md 単体、実装コードなし） | 競合せず |
| `SomeStay07/claude-doctor-skill` | MIT | 11 | 2026-02-26 | Installed（46 チェック全て `ls`/`grep` の存在確認） | 競合せず |
| `amaljithkuttamath/skill-doctor` | MIT | — | — | Installed（Glob で SKILL.md 列挙 → LLM 判定。使用頻度・token 実測なし） | 競合せず。診断項目は参考 |

**cclens のライセンス欠落は本プロジェクトの方針を変えた。** §3.3 の旧方針「token 会計を cclens に寄せる」を撤回する。あわせて cclens の token 推定は**ハイブリッド**（実行時は API usage report の実測、config 側は `src/adapter/config.rs` で `chars/4` のハードコード概算）と判明。日本語環境で 2〜3 倍ずれる原因がこれ。README にも「static cost is a token estimate, not a measured runtime figure」と明記されている。

#### B. 公式が既に埋めている（作らない）

| 機能 | 診断内容 | 判定 |
|---|---|---|
| **`/skill-doctor`**（built-in, v2.1.252+） | **skill ごとの token コストと使用頻度を実測**（7 日窓）。未使用 skill / plugin を検出 | ⛔ **P8 の skill 部分は作らない。** 公式に譲る。本プロジェクトは skill 以外（hook / instruction / rule / MCP）と cross-agent に絞る |
| **`claude plugin eval --ablation with-without`** | plugin を実走させ、**plugin 無しベースラインとの差分**を測定。`tool_used: Skill` grader で発火の有無を判定。`--json` あり | 🔄 **P7（hook-amplification）の実効コスト測定に転用できる可能性。** v0.2 の probe 手段の第一候補 |

⚠️ 命名衝突: `claudeskills.info` が紹介する「skill-doctor プラグイン」は `amaljithkuttamath/skill-doctor` と同一実体で、**公式 built-in の `/skill-doctor` とは別物**。ドキュメントで区別を明記する。

#### C. 依存 or コード参考の候補（MIT）

| プロジェクト | license | star | token 算出 | Claude+Codex | 判定 |
|---|---|---|---|---|---|
| **`auditt98/context-viewer`** | MIT | 6 | **tiktoken 実測**（`cl100k_base`、「no chars/4 estimates」と明記） | ✅ **両対応**（Codex CLI / Cowork、OS 別セッションディレクトリ自動検出） | ✅ **estimator の手法をコード参考**。web app only でライブラリ化なしなので import は不可 |
| **`manavgup/context-analyzer`** | MIT | 16 | **API 応答実測**（input/output/cache_read/cache_creation） | ✅ 両対応（Codex セッションも同ダッシュボード） | ✅ History 軸の参考。hook + SQLite + dashboard 構成 |
| `destilabs/mcp-doctor` | MIT | 16 | — | 判定モデル選択のみ（環境対応ではない） | MCP 接続診断は任せる |
| `realwigu/mcp-doctor` | MIT | 3 | — | エディタ横断（Codex CLI 対応は未確認） | 同上 |

**`chars/4` 問題は context-viewer が既に解いている**（tiktoken 実測）。本プロジェクトの estimator はこの手法に寄せる。ただし両者とも web app / dashboard でライブラリ公開が無いため、**コードの取り込みではなく手法の参考**にとどまる。

#### D. 空白地（本プロジェクトの存在理由、2 名が独立に確認）

1. **agent 環境間の設定 drift 検出** — Claude Code / Codex 向けの同種ツールは確認できず（インフラ向け config drift ツールしかヒットしない）
2. **capability の到達性判定** — 「存在するが loader が読まない」「参照先が存在しない」を機械的に出すもの
3. **provenance chain** — 注入経路を settings → plugin → hook → stdout まで辿るもの
4. **MCP tool schema の token コスト定量** — mcp-doctor 系は description の明瞭さとセキュリティを見るが、schema 自体の消費量は測らない
5. **hook の健全性診断** — 登録済みだが発火しない / 意図と違う挙動。context-analyzer は hook イベントを記録するが hook 自体の診断はしない
6. **doctor 系と skill-doctor 系の横断** — 両者は分立しており、「この環境で今実際に効いている自動化は何か」を横断で見るものは未確認

### 3.3 確定方針（調査反映後）

| 領域 | 方針 | 変更 |
|---|---|---|
| skill の token コスト・使用頻度 | **公式 `/skill-doctor` に譲る**。本プロジェクトは出力を引用するか、無ければ自前 fallback | 🔄 新規（公式の存在が判明） |
| token 会計全般 | **cclens に寄せない**（ライセンス不明）。estimator は tiktoken 方式を自前実装、手法は context-viewer 参考 | 🔄 **旧方針を撤回** |
| MCP 接続診断 | 作らない。mcp-doctor 系に任せる | 変更なし |
| MCP schema の token コスト | **自前**（空白地 4） |  新規 |
| skill frontmatter の妥当性検証 | コミュニティ skill-doctor 系 / `skill-creator` の validate に任せる | 変更なし |
| **到達性判定・provenance・cross-agent 突合・snapshot 差分** | **自前。ここが本プロジェクト** | 変更なし |
| Effective の確定手段 | `claude --debug --debug-file` の JSON payload を第一候補にする（`/context` 等は interactive で機械可読出力なし、統一 JSON export CLI は存在しない） | 🔄 新規 |

### 3.4 公式仕様として確認できたこと（adapter の根拠）

`discoveryRules()` に焼く根拠。**出典は公式ドキュメント**（`code.claude.com/docs/en/`）。

| 規則 | 確認 | 支える failure pattern |
|---|---|---|
| skill は `<dir>/SKILL.md` のみ。frontmatter 必須 | ✅ 公式（skills.md § Discovery Locations） | **P1** |
| 探索優先度 Enterprise > Personal > Project > Plugin > Bundled | ✅ 公式 | P12 |
| **`~/.agents/skills/` は探索対象外** | ✅ 公式 | **P3 の原因** |
| rule は `paths:` があれば条件付き、**無ければ常時ロード** | ✅ 公式（memory.md § Path-specific rules） | **P6** |
| CLAUDE.md は Managed > User > Project > 親遡り の順で**連結**（上書きでない） | ✅ 公式 | 固定費算出 |
| **SubagentStart は parent の CLAUDE.md / auto memory を継承しない**（session_id / permission_mode / effort のみ継承） | ✅ 公式（memory.md） | **P7 の根拠** |
| hook は matching 分すべて並列実行、exit 2 が最も restrictive として勝つ | ✅ 公式（hooks-guide.md） | P7 |
| 無効化 plugin の skill / MCP tool / hook はセッションに load されない | ✅ 公式（plugins.md） | P2 / P5 |
| **plugin 無効化の mid-session 反映は公式未明記** | ⚠️ 不明 | **P14（自己観測が唯一の根拠）** |
| deferred stub の制御フラグ名（`tengu_*`）は**非公開・未文書** | ⚠️ 内部実装 | **P9（flag 名をハードコードしない根拠）** |
| `/context` `/doctor` `/mcp` `/hooks` `/skills` `/skill-doctor` は**すべて interactive、JSON export なし** | ✅ CLI 実測 | L3 probe の設計制約 |
| 機械可読の唯一の経路は `claude --debug --debug-file <path>` | ✅ CLI 実測 | L3 probe の実装手段 |

未検証（実測が必要、v0.1 では `confidence` を下げて扱う）: hook イベントの正確な総数（報告では 44 だが未検証）、settings precedence の競合時の実挙動、SubagentStart 非継承の実測確認。

## 4. アーキテクチャ

```
                   ┌──────────────── adapters ────────────────┐
                   │  claude-code            codex            │
                   │  (settings.json,        (config.toml,    │
                   │   CLAUDE.md, skills/,    AGENTS.md,      │
                   │   plugins/, rules/,      agents/*.toml,  │
                   │   agents/*.md,           hooks.json,     │
                   │   .claude.json)          plugins/)       │
                   └──────────────┬───────────────────────────┘
                                  │
             ┌────────────────────▼────────────────────┐
             │  L1 static    宣言を読む（存在の列挙）    │
             │  L2 derived   discovery 規則を適用し     │
             │               到達性 + provenance を付す │
             │  L3 probe     実起動 / hook dry-run で   │
             │               Effective を確定（opt-in） │
             └────────────────────┬────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │  Resource / Binding /      │
                    │  Observation / Snapshot    │  ← 4 種の事実データ（runtime 非依存）
                    └─────────────┬─────────────┘
                                  │
          ┌───────────────────────▼───────────────────────┐
          │  analyzer: rule pack（P1〜P14 detector）       │
          │  protected filter → static → cost → guard     │
          └───────────────────────┬───────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │  reporter: JSON / text     │
                    │  + snapshot 保存 / 差分     │
                    └────────────────────────────┘
```

### 4.1 3 層 collector の役割分担

| 層 | 何をする | 副作用 | v0.1 |
|---|---|---|---|
| **L1 static** | 設定ファイル・マニフェスト・宣言ファイルを読み、存在する項目を列挙 | なし | ✅ |
| **L2 derived** | 各 adapter の **discovery 規則**を適用して到達性を判定し、**provenance chain** を組み立て、固定費を推定 | なし | ✅ **ここが芯** |
| **L3 probe** | 実際に 1 セッション起動して「context に X があるか」を自己申告させる / hook を dry-run して stdout バイト数を測る | **あり**（token 消費、hook の副作用） | ❌ v0.2、既定 off |

**L3 の根拠と手段の優先順位**: Effective の最終確定は probe しかない（`/context` 等の診断コマンドは全て interactive で JSON export が無く、統一の機械可読 CLI は存在しない）。手段は 3 つあり、**安い順に試す**:

| 手段 | コスト | 得られるもの | 備考 |
|---|---|---|---|
| **1. `claude --debug --debug-file <path>`** | token ほぼゼロ | debug log の JSON payload。**機械可読の唯一の公式経路** | 第一候補。ログのスキーマは未検証（要実測） |
| **2. `claude plugin eval --ablation with-without --json`** | 中（実走する） | plugin 有無のベースライン差分、`tool_used: Skill` grader による発火判定 | P7 の実効コスト測定に転用できる可能性 |
| **3. `claude -p` で自己申告させる** | 小（1 問分） | 「context に文字列 X があるか」の YES/NO | 2026-09-07 に実際にこれで確定させた（新規セッション 3 本）。最後の手段 |

既定 off、`--probe` で opt-in。hook dry-run は allowlist 制（ponytail の activate はフラグファイルを書いた＝**副作用が実測されている**）。

### 4.2 保存形式 — 4 種の事実データ（Graph は保存しない）

**原則: 保存するのは地味で壊れにくい事実。分析するときに Graph として見る。**

Graph をそのまま永続化すると、runtime のバージョンアップで discovery 規則が変わった時に Resource の記録まで書き換わってしまう。3 つの寿命が違うので分ける。

| 種類 | 寿命 | 何で決まるか | 例（skill の場合） |
|---|---|---|---|
| **Resource** | 内容が変わるまで持続 | content hash | skill そのもの。パス、hash、owner、抽出した参照文字列 |
| **Binding** | runtime バージョンに依存 | (Resource, runtime, runtime_version) | Claude からどう発見されるか、いつロードされるか |
| **Observation** | 時系列で追記、不変 | 測定時刻 + 測定方法 | description が実際に載った / 何回使われた / 何 token だった |
| **Snapshot** | その時点で凍結 | 取得時刻 | 上記 3 種の集合 + 環境メタ |

```jsonc
// Resource — 「何が在るか」。runtime を知らない
{
  "resource_id": "sha256:ab12…",          // 内容 hash が同一性。パスではない（移動しても同じ Resource）
  "kind": "skill",                         // skill|hook_script|instruction|agent_def|rule|mcp_server|plugin|memory|output_style
  "name": "viv-call-prep",
  "path": "~/.claude/skills/viv-call-prep.md",
  "owner": "user",                         // user|project|plugin:<id>|shared|builtin
  "content_hash": "sha256:ab12…",
  "normalized_hash": "sha256:cd34…",       // 空白・改行を正規化した hash（drift 判定はこちらで比較）
  "mtime": "2026-06-20T10:33:00+09:00",
  "size_bytes": 2410,
  "declared": { "name": "viv-call-prep", "description": "…", "frontmatter_keys": ["name","description"] },
  "references": [                          // ★ 抽出した生の参照。解決はしない（分析時にやる）
    { "raw": "vercel:react-best-practices", "line": 28, "syntax": "skill_ref" }
  ]
}

// Binding — 「この runtime からどう見えるか」。runtime バージョンごとに再計算される
{
  "resource_id": "sha256:ab12…",
  "resource_path": "~/.claude/skills/viv-call-prep.md",  // ★ 一意キーに必須（下記 7 参照）
  "runtime": "claude-code",
  "runtime_version": "2.1.263",
  "discovered": false,
  "rule_id": "claude.skill.requires_dir_skill_md",   // ★ どの規則で判定したか。規則が変われば追跡できる
  "rule_source": "docs:skills.md#discovery-locations",
  "confidence": "high",                    // high=規則で確定 / medium=heuristic / probe_required
  "load_mode": "never",                    // always|on_demand|deferred|path_conditional|never
  "scope_condition": null,                 // paths glob 等。null=無条件
  "applies_to": ["session"],               // session|subagent。SubagentStart 継承の有無を表現
  "search_path": "~/.claude/skills/",
  "precedence": 2                          // 同名衝突時にどちらが勝つか
}

// Observation — 「実際にどうだったか」。追記のみ、上書きしない
{
  "resource_id": "sha256:ab12…",
  "resource_path": "~/.claude/skills/viv-call-prep.md",  // ★ Binding と同じ理由で必須
  "runtime": "claude-code",   // null 可。filesystem の事実（size/mtime）は runtime 非依存
  "kind": "token_cost",                    // token_cost|description_loaded|invocation|hook_fired|context_present
  "value": 0,
  "unit": "tokens",
  "measured_at": "2026-09-07T10:15:00+09:00",
  "method": "static_estimate_chars_div_2_2",  // ★ 証拠の等級。同じ量でも method 違いは別 Observation として並存
  "confidence": "low",
  "scope": "next_session"                  // ★ next_session|running_session。SESSION_STALENESS の根拠
}

// Snapshot — その時点の環境
{
  "snapshot_id": "2026-09-07T10:15:00+09:00",
  "tool_version": "agent-doctor 0.1.0",
  "runtimes": [ { "runtime": "claude-code", "version": "2.1.263" }, { "runtime": "codex", "version": "…" } ],
  "env": { "os": "darwin 25.6.0", "project": "/Volumes/SSD2TB/interventionworks" },
  "resources": ["sha256:ab12…", "…"],
  "bindings": [ /* 上記形式 */ ],
  "observations": [ /* 上記形式 */ ]
}
```

#### 設計上の要求

1. **`resource_id` は content hash、パスではない。** ファイルを移動しても同じ Resource として追跡できる（今日 telegram rule を移動した事象がそのまま該当）
2. **`normalized_hash` を別に持つ。** drift 判定は空白・改行を正規化した後で比較する。無いと改行コード差で偽陽性が出る
3. **`references` は生の文字列のまま保存し、解決しない。** 「andy.md の 28 行目に `vercel:react-best-practices` という文字列がある」は壊れにくい事実。「それが解決できない」は分析結果。この分離が `UNREACHABLE_REFERENCE` を導く
4. **`Binding.rule_id` を必ず持つ。** discovery 規則は runtime バージョンで変わる。どの規則で判定したかを残さないと、規則が変わった時に過去の判定が検証不能になる
5. **`Observation.method` を必ず持つ。** ゆうの「観測 → 証拠 → 症状」の**証拠の等級**がこれ。`chars/4` の推定と tiktoken 実測と公式 `/skill-doctor` の実測は、同じ token 数でも別の Observation として並存する
6. **`Observation.scope` で next_session と active_runtime を分ける。** これが `SESSION_STALENESS` の検出根拠になり、レポートの宣言にも使う
7. **Binding / Observation の一意キーに `resource_path` を含める。**（2026-09-07 Gate A の実測で判明）
   `resource_id` は content hash なので、**内容が完全一致する資源が複数パスに在ると同じ id になる**。
   実測では 175 Binding のうち **44 件が `(resource_id, runtime)` だけでは識別できず**、
   snapshot diff が同一環境の 2 回比較で偽の差分 16 件を出した。
   Resource の同一性は内容（移動を追跡できる）、Binding / Observation の同一性は
   「どこにある実体がどう見えるか」なので、パスを含めないと成立しない。
   一意キー: Binding = `(resource_id, runtime, resource_path)` /
   Observation = `(resource_id, resource_path, runtime, kind, method)`

#### Graph は分析時に生成する

```
Resource ──(Binding)──→ Runtime          「この runtime から見えるか」
Resource ──(reference)──→ Resource        「参照が解決するか」（生文字列を分析時に解決）
Resource ──(Observation)──→ 測定値        「実際にどうだったか」
Snapshot ──(diff)──→ Snapshot             「いつ変わったか」
```

Finding は必ずこの Graph の**経路として説明できる形**で出す。`explain <resource_id>` はこの経路をそのまま表示する。

### 4.3 adapter が実装すべきインターフェース

```
interface RuntimeAdapter {
  id: "claude-code" | "codex"
  detect(): { present: boolean, version: string | null }
  searchPaths(): SearchPath[]                       // 探索パスと優先順位
  discoveryRules(version): DiscoveryRule[]          // 「何が発見されるか」の規則（★ 芯、版差を持つ）

  collectResources(): Resource[]                    // 事実のみ。runtime 非依存の形で返す
  computeBindings(resources): Binding[]             // discovery 規則を適用。rule_id を必ず埋める
  collectObservations(resources): Observation[]     // usage / mtime 等、既に存在する記録から
  probePlan(): ProbeSpec[]                          // Phase 1 以降。計画を返すだけで実行しない

  protectedDefaults(): Glob[]                       // 安全側の初期値
}
```

`collectResources` と `computeBindings` を**必ず分ける**のが規約。Resource 収集は runtime バージョンを知らずに動き、Binding 計算だけがバージョンに依存する。これで Claude Code の仕様変更時に再計算する範囲が Binding に閉じる。

`discoveryRules()` が本プロジェクトの資産になる。Claude Code 側で分かっている規則の例:

- skill は `<dir>/SKILL.md` のみ（平置き `.md` は読まれない）→ **P1**
- rule は frontmatter `paths:` があれば条件付き、無ければ常時 → **P6**
- `~/.agents/skills/` は Claude Code の探索対象外 → **P3 の原因**
- MCP tool は deferred 機構が有効なら名前のみ → **P9**
- SessionStart の context はサブエージェントに継承されない（だから SubagentStart hook が別に要る）→ **P7**

**これらは公式ドキュメントに散在するか未文書。実測で確定させて adapter に焼くこと自体が価値。** バージョン差で変わるので `discoveryRules()` は agent バージョンを引数に取る。

## 5. CLI 面（v0.1）

```bash
agent-doctor scan                      # 既定: READ ONLY, 全 adapter, human 出力
agent-doctor scan --json               # 機械可読
agent-doctor scan --agent claude-code  # 絞る
agent-doctor scan --probe              # L3 を有効化（token を使う。要確認プロンプト）
agent-doctor scan --since <snapshot>   # History 差分
agent-doctor snapshot [--out FILE]     # 現状を baseline として保存
agent-doctor explain <item-id>         # 1 項目の provenance chain を掘る（★ 目玉）
agent-doctor patterns                  # 検出パターン一覧と説明
```

### 5.1 出力の原則

```
Effective state for: NEXT session
  (running sessions keep their startup snapshot — see P14)

claude-code  /Volumes/SSD2TB/interventionworks
  startup fixed cost   ~36,600 tok   (estimator: chars/2.2 ja)
  capabilities         92 skill (8 fired in 30d) · 141 tool (deferred, ~0 tok)
  protected            3 items, 31,200 tok  (not counted as reducible)

ERROR  P1 unreachable-capability      13 items
  ~/.claude/skills/viv-call-prep.md and 12 more
  reason: loader requires <dir>/SKILL.md
  → agent-doctor explain skill:claude-code:user:viv-call-prep

ERROR  P2 dangling-reference          4 refs
  ~/.claude/agents/andy.md:28  vercel:react-best-practices
  target plugin not found in: enabledPlugins, installed_plugins, cache, marketplaces
  also present in codex: ~/.codex/agents/andy.toml:24   ← cross-agent

WARN   P3 cross-agent-drift           10 skills
  finish   claude 2026-09-07 / codex 2026-06-08   diff 202 lines

INFO   P9 false-bloat guard           suppressed 1 finding
  141 MCP tools are deferred (name-only). Not reported as bloat.

INFO   PROTECTED_HEAVY               MEMORY.md 25,798 B — protected, no action proposed
       heavy is not a defect. no reduction proposed.

WARN   SESSION_STALENESS             1 resource   (requires --probe to confirm)
  ~/.claude/rules/telegram-channels.md  moved 09:26
  next_session: not loaded  /  running_session(pid 23127): still present
  → config change will apply on next launch
```

#### レポート種別の宣言（必須、`SESSION_STALENESS` 対応）

**すべてのレポートは、どちらを観測したものかを冒頭で宣言する。**

| 種別 | 意味 | 取得方法 |
|---|---|---|
| `next_session` | **次回起動時**の Effective Environment（既定） | 静的収集 + discovery 規則の適用 |
| `running_session` | **今動いているセッション**の実測 | probe（Phase 1 以降） |

両方を取得した場合、食い違いを `SESSION_STALENESS` として報告する。宣言を省略すると「直したのにまだ残っている」という誤診に見え、Doctor の信用を一度で失う。

```
Report scope: NEXT SESSION (static analysis)
  Running sessions keep the snapshot they started with.
  Config changes take effect on next launch.
  To compare against a live session: --probe
```

**言葉の規律**（Doctor is not an Optimizer）:

- 「削除」「不要」「無駄」を出力に使わない。`fixed cost N tok, last fired: never` のように**事実だけ**
- protected は「保護されているので提案しない」と明示し、コスト合計から reducible を分離
- **P9 のガードが何を抑制したかを必ず出す。** 「141 tool は問題ではない」と Doctor 自身が言うことで、Optimizer でないことを毎回証明する
- 修正提案は出すが**自動適用しない**。`--fix` を v0.1 では実装しない
- **「重い = 悪」「使ってない = 不要」にしない。** 大きさと未使用は事実として出すが、それ自体を欠陥として扱わない。判断は人が持つ
- **「見えない = 異常」にしない。** `discovered=false` は他 runtime の領域に在るだけのことが多い（実測 73 件のうち 72 件）。仕様どおりの不可視は Observation で、Finding にしない
- Doctor が担うのは **観測 → 証拠 → 症状** まで。治療しない

### 5.2 設定ファイル

```toml
# .agent-doctor.toml（repo or ~/.config/agent-doctor/）
[protected]
globs = [
  "**/memory/**", "**/MEMORY.md", "**/soul/**",
  "**/CLAUDE.md", "**/AGENTS.md",          # instruction は既定で保護
]
[estimator]
mode = "ja"        # ja=chars/2.2 / en=chars/4 / tokenizer=<name>
[probe]
enabled = false
hook_allowlist = []   # dry-run してよい hook（既定は空 = 何も実行しない）
```

**protected の初期値は安全側**（memory / identity / instruction を最初から保護）。ゆうの「MEMORY.md は token 目的で削るの禁止」を製品のデフォルトにする。

## 6. 非目標（v0.1 で作らないもの）

- 自動修復・自動削除（`--fix` は作らない）
- token 削減を目的にした最適化提案
- MCP サーバーの接続診断（mcp-doctor 系に任せる）
- Skill frontmatter の妥当性検証（公式 `/skill-doctor` に任せる）
- Claude / Codex 以外の adapter（Cursor / Cline 等は v0.3 以降、interface は残す）
- 常駐監視（単発の `scan` のみ。継続監視は別プロジェクト）
- **既存 OSS の再実装**

## 7. 実装言語（推奨と理由）

**推奨: TypeScript (Node)。**

| 観点 | TS/Node | Python |
|---|---|---|
| 対象データ | Claude 側は JSON / JSONL、Codex 側は TOML。JSON は Node が素直 | TOML は 3.11+ 標準、JSON も可 |
| 配布 | `npx agent-doctor` が最も摩擦が低い。Claude Code plugin 化も同居 | uv/pipx は agent 利用者層に一段高い |
| 既存との棲み分け | cclens が Rust なので競合しない層 | 同じ |
| 実装速度 | — | Codex はどちらも速い |

**cclens への依存は取りやめた**（ライセンス未設定、§3.2-A）。代わりに必要になったのは tokenizer で、ここが言語選択に効く:

- Python: `tiktoken` 本家がそのまま使える（context-viewer と同じ `cl100k_base`）
- TS/Node: `gpt-tokenizer` / `js-tiktoken` の port を使う。追加依存 1 つ

**それでも TS 推しを維持する。** tokenizer は port で足りる一方、配布の摩擦（`npx`）と Claude Code plugin 同居の利点は代替できない。ただし Codex が Python の方が速いと判断するなら覆してよい。**その場合の唯一の条件は、estimator を chars/4 にしないこと**（日本語で 2〜3 倍ずれる。cclens が実際にこれで外している）。

## 8. スコープ（Phase 0 は別文書）

**Phase 0 の実装指示は [phase0-implementation-handoff.md](phase0-implementation-handoff.md) が正本。** ここでは全体像の中での位置だけ示す。

| Phase | 狙い | 含む |
|---|---|---|
| **Phase 0** | **4 種の事実データが両 runtime で成立するかの確認** | Resource 収集（Claude / Codex）→ 同一 IR へ normalize → source→binding→observation の追跡 → shared resource 突合 → snapshot 保存と diff。診断は `UNREACHABLE_REFERENCE` / `CROSS_RUNTIME_DRIFT` / `SCOPE_MISMATCH` の 3 つだけ |
| Phase 1 | Effective の確定 | probe（`--debug` ログ / `plugin eval` / 自己申告の 3 段）、`SESSION_STALENESS` の実検出、`HOOK_AMPLIFICATION` の実測 |
| Phase 2 | 診断の拡張 | 残りの Finding（`TOMBSTONE_ENTRY` / `FIXED_COST_WITHOUT_USAGE` / `CONTEXT_TAX` / `DUPLICATE_RESOURCE` / `SHARED_RESOURCE_COUPLING` / `RUNTIME_FORMAT_DIVERGENCE`）、`FALSE_BLOAT_GUARD` の本実装 |
| Phase 3 | 拡張 | 他 runtime の adapter（Cursor / Cline 等）、公式 `/skill-doctor` 出力の取り込み |

### Acceptance（全 Phase 共通の製品思想）

**2 つを同時に満たして初めて合格。**

1. **人が半日かけて見つけた症状を検出する** — 2026-09-07 の BECKY 環境で人手で見つけた 7 症状
2. **数字が大きいだけのものを問題扱いしない** — MCP 141 tool（deferred で固定費ほぼゼロ）と `MEMORY.md` 25,798 B（identity として protected）を Finding に出さない

2 番目が製品思想の担保。**重い = 悪、使ってない = 不要 にしない。** 回帰テストでは 2 番目を主目的として扱い、1 番目だけ通って 2 番目が落ちたビルドは不合格とする。

## 9. リスクと未解決

| リスク | 内容 | 対処 |
|---|---|---|
| **discovery 規則の陳腐化** | Claude Code は 2 週間で仕様が動く。規則を焼くと嘘をつくツールになる | `discoveryRules(version)` にして版差を持つ。確定できない項目は `confidence: probe_required` にして断定しない |
| **未文書仕様への依存** | deferred の feature flag 名（`tengu_*`）等は内部実装 | 検出できたら使う、無ければ degrade。**flag 名をハードコードしない** |
| **token 推定の不正確さ** | 日本語で 2〜3 倍ずれる | `estimator` を出力に必ず添える。正確さより**同一条件での比較可能性**を優先 |
| **probe の副作用** | hook dry-run が状態を書く（実測済み） | allowlist 制、既定空。probe は「起動して聞く」だけを既定に |
| **Doctor 自身が肥大化要因になる** | plugin 化すると自分が固定費を持つ | CLI を主、plugin 化は任意。plugin 版は description を 1 行に抑える |
| **P14 の周知** | 「直したのに変わらない」の混乱 | 出力ヘッダに毎回書く |
| **公式に追い抜かれる** | `/skill-doctor` が v2.1.252 で登場したように、公式が Effective 計測を広げてくる。skill は既に取られた | **公式が取れない 4 軸（到達性 / provenance / cross-agent / snapshot 差分）に軸足を置く**。公式が出す領域は引用するだけにして、重複実装を持たない |
| **参考にした OSS のライセンス** | cclens はライセンス不在で依存不可（判定済み）。他も web app 主体でライブラリ公開なし | **コードは取り込まず手法のみ参考**。取り込む場合は MIT 出典を明記 |

## 10. 次アクション（Codex への実装判断材料として）

1. ~~§3 を埋める~~ **完了**（2026-09-07）
2. **Emma レビュー**: 4 軸（Presence / Activation / Provenance / Temporal）の切り方と、Resource / Binding / Observation / Snapshot の分離に対して。特に「Observation.method の等級をどこまで細かく持つか」
3. **Codex packet**: §4.2 のスキーマ + §4.3 の adapter interface + fixture 14 本を渡して、claude-code adapter の L1+L2 から着手
4. **vehicle 決定**（ゆう）: IW 直営 OSS（Vibe-Guard と同枠）か
5. **ゆう判断が要る 1 点**: 公開範囲。BECKY 環境の実測値がそのまま fixture の由来になっているので、`notes.md` に何を書くか（パス名・skill 名は出るが人格の中身は出さない、が私の推し）

## 付記: この設計の出自

BECKY 環境を半日棚卸しして、**人間が手で見つけた 7 症状を機械化できる形に一般化した**もの。仮想のユースケースから作った設計ではない。14 パターン全てに実測実例があり、そのうち 1 つ（P14 stale-session-state）は**設計中の自己観測から発見された**（rule ファイルを移動した当セッションのコンテキストから、そのファイルが消えなかった）。
