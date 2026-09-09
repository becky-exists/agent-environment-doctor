# round 2 — Claude（環境を読まない新規サブエージェント）の回答（要約、2026-09-07）

採点: **3 / 5**（1 周目と同じ。ただし到達した判断は深くなった）

## 到達できた判断
- drift 10 件を diff から 3 群に分けた: **A 実質差**（finish / becky-proofreader / becky-memory-tidy / image-prompt-director）、**B 語置換のみ**（CLAUDE.md→AGENTS.md、Claude→Codex。触らない）、**C 由来が別**（agent-reach の description）
- F-016 は誤検出、F-015 は 1 行修正の候補、B 群は「触らない」で閉じた
- vercel cluster は「使う / 使わない」の二択まで絞り、それぞれのレビュー手順を出した

## 4 にするために足りないもの（レポート側で埋められるもの）
1. plugin の中身（有効化しても当該 skill があるか）— coverage 外。今回は unknowns に明記のみ
2. codex の「disabled」の意味（enabled=false 明示か既定か）と層（<project>/.codex は未読）→ **round 2 後に summary に明記**
3. claude-code の「not installed」の層（user 層のみ）→ **同上**
4. 参照元が散文か機械解決フィールドか → **referrer_context を追加**
5. cluster レベルのパターン観測（codex 側 10 件中 9 件が同一分の mtime、語置換を含む diff の数、差分行数の分布）→ **pattern_observations を追加**
6. diff の向きの明示、truncated 時の全文への手段 → **ヘッダに '-'/'+' の意味、--diff-lines を追加**
7. protected 29 件の MEMORY.md が symlink か → **real_path を表示**
8. codex 側 invocation が「未使用」か「未計測」か → **not collected と明記**

## 受け手が挙げたが Doctor が持たない（持つべきでない）もの
- 同期スクリプトの有無（shell / launchd / cron は coverage 外、Phase 1）
- 修正の選択肢ごとの「触るファイル一覧」— 直し方の決め打ちに近い。Doctor は出さない

## 誘導・評価語
- ERROR の重さと「実害は測っていない」の衝突（→ referrer_context で散文であることを明示）
- drift の問いが「どちらか一方を選ぶ」前提（→ merge / 生成規則を含む問いに変更）
- diff の向きが読めない（→ 明示）
- 同サイズ MEMORY.md 29 行の列挙が重複を連想させる（→ symlink 先を表示）
