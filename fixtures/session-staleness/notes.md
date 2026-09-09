# session-staleness — 由来

2026-09-07 に実際に踏んだ症状。`~/.claude/rules/telegram-channels.md` を `~/.claude/channel-prompts/` へ移動したところ、
新規セッションからは消えたのに、**移動を実行した当のセッションには最後まで載り続けた**。
「直したのに直っていない」に見えるやつで、Doctor の信用を一度で失う種類の食い違い。

## この fixture が含む 3 つのケース

| セッション | entrypoint | 期待 |
|---|---|---|
| `aaaa1111…` | `cli` | `moved-away` を持っているが今は発見されない形式 → **capability_present_but_unconfigured**。さらに常時ロード rule が起動後に変わっている → **resource_changed_after_start** |
| `bbbb2222…` | `sdk-py` | capability は比較しない（起動フラグで絞られるため）。時刻だけ比較 → **resource_changed_after_start のみ** |
| `cccc3333…` | `cli` | **Doctor 自身のセッション**として指定。同名だが説明文が違う `moved-away` を持つ。何も報告してはいけない |

対照: `still-there` は今も発見される。同名・同状態で、staleness ではない。

## 実装中に潰した偽陽性（この fixture が守るもの）

| 出た件数 | 原因 | 直し方 |
|---|---|---|
| 545 | 「設定にはあるがセッションに無い」方向を Finding にしていた。非対話セッションは起動フラグで capability を絞られる | その方向は Finding にしない。観測として件数だけ |
| 91 | `isInitial:false` の絞り込み skill 一覧（skill 呼び出し後に 1 件だけ載る）で起動時集合を上書きしていた | `isInitial:true` の記録だけを起動時集合とする |
| 26 | CLI 同梱の skill / agent（dataviz・Explore 等）はファイルとして収集できない | 同名のファイルが在るのに発見されていない場合だけ報告する |
| 1 | セッションの `agmsg` は `~/.claude/commands/agmsg.md`（スラッシュコマンド）だったが、`~/.agents/skills/agmsg/SKILL.md` という別物が同名で在った | `~/.claude/commands` を収集対象に加え、**説明文の先頭で同一性を裏取り**する |
| 1 | 起動スクリプトの注入本文の突合で、argv の値の終端を「次のフラグ」で探していた。注入本文の中に `--channels` が入っていて切れた | argv 末尾は切らず、ファイル本文との前方一致で判定する |

## live 判定について

`live` は記録ファイルの更新時刻による heuristic。**セッションとプロセスの紐付けはできていない**
（`lsof` では transcript が開いて見えない）。fixture では `probe.live_window_minutes` を 10 年にして、
チェックアウト時刻に依らず「動いている」扱いにしている。
