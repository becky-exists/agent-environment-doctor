# `report --llm` — 修正役の LLM へ渡すレポート形式（設計のみ、v0.1）

> 2026-09-07。実装しない。Finding 3 本が入った後に、この設計に沿って `report --llm` を足す。
> 前提: Doctor は治療しない。**修正するのは人間か、人間が使う LLM**（Emma / Claude / Codex）。このレポートはその LLM への**入力**であり、Doctor の出力の中で唯一「次に何かをする主体」を想定している。

> **実装済み（2026-09-07 夕）**: `src/llm-report.ts`、CLI `report --llm [--format md] [--finding F-001] [--no-redact]`。
> 実装で設計から変えた点: (1) `decision_points` の選択肢は出さない（直し方を決め打ちしない）→ `human_decision_needed` は問いだけ。(2) `protected` は severity を下げない。`protected_handling` で「全面的な変更・削除は推奨しない」を伝える。(3) `doctor_actions`（何も書いていない宣言）と `unsupported`（coverage の未収集）を最上位に追加。(4) `--receiver` は作らない（形式は 1 つ、Markdown か JSON かだけ）。

## 0. 設計の要求（何のための形式か）

1. **貼ればそのまま動く。** 受け手の LLM が Snapshot 全体や Doctor のソースを読まなくても、Finding ごとに判断できる材料が閉じている
2. **証拠を切り離さない。** `evidence_refs` の参照先（Resource のパス、Binding の rule、Observation の値、absence の探索先）を**展開して同梱**する。参照 id だけ渡すと LLM は推測で埋める
3. **確信度を落とさない。** `confidence` と `method`（証拠の等級）を Finding にも証拠にも残す。`probe_required` は「分からない」と読ませる
4. **Doctor が言っていないことを言わせない。** 「削除」「不要」を含まない summary をそのまま渡し、加えて `doctor_did_not_conclude[]` で「Doctor はこれを判断していない」を明示する。受け手が勝手に Optimizer にならないための柵
5. **抑制したものも渡す。** `suppressed[]`（数が大きいが Finding にしなかったもの）を同梱し、受け手が「MCP が 141 本もある」を自分で問題にしないようにする
6. **人の判断点を明示する。** 修正に判断が要る箇所（どちらを正本にするか等）を `decision_points[]` として切り出す。LLM はそこで止まって人に聞く
7. **token を意識する。** 証拠の展開は上限つき（本文の抜粋は該当行 ±2 行、absence の searched は全件）。長い Finding は `--llm --finding <id>` で 1 本ずつ出せる

## 1. 全体構造（JSON）

```jsonc
{
  "format": "agent-doctor-llm-report/1",
  "tool_version": "agent-doctor 0.2.0",
  "generated_at": "2026-09-07T15:00:00+09:00",

  // ★ 必須。受け手が最初に読む。これを落とすと「直したのにまだ残っている」の誤診が起きる
  "report_scope": {
    "observed": "next_session",
    "meaning": "State that the NEXT launched session will see. Sessions already running keep the state they started with. Any fix you propose takes effect on next launch; it will not change a running session, including the one you may be running in.",
    "probe_available": false
  },

  "environment": {
    "runtimes": [
      { "runtime": "claude-code", "version": "2.1.263", "config_home": "~/.claude" },
      { "runtime": "codex", "version": "0.153.4", "config_home": "~/.codex" }
    ],
    "project": "/Volumes/…/interventionworks",
    "home_redacted": true            // 既定で HOME を ~ に置換。--no-redact で生パス
  },

  // 受け手への契約。プロンプトの一部としてそのまま読ませる前提の文
  "handoff_contract": [
    "You are receiving a diagnosis, not a work order.",
    "For each finding, propose a fix as a reviewable change (diff, command, or step list). Do not execute anything.",
    "Where a finding lists decision_points, stop and ask the human before proposing.",
    "Do not propose changes for anything in suppressed[] or protected[]. They are not findings.",
    "Do not use the words 'unnecessary', 'bloat', 'waste', or 'cleanup' about resources; the Doctor did not conclude that.",
    "Config changes apply on next launch. Say so in every proposal."
  ],

  "summary": {
    "findings": { "error": 2, "warn": 1, "info": 0 },
    "resources": 203, "bindings": 275, "observations": 510,
    "protected_count": 31,
    "suppressed_count": 2
  },

  "findings": [ /* §2 */ ],
  "suppressed": [ /* §3 */ ],
  "protected": [ /* §3 */ ],

  // Finding の証拠が参照している Resource だけを抜粋（Snapshot 全体は入れない）
  "resources_referenced": { "sha256:…": { "path": "~/.claude/agents/andy.md", "kind": "agent_def", "name": "andy", "size_bytes": 4120, "mtime": "…" } }
}
```

## 2. Finding 1 件の形

```jsonc
{
  "id": "F-001",                                  // レポート内で安定した通し番号（会話で指せる）
  "finding_id": "UNREACHABLE_REFERENCE",
  "subtype": "missing_target",
  "severity": "error",
  "confidence": "high",
  "axes": ["presence", "provenance"],
  "scope": "next_session",
  "protected": false,

  // Doctor の言葉。事実のみ。「削除」「不要」を含まない
  "summary": "~/.claude/agents/andy.md:28 references `vercel:react-best-practices`. No plugin named `vercel` is enabled or installed for claude-code; the same reference also appears in codex ~/.codex/agents/andy.toml:24.",

  "subject": { "resource_id": "sha256:…", "path": "~/.claude/agents/andy.md", "line": 28, "kind": "agent_def", "name": "andy", "runtime": "claude-code" },

  // 影響を受ける資源。修正の当たり先。runtime ごとに Binding の状態を添える
  "affected_resources": [
    { "path": "~/.claude/agents/andy.md", "runtime": "claude-code", "binding": { "discovered": true, "load_mode": "on_demand", "rule_id": "claude.skill.search_paths" } },
    { "path": "~/.codex/agents/andy.toml", "runtime": "codex", "binding": { "discovered": true, "load_mode": "on_demand", "rule_id": "codex.agent_def.toml" } }
  ],

  // ★ 展開済みの証拠。参照 id ではなく中身
  "evidence": [
    {
      "type": "reference",
      "path": "~/.claude/agents/andy.md", "line": 28,
      "raw": "vercel:react-best-practices", "syntax": "skill_ref", "confidence": "high",
      "excerpt": { "from": 26, "to": 30, "lines": ["…", "…", "- `vercel:react-best-practices`: TSX 編集後のレビュー", "…", "…"] }
    },
    {
      "type": "absence",
      "target": "plugin `vercel`",
      "searched": [
        "~/.claude/settings.json#enabledPlugins",
        "~/.claude/plugins/installed_plugins.json#plugins",
        "~/.claude/plugins/cache/*/vercel*",
        "~/.claude/plugins/marketplaces/*"
      ],
      "method": "filesystem", "confidence": "high"
    },
    {
      "type": "binding",
      "path": "~/.claude/agents/andy.md", "runtime": "claude-code",
      "rule_id": "claude.skill.search_paths", "rule_source": "docs:skills.md#discovery-locations",
      "discovered": true
    },
    {
      "type": "contrast",
      "path": "~/.claude/agents/anna.md", "line": 14,
      "note": "references `frontend-design`, which resolves to ~/.claude/skills/frontend-design/SKILL.md (discovered=true)"
    }
  ],

  // 規則の追跡。Claude Code の仕様が動いた時、受け手が「この判定はまだ正しいか」を確かめられる
  "rule": { "rule_id": "claude.plugin.disabled_not_loaded", "rule_source": "docs:plugins.md", "runtime_version": "2.1.263" },

  // ★ Doctor が判断していないこと。受け手が勝手に埋めないための柵
  "doctor_did_not_conclude": [
    "whether the reference should be removed or the plugin should be installed",
    "whether the codex copy should be changed at the same time"
  ],

  // 修正に人の判断が要る点。ここで LLM は止まる
  "decision_points": [
    { "question": "Should `vercel` be installed, or should the reference be dropped from both agent definitions?", "options": ["install plugin", "drop reference (claude + codex)", "leave as is"], "who_decides": "human" }
  ],

  // 修正が反映される条件。毎回付ける
  "applies_on": "next_session",

  "related": ["F-002"]                          // 同じ資源・同じ原因の Finding
}
```

### 2.1 `evidence[].type` ごとの展開規則

| type | 必ず入れるもの | 上限 |
|---|---|---|
| `resource` | path / kind / name / size_bytes / mtime / normalized_hash 先頭 12 桁 | 本文は入れない |
| `reference` | path / line / raw / syntax / confidence / `excerpt`（該当行 ±2） | 5 行 |
| `binding` | path / runtime / rule_id / rule_source / discovered / load_mode / scope_condition | — |
| `observation` | kind / value / unit / method / scope / measured_at / source_ref | — |
| `absence` | target / searched（**全件**）/ method | searched は省略しない |
| `contrast` | path / note（何が正常例か 1 文）/ 必要なら line | — |

### 2.2 `CROSS_RUNTIME_DRIFT` の追加フィールド

```jsonc
"sides": [
  { "runtime": "claude-code", "path": "~/.claude/skills/finish/SKILL.md", "mtime": "2026-09-07T…", "normalized_hash": "sha256:a1b2…", "newer": true },
  { "runtime": "codex",       "path": "~/.agents/skills/finish/SKILL.md", "mtime": "2026-06-08T…", "normalized_hash": "sha256:c3d4…", "newer": false }
],
"diff": { "lines_differ": 202, "method": "multiset_symmetric_difference", "unified_excerpt": null },   // excerpt は --llm --diff で明示した時だけ
"doctor_did_not_conclude": ["which side is canonical"],
"decision_points": [{ "question": "Which side is canonical for `finish`?", "options": ["claude-code", "codex", "merge", "keep both intentionally"], "who_decides": "human" }]
```

### 2.3 `SCOPE_MISMATCH` の追加フィールド

```jsonc
"condition": { "line": 3, "text": "claude --channels telegram で起動している場合", "detector": "heuristic:launch_condition_ja", "confidence": "medium" },
"mechanism_available": { "kind": "paths_frontmatter", "example": "~/.claude/rules/family-scope.md", "rule_source": "docs:memory.md#path-specific-rules" },
"doctor_did_not_conclude": ["what the paths: glob should be", "whether the rule should move out of rules/ instead"]
```

## 3. `suppressed[]` と `protected[]`

Optimizer でないことを毎回示す部分。**省略不可。**

```jsonc
"suppressed": [
  { "reason": "count_is_not_a_symptom", "detail": "141 MCP tools across 16 servers; load_mode=deferred, fixed cost near zero", "count": 141 },
  { "reason": "invisible_by_specification", "detail": "72 bindings discovered=false because the path belongs to the other runtime (claude.skill.not_in_search_path / codex.skill.not_in_search_path)", "count": 72 }
],
"protected": [
  { "path": "~/.claude/projects/<slug>/memory/MEMORY.md", "size_bytes": 25798, "why": "memory/identity, protected by default. No proposal.", "glob": "**/MEMORY.md" }
]
```

## 4. Markdown 直列化（`--llm --format md`）

チャットに貼る用。JSON と同じ内容を、受け手が上から読む順に並べる。

```
# agent-doctor report (LLM handoff)
Scope: NEXT SESSION. Running sessions keep their startup state. Fixes apply on next launch.

## Contract
- You are receiving a diagnosis, not a work order. …（§1 handoff_contract をそのまま）

## F-001  ERROR  UNREACHABLE_REFERENCE / missing_target  (confidence: high)
~/.claude/agents/andy.md:28 references `vercel:react-best-practices`. …
Affected: claude-code ~/.claude/agents/andy.md (on_demand) · codex ~/.codex/agents/andy.toml (on_demand)
Evidence:
  - reference L28: `vercel:react-best-practices`  [skill_ref, high]
      26 | …
      28 | - `vercel:react-best-practices`: …
  - absence: plugin `vercel` not found in 4 places: enabledPlugins, installed_plugins.json, plugins/cache, marketplaces
  - contrast: anna.md:14 `frontend-design` resolves (discovered=true)
Doctor did not conclude: remove vs install; whether to change the codex copy together
Decision (human): install plugin / drop reference (both) / leave as is
Applies on: next session

## Not findings (do not propose changes)
- 141 MCP tools, deferred — count is not a symptom
- 72 bindings invisible by specification (other runtime's territory)
- MEMORY.md 25,798 B — protected
```

## 5. CLI 面（将来）

```
agent-doctor report --llm                       # JSON、全 Finding
agent-doctor report --llm --format md           # Markdown
agent-doctor report --llm --finding F-001       # 1 本だけ（token を絞る）
agent-doctor report --llm --diff                # CROSS_RUNTIME_DRIFT に unified diff 抜粋を含める（既定は行数だけ）
agent-doctor report --llm --no-redact           # HOME を ~ に置換しない
agent-doctor report --llm --receiver codex      # handoff_contract の言い回しを受け手向けに（内容は同じ）
```

## 6. 決めていないこと（実装前に決める）

1. **`resources_referenced` の粒度**: Finding が触れた Resource だけか、同じディレクトリの兄弟まで含めるか（SCOPE_MISMATCH の対照は兄弟が要る）
2. **excerpt の秘匿**: hook の `command` や MCP の `env` に秘密が入りうる。`--llm` は既定で値をマスクし、キー名だけ出す。マスク規則は snapshot 側と共通にする（snapshot にも同じ露出があるので、先に snapshot で決める）
3. **`decision_points` の生成規則**: Finding 種別ごとに固定文か、evidence から組むか。v0.1 は固定文
4. **受け手ごとの差**: Emma（ChatGPT）は貼り付け前提で Markdown、Claude / Codex は JSON をファイルで渡す前提。形式は同一、既定の `--format` だけ受け手で変える
5. **`related[]` の閉じ方**: 同一資源に複数 Finding が出た時に 1 つに畳むか、個別に出して related で結ぶか。v0.1 は個別 + related
