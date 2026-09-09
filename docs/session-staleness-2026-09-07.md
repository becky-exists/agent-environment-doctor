# SESSION_STALENESS（#55）— 実装と実測（2026-09-07）

> 「static な Doctor から runtime-aware な Doctor へ一段進める」（ゆう）。
> configured state と active runtime state を比較できるようにした。

## 設計変更: probe を「起動して聞く」から「記録を読む」へ

Issue #55 の当初案は 2 経路だった。`claude --debug` のログ、または自己申告 1 問（200 token 級）。
実測で **もっと強い経路**が見つかったので、そちらを採った。

| 源 | 何が読めるか | 費用 |
|---|---|---|
| `~/.claude/projects/<slug>/*.jsonl` | 起動時の skill / agent / deferred tool / MCP instructions の**名前の集合**、開始時刻、version、cwd、entrypoint | 0 |
| `$CODEX_HOME/sessions/**/rollout-*.jsonl` | `session_meta`: 開始時刻・cli_version・**起動時に載った命令本文の指紋** | 0 |
| `ps` の argv | 起動スクリプトが実際に注入した本文、起動時刻 | 0 |

**起動しない。token を使わない。何も書かない。しかも新規セッションではなく、実際に動いているセッションを観測する。**
自己申告 probe は #55 では不要になった（`probePlan()` の interface は残す）。

⚠ プライバシー: transcript は会話本文そのもの。**構造レコードのフィールドだけを取り、本文は保持しない。**
`skill_listing.content` は同一性の裏取りに使う説明文の先頭 80 字だけを一時的に持ち、Snapshot には載せない。
argv も指紋だけを載せ、本文は Snapshot に入れない（秘密が混ざりうる）。

## 互いに補完関係

- claude-code の記録には capability の一覧が載るが、**命令本文が載らない** → CLAUDE.md / rules / memory は mtime 比較しかできない
- codex の記録には**命令本文が載る**が、capability の一覧が無い

だから比較の可否を 2 系統に分けた。`comparable_capabilities`（起動時の集合が記録されている対話セッション）と
`comparable_timestamps`（開始時刻があり、まだ動いていて、自分自身でないセッション。runtime を問わない）。

## Finding（subtype）

| subtype | 条件 | confidence の根拠 |
|---|---|---|
| `capability_present_but_unconfigured` | セッションが持つ名前と**同名のファイルが在るのに発見されていない**、かつ**説明文の先頭が一致** | high。両方が直接の事実 |
| `resource_changed_after_start` | 常時ロードされる**ファイル**の mtime がセッション開始より後（セッション 1 本 = 1 Finding、合成資源は実体ファイルで畳む） | medium。**本文は読めない**ので時刻の比較まで |
| `injection_digest_divergence` | 起動中プロセスの argv 末尾と、起動スクリプトが今 cat するファイルの本文が前方一致しない | medium。argv は quote を復元できないので前方一致で判定 |

出さないもの: Doctor 自身のセッション / サブエージェント / 「設定にはあるがセッションに無い」方向 /
収集対象に無い名前 / 「再起動すべき」という提案。

## 実装中に潰した偽陽性 5 件（ここが本体）

最初の実行で **545 件**出た。全部潰して **4 件**（すべて真）になった。

| 件数 | 原因 | 直し方 |
|---|---|---|
| 545 → 0 | 「設定にはあるがセッションに無い」を Finding にしていた。非対話セッション（`entrypoint: sdk-py`）は `--setting-sources=` や `--disallowedTools` で capability を絞って起動される | その方向は Finding にしない。件数だけ観測に出す |
| 91 → 0 | `isInitial:false` の絞り込み skill 一覧（skill 呼び出し後に 1 件だけ載る）で起動時集合を上書きしていた | `isInitial:true` の記録だけを起動時集合とする |
| 26 → 0 | CLI 同梱の skill / agent（dataviz・code-review・Explore・general-purpose 等）はバンドル内にありファイルとして収集できない | 同名のファイルが在るのに発見されていない場合だけ報告する |
| 1 → 0 | セッションの `agmsg` は `~/.claude/commands/agmsg.md`（スラッシュコマンド）だったが、`~/.agents/skills/agmsg/SKILL.md` という**別物が同名**で在った | `~/.claude/commands` を収集対象に加え、**説明文の先頭で同一性を裏取り** |
| 1 → 0 | argv の値の終端を「次のフラグ」で探していたが、注入本文の中に `--channels` が入っていて切れた | argv 末尾は切らず、ファイル本文との前方一致で判定 |
| 39 → 4 | `settings.json#hooks.X[i]` のような合成資源を別々に数え、MEMORY.md の symlink 29 本も別々に数えていた | 実体ファイルで畳み、内訳は `entries_from_this_file` に残す |

`agmsg` の件は一度「Claude Code が `~/.agents/skills` を読んでいるのでは（= 規則が誤り）」と疑った。
説明文を突き合わせて別物だと分かり、**規則は正しかった**。名前だけの突合は誤診になる、が残った教訓。

## 実環境の結果（2026-09-07 夕）

```
active  40 session record(s) read (6 recently active), 5 running process(es)
        1 compared by capability, 5 by timestamp
WARN SESSION_STALENESS / resource_changed_after_start  4
```

最古の 1 本は 18 時間前に起動していて、常時ロードされるファイルが 11 件（hook 8 + instruction 2 + memory 1）
その後に変わっていた。当初の症状（rules を移動した当のセッションに残り続けた）と同じ構造。

## 未解決（正直に残す）

- **セッションとプロセスの紐付けができていない**。`lsof` に transcript が現れないため、`live` は
  記録ファイルの更新時刻による heuristic。プロセス由来の Finding は pid が証拠で、session ではない
- 命令本文の内容比較は claude-code 側ではできない（記録が無い）。**「古い本文を持っている」とは言わず、
  「開始より後に変わった」までしか言わない**
- Codex の `base_instructions` は組み込み命令 + AGENTS.md の連結なので、単一ファイルとは一致しない。
  版を跨いだ比較は history 層（#58）待ち
