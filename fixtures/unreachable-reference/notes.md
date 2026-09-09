# unreachable-reference — 由来

実運用の Claude Code 環境（2026-09-07 棚卸し）から一般化した。人格・記憶の中身は持ち込んでいない。

| fixture の要素 | 由来 |
|---|---|
| `flat-orphan.md`（平置き skill） | `~/.claude/skills/` 直下に役職スキルが `.md` 平置きで 13 本あり、1 本も発見されていなかった。後日 `agents/` へ統合して退避済み |
| `andy.md` の `ghost:some-skill` | エージェント定義が `vercel:*` 系 skill を 4 箇所参照していたが、その plugin は enabledPlugins / installed_plugins.json / cache / marketplaces のどこにも無かった。Codex 側の agent 定義（`.toml`）にも同じ参照が複製されていた |
| `discovered-one/SKILL.md` | 対照。発見される形で置かれた skill を必ず 1 本入れる（偽陽性の検出用） |

## この fixture が守る判定基準

`discovered=false` それ自体は症状ではない。**「探索対象の場所に、発見されない形式で置いてある」** が症状。
`flat-orphan.md` は claude-code から見て `in_search_path=true` の場所にあり、形状（`claude.skill.requires_dir_skill_md`）で落ちている。
同じファイルが codex から `discovered=false` なのは領域（`codex.skill.not_in_search_path`）の話で、そちらは Observation。
