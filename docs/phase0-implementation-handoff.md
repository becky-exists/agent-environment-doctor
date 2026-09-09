# Agent Environment Doctor — Phase 0 Implementation Handoff

> 宛先: Codex（実装）。発注: ゆう。設計: ベッキー。2026-09-07。
> 前提文書: [design-review-v0.1.md](design-review-v0.1.md)（rev.2）/ [failure-patterns-v0.1.md](failure-patterns-v0.1.md)（rev.2）
> **Phase 0 の目的は診断機能を揃えることではない。「4 種の事実データが両 runtime で成立するか」の確認。**

## 0. Phase 0 の成立条件（これだけ）

```
1. Claude Code から Resource を収集できる
2. Codex から Resource を収集できる
3. 両方を同じ IR へ normalize できる
4. source → binding → observation を追跡できる
5. shared resource を突合できる
6. snapshot を保存し、次回 diff が取れる
```

診断は 3 つだけ実装する。`UNREACHABLE_REFERENCE` / `CROSS_RUNTIME_DRIFT` / `SCOPE_MISMATCH`。

**これが BECKY fixture で当たれば芯は成立。** 当たらなければ IR の切り方が間違っているので、機能を足す前に IR を直す。

## 1. やらないこと（Phase 0 の非スコープ）

明示的に**作らない**。作ると Phase 0 の判定が濁る。

- probe（実起動して確定させる層）。`probePlan()` の interface だけ切って中身は空
- 残り 11 個の Finding
- token の実測（tiktoken）。Phase 0 では `size_bytes` と文字数だけ持ち、**token 換算をしない**
- 自動修復（`--fix`）
- **`SESSION_STALENESS` の検出**（probe が必要なため Phase 1）。ただし**レポート種別の宣言は Phase 0 から必須**（§6.1 の `Report scope:` 行）。検出しないが、誤診を防ぐ宣言だけは最初から出す
- 公式 `/skill-doctor` 出力の取り込み
- MCP サーバーへの接続
- Claude / Codex 以外の adapter
- TUI / dashboard

**Phase 0 は READ ONLY。ファイルを 1 つも書き換えない**（`snapshot` の出力先だけ例外）。

## 2. IR スキーマ（実装の中心）

[design-review §4.2](design-review-v0.1.md) が正本。Phase 0 で必須のフィールドだけ再掲する。

### 2.1 Resource

```jsonc
{
  "resource_id": "sha256:<content_hash>",   // 必須。パスではなく内容 hash が同一性
  "kind": "skill|hook_script|instruction|agent_def|rule|mcp_server|plugin|memory|output_style",
  "name": "viv-call-prep",
  "path": "/Users/…/.claude/skills/viv-call-prep.md",   // 絶対パス。~ は展開して保存
  "owner": "user|project|plugin:<id>|shared|builtin",
  "content_hash": "sha256:…",
  "normalized_hash": "sha256:…",            // 必須。下記の正規化を通した後の hash
  "mtime": "2026-06-20T10:33:00+09:00",
  "size_bytes": 2410,
  "declared": { "name": "…", "description": "…", "frontmatter_keys": ["…"] },
  "references": [ { "raw": "vercel:react-best-practices", "line": 28, "syntax": "skill_ref" } ]
}
```

**正規化の規則**（`normalized_hash` 用、実装で固定すること）:
1. 改行を `\n` に統一
2. 行末の空白を除去
3. 末尾の空行を除去
4. **frontmatter は含める**（description の差分も drift として見たい）
5. それ以外は変更しない（本文の意味を変える正規化はしない）

理由: 改行コード差だけで `CROSS_RUNTIME_DRIFT` の偽陽性が出るのを防ぐ。一方で description の差は本物の drift。

### 2.2 Binding

```jsonc
{
  "resource_id": "sha256:…",
  "resource_path": "/Users/…/.claude/skills/x.md",   // 必須。一意キーの一部
  "runtime": "claude-code|codex",
  "runtime_version": "2.1.263",
  "discovered": false,                      // 必須
  "rule_id": "claude.skill.requires_dir_skill_md",   // 必須。§4 の規則表の ID
  "rule_source": "docs:skills.md#discovery-locations",
  "confidence": "high|medium|probe_required",
  "load_mode": "always|on_demand|deferred|path_conditional|never",
  "scope_condition": null,                  // paths glob 等
  "applies_to": ["session"],                // session|subagent
  "search_path": "/Users/…/.claude/skills/",
  "precedence": 2
}
```

`collectResources()` と `computeBindings()` を**必ず分ける**。Resource 収集は runtime バージョンを知らずに動く。これで仕様変更時の再計算が Binding に閉じる。

> **rev.3（2026-09-07、Codex 独立レビュー反映）**: Binding は `binding_id` / `mechanism` / `source_ref` を持つ。一意キーは `(runtime, resource_id, resource_path, mechanism, source_ref)`（`binding_id` はその hash）。`load_mode` に `unknown`、`ResourceKind` に `exec_policy`（Codex `.rules`）と `launcher` を追加。schema_version は 2。起動スクリプトは `--launcher` で明示した分だけ収集し、`--append-system-prompt "$(cat <path>)"` を `append_system_prompt` の別 Binding にする。正本は `src/ir/types.ts` と `docs/codex-review-result-phase0.md`。

⚠ **一意キーは `(resource_id, runtime, resource_path)`。`resource_id` だけでは足りない**（2026-09-07 Gate A で判明）。`resource_id` は content hash なので、内容が完全一致する資源が複数パスに在ると同じ id になる。実測で 175 Binding のうち 44 件が path 無しでは識別できず、同一環境の 2 回比較で偽の差分 16 件が出た。`~/.claude/skills/x/SKILL.md`（discovered=true）と `~/.agents/skills/x/SKILL.md`（探索対象外で false）が同一内容のとき、まさにこれが起きる。

### 2.3 Observation

Phase 0 で作る Observation は**この 3 種だけ**。

| kind | value | method | 出所 |
|---|---|---|---|
| `invocation` | 回数 | `transcript_scan` or `usage_record` | `~/.claude.json#skillUsage`、`pluginUsage` |
| `size` | バイト数 | `filesystem` | `stat` |
| `mtime` | ISO8601 | `filesystem` | `stat` |

```jsonc
{
  "resource_id": "sha256:…",
  "resource_path": "/Users/…/.claude/skills/x.md",   // 必須
  "runtime": "claude-code",
  "kind": "invocation",
  "value": 0,
  "unit": "count",
  "measured_at": "2026-09-07T10:15:00+09:00",
  "method": "usage_record",                 // 必須。証拠の等級
  "confidence": "high",
  "scope": "next_session"                   // 必須。Phase 0 は全部 next_session
}
```

一意キー: `(resource_id, resource_path, runtime, kind, method)`。**`method` と `scope` は必須。**

**`runtime` は null 可**（2026-09-07 実測で追加）。`size` / `mtime` は filesystem の事実で runtime の観測ではないため、`runtime: null` にして runtime を除いたキーで一意化する。これをやらないと、両 adapter が同じファイルを stat した時に同一の観測が 2 件入る（実測で 144 件の冗長が出た）。`invocation` は runtime 固有なので runtime を埋める。 token 換算は Phase 0 では作らない（`chars/4` を絶対に入れないこと。日本語で 2〜3 倍外れる。cclens が実際にこれで外している）。

### 2.4 Snapshot

```jsonc
{
  "snapshot_id": "2026-09-07T10:15:00+09:00",
  "schema_version": 1,
  "tool_version": "agent-doctor 0.1.0",
  "runtimes": [ { "runtime": "claude-code", "version": "2.1.263" },
                { "runtime": "codex", "version": "…" } ],
  "env": { "os": "darwin 25.6.0", "project": "/Volumes/SSD2TB/interventionworks" },
  "resources": [ /* Resource[] 全体を埋め込む */ ],
  "bindings": [ /* Binding[] */ ],
  "observations": [ /* Observation[] */ ]
}
```

`schema_version` を必ず持つ。diff は同一 `schema_version` 間でのみ行い、違えば「比較不能」と明示して落とす（黙って壊れた差分を出さない）。

## 3. 収集対象ファイルの完全リスト（実測済み）

BECKY 環境で実在を確認したパスのみ。**存在しないものは skip し、エラーにしない**（環境ごとに欠けるのが正常）。

### 3.1 claude-code adapter

| kind | パス | 形式 | 備考 |
|---|---|---|---|
| instruction | `~/.claude/CLAUDE.md` | md | 常時 |
| instruction | `<project>/CLAUDE.md` | md | 常時。親ディレクトリを root まで遡る |
| instruction | `~/.claude/output-styles/*.md` | md+fm | `settings.json#outputStyle` が指すものだけ有効 |
| memory | `~/.claude/projects/<slug>/memory/**` | md | **既定で protected** |
| rule | `~/.claude/rules/*.md`, `<project>/.claude/rules/*.md` | md+fm | `paths:` 有無で `load_mode` が変わる → **SCOPE_MISMATCH** |
| skill | `~/.claude/skills/*/SKILL.md` | md+fm | 発見される |
| skill | `~/.claude/skills/*.md` | md+fm | **発見されない** → `UNREACHABLE_REFERENCE` |
| skill | `<project>/.claude/skills/*/SKILL.md` | md+fm | project scope |
| skill | `~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills/*/SKILL.md` | md+fm | plugin 由来 |
| agent_def | `~/.claude/agents/*.md` | md+fm | `references` の抽出対象 |
| hook_script | `~/.claude/settings.json#hooks` | json | inline command と外部スクリプトの両方 |
| hook_script | `~/.claude/plugins/cache/**/hooks/hooks.json` | json | plugin 由来。`plugin.json#hooks` の相対参照も辿る |
| mcp_server | `~/.claude.json#mcpServers` | json | global |
| mcp_server | `~/.claude.json#projects.<path>.mcpServers` | json | project |
| mcp_server | `~/.claude/plugins/cache/**/.mcp.json` | json | plugin 由来 |
| plugin | `~/.claude/plugins/installed_plugins.json` | json | 実体の在処 |
| plugin | `~/.claude/settings.json#enabledPlugins` | json | 有効・無効 |
| settings | `~/.claude/settings.json`, `settings.local.json`, `<project>/.claude/settings*.json`, `~/.claude/managed-settings.json` | json | precedence: managed > project local > project > user |
| observation 源 | `~/.claude.json#skillUsage`, `#pluginUsage` | json | `invocation` |

**注意 3 点**:
- `~/.claude.json` は巨大（BECKY 環境で数 MB、`projects` に全プロジェクトの履歴を持つ）。**全体を読まず、必要なキーだけ streaming で拾う**
- `~/.agents/skills/**` は **claude-code の探索対象外**（公式確認済み）。claude-code adapter では収集するが `discovered: false, rule_id: "claude.skill.not_in_search_path"` にする。これが `CROSS_RUNTIME_DRIFT` の起点
- `settings.json` の `hooks` は 1 エントリに複数 hook の配列。**provenance に配列インデックスを含める**（`settings.json#hooks.PreToolUse[1].hooks[0]`）。同じスクリプトが複数箇所から呼ばれるので、位置まで特定しないと突合できない

### 3.2 codex adapter

| kind | パス | 形式 | 備考 |
|---|---|---|---|
| instruction | `~/.codex/AGENTS.md` | md | 常時（BECKY 環境で 21,289 B） |
| instruction | `<project>/AGENTS.md` | md | 常時（同 13,463 B） |
| agent_def | `~/.codex/agents/*.toml` | toml | **`.md` ではない。`developer_instructions` に md が埋まる** → `RUNTIME_FORMAT_DIVERGENCE` |
| rule | `~/.codex/rules/*.rules` | 独自 | BECKY 環境に `default.rules` 1 本。形式は要調査 |
| skill | `~/.agents/skills/*/SKILL.md` | md+fm | **codex 側の探索対象**。symlink を含む（実体が別リポにある） |
| skill | `~/.codex/skills/**` | md+fm | BECKY 環境では空 |
| hook_script | `~/.codex/hooks.json` | json | イベント: UserPromptSubmit / SessionStart / Stop |
| mcp_server | `~/.codex/config.toml#mcp_servers.*` | toml | `tools.<name>.approval_mode` の入れ子あり |
| plugin | `~/.codex/config.toml#plugins."<id>"` | toml | `enabled = false` が残る → `TOMBSTONE_ENTRY`（Phase 2） |
| plugin | `~/.codex/plugins/cache/**` | — | 実体 |
| settings | `~/.codex/config.toml` | toml | `projects."<path>".trust_level` あり |

**注意 2 点**:
- `CODEX_HOME` で別の home を指せる（BECKY 環境は `~/.codex-artdept` を cron で使用）。**環境変数を尊重し、複数 home を並列に扱えるようにする**
- symlink は `realpath` まで解決して `path` に記録し、**symlink 経由であることを `owner: "shared"` で表現する**。BECKY 環境の `~/.agents/skills/web-qa` は `<repo>/codex-skills/web-qa` を指す

### 3.3 参照の抽出（`Resource.references`）

`UNREACHABLE_REFERENCE / missing_target` の入力。**解決はせず、生文字列と位置だけ保存する。**

抽出パターン（Phase 0 はこの 3 つだけ、過剰に賢くしない）:

| syntax | 正規表現の意図 | 例 |
|---|---|---|
| `skill_ref` | バッククォート内の `<ns>:<name>` または既知 skill 名 | `` `vercel:react-best-practices` `` |
| `path_ref` | `~/` または絶対パスで始まるファイル参照 | `~/.claude/rules/telegram-channels.md` |
| `plugin_ref` | `<plugin>@<marketplace>` | `codex@openai-codex` |

**誤検出を許容する。** 解決フェーズで「参照先が存在しない」と出た時、それが本当に参照なのか単なる文中の文字列なのかは `confidence` で表現する。Phase 0 では `syntax` と行番号を残すことが目的。

## 4. discovery 規則（Phase 0 で実装する分）

`rule_id` として実装に焼く。**出典は公式ドキュメント**（`code.claude.com/docs/en/`）。

| rule_id | 規則 | 出典 | 支える Finding |
|---|---|---|---|
| `claude.skill.requires_dir_skill_md` | skill は `<dir>/SKILL.md` のみ。平置き `.md` は読まれない | skills.md | `UNREACHABLE_REFERENCE` |
| `claude.skill.search_paths` | Enterprise > Personal > Project > Plugin > Bundled | skills.md | `DUPLICATE_RESOURCE`（Phase 2） |
| `claude.skill.agents_dir_excluded` | `~/.agents/skills/` は探索対象外 | 公式確認 | `CROSS_RUNTIME_DRIFT` |
| `claude.rule.paths_optional` | `paths:` があれば条件付き、**無ければ常時ロード** | memory.md | `SCOPE_MISMATCH` |
| `claude.instruction.concat_order` | Managed > User > Project > 親遡り の順で**連結**（上書きでない） | memory.md | Activation |
| `claude.subagent.no_instruction_inherit` | SubagentStart は parent の CLAUDE.md / auto memory を継承しない | memory.md | `HOOK_AMPLIFICATION`（Phase 1） |
| `claude.plugin.disabled_not_loaded` | 無効 plugin の skill / MCP / hook は load されない | plugins.md | `UNREACHABLE_REFERENCE` |
| `codex.skill.agents_dir_included` | codex は `~/.agents/skills/` を探索する | 実測 | `CROSS_RUNTIME_DRIFT` |
| `codex.agent_def.toml` | agent 定義は `.toml`、`developer_instructions` に md が入る | 実測 | `RUNTIME_FORMAT_DIVERGENCE` |

`discoveryRules(version)` は**バージョンを引数に取る**。Claude Code は 2 週間で仕様が動くので、規則に `since` / `until` を持たせて版差を表現する。確定できないものは規則を書かず `confidence: "probe_required"` にして**断定しない**。

## 5. 診断 3 つの検出ロジック

### 5.1 `UNREACHABLE_REFERENCE`

2 つの subtype。どちらも「到達できない」の裏表。

```
subtype: undiscovered_declaration
  条件: Resource が存在し、かつ全 runtime の Binding が discovered=false
  severity: error
  出力: resource.path, rule_id, rule_source
  実例: ~/.claude/skills/*.md（平置き）13 本

subtype: missing_target
  条件: Resource.references[] の raw を解決した結果、対応する Resource が
        どの runtime にも存在しない
  severity: error
  出力: 参照元 path:line, raw 文字列, 探した場所のリスト
  実例: agents/andy.md:28 の `vercel:react-best-practices`
        （enabledPlugins / installed_plugins / cache / marketplaces のどこにも無い）
```

**解決の手順**（`missing_target`）:
1. `raw` を `<ns>:<name>` に分解
2. `ns` が plugin id なら、その plugin が installed かつ enabled か確認
3. plugin が無ければ「参照先の plugin 自体が不在」として報告
4. plugin があれば、その skill が存在するか確認
5. 探した場所を全部 `searched[]` に列挙して出力する（**なぜ無いと言えるかを示す**）

### 5.2 `CROSS_RUNTIME_DRIFT`

```
条件: 同一 name かつ同一 kind の Resource が 2 つ以上あり、
      それぞれが異なる runtime の Binding で discovered=true、
      かつ normalized_hash が異なる
severity: warn
出力: name, 各 runtime の path / mtime / normalized_hash / 差分行数、どちらが新しいか
非出力: どちらを正本にすべきかの提案（人が決める）
実例: finish（claude 2026-09-07 / codex 2026-06-08、diff 202 行）他 9 本
```

**同名だが別 runtime の探索パスにあるだけで二重ロードはしていない**ケースと、**同一 runtime 内で重複している**ケースを区別する。前者が `CROSS_RUNTIME_DRIFT`、後者が `DUPLICATE_RESOURCE`（Phase 2）。BECKY 環境の 26 本は全部前者。

差分行数の算出は `normalized_hash` が違うものだけに対して行う（全ペアに diff をかけない）。

### 5.3 `SCOPE_MISMATCH`

```
条件A（静的・確定）: rule kind の Resource で、Binding.load_mode == "always"
                     かつ 同ディレクトリに load_mode == "path_conditional" の
                     Resource が存在する（＝条件付きにできる機構があるのに使っていない）
条件B（heuristic）:  本文に起動条件を示す語がある
                     （「〜で起動している場合」「when launched with」「--<flag> セッション」等）
                     かつ load_mode == "always"
severity: warn（条件A+B の両方なら warn、B だけなら info）
confidence: A=high / B=medium
出力: path, load_mode, 検出した条件文の行, 同ディレクトリの対照例
実例: ~/.claude/rules/telegram-channels.md
      （paths: 無しで常時ロード、本文 1 行目が「claude --channels … で起動している場合」、
        同ディレクトリの family-scope.md は paths: 指定済み＝対照例）
```

**heuristic の語彙リストは設定ファイルに出す。** ハードコードすると言語や表現の違いで外す。Phase 0 は日本語と英語の各 3 パターンだけ入れて、`confidence: medium` で出す。

さらに: **同じ内容が別経路でも注入されているか**を突合する（`SHARED_RESOURCE_COUPLING` の入口）。BECKY 環境では起動スクリプトが `--append-system-prompt "$(cat <該当ファイル>)"` で同じ内容を注入していた。Phase 0 では**起動スクリプト内の `cat <path>` パターンを path_ref として抽出するところまで**やり、突合は Phase 2。

## 6. CLI 面（Phase 0）

```bash
agent-doctor scan                      # 既定: 全 runtime, human 出力, READ ONLY
agent-doctor scan --json               # 機械可読
agent-doctor scan --runtime claude-code
agent-doctor snapshot --out <file>     # 4 種の事実データを保存
agent-doctor diff <old> [<new>]        # snapshot 間差分。new 省略で現状と比較
agent-doctor explain <resource_id>     # source → binding → observation の連鎖を表示（★ 目玉）
```

`--probe` は**受け付けるが「Phase 1 で実装予定」と表示して終了**する（フラグの互換を先に確保）。

### 6.1 出力の必須要素

```
Report scope: NEXT SESSION (static analysis)
  Running sessions keep the snapshot they started with.
  Config changes take effect on next launch.

claude-code  2.1.263   /Volumes/SSD2TB/interventionworks
codex        <ver>     (CODEX_HOME=~/.codex)

resources 収集   claude-code 187 / codex 42   (shared 26)
protected        3 resources — excluded from findings

ERROR  UNREACHABLE_REFERENCE   14
  undiscovered_declaration  13   ~/.claude/skills/*.md (flat)
    rule: claude.skill.requires_dir_skill_md  (docs:skills.md#discovery-locations)
  missing_target             4   agents/andy.md:28 → `vercel:react-best-practices`
    searched: enabledPlugins, installed_plugins.json, plugins/cache, marketplaces
    also referenced by: codex ~/.codex/agents/andy.toml:24

WARN   CROSS_RUNTIME_DRIFT     10
  finish   claude-code 2026-09-07 (a1b2…) / codex 2026-06-08 (c3d4…)   202 lines differ
  → agent-doctor explain sha256:a1b2…

WARN   SCOPE_MISMATCH          1
  ~/.claude/rules/telegram-channels.md   load_mode=always
  condition found at line 3: "claude --channels … で起動している場合"
  compare: family-scope.md has paths: ["~/iw-personal/**"]

no findings for: 141 deferred MCP tools, MEMORY.md (25,798 B, protected)
```

**最後の行を必ず出す。** 「数が大きいが問題ではないもの」を Doctor 自身が毎回明示することで、Optimizer でないことを証明する。

### 6.2 言葉の規律

- 「削除」「不要」「無駄」「最適化」を出力に使わない
- **重い = 悪、使ってない = 不要 にしない**。大きさと未使用は事実として出すが、それ自体を欠陥として扱わない
- Doctor が担うのは **観測 → 証拠 → 症状** まで。治療しない
- Finding には必ず「なぜそう言えるか」（`rule_id` / `searched[]` / 対照例）を添える

## 7. fixture（BECKY 環境から起こす最小合成環境）

```
fixtures/
  unreachable-reference/
    env/
      home/.claude/skills/discovered-one/SKILL.md      # 発見される（対照）
      home/.claude/skills/flat-orphan.md               # 平置き＝発見されない
      home/.claude/agents/andy.md                      # `ghost:some-skill` を 1 行参照
      home/.claude/settings.json                       # enabledPlugins に ghost 無し
      home/.claude/plugins/installed_plugins.json      # ghost 無し
    expected.json
    notes.md      # 由来: 平置き役職スキル 13 本 / vercel:* 4 参照
  cross-runtime-drift/
    env/
      home/.claude/skills/finish/SKILL.md              # 新しい版
      home/.agents/skills/finish/SKILL.md              # 古い版（本文が違う）
      home/.claude/skills/same/SKILL.md                # 両方同一（対照、出ないこと）
      home/.agents/skills/same/SKILL.md
    expected.json
    notes.md      # 由来: finish diff 202 行 他 9 本
  scope-mismatch/
    env/
      home/.claude/rules/channels-only.md              # paths 無し + 本文に起動条件
      home/.claude/rules/family-scope.md               # paths 有り（対照）
      home/bin/start.sh                                # --append-system-prompt "$(cat …)"
    expected.json
    notes.md      # 由来: telegram-channels.md
  guard-false-bloat/
    env/
      home/.claude.json                                # mcpServers 多数
      home/.claude/projects/x/memory/MEMORY.md         # 大きい（protected）
    expected.json   # findings: [] ← ★ 何も出ないことが期待値
    notes.md      # 由来: MCP 141 tool / MEMORY.md 25,798 B
```

**規約 4 つ**:
1. 実環境をコピーしない。**1 fixture 1 症状**の最小環境
2. 各 fixture に**対照例を必ず入れる**（発見される skill、同一内容の skill、`paths` 有りの rule）。偽陽性を検出するため
3. `guard-false-bloat` の期待値は **`findings: []`**。これが製品思想の回帰テスト。**ここが落ちたビルドは、他が全部通っても不合格**
4. `notes.md` に由来を書く。**パス名と skill 名は書いてよい。人格・記憶の中身は書かない**（ゆう判断待ち、私の推し）

`HOME` を fixture の `env/home` に差し替えて実行する（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` も同様）。**実環境を読まないことをテストで保証する**。

## 8. 実装順序と検証ポイント

| # | やること | 完了の判定 |
|---|---|---|
| 1 | Resource / Binding / Observation / Snapshot の型と JSON Schema | schema で fixture の expected.json が validate できる |
| 2 | claude-code adapter の `collectResources()` | BECKY 実環境で skill / instruction / rule / agent_def / hook / mcp / plugin が収集でき、件数が §3.1 と合う |
| 3 | `computeBindings()` + discovery 規則 9 本 | 平置き `.md` 13 本が `discovered: false` かつ `rule_id` 付きで出る |
| 4 | 参照抽出（`references[]`） | `agents/andy.md` から `vercel:*` 4 件が行番号付きで取れる |
| 5 | codex adapter（同じ 2 つ） | `~/.codex/AGENTS.md` / `agents/*.toml` / `hooks.json` / `config.toml` が読め、`~/.agents/skills` の symlink が realpath 解決される |
| 6 | normalize（両 runtime を同一 IR へ） | 同じ `finish` が 2 つの Resource + 2 つの Binding として出る |
| 7 | 診断 3 つ | 各 fixture で expected.json と一致 |
| 8 | `snapshot` + `diff` | 同一環境で 2 回取って差分ゼロ。1 ファイル触って差分 1 件 |
| 9 | `explain` | 1 resource の source → binding → observation が表示される |
| 10 | Acceptance | §9 |

**2 と 5 の間で必ず止まって IR を見直す。** Codex 側を入れた瞬間に IR の破綻が出るなら、そこが Phase 0 の答え（＝IR の切り方が違う）。機能を足して隠さない。

## 9. Acceptance（Phase 0）

BECKY 実環境（2026-09-07 スナップショット）に対して:

**必ず検出する**

| # | 症状 | 期待 |
|---|---|---|
| 1 | 平置き skill 13 本 | `UNREACHABLE_REFERENCE / undiscovered_declaration` |
| 2 | `vercel:*` 参照 4 件（Claude 側） | `UNREACHABLE_REFERENCE / missing_target` |
| 3 | 同じ `vercel:*` が Codex 側にも複製 | 上記 finding に `also referenced by: codex …` が付く |
| 4 | 同名 skill 10 本の版ズレ | `CROSS_RUNTIME_DRIFT`、`finish` が 202 行差で最上位 |
| 5 | `telegram-channels.md` の scope | `SCOPE_MISMATCH`（現在は移動済みなので、fixture 側で検証） |

**絶対に検出しない（製品思想の担保）**

| # | 対象 | 理由 |
|---|---|---|
| 6 | MCP 141 tool | deferred で固定費ほぼゼロ。**数の多さを Finding にしない** |
| 7 | `MEMORY.md` 25,798 B | identity。protected。**重い = 悪にしない** |
| 8 | 3 か月発火ゼロの skill 群 | **使ってない = 不要にしない**。Phase 0 では Finding を出さない |
| 9 | 同一内容で重複している skill 16 本 | `normalized_hash` が同じなら drift ではない |

**6〜9 が 1 つでも Finding に出たら不合格。** 1〜5 が全部通っていても不合格とする。

## 10. 判断が必要な点（Codex → ゆう / ベッキー）

1. **実装言語**: ベッキーの推しは TypeScript（`npx` の摩擦の低さ、Claude 側が全部 JSON、plugin 同居）。Codex が Python の方が速いと判断するなら覆してよい。**唯一の条件は estimator に `chars/4` を使わないこと**（Phase 0 では token 換算そのものを作らないので、実質 Phase 1 の制約）
2. **`~/.claude.json` の読み方**: 数 MB あり `projects` に全履歴が入る。streaming parser を使うか、必要キーだけ抽出するか、実装者判断
3. **codex の `rules/*.rules` 形式**: BECKY 環境に `default.rules` が 1 本あるが形式未調査。Phase 0 では **kind だけ記録して中身を parse しない**でよいか
4. **fixture の `notes.md` の公開範囲**（ゆう判断）: パス名・skill 名は出る。人格・記憶の中身は出さない、がベッキーの推し

## 付記

Phase 0 は**機能を作るフェーズではなく、IR が現実に耐えるかを確かめるフェーズ**。診断が 3 つしかないのは意図的。Resource / Binding / Observation / Snapshot の 4 種で両 runtime の事実が素直に表現できるなら、残りの Finding は同じ土台の上に足すだけになる。表現できないなら、Phase 0 で判明したことが最大の成果になる。
