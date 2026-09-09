# scope-mismatch — 由来

実運用環境の `~/.claude/rules/telegram-channels.md` から一般化した。

- 本文 1 行目が「`claude --channels …` で起動している場合」で始まるのに frontmatter に `paths:` が無く、全セッションに常時ロードされていた
- 同じディレクトリの `family-scope.md` は `paths:` を宣言していた（＝条件付きにできる機構があるのに使っていない、の対照）
- さらに起動スクリプトが `--append-system-prompt "$(cat <同じファイル>)"` で同じ本文を注入しており、channels セッションでは 2 回、通常セッションでは 1 回無用に載っていた
- 2026-09-07 に `rules/` から `channel-prompts/` へ移動して解消。移動後も起動中セッションには旧本文が残り続けた（`SESSION_STALENESS` の初観測）

## `bin/start.sh` について（2 本目の注入経路）

Codex 独立レビュー（2026-09-07、観点 2-A〜2-D）を受けて、Binding の identity に `mechanism` と `source_ref` を入れ、
起動スクリプトは **明示された分だけ**（`launchers` / CLI `--launcher`）収集するようにした。
この fixture では `channels-only.md` に Binding が 2 本並ぶ:

| mechanism | source_ref | rule_id |
|---|---|---|
| `rule_autoload` | discovery `~/.claude/rules` | `claude.rule.paths_optional` |
| `append_system_prompt` | resource `~/bin/start.sh:5` | `claude.launcher.append_system_prompt` |

同じ runtime・同じパス・同じ load_mode でも別の結合。旧キー `(runtime, resource_id, resource_path)` ではこれが 1 件に潰れていた。
shell 設定や launchd の全域探索はしない（coverage の「収集していないもの」に明記）。
