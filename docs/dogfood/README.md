# report --llm ドッグフード記録

実環境（BECKY、Claude Code 2.1.263 / Codex 0.153.4、`--launcher ~/bin/becky-start.sh`）の `report --llm --format md` を、
**レポートしか読めない**受け手 2 者に渡し、「このレポートだけで妥当な修正判断まで辿れるか」を 1〜5 で採点させた。
受け手は Codex（`codex exec --sandbox read-only`、report.md 以外を読まない指示）と、環境を読まない新規の Claude サブエージェント。

| round | 日時 | Codex | Claude | 主な不足 → 対応 |
|---|---|---|---|---|
| 1 | 2026-09-07 17:2x | **2 / 5** | **3 / 5** | drift の差分本文が無い / 「9 places」が列挙されていない / claude 側の plugin 状態が不明 / 「newer」が正本を暗示 / 根本原因で束ねてほしい / severity の基準が不明 / protected 一覧が切れている / snapshot id が無い / rule 名の不整合（agent_def に skill の規則）/ codex 側の使用記録が無い（→ claude の回数が写っていた欠陥を発見） |
| 2 | 2026-09-07 17:5x | **2 / 5** | **3 / 5** | 点は動かず、中身が動いた。Codex: 残る不足は「無効化の意図・正本・実行時影響・plugin の中身・検証手順」= 静的 Doctor が持たない層に収束。diff を見て F-012〜014 を「runtime 固有の置換」と読み、F-016 をラベルと見抜いた。Claude: drift を A 実質差 / B 語置換 / C 由来別 の 3 群に分け、B は「触らない」で閉じた。「4 にするには」= plugin の中身 / disabled の意味と層 / 散文か機械解決か / cluster のパターン観測 / diff の向き → **round 3 用に反映済み**（commit 下記） |

原文: `round1-codex.md` / `round1-claude.md` / `round2-*.md`

## round 1 → 2 で変えたこと（commit 88a2ef87）
- drift: unified diff の抜粋（上限 80 行）+ 正規化の定義 + 同名ペアの母数 + 両側の size / real_path / 発火記録。「newer」→「後に触られた方であって正しさではない」
- missing_target: plugin 状態を runtime ごとに。absence の探索先を全件列挙。「exists but is disabled」→ 中立表現
- 同じ根本原因で cluster（vercel ×4 / drift ×10）、人への問いは cluster 単位で 1 つ
- severity / confidence の basis を毎 Finding に。snapshot_id。protected は glob 別に全量。affected に protected が含まれるなら protected_paths
- agent_def の rule_id を正す。**claude の skillUsage 回数が ~/.agents 側の複製に付いていた欠陥**を修正（Doctor 自身のバグをドッグフードが見つけた）

## 受け手が「レポートに無い」と言ったが、Doctor が持たない（持つべきでない）もの
- 修正後の検証手順・ロールバック手順 — 修正側の仕事。Doctor は治療しない
- plugin を有効化した時にその skill が本当に提供されるか — plugin の中身は coverage 外。unknowns に明記した
- 実害（起動中に何が起きるか）— --probe（Phase 1）。static の限界として unknowns に明記した
- 「意図的な分岐か」— 環境に意図の記録が無い。人に聞く問いとして残す

## round 2 → 3 で変えたこと
- cluster に **pattern_observations**（結論なし、事実のみ）: mtime の同一分クラスタ（codex 側 9/10 が 2026-06-08T05:54）、Claude→Codex 語置換を含む diff の数（6/10）、差分行数の分布
- missing_target に **referrer_context**（参照元は散文で、runtime が起動時に解決するフィールドではない。実行時の影響は未観測）
- plugin 状態に層と明示性: `claude-code: not installed (user layer only; project-layer enabledPlugins not read)` / `codex: disabled (enabled=false set explicitly, $CODEX_HOME layer only)`
- diff ヘッダに '-' / '+' の意味、`--diff-lines <n>` で全文に近づける。invocation の null は「not collected」と明記
- protected に symlink 先（29 件の MEMORY.md は 1 本の実体への symlink）
- drift の問いを「どちらか」前提から「同じにするなら共有内容は何か（片側 / merge / 生成規則）」へ

## 判定（v0.1 の芯として）
2 者とも「レポートだけで **正しい質問に辿り着ける**」「F-016 の誤検出と B 群の『触らない』は確定できる」まで到達した。
「修正判断まで辿れるか」で点が伸びないのは、残りが **意図・正本・実行時影響** という、静的 Doctor が持たず人が答える層だから。
Doctor の仕事は観測 → 証拠 → 症状。ここで人へ渡るのは設計どおり。round 3 は必要になった時に回す（`docs/dogfood/` に手順が残っている）。
