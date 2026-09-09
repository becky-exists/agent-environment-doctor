# Codex 独立レビュー結果 — Phase 0 IR 設計

> 2026-09-07 15:25 受理、codex-cli 0.153.4 / gpt-5.6-sol / sandbox read-only / 149,060 tokens。依頼書: [codex-review-request-phase0.md](codex-review-request-phase0.md)。コード変更なし、指摘のみ。
> 注: 依頼書の実行コマンドは `npx tsx` だったため sandbox 内で IPC pipe の listen EPERM で全滅し、Gate A の実データ再測定は「情報不足」。依頼書と script は `node dist/cli.js` に修正済み（次回から再測定可能）。

# Phase 0 IR 設計 独立レビュー

## 観点 1. Gate A で直した IR 3 点

### 観点 1-a: 要修正

根拠: `Binding` / `Observation` に `resource_path` を加える判断自体は妥当。同じ content hash を持つ複数配置を識別するには、内容の同一性と配置の同一性を分ける必要がある。

ただし、追加後も一部の参照・検査が `resource_id` だけで結合されている。

- `EvidenceRef` の observation 参照に `resource_path` / `runtime` / `method` がない
- Gate A の `binding.covers_all_resources` は `resource_id` だけを見ており、同一内容の別パスに Binding がなくても検出できない
- evidence chain の組み立ても `resource_id` だけで最初の Binding / Observation を選ぶため、別パスの証拠を指す可能性がある
- Observation は同じ `resource_id` を複数パスで共有できるため、現在の observation evidence は一意に解決できない

`Resource` は「content entity」と「配置 occurrence」が1オブジェクトに混在しているが、Phase 0 の3 Findingだけなら、`resource_id = content hash` と `(resource_id, path)` の複合識別を維持する設計で成立する。Resource ID をパス込みへ変えると移動追跡を失うため、現時点では推奨しない。

影響: Finding の対象判定自体が正しくても、`evidence_refs` が別配置の Binding / Observation を指す可能性がある。「証拠まで辿れる」という製品の中核が壊れる。

提案: IR と利用側を次の複合キーで統一する。

- Resource occurrence: `(resource_id, path)`
- Binding: 後述の `binding_id`、または少なくとも `(resource_id, resource_path, runtime, mechanism, source_ref)`
- Observation: `(resource_id, resource_path, runtime, kind, method, scope, measured_at)`
- observation EvidenceRef に `resource_path`, `runtime`, `method`, `scope` を追加
- Gate A の coverage と evidence chain もパス込みで照合

将来スキーマを整理する場合は、content hashだけを持つ `ResourceContent` と、path/owner/mtime/sizeを持つ `ResourceLocation` の分離が自然。ただし3 Findingの前提条件ではない。

優先度: **Finding 3本の実装前に直すべき。**

---

### 観点 1-b: 妥当

根拠: Resource を runtime 非依存にし、複数 adapter が同じ実体を観測できる構造は、`CROSS_RUNTIME_DRIFT` と「仕様どおりの不可視」を同じ事実集合から判断する目的に合っている。adapterごとに探索対象を完全分離すると、相手 runtime の領域にある同名資源との対照を上位層で再収集する必要が生じ、収集責務が別の場所へ移るだけになる。

`(resource_id, path)` による重複排除も、現在の Resource がpathを含む構造では妥当。

一方、両 adapter が同じファイルを読み、先に収集した Resource を採用する実装は、adapter間で `kind` / `owner` / `name` / frontmatter解析結果が異なった場合に差を黙って捨てる。現状の共有skillでは実害が限定的だが、Resource収集が本当にruntime非依存なら、長期的には共通 filesystem collector に寄せる方が設計意図を保ちやすい。

影響: 現状のままでも3 Findingは成立する。将来adapterごとの解析差が増えると、adapter順序によってSnapshotが変わり得る。

提案:

- Phase 0では現在の重複排除を維持
- 重複キーで内容以外のフィールドが不一致なら、黙って先勝ちにせずGate Aで検出
- 共通化は後続で `ResourceCollector` と runtime固有の `computeBindings()` に分ける

優先度: **不一致検査だけFinding実装前が望ましい。collectorの共通化は後でよい。**

---

### 観点 1-c: 要修正

根拠: `runtime: null` でfilesystem由来の観測を表すこと自体は理解可能で、`size` / `mtime` の二重生成を抑える目的にも合う。

ただしObservationは「時系列で追記、不変」と定義されている一方、一意キーが `scope` と `measured_at` を含まない。現在の `obsMap` では、同じSnapshot内に次の観測が共存できない。

- 同じmethodによる異なる時点の測定
- `next_session` と `active_runtime` の同一kind/method
- 将来、同じ対象を異なるtool versionで再測定した結果

これは `runtime: null` より大きな一意性上の問題。

影響: Phase 1のprobeと時系列観測を追加した時、観測が上書き・重複排除され、`SESSION_STALENESS` 等の根拠を失う。現時点でもObservation evidenceを一意に参照できない。

提案:

- `runtime: null` はPhase 0では維持してよい
- `scope` は既に別の意味で使われているため、`scope: 'filesystem' | 'runtime'` への転用はしない
- 必要なら後で `subject_scope: 'filesystem' | 'runtime'` を追加
- Observation identityには最低限 `scope` と `measured_at` を含める
- Snapshot生成時の「同じadapterが同一測定を重複生成した場合の排除」と、履歴上のObservation identityを別概念にする

優先度: **EvidenceRefの修正はFinding実装前。時系列identityの完成はPhase 1前でもよい。**

---

## 観点 2. Binding の一意性

### 観点 2-A: 要修正

根拠: `mechanism` はidentityに必要。同一ファイルが同一runtimeへ、rule autoloadと`--append-system-prompt`の両方から入る場合、現在のキーでは2本の結合を表現できない。これは「同じ資源」ではなく「異なる注入辺」である。

ただし `mechanism` だけを足しても十分ではない。例えば同じhook scriptを、同じhook mechanismから異なるevent/matcherや複数の設定位置で登録できる。公式Codex Hooksも複数のhook sourceをマージし、同一layerの`hooks.json`とinline `[hooks]`も併存可能としている。[OpenAI Codex Hooks](https://developers.openai.com/codex/hooks)

影響: 二重注入、複数hook登録、将来の`CONTEXT_TAX`を1 Bindingへ潰す。`SCOPE_MISMATCH`でも、どの経路のscopeを評価したか不明になる。

提案:

- `mechanism` をBindingへ追加
- さらに宣言位置を識別する `source_ref` または安定した `binding_id` を追加
- 推奨identity:
  `binding_id = hash(runtime_instance, resource_id, resource_path, mechanism, source_ref)`
- `source_ref` の例:
  `settings.json#hooks.PreToolUse[1].hooks[0]`,
  `becky-start.sh:42`,
  `AGENTS.md@<directory>`

優先度: **Finding 3本の実装前に直すべき。** schema version 1を前提にFindingを積む前に決めるべき項目。

---

### 観点 2-B: 妥当

根拠: `load_mode` / `scope_condition` は基本的にはBindingの状態・属性であり、identityに直接含めるべきではない。同じ宣言位置の条件が変更された場合、それは「同じBindingの変更」としてsnapshot diffで検出したいからである。

反例となる複数hook登録も、条件自体をidentityにするのではなく、設定内の配列位置など `source_ref` で別Bindingとして識別できる。

影響: 条件をidentityへ含めると、scope変更が「Bindingの変更」ではなく削除＋追加として見え、diffの意味が弱くなる。

提案: `load_mode` / `scope_condition` は属性のまま維持し、宣言位置をidentityにする。条件が静的に分からない場合に備え、`load_mode`へ `unknown` を追加するか、nullableにする。

優先度: **`unknown` の導入はFinding実装前。その他は現設計で妥当。**

---

### 観点 2-C: 要修正

根拠: 「結合を作った主体」はprovenance chainに必要。`mechanism = append_system_prompt` だけでは、どのscript・設定・pluginが注入したか説明できない。

`injected_by` を単なる外部パス文字列に限定すると、Resource化された設定やscriptとの関係が弱くなる。

影響: Findingは二重注入を示せても、一次事実へ辿れない。設定変更後のdiffでも、どの宣言が変わったか識別できない。

提案:

- Bindingに `source_ref` を必須化
- 収集済みResourceが主体なら `source_resource_id` + `source_resource_path`
- まだResource化できない外部要因には `external_source_ref`
- `injected_by` という単一文字列より、型付きprovenanceを推奨

優先度: **Finding実装前に直すべき。**

---

### 観点 2-D: 要修正

根拠: 起動scriptの2本目を収集しないままでは、`mechanism` を追加しても実データまたはfixtureで検証できない。handoff §5.3にもPhase 0で `cat <path>` を `path_ref` として抽出すると明記されている。

ただし、全shell設定・launchd plistを網羅的に探索することはPhase 0の範囲を超える。静的探索で「実際にそのlauncherが使われた」ことまでは証明できない。

影響: 実在した二重注入をIRで表現できるというGateを通せず、最重要のキー設計が未検証のままになる。

提案:

- Phase 0ではfixtureと明示的に与えられたlauncherだけを収集
- `cat <path>` と `--append-system-prompt` の関係を別Bindingとして生成
- 実際に使われたlauncherかどうかは `confidence: medium` または `probe_required`
- shell設定やlaunchd全域の自動探索はPhase 1以降
- 実装順序は「IRにmechanism/provenance追加 → fixture collector追加 → Gate Aで2 Bindingを確認」

優先度: **最小fixtureによる検証はFinding実装前。環境全域の探索は後でよい。**

---

## 観点 3. Codex adapter の discovery 規則

### 観点 3-1: 要修正

根拠: `codex.instruction.agents_md_always` は公式根拠があるが、現在の規則は不完全。公式仕様は以下を定めている。

- globalは`$CODEX_HOME/AGENTS.override.md`を優先し、なければ`AGENTS.md`
- project rootからCWDへ下りながら各階層を連結
- 各階層ではoverride、AGENTS、fallback名の順
- 1階層につき最大1ファイル
- 空ファイルを除外
- `project_doc_max_bytes`で打ち切り

[OpenAI Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)

影響: 現実にはロードされないAGENTS.mdを`always`としたり、中間ディレクトリのAGENTS.mdを収集できなかったりする。そこにあるreferenceが `UNREACHABLE_REFERENCE` の入力から漏れる。

提案: 分類は「実測どおり（公式にも根拠あり）」へ変更するが、規則を `global selection`、`project chain`、`override/fallback`、`size limit` に分割する。`rule_source`を上記公式URLへ差し替える。

優先度: **Finding実装前。**

---

### 観点 3-2: 妥当

根拠: `codex.skill.agents_dir_included` は公式に明記されている。Codexは `$HOME/.agents/skills`、repo rootからCWDまでの各 `.agents/skills`、admin/system locationsを探索し、symlinkも追跡する。[OpenAI Codex Skills](https://developers.openai.com/codex/skills)

影響: `CROSS_RUNTIME_DRIFT` のCodex側Bindingを高confidenceで作れる。

提案: 「実測どおり（公式にも根拠あり）」へ変更し、`rule_source`を公式URLへ差し替える。project階層・`/etc/codex/skills`・system・symlinkも規則と収集範囲へ反映する。

優先度: **公式出典への差し替えとproject階層の収集はFinding実装前。admin/system拡張は後でもよい。**

---

### 観点 3-3: 要修正

根拠: 公式の標準探索場所に `~/.claude/skills` は含まれない。ただし `[[skills.config]] path = "/path/to/skill/SKILL.md"` により任意パスのskillを明示参照できる。[OpenAI Codex Skills](https://developers.openai.com/codex/skills)

したがって「常に探索対象外」は過剰な断定。

影響: `~/.claude/skills` 内のskillが明示設定されている環境で、偽の `discovered=false` と誤った `UNREACHABLE_REFERENCE` / drift判定を生む。

提案: 規則を「標準探索場所には含まれない」に変更し、`skills.config`による明示参照を先に評価する。

優先度: **Finding実装前。**

---

### 観点 3-4: 要修正

根拠: 現在の公式skills資料が列挙するuser locationは `$HOME/.agents/skills` であり、`$CODEX_HOME/skills` は列挙されていない。[OpenAI Codex Skills](https://developers.openai.com/codex/skills)

影響: 存在するだけの `$CODEX_HOME/skills` を標準探索対象と誤認し、偽のBindingを作る可能性がある。

提案: `codex.skill.codex_home_skills` を標準規則から外す。0.153.4で実際にロードを確認した記録があるなら「version依存・undocumented behavior」として `since: 0.153.4`, `until`未確定、confidence lowで隔離する。

優先度: **Finding実装前。**

---

### 観点 3-5: 妥当

根拠: 公式仕様はskillを「`SKILL.md`を持つディレクトリ」と定義し、必須のname/descriptionも定めている。[OpenAI Codex Skills](https://developers.openai.com/codex/skills)

影響: 平置き `.md` の `discovered=false` を高confidenceで判定できる。

提案: 「実測どおり（公式にも根拠あり）」へ変更し、公式URLを設定する。

優先度: **Finding実装前。**

---

### 観点 3-6: 妥当

根拠: 公式資料はpersonal agentを `~/.codex/agents/*.toml`、project agentを `.codex/agents/*.toml` とし、`developer_instructions`を必須フィールドとしている。[OpenAI Codex Subagents](https://developers.openai.com/codex/subagents)

影響: agent definitionの収集形式を高confidenceで確定できる。現実装はproject-scoped agentsを収集していないため、参照抽出に漏れが出る。

提案: 公式出典へ差し替え、project-scoped `.codex/agents/*.toml` も収集する。

優先度: **project agent内の参照を `UNREACHABLE_REFERENCE` の対象にするならFinding実装前。**

---

### 観点 3-7: 要修正

根拠: `hooks.json`と対象eventには公式根拠がある。[OpenAI Codex Hooks](https://developers.openai.com/codex/hooks)

ただし現実装は以下を収集していない。

- inline `[hooks]` in `config.toml`
- project `.codex/hooks.json`
- project `.codex/config.toml`
- plugin-bundled hooks
- trust状態

また、公式仕様では未trustのhookはskipされるため、ファイルの存在だけで `discovered=true / load_mode=always` とするのは不正確。

影響: hookを使う将来Findingで偽陽性・見逃しが出る。hook内referenceを3 Findingへ利用する場合にも漏れが出る。

提案: 「実測どおり（公式にも根拠あり）」へ変更。ただし `discovered` と「実行可能」を分離し、trust状態をactivation属性またはObservationで表す。

優先度: **3 Findingがhook referenceを対象にしないなら後でよい。対象にするならFinding実装前。**

---

### 観点 3-8: 情報不足

根拠: 確認できた公式Config Referenceには、トップレベルplugin全体を `[plugins."<id>"] enabled` で制御する現在仕様を裏付ける記述が見つからなかった。plugin-bundled MCP serverのenablementは公式記載があるが、同一概念ではない。[OpenAI Codex Config Reference](https://developers.openai.com/codex/config-reference)

影響: pluginのinstalled/enabled判定は `UNREACHABLE_REFERENCE / missing_target` の解決結果を左右する。

提案: 0.153.4限定のundocumented behaviorとしてconfidenceを下げ、`since: 0.153.4`を付ける。現在版のplugin状態取得方法を公式CLIまたはplugin manifest仕様で別途確定するまでhighにしない。

優先度: **plugin参照をmissing target判定に使うため、Finding実装前。**

---

### 観点 3-9: 妥当

根拠: `config.toml` の `[mcp_servers.<id>]` と、`tools.<tool>.approval_mode` は公式Config Referenceに記載されている。[OpenAI Codex Config Reference](https://developers.openai.com/codex/config-reference)

影響: MCP Resourceの収集元は確定できる。

提案: 公式出典へ差し替える。なお `enabled=false` を見ず常に`discovered=true`とする現実装は別途修正が必要。

優先度: **MCP数自体はFindingにしない製品思想のため、3 Finding後でもよい。**

---

### 観点 3-10: 要修正

根拠: `.rules` は公式仕様があり、独自の `prefix_rule(...)` DSLである。active config layerの`rules/*.rules`を起動時にscanし、project rulesはtrusted projectだけ有効になる。また公式にexperimentalと明記されている。[OpenAI Codex Rules](https://developers.openai.com/codex/rules)

ただしこれはsystem promptへ常時ロードされるinstructionではなく、sandbox外コマンドのapproval policyである。

影響: 現在の `kind: rule`, `load_mode: always`, `applies_to: ['session']` は、Claudeのprompt ruleとCodexのexec policyを同種に見せる。`SCOPE_MISMATCH` がCodex `.rules` をprompt注入として評価すると偽陽性になる。

提案:

- `ResourceKind` に `exec_policy` を追加するか、少なくともrule subtypeを追加
- `load_mode`をprompt loadの意味に使わない
- `active config layer` / project trustをBinding属性として保持
- `rule_source`を公式URLへ変更
- experimentalなのでversion境界またはconfidence mediumを維持

優先度: **SCOPE_MISMATCH実装前。**

---

### 観点 3-11: CODEX_HOME 複数運用 — 要修正

根拠: 公式AGENTS.md仕様は`CODEX_HOME`がglobal instructionの基点になることを明記している。[OpenAI Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)

現在の`CollectContext`は1回につき1つの`configHome`しか持たず、`RuntimeInfo` / `Binding`にもruntime instanceを識別するキーがない。

影響: `~/.codex`と`~/.codex-artdept`を1 Snapshotへ並列収集した場合、どのCodex環境のBindingかを安定して識別できない。

提案: `runtime_instance_id`または`config_home`をBinding identityへ含める。複数homeの自動列挙はせず、CLI引数で明示されたhomeだけを複数adapter instanceとして収集する。

優先度: **現在の3 Findingをdefault homeだけで実装するなら後でよい。schema version 1を固定するなら先にフィールドだけ追加すべき。**

---

## 観点 4. `~/.codex/rules/*.rules`

### 観点 4-a: 要修正

根拠: 形式は情報不足ではない。公式資料に `prefix_rule(...)` DSL、主要フィールド、複数ruleの結合規則、検証用の `codex execpolicy check` が記載されている。[OpenAI Codex Rules](https://developers.openai.com/codex/rules)

影響: 「形式未調査」のままでは、既知の一次資料を利用せず `probe_required` としていることになる。

提案: Phase 0で完全parserを書く必要はない。最低限、次をResourceのdeclared metadataとして静的抽出する価値がある。

- `prefix_rule` の存在数
- `pattern`
- `decision`
- `justification`
- `match` / `not_match`

ただし次段の3 Findingには直接必要ないため、完全な意味評価は後回しでよい。

優先度: **parse実装は後でよい。ResourceKindの是正はFinding実装前。**

---

### 観点 4-b: 要修正

根拠: `load_mode: always` は不適切。`.rules` は起動時にscanされるが、promptへ常時ロードされる資源ではなく、コマンドがpatternへ一致した時に評価されるexec policyである。またproject-local rulesはproject trustが条件になる。[OpenAI Codex Rules](https://developers.openai.com/codex/rules)

影響: Activation軸を誤って表現し、`SCOPE_MISMATCH` の偽陽性要因になる。

提案:

- `load_mode`に当てはめるなら `path_conditional` ではなく、新しい `match_conditional` が必要
- より自然なのは、prompt/context用Bindingとexec-policy Bindingを別subtypeに分けること
- 少なくとも現時点で`always`は使わず、`unknown`または専用値へ変更
- project trust conditionを保持する

優先度: **SCOPE_MISMATCH実装前。**

---

## 実測結果

指定されたREAD ONLYコマンド3本は、すべて実行環境のIPC制限で開始前に失敗したため、Gate Aの実データ結果は**情報不足**。

再現手順:

```bash
cd /Volumes/SSD2TB/interventionworks/iw-projects/agent-environment-doctor
npx tsx src/cli.ts collect --project /Volumes/SSD2TB/interventionworks
npx tsx src/cli.ts gate-a --project /Volumes/SSD2TB/interventionworks
npx tsx src/cli.ts explain .agents/skills/finish --project /Volumes/SSD2TB/interventionworks
```

3本ともNode.js v24.14.1で次のエラーになった。

```text
Error: listen EPERM: operation not permitted
/var/folders/.../T/tsx-501/<id>.pipe
```

したがって、依頼書記載の「偽差分16件」「60件が潰れた」「Observation 144件冗長」の数値は今回独立再測定できていない。

## 優先度の切り分け

### Finding 3本の実装前に直すべきもの

1. Bindingに `mechanism` と型付きprovenance / `source_ref` を追加
2. Binding identityへ `source_ref`、可能なら`runtime_instance_id`を追加
3. observation EvidenceRefをpath/runtime/method/scopeまで一意化
4. Gate Aのcoverage・evidence chainを複合キーへ修正
5. `load_mode`に`unknown`を追加
6. Codex AGENTS.mdのoverride・階層連結・上限を公式仕様へ合わせる
7. Codex skillsの標準探索場所を公式仕様へ合わせる
8. `skills.config`による任意path参照を評価する
9. `$CODEX_HOME/skills`を標準探索対象から外す
10. project-scoped agentsを収集する
11. plugin enablementをhigh confidenceで断定しない
12. Codex `.rules`をprompt ruleから分離し、`load_mode: always`を撤回
13. launcher二重注入を最小fixtureで表現し、2 BindingになることをGate Aで確認

### 後でよいもの

1. Resource収集の共通collector化
2. Observationの完全な時系列identity設計（Phase 1開始前まで）
3. shell設定・launchd plistの環境全域探索
4. hooksのtrust・inline/project/plugin source完全対応
5. MCP `enabled=false` のBinding反映
6. `.rules` DSLの完全parser
7. 複数`CODEX_HOME`の自動探索
8. admin/system skill locationsの完全収集
