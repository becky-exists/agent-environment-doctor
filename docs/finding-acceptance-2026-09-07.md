# Finding 3 本 — 実環境 Acceptance（2026-09-07）

> 対象: BECKY 実環境（Claude Code 2.1.263 / Codex 0.153.4、project=`/Volumes/SSD2TB/interventionworks`、`--launcher ~/bin/becky-start.sh`）
> 判定基準: [phase0-implementation-handoff.md §9](phase0-implementation-handoff.md)。**6〜9 が 1 つでも出たら不合格**。
> 前提: IR 修正 6 点（Codex 独立レビュー反映）後、Gate A 17/17 PASS、テスト 34/34 PASS。

## 必ず検出する

| # | 症状 | 期待 | 実測 | 判定 |
|---|---|---|---|---|
| 1 | 平置き skill 13 本 | `undiscovered_declaration` | **0 件**。13 本は 9/7 朝に `agents/` へ統合済みで実環境に残っていない。fixture `unreachable-reference` で検出を担保 | ✅（fixture） |
| 2 | `vercel:*` 参照（Claude 側） | `missing_target` | `vercel:react-best-practices` / `vercel:nextjs` / `vercel:verification` の 3 raw、Claude 側参照 4 行（andy.md:28/29/30、claire.md:51）。status=`plugin_disabled`（Codex 側 `vercel@claude-plugins-official` enabled=false、Claude 側は未インストール）。error / high | ✅ |
| 3 | 同じ参照が Codex 側にも複製 | `also referenced by: codex …` | 各 Finding の referrers に `~/.codex/agents/andy.toml:24-26`、`~/.codex/agents/claire.toml:44`、`~/.codex/AGENTS.md:82-83` を含む | ✅ |
| 4 | 同名 skill 10 本の版ズレ | `CROSS_RUNTIME_DRIFT`、`finish` が 202 行差で最上位 | **10 件、`finish` 202 行で最上位**（becky-proofreader 190 / becky-memory-tidy 53 / image-prompt-director 16 / agent-reach 11 / _brand-template 8 / lucide-icons 4 / moto-logos-brand 4 / slight-brand 4 / frontend-design 2）。同名 26 組のうち一致 16 は出ない | ✅ |
| 5 | `telegram-channels.md` の scope | `SCOPE_MISMATCH` | **0 件**（9/7 朝に `rules/` → `channel-prompts/` へ移動済み）。fixture `scope-mismatch` で検出 + launcher 経由の 2 本目の Binding を担保 | ✅（fixture） |

## 絶対に検出しない（製品思想の担保）

| # | 対象 | 実測 | 判定 |
|---|---|---|---|
| 6 | MCP 16 server / 141 tool | Finding 0。`no findings for:` に「16 MCP server binding(s), load_mode=deferred. Count alone is not reported.」 | ✅ |
| 7 | `MEMORY.md` 27,822 B ×29 | Finding 0。protected 33 resources / 871,211 B として列挙、「heavy is not a defect」 | ✅ |
| 8 | 発火ゼロの skill 群 | Finding 0。「73 discovered skill(s) have no recorded invocation. Unused is not reported as a finding.」 | ✅ |
| 9 | 同一内容で重複 16 組 | Finding 0（normalized_hash 一致は drift ではない） | ✅ |
| 9' | discovered=false 73 件のうち領域 72 件 | Finding 0。「72 binding(s) are discovered=false because the path belongs to another runtime. Observation, not a finding.」 | ✅ |

## 実装中に潰した偽陽性（精度の記録）

| 出た Finding | 原因 | 直し方 | 後回し項目の前倒し？ |
|---|---|---|---|
| `read:false` / `read:true`（finish/SKILL.md:62） | `key:value` 記法をバッククォートで囲んだもの | `skill_ref` の name が真偽値・数値・`...` なら参照ではない | いいえ（抽出規則） |
| `123456789:AAH...`（telegram plugin の設定例） | トークン例 | ns を英字始まりに限定 | いいえ（抽出規則） |
| `codex:codex-rescue`（codex plugin の 3 skill から 6 箇所） | plugin の **agent** への参照。agent 定義を収集していなかった | plugin の `agents/*.md` を `<plugin>:<agent>` の agent_def として収集、到達可能集合に agent_def も含める | **はい**（Codex レビュー 3-6 系の収集範囲。3 Finding の偽陽性になったので前倒し） |

## 残った warn / medium（正直に出しているもの）

| Finding | 内容 | 扱い |
|---|---|---|
| `superpowers:test-driven-development`（systematic-debugging/SKILL.md:181、両 runtime） | `superpowers` plugin はどこにも無い。本物の死んだ参照 | ns が未知の plugin なので `namespace_unknown`、warn / medium。summary に「ラベルの可能性」を明記 |
| `ctrl:despawn`（agmsg/SKILL.md:135） | メッセージ種別のラベル。参照ではない | 同上。Doctor は構文だけでは区別できないので、確信度で表現し断定しない |
| `vercel:ai-sdk`（~/.codex/AGENTS.md:79） | 死んだ参照。AGENTS.md は protected | **error / high のまま出す**（ゆう裁定 9/7 夕: protected は最適化提案を止める保護で、事実ベースの診断の等級は下げない）。LLM report の `protected_handling` で「全面的な変更・削除は推奨しない、局所修正も人の承認が要る」と伝える |

## 数字

| | 値 |
|---|---|
| resources / bindings / observations（launcher 付き） | 206 / 278 / 516 |
| Finding | error 4 / warn 12 / info 0（protected の `vercel:ai-sdk` を error のまま数える） |
| suppressed（no findings for:） | 4 群 + protected 33 |
| Gate A | 17 / 17 PASS |
| テスト | 34 / 34 PASS（fixture 4 本の Finding 照合、guard `findings: []`、read-only、golden、coverage） |
