# round 1 — Claude（環境を読まない新規サブエージェント）の回答（要約、2026-09-07）

採点: **3 / 5**

## 判断
- F-001〜003（vercel:*）: 保留。根本原因が同じ（vercel plugin disabled）なので 1 つの判断で分岐。「使う」なら plugin マニフェストに当該 skill が本当に含まれるかを先に確認、claude-code 側の plugin 状態が書かれていないので現状確認から。「要らない」なら両 runtime の該当行を同じ commit で揃える
- F-004（vercel:ai-sdk、protected）: 変更しない寄り。引用行は仮定形の列挙で起動時に何かを解決する記述ではない。ERROR は機械的基準によるもので実害は薄い
- F-005〜009（差分が大きい drift）: 保留。~/.agents 側の mtime が全部 2026-06-08T05:54:1x（同一秒台）→ 6/8 に一括コピーされ以後 claude 側だけ育った、と読める。**diff の中身が無いので codex 固有の書き換えがあるか分からず同期してよいか判断できない**
- F-010〜014（差分 2〜8 行）: 変更しない。3 件はバイト数が完全一致で「4 行差」→ 機械的な置換の可能性。差分表示が出てから再判断
- F-015（superpowers）: 保留、低優先
- F-016（ctrl:despawn）: 変更しない。agmsg の制御メッセージ種別。抽出の偽陽性

## レポートだけでは判断できなかったこと（13 点）
1. 「Searched 9 places」の 9 箇所が列挙されていない
2. claude-code 側の vercel plugin 状態が一切書かれていない
3. disabled な plugin が本当にその skill 名を提供するかが未確認
4. drift の diff 内容が無い。normalized の定義も不明
5. 同名ペアの母数が無い（26 中 10 なのか、ほぼ全部なのか）
6. ~/.agents 側が symlink か実体かが明記されていない
7. 参照が到達不能だった時の runtime 上の帰結が書かれていない
8. ERROR / WARN の判定基準が明文化されていない
9. protected の付与が一貫していない（AGENTS.md は F-001〜003 でも Affected なのに protected 表示は F-004 だけ）
10. protected 一覧が「… and 28 more」で切れている
11. binding の rule 名に整合しない箇所（agent_def に `claude.skill.search_paths`）
12. snapshot ID / 実行 ID が無い
13. codex 側の usage 記録が未収集

## 誘導・評価語
- 「The claude-code copy is newer.」が要約末尾にあり「新しい方へ揃える」を暗示
- 「exists **but** is disabled」の but が有効化の方向を持つ
- 「Is X **still** wanted?」が「かつて望まれていた」前提を含む
- TOMBSTONE_ENTRY（墓石）は「残骸」に近い評価語
- Finding が confidence high なのに支える binding が medium（較正）

## 形式の改善提案
1. 根本原因でクラスタ化（vercel ×4 / 6-8 一括コピー後の分岐 ×10）、人への質問は cluster 単位
2. 各 finding に「runtime 上の帰結」と選択肢の列挙（順位なし）
3. drift に差分の要約、母数と protected 全量を付録、snapshot ID を先頭に
