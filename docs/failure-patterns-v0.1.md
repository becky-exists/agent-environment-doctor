# Failure Pattern カタログ v0.1 — 実環境から一般化

> 出典: 2026-09-07 の BECKY 環境（Claude Code 2.1.263 + Codex）棚卸しの実測。
> **全パターンに実測された実例がある**（合成した仮想ケースはゼロ）。各パターンは fixture 化して detector の回帰テストにする。
> 設計本体は [design-review-v0.1.md](design-review-v0.1.md)。Phase 0 の実装指示は [phase0-implementation-handoff.md](phase0-implementation-handoff.md)。
> **rev.2 (2026-09-07)**: 診断項目に正式 ID（SCREAMING_SNAKE）を付与し、4 軸との対応表を追加。P1/P2 は `UNREACHABLE_REFERENCE` の 2 つの subtype に統合。

## 4 軸との対応

観測軸（Presence / Activation / Provenance / Temporal）と Finding の対応。**軸は観測次元、以下は症状**。

| Finding | 導出元の軸 |
|---|---|
| `UNREACHABLE_REFERENCE` | Presence / Reachability |
| `CROSS_RUNTIME_DRIFT` | Presence × Provenance × Temporal |
| `RUNTIME_FORMAT_DIVERGENCE` | Presence × Provenance |
| `TOMBSTONE_ENTRY` | Presence × Temporal |
| `SCOPE_MISMATCH` | Activation / Scope |
| `HOOK_AMPLIFICATION` | Activation × Temporal |
| `FIXED_COST_WITHOUT_USAGE` | Activation × Temporal |
| `PROTECTED_HEAVY` | Activation（+ protected フィルタ） |
| `SHARED_RESOURCE_COUPLING` | Provenance / Lineage |
| `DUPLICATE_RESOURCE` | Presence × Provenance |
| `BASELINE_REGRESSION` | Temporal State |
| `SESSION_STALENESS` | Temporal × Activation（`Observation.scope` の食い違い） |
| `FALSE_BLOAT_GUARD` | （ガード。他 Finding に作用） |

## 読み方

| 欄 | 意味 |
|---|---|
| severity | `error` = 機能が壊れている / `warn` = 固定費や整合性の問題 / `info` = 事実の提示のみ、行動を促さない |
| 検出可能性 | `static` = ファイルだけで判定できる（v0.1 対象）/ `probe` = 実際に起動しないと確定しない（v0.2）/ `history` = baseline 差分が必要 |
| protected 相互作用 | protected 指定された対象に当たった時の振る舞い |

---

## P1. `UNREACHABLE_REFERENCE` / `undiscovered_declaration` — 宣言側が到達不能

宣言は存在するが、loader の探索規則に合わず**一度も発見されていない**。

- **検出**: 各 adapter の discovery 規則を実装し、宣言ファイルがその規則を満たすか判定。満たさない＋usage 記録ゼロで確定。
  **ただし `search_path.in_search_path === false`（他 runtime の領域）は対象外**。そこに在るのは正常なので Observation に留める（下記「判定基準」節）
- **severity**: `error`（能力があると思っているのに無い＝判断が狂う）
- **検出可能性**: static
- **実例**: `~/.claude/skills/` 直下に平置きされた 13 本の役職スキル（`viv-account-research.md` 等）。frontmatter に name/description があり内容も完成しているが、Claude Code は `<dir>/SKILL.md` 形式しか読まないため 2026-06-20 の作成から 2026-09-07 まで **80 日間、一度も発見されなかった**（skillUsage 記録ゼロ、全 transcript に発動痕跡ゼロ）
- **fixture**: `skills/foo.md`（平置き、有効な frontmatter）と `skills/bar/SKILL.md` を並べ、前者だけが unreachable と出ること
- **protected 相互作用**: なし

## P2. `UNREACHABLE_REFERENCE` / `missing_target` — 参照側が到達不能

設定や指示書が、**存在しない capability** を使える前提で参照している。

- **検出**: 全 instruction / agent 定義から capability 参照（`name:` 形式、skill 名、plugin 名）を抽出し、実在する capability 集合との差集合を取る
- **severity**: `error`
- **検出可能性**: static
- **実例 A**: `~/.claude/agents/andy.md` に 3 行、`claire.md` に 1 行、`vercel:*` スキルを「自動起動 / 連携スキル」として参照。しかし vercel plugin は enabledPlugins・installed_plugins・plugin cache・marketplace の**すべてから消えている**（完全アンインストール済み）
- **実例 B**: 同じ `vercel:*` 参照が Codex 側 `~/.codex/agents/andy.toml` にも複製されている → **P3 と複合**。片方の runtime だけ直しても残る
- **実例 C**: `~/.claude/CLAUDE.md` が P1 の 13 本を「`~/.claude/skills/` に `viv-*` / `becky-*` …」と使用可能な前提で案内していた（2026-09-07 に修正済み）
- **fixture**: agent 定義が `ghost:skill` を参照し、その plugin がどのマニフェストにも無い状態
- **protected 相互作用**: なし

## P3. `CROSS_RUNTIME_DRIFT` — runtime 間の版ズレ

同名 capability が複数の agent 環境に存在し、**内容が異なる**。

- **検出**: capability 名でクロス結合し、内容 fingerprint（正規化後ハッシュ）と mtime を比較。差分行数と新旧を出す
- **severity**: `warn`
- **検出可能性**: static
- **実例**: `~/.claude/skills/` と `~/.agents/skills/`（Codex 側が参照）の同名 26 本のうち、完全一致 16 / **内容差分 10**。最悪は `finish`（Claude 側 2026-09-07 更新 / Codex 側 2026-06-08 のまま、**diff 202 行**）と `becky-proofreader`（diff 190 行）。Codex は 3 か月前の版を正本として動いていた
- **fixture**: 2 つの root に同名 skill を置き、片方だけ内容を変える
- **protected 相互作用**: なし（drift は報告するが、どちらを正本にするかは提案しない）

```
実測スナップショット（2026-09-07）
finish                claude=2026-09-07  codex=2026-06-08  diff 202 行
becky-proofreader     claude=2026-07-19  codex=2026-06-08  diff 190 行
becky-memory-tidy     claude=2026-08-28  codex=2026-06-08  diff  53 行
image-prompt-director claude=2026-07-29  codex=2026-06-08  diff  16 行
agent-reach           claude=2026-07-03  codex=2026-06-10  diff  11 行
（他 5 本は diff 2〜8 行）
```

## P4. `RUNTIME_FORMAT_DIVERGENCE` — 同一概念の形式分岐

同じ概念が agent 環境ごとに**別形式・別本数**で存在し、同期経路が無い。

- **検出**: adapter が「概念」単位（agent 定義 / instruction / hook）で正規化した後、集合差と形式差を出す
- **severity**: `warn`
- **検出可能性**: static
- **実例**: 同じ 6 名のロール人格が Claude では `.md` 6 本（andy/anna/becky/claire/michael/viv）、Codex では `.toml` 5 本（becky が無い）。description 本文は人手コピーで、`developer_instructions` に同じ Markdown が埋め込まれている
- **fixture**: `agents/x.md` と `agents/x.toml` を置き、一方にしか存在しない `y` を混ぜる
- **protected 相互作用**: なし

## P5. `TOMBSTONE_ENTRY` — 墓標エントリ

無効化・削除済みなのに設定ファイルにエントリが残る。

- **検出**: `enabled: false` 相当のエントリと、実体（cache / manifest）の不在を突き合わせる
- **severity**: `info`（実害は無い。ただし P2 の温床であることを示すので、P2 と同時に出た場合は `warn` に昇格）
- **検出可能性**: static
- **実例**: Codex `~/.codex/config.toml` の `[plugins."vercel@claude-plugins-official"] enabled = false`。Claude 側はエントリ自体が消えているのに、Codex 側には無効化の記録が残る。**同じ plugin の状態が 2 runtime で別の形をしている**
- **fixture**: `enabled = false` のエントリ + cache 不在
- **protected 相互作用**: なし

## P6. `SCOPE_MISMATCH` — scope の取り違え

特定文脈でしか使わない instruction が、**全セッションに常時ロード**されている。

- **検出**: 条件付きロード機構（Claude の rule `paths:` 等）を持つディレクトリ内で、条件が未指定のファイルを列挙。加えて本文に含まれる起動条件の記述（「〜で起動している場合」等）と、実際の scope 指定の食い違いを検出
- **severity**: `warn`
- **検出可能性**: static（本文の意図読みは heuristic なので `warn` 止め、確定は probe）
- **実例**: `~/.claude/rules/telegram-channels.md`（3,556 B）。本文 1 行目が「`claude --channels …` で起動している場合、以下を守る」なのに `paths:` 未指定のため全セッションに載っていた。さらに起動スクリプトが `--append-system-prompt "$(cat …)"` で同じ内容を注入しており、**channels セッションでは二重ロード / 通常セッションでは無用な固定費**。同ディレクトリの `family-scope.md` は `paths:` 指定済みで対照例になる
- **fixture**: `paths:` 有りと無しの rule を並べ、本文に起動条件の文言を含める
- **protected 相互作用**: なし

## P7. `HOOK_AMPLIFICATION` — hook の増幅注入

hook が同一 payload を**セッションとサブエージェントの両方**に注入し、実効コストが呼び出し回数に比例する。

- **検出**: hook を dry-run 実行して stdout バイト数を測り（副作用の無い hook のみ、allowlist 制）、発火イベント数 × 過去の発火回数（サブエージェント起動回数を transcript から集計）で実効コストを推定
- **severity**: `warn`
- **検出可能性**: probe（バイト数）+ history（発火回数）。静的には「同一スクリプトが複数イベントに登録されている」ことまで
- **実例**: ponytail plugin が `SessionStart` と `SubagentStart` に同じ 5,322 B（約 1,330 token）のペルソナ全文を注入。実測で直近 30 日 225 セッション中コードを書いたのは 26（12%）、Agent 起動 75 回のうち 26 回はコードを書かない役（michael/anna/claire/viv）だった。**本体で約 300k token / サブエージェントで約 100k token を月に払い、88% のセッションで適用対象が無かった**
- **fixture**: SessionStart と SubagentStart に同一スクリプトを登録した hook 設定 + 固定長を吐くダミースクリプト
- **protected 相互作用**: hook が protected（identity 注入等）に指定されていれば `info` に降格

## P8. `FIXED_COST_WITHOUT_USAGE` — 固定費だけ払う resource

起動時に description 等の固定費を払うが、長期間発火していない。

- **検出**: `fixed_cost_tokens > 0` かつ `usage.count == 0`（または `last_used_at` が閾値より古い）
- **severity**: `info`（**warn にしない**。使用頻度が低いことは不要の証明ではない）
- **検出可能性**: static + history
- **実例**: 全 92 skill のうち直近 30 日の発火は 8 本。3 か月以上ゼロのものが多数（`becky-observer-check` `setup-audit` 等）。ただしこれらは運用・自発行動の武器で、**削除対象ではない**と人が判断した
- **fixture**: usage 記録の無い skill + 記録のある skill
- **protected 相互作用**: protected なら出力から除外可（`--include-protected` で表示）
- **⚠ 設計上の要求**: このパターンの出力に「削除」「不要」という語を使わない。`fixed cost N tok, last fired: never` という事実だけを出す

## P9. `FALSE_BLOAT_GUARD` — 誤検知を抑制するガード

「多い」ことを問題として報告してしまう誤検知を、**Doctor 自身が抑制する**ためのパターン。

- **検出**: 遅延ロード機構（deferred / on-demand）に載っている capability を識別し、固定費を実測ゼロとして扱う。数の多さを severity に反映させない
- **severity**: `info` のみ
- **検出可能性**: static（機構の識別）+ probe（実際に載っていないことの確認）
- **実例**: MCP 由来 120 本 + 組み込み 21 本 = 141 tool。数だけ見れば最大の肥大化要因に見えるが、`tengu_deferred_stub_tool` により**名前だけが載りスキーマ本文は載らない**ため固定費はほぼゼロ。「141 tool あるから削れ」は誤診
- **fixture**: deferred 機構が有効な環境と無効な環境を用意し、同じ tool 数で固定費の判定が変わること
- **protected 相互作用**: なし
- **⚠ 設計上の要求**: このパターンは「検出したら報告する」ではなく「**他のパターンが誤検知するのを止める**」ためのガード。regression test の主目的

## P10. `PROTECTED_HEAVY` — 重いが保護対象

固定費は大きいが、identity / memory / 契約に属するため削減対象外。

- **検出**: protected 指定（設定ファイル or デフォルト glob）に一致する重い項目
- **severity**: `info`
- **検出可能性**: static
- **実例**: auto-memory の `MEMORY.md` 25,798 B。単体で最大の固定費だが、人格の起動手順と記憶の索引であり、token 節約目的で削るのは禁止と人が明示的に決めた
- **fixture**: protected glob に一致する大きなファイル + 一致しない大きなファイル。前者が warn を出さないこと
- **protected 相互作用**: **これが protected 機構そのものの試験**
- **⚠ 設計上の要求**: protected はデフォルトで安全側（memory / identity / soul 相当のパスは初期値で protected）

## P11. `SHARED_RESOURCE_COUPLING` — 共有リソースへの多重依存

複数の agent 環境が**同一の外部スクリプト・ファイル**に依存し、片方の変更が他方を壊しうる。

- **検出**: adapter 横断で hook command / MCP command のパスを正規化し、2 環境以上から参照されるものを列挙
- **severity**: `info`（意図的な共有もある。ただし片方にしか無い前提条件があれば `warn`）
- **検出可能性**: static
- **実例**: `stop_hook_tts.py`（音声読み上げ）を Claude の `settings.json` と Codex の `hooks.json` の**両方**が Stop hook として呼ぶ。venv パスは Claude 側の想定で書かれている
- **fixture**: 2 つの adapter が同じスクリプトパスを hook に登録
- **protected 相互作用**: なし

## P12. `DUPLICATE_RESOURCE` — 重複 resource

同名 capability が複数の探索パスに存在し、どちらが効いているか不明。

- **検出**: 同一 adapter の探索パス内で名前衝突を検出し、優先順位規則を適用して「実際に効く方」を確定、他を shadowed として報告
- **severity**: `warn`（内容が一致していれば `info`）
- **検出可能性**: static
- **実例**: `~/.claude/skills/` と `~/.agents/skills/` に同名 26 本。ただし**この 2 つは別 agent の探索パス**なので Claude 内での二重ロードは発生しておらず、実体は P3（drift）だった。**「重複しているが実害は無い」と「重複して二重ロードしている」を分けて報告する必要がある**という設計要求がここから出た
- **fixture**: 同一 adapter 内の重複（実害あり）と、別 adapter 間の同名（実害なし）の両方
- **protected 相互作用**: なし

## P13. `BASELINE_REGRESSION` — 経年肥大化

過去の snapshot と比較して固定費や項目数が増えている。

- **検出**: `snapshot` で保存した JSON と現状を差分。増分の内訳（どの capability が増えたか、どの hook が増えたか）を出す
- **severity**: `info`
- **検出可能性**: history
- **実例**: 未取得（v0.1 の snapshot 機構が無いため）。**2026-09-07 の実測値を最初の baseline とする**:

```
claude-code / project=/Volumes/SSD2TB/interventionworks  (2026-09-07)
  startup floor          約 36,600 token（cclens overhead 実測、最小構成比較は 6,082）
  instruction 常時        user CLAUDE.md 18,381 B + repo CLAUDE.md 11,240 B + MEMORY.md 25,798 B
  skill description       92 本 / 約 30,000 字
  deferred tool           141 本（固定費ほぼゼロ）
  agent description       13 種
  SessionStart hook 出力  約 11,400 B（7 本）

codex  (2026-09-07)
  instruction 常時        ~/.codex/AGENTS.md 21,289 B + repo AGENTS.md 13,463 B
  agent 定義              5 本（.toml）
  hook                    3 イベント（UserPromptSubmit / SessionStart / Stop）
  plugin                  8 エントリ（うち 1 は tombstone）
```

- **fixture**: 2 世代の snapshot JSON

## P14. `SESSION_STALENESS` — 起動中セッションに残る旧状態

設定ファイルを移動・削除・無効化しても、**すでに起動しているセッションのコンテキストからは消えない**。

- **検出**: 静的診断（ファイル）と、実行中セッションの実体（transcript の system prompt、または probe の自己申告）を突き合わせる。両者が食い違ったら報告
- **severity**: `warn`（人が「直したのに直っていない」と誤認する。Doctor を信用できなくする最も危険な種類の食い違い）
- **検出可能性**: probe / transcript
- **実例（自己観測、2026-09-07）**: `~/.claude/rules/telegram-channels.md` をこのセッションの途中で `~/.claude/channel-prompts/` へ移動した。移動後に起動した新規セッション 3 本では本文固有の語句（「返信の鉄則」「二重ベッキー対策」）が**載っていない**ことを probe で確認。しかし**移動を実行した当セッション自身のコンテキストには、旧パスの rule 全文が最後まで載り続けた**（session 開始時に `Contents of /Users/<home>/.claude/rules/telegram-channels.md` として注入され、ファイル移動後も消えない）。同様に、無効化した plugin の capability も起動中セッションでは参照可能なままだと推定される（ゆうの観測。plugin での直接実測は未実施）
- **fixture**: probe を 2 回走らせる。1 回目の起動 → 設定ファイルを移動 → 同じセッションで再問い合わせ、で消えないこと。新規セッションでは消えること
- **protected 相互作用**: なし

### この発見が設計に課す前提

**Doctor が診断するのは「次に起動するセッションの Effective State」であって、「今動いているセッションの状態」ではない。** これを出力に明記しないと、ユーザーは「Doctor が直ったと言ったのに Claude の挙動が変わらない」と混乱する。

- 出力ヘッダに診断対象を明示する: `Effective state for: NEXT session (current sessions retain their startup snapshot)`
- 設定変更を伴う修正提案（Doctor は自動適用しないが提案はする）には「反映には新規セッションが必要」を添える
- Doctor 自身が Claude Code のセッション内から実行された場合、**自分のコンテキストと自分の診断結果が食い違うのが正常**。これを異常として報告しない

---

## discovered=false を Finding にしない判定基準（2026-09-07 ゆう指示）

実測で `discovered=false` が 73 件出た。**このうち 72 件は Finding ではなく Observation。**

| 実例 | 件数 | 判定 | 理由 |
|---|---|---|---|
| `~/.agents/skills/**` が Claude から見えない | 32 | **Observation** | 公式に探索対象外。Codex のために置いてある。仕様どおり |
| `~/.claude/skills/**` が Codex から見えない | 40 | **Observation** | 同じく仕様どおり。逆向きの対称 |
| Codex の `vercel` plugin `enabled = false` | 1 | **Observation** | 意図的な無効化。ただし**参照が残っていれば** `UNREACHABLE_REFERENCE` |
| 探索対象パスに平置き `.md` で置かれた skill | 0（退避済み） | **Finding** | 発見される場所に、発見されない形式で置かれている＝形式の誤り |

### 判定基準

**「探索対象外の場所に置いてある」と「探索対象の場所に誤った形式で置いてある」を分ける。**

```
discovered=false のとき:
  search_path.in_search_path === false
    → その runtime の領域ではない。Observation。Finding にしない
  search_path.in_search_path === true かつ 形式が規則に合わない
    → 発見される場所に置いたのに発見されない。Finding（UNREACHABLE_REFERENCE）
  参照側が解決できない
    → Finding（UNREACHABLE_REFERENCE / missing_target）
```

`Binding.discovered === false` それ自体は症状ではない。**「見えないこと」が意図に反しているかどうか**が症状。意図の判定材料は `search_path.in_search_path`（そこは誰の領域か）。

この基準を守らないと、正常な cross-runtime 構成で 72 件の偽 Finding が出る。**`guard-false-bloat` と並ぶ、Doctor が Optimizer に堕ちないための第 2 のガード。**

---

---

## パターン間の関係（detector の実行順に影響）

```
P1 unreachable ──┐
                 ├─→ P2 dangling（不在の確定に P1 の判定が必要）
P5 tombstone ────┘
P12 duplicate ───→ P3 drift（同名検出が前提）───→ P4 format-divergence
P7 amplification ─→ P8 fixed-cost（実効コストの算出に必要）
P9 false-bloat ──→ 全 warn パターンへのガード（最後に適用）
P14 stale-session ─→ 診断対象の宣言（出力ヘッダ。全パターンの解釈枠）
P10 protected ───→ 全パターンへのフィルタ（最初に適用）
```

**実行順**: P10 で protected をマークして全体をフィルタ → 静的検出（P1/P2/P5/P12/P3/P4/P6/P11）→ コスト算出（P8、probe があれば P7）→ **P9 で誤検知を抑制** → P14 の前提を出力ヘッダに付けて出力。

## fixture の構造（提案）

```
fixtures/
  <pattern-id>/
    env/                    # 最小の合成環境（HOME を差し替えて食わせる）
      .claude/…
      .codex/…
      repo/…
    expected.json           # 出す findings（id, severity, target, provenance）
    notes.md                # 由来（どの実例を最小化したものか）
```

実環境を丸ごとコピーしない。**1 パターン 1 症状**の最小環境にする。実例の由来は notes.md に残し、実測値（P13 の baseline）だけ別途保管する。

## 未検証・要実測

- **P7 の probe 安全性**: hook を dry-run するのは副作用のリスクがある（今回 ponytail はフラグファイルを書いた）。allowlist と `--no-probe` 既定が必要
- **plugin 無効化の即時性**: rule ファイルでは P14 として**自己観測で確定**（移動しても当セッションからは消えない）。ただし **plugin での直接実測は未実施**。plugin の capability も同様に残るかは要確認（残ると推定）
- **Effective の確定手段**: 今回は `claude -p` で起動して「context に文字列 X があるか」を自己申告させる方法で確定させた（ponytail 注入ゼロ、telegram rule 消失を各 3 本で確認）。これが唯一の確定手段なら v0.2 の probe の中核になるが、トークンを消費するので既定 off
