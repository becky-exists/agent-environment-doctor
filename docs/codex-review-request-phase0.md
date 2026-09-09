# Codex 独立レビュー依頼 — Phase 0 の IR 設計

> 宛先: Codex。依頼: ゆう。実装: ベッキー（Claude）。2026-09-07。
> **このレビューではコードを変更しない。指摘だけ出す。** 修正するかは指摘を見てゆうが決める。
> 対象コミット: `b045bc81`（Claude adapter + Gate A）/ `23ebbef2`（Codex adapter）
> 前提: [design-review-v0.1.md](design-review-v0.1.md) rev.2 / [phase0-implementation-handoff.md](phase0-implementation-handoff.md)

## 読む順番

1. `src/ir/types.ts` — IR の 4 種（Resource / Binding / Observation / Snapshot）+ Finding
2. `src/adapters/types.ts` — RuntimeAdapter の規約
3. `src/adapters/claude-code/{rules,index,references}.ts`
4. `src/adapters/codex/{rules,index}.ts`
5. `src/snapshot.ts` — 収集・重複排除・diff
6. `src/gate-a.ts` — 14 項目の関門

実行して確かめる場合（**READ ONLY、環境を書き換えません**）:

```
cd /Volumes/SSD2TB/interventionworks/iw-projects/agent-environment-doctor
node dist/cli.js collect  --project /Volumes/SSD2TB/interventionworks
node dist/cli.js gate-a   --project /Volumes/SSD2TB/interventionworks
node dist/cli.js explain .agents/skills/finish --project /Volumes/SSD2TB/interventionworks
```

`dist/` は依頼側が `npm run build` 済み（`tsc` の出力、`src/` と同一内容）。`npx tsx` は起動時に IPC pipe を listen するため read-only sandbox では `listen EPERM` で落ちる（2026-09-07 15:27 実測）。sandbox 内では `node dist/cli.js` を使う。

---

## 観点 1. Gate A で直した IR 3 点の妥当性

Gate A が実データで検出した 3 つの欠陥を、いずれも IR 側で直した（adapter を足して誤魔化さない方針）。**この 3 つの直し方が正しいか**を独立に判断してほしい。

### 1-a. `Binding` / `Observation` に `resource_path` を追加

- **症状**: 同一環境で 2 回 snapshot を取ると偽の差分 16 件が出た
- **原因**: `resource_id` は content hash なので、内容が完全一致する資源が複数パスに在ると同じ id になる。`(resource_id, runtime)` では Binding を識別できず、両 runtime で 275 キーのうち **60 件が潰れていた**
- **直し方**: 一意キーを `(resource_id, runtime, resource_path)` にした
- **見てほしい点**: Resource の同一性を content hash に置いたまま、Binding の同一性にパスを持たせる設計は妥当か。それとも Resource 側の同一性定義を変えるべきか

### 1-b. `Resource` を runtime 非依存として重複排除

- **症状**: 両 adapter が同じパスを収集し、同じ実体が Resource 配列に 2 回入った
- **背景**: `~/.agents/skills` は Claude adapter が「探索対象外」として、Codex adapter が「探索対象」として、**両方が読む**。突合のために両方読む必要がある
- **直し方**: `collect()` で `(resource_id, path)` をキーに重複排除。Resource には runtime を持たせない
- **見てほしい点**: 「複数 adapter が同じ実体を読む」構造自体が正しいか。adapter ごとに読む範囲を分けて、突合は上位層でやる方が素直ではないか

### 1-c. `Observation.runtime` を nullable に

- **症状**: `size` / `mtime` が両 adapter から 1 件ずつ出て、144 件の冗長が発生
- **直し方**: filesystem 由来（`size` / `mtime`）は `runtime: null`（runtime 非依存の観測）にし、`runtime` を除いたキーで一意化。`invocation` は runtime 固有なので runtime を埋める
- **見てほしい点**: `runtime: null` で「runtime に属さない観測」を表すのは型として素直か。別フィールド（`scope: 'filesystem' | 'runtime'` 等）に分けるべきか

---

## 観点 2. Binding の一意性に `mechanism` が必要か（★ 最重要、Emma 提起）

### 具体的な穴

現在の一意キーは `(runtime, resource_id, resource_path)`。**これだと同じファイルが同じ session に複数経路から入るケースが 1 件に潰れる。**

実在した例が `~/.claude/rules/telegram-channels.md`（2026-09-07 午前に移動する前の状態）:

| 経路 | 仕組み | load_mode |
|---|---|---|
| ① rules として自動ロード | `~/.claude/rules/*.md` の `paths:` 無し → 常時ロード | `always` |
| ② 起動スクリプトからの注入 | `becky-start.sh` が `--append-system-prompt "$(cat <該当ファイル>)"` | `always` |

同じ runtime、同じ path、同じ load_mode。**でも別の結合**。二重注入がこの構成の問題の本体だった（channels セッションでは 2 回、通常セッションでは 1 回無用に載っていた）。

### 判断してほしいこと

**(A) `mechanism` を identity に含めるべきか**

候補値: `rule_autoload` / `instruction_concat` / `append_system_prompt` / `skill_description` / `skill_body` / `hook_stdout` / `mcp_instructions` / `output_style` / `plugin_provided`

- 含めると: 二重注入が見える。`SCOPE_MISMATCH` と将来の `CONTEXT_TAX` の精度が上がる
- 含めないと: Binding が単純。ただし二重注入は表現できない

**(B) `scope` / `activation`（`load_mode` / `scope_condition`）まで identity に入れるべきか**

ベッキーの見立て（**参考程度に。独立に判断してほしい**）:
- `mechanism` は identity に**入れるべき**。「どう入るか」が違えばそれは別の結合
- `load_mode` / `scope_condition` は identity ではなく**属性**。同じ mechanism なら条件は一意に決まるはず
- ただし反例があるかもしれない（同じ mechanism で条件だけ違う結合が成立するケース）。そこを潰してほしい

**(C) 「結合を作った主体」を持つ必要があるか**

②の経路は `becky-start.sh` が `cat` して注入している。つまりこの Binding を作ったのは**リポジトリ外のシェルスクリプト**。`mechanism` だけでは「誰がこの結合を作ったか」が残らない。`injected_by`（結合元の Resource か外部パス）を持つべきか、それは `provenance` chain の担当か。

### ⚠ 実装の穴（正直に共有）

**Phase 0 の実装は②の経路を検出していない。** `becky-start.sh` を読んでいないので、現状では注入経路が 1 本しか存在しないことになっている。

Handoff §5.3 には「起動スクリプト内の `cat <path>` パターンを `path_ref` として抽出するところまでやる」と書いたが、**未実装**。

したがって Emma の指摘は 2 段になる:
1. キー設計に `mechanism` が要るか（設計の問題）
2. そもそも 2 本目の経路を収集していない（実装の穴）

**2 を先に埋めないと 1 の妥当性を実データで検証できない**、という順序の問題も含めて判断してほしい。収集対象に「起動スクリプト・シェル設定・launchd plist」を含めるべきか、それは Phase 1 の probe（`--debug` ログから実際の注入を見る）に任せるべきか。

---

## 観点 3. Codex adapter の discovery 規則

`src/adapters/codex/rules.ts` の 10 規則は、ほぼ全部が `rule_source: measured:2026-09-07`（BECKY 環境の実測）を根拠にしている。Claude 側は公式ドキュメント（`code.claude.com/docs/en/`）を出典にできたが、Codex 側は同等の資料を見つけられなかった。

**規則ごとに次の 3 分類をしてほしい。**

| 分類 | 意味 | 期待する扱い |
|---|---|---|
| **実測どおり（公式にも根拠あり）** | 公式ドキュメントか CLI ヘルプに記載がある | `rule_source` を公式出典に差し替え |
| **undocumented behavior** | 実装の観測であって保証されていない | `confidence` を下げる。`rule_source: measured:` のまま。破壊的変更が起きうる前提にする |
| **version 依存** | Codex のバージョンで変わる | `since` / `until` を付ける。現在は `codex-cli 0.153.4` で実測 |

対象の 10 規則:

```
codex.instruction.agents_md_always     AGENTS.md（~/.codex と <project>）は常時ロード
codex.skill.agents_dir_included        ~/.agents/skills/<dir>/SKILL.md が探索対象
codex.skill.not_in_search_path         ~/.claude/skills/ は探索対象外
codex.skill.codex_home_skills          $CODEX_HOME/skills/ も探索対象（BECKY 環境では空）
codex.skill.requires_dir_skill_md      平置き .md は読まれない（Claude と同じ形状）
codex.agent_def.toml                   agents/*.toml、本文は developer_instructions
codex.hook.hooks_json                  hooks.json、UserPromptSubmit/SessionStart/Stop を実測
codex.plugin.enabled_flag              config.toml の [plugins."<id>"] enabled
codex.mcp.config_toml                  config.toml の [mcp_servers.<name>]
codex.rule.rules_dir                   $CODEX_HOME/rules/*.rules（形式未調査）
```

特に確認してほしい 3 点:
1. **`~/.agents/skills` は本当に Codex の探索対象か。** BECKY 環境では `.skill-lock.json` があり、外部インストーラが両方へ配置している。Codex 本体が読んでいるのか、インストーラの都合で置かれているだけなのか
2. **AGENTS.md の探索順序と結合規則**。Claude の CLAUDE.md は「Managed > User > Project > 親遡り で連結」と公式にあるが、Codex 側は未確認。親ディレクトリ遡りをするのか
3. **`CODEX_HOME` の扱い**。BECKY 環境は cron で `~/.codex-artdept` を別 home として使っている。複数 home を並列に扱う設計で問題ないか

---

## 観点 4. `~/.codex/rules/*.rules` を Phase 0 で parse するか

現状: `default.rules` 1 本の存在だけ記録し、中身は parse していない。Binding は `confidence: 'probe_required'`、`load_mode: 'always'`（常時ロードと仮定）。

**判断してほしいこと**:
- Phase 0 で parse すべきか、`probe_required` のまま Phase 1 に送るか
- 形式は何か（独自 DSL / JSON / TOML / 行区切り）。パーサを書く価値があるか
- `load_mode: 'always'` の仮定は妥当か。条件付きロードの機構を持つか（Claude の `paths:` 相当）

ベッキーの見立て: **Phase 1 に送る**。1 ファイルしかなく、形式が分からないまま推測パーサを書くと嘘をつく規則になる。ただし「常時ロードと仮定して `load_mode: always`」を置いているのは**断定しすぎ**かもしれない。`probe_required` なら `load_mode` も `unknown` を持てるようにすべきか。

---

## レビュー結果の出し方

指摘だけ。コードは変更しない。各観点について:

```
観点 N-x: <判定>（妥当 / 要修正 / 情報不足）
  根拠: <なぜそう言えるか。公式資料なら URL、実測なら再現手順>
  影響: <直さないと何が壊れるか。Finding の精度か、将来の拡張か>
  提案: <直すなら何をどう変えるか。IR / adapter / 収集範囲のどれに手を入れるか>
  優先度: <Finding 3 本の実装前に直すべきか、後でよいか>
```

**特に「Finding 実装前に直すべきもの」と「後でよいもの」の切り分けを明示してほしい。** 次段は `UNREACHABLE_REFERENCE` / `CROSS_RUNTIME_DRIFT` / `SCOPE_MISMATCH` の 3 本なので、それらの精度に影響するものだけ先に直す。

## 触ってほしくないもの（製品思想）

レビューで「これも検出すべき」と言われても、**次の 2 つは Finding にしない**設計になっている。ここへの変更提案は受けない。

1. **数が大きいだけのもの**: MCP 141 tool（deferred で固定費ほぼゼロ）、`MEMORY.md` 25,798 B（identity として protected）。`fixtures/guard-false-bloat/expected.json` の期待値は `findings: []` で、これが落ちたビルドは他が全部通っても不合格
2. **仕様どおりの不可視**: `discovered=false` 73 件のうち 72 件は「他 runtime の領域に在る」だけ（Claude から `~/.agents` が見えない、Codex から `~/.claude` が見えない）。これは Observation で Finding ではない

Doctor が担うのは **観測 → 証拠 → 症状** まで。治療しない。重い = 悪、使ってない = 不要、見えない = 異常 にしない。
