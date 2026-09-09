/**
 * Codex の discovery 規則テーブル
 *
 * 出典は 2026-09-07 の Codex 独立レビューで公式ドキュメントに差し替えた（docs/codex-review-result-phase0.md 観点 3）。
 *   docs:codex/skills           https://developers.openai.com/codex/skills
 *   docs:codex/agents-md        https://developers.openai.com/codex/guides/agents-md
 *   docs:codex/hooks            https://developers.openai.com/codex/hooks
 *   docs:codex/subagents        https://developers.openai.com/codex/subagents
 *   docs:codex/config-reference https://developers.openai.com/codex/config-reference
 *   docs:codex/rules            https://developers.openai.com/codex/rules
 * 公式に無い挙動は measured:<date> のまま confidence を下げ、since を付ける。断定しない。
 */

import { join } from 'node:path';

import type { DiscoveryRule, SearchPath } from '../types.js';

export const CODEX_DOCS = {
  skills: 'https://developers.openai.com/codex/skills',
  agentsMd: 'https://developers.openai.com/codex/guides/agents-md',
  hooks: 'https://developers.openai.com/codex/hooks',
  subagents: 'https://developers.openai.com/codex/subagents',
  configReference: 'https://developers.openai.com/codex/config-reference',
  rules: 'https://developers.openai.com/codex/rules',
} as const;

export const CODEX_RULES: DiscoveryRule[] = [
  {
    rule_id: 'codex.instruction.agents_md_always',
    rule_source: `docs:codex/agents-md ${CODEX_DOCS.agentsMd}`,
    description:
      'AGENTS.md is always loaded, concatenating $CODEX_HOME (AGENTS.override.md takes precedence) with each level from project root→cwd. ' +
      'Phase 0 collects only $CODEX_HOME/AGENTS.md and <project>/AGENTS.md (override, intermediate levels, and project_doc_max_bytes are not yet supported → see coverage)',
    confidence: 'high',
  },
  {
    rule_id: 'codex.skill.agents_dir_included',
    rule_source: `docs:codex/skills ${CODEX_DOCS.skills}`,
    description: '$HOME/.agents/skills/<dir>/SKILL.md is a standard search location. Each .agents/skills from repo root→cwd, plus admin/system placements, are also officially listed, but Phase 0 collects $HOME only',
    confidence: 'high',
  },
  {
    rule_id: 'codex.skill.not_in_standard_locations',
    rule_source: `docs:codex/skills ${CODEX_DOCS.skills}`,
    description:
      '~/.claude/skills/ is not among Codex\'s standard search locations. However, config.toml\'s [[skills.config]] path can explicitly reference any path, so we do not say it is "always out of scope" (explicit references are codex.skill.explicit_config_path)',
    confidence: 'high',
  },
  {
    rule_id: 'codex.skill.explicit_config_path',
    rule_source: `docs:codex/skills ${CODEX_DOCS.skills}`,
    description: 'A skill explicitly referenced via config.toml\'s [[skills.config]] path = "<SKILL.md>" is in search scope regardless of location',
    confidence: 'high',
  },
  {
    rule_id: 'codex.skill.codex_home_skills',
    rule_source: 'measured:2026-09-07',
    description:
      '$CODEX_HOME/skills/ is not listed among the official standard search locations. However, on 0.153.4 we observed $CODEX_HOME/skills/.system/* actually being read (undocumented). Isolated as version-dependent',
    confidence: 'low',
    since: '0.153.4',
    until: null,
  },
  {
    rule_id: 'codex.skill.requires_dir_skill_md',
    rule_source: `docs:codex/skills ${CODEX_DOCS.skills}`,
    description: 'A skill is a directory holding SKILL.md. A flat .md is not read (same shape as Claude)',
    confidence: 'high',
  },
  {
    rule_id: 'codex.agent_def.toml',
    rule_source: `docs:codex/subagents ${CODEX_DOCS.subagents}`,
    description: 'Personal agents live in ~/.codex/agents/*.toml, project agents in <project>/.codex/agents/*.toml. Body is developer_instructions. Phase 0 collects personal only',
    confidence: 'high',
  },
  {
    rule_id: 'codex.hook.hooks_json',
    rule_source: `docs:codex/hooks ${CODEX_DOCS.hooks}`,
    description:
      'Hooks live in $CODEX_HOME/hooks.json (also inline [hooks], project .codex/hooks.json, and plugin-bundled ones; an untrusted hook is skipped). ' +
      'Phase 0 collects only $CODEX_HOME/hooks.json and does not check trust state → discovered means only "registered"',
    confidence: 'medium',
  },
  {
    rule_id: 'codex.plugin.enabled_flag',
    rule_source: 'measured:2026-09-07',
    description: 'Controlling an entire plugin via config.toml\'s [plugins."<id>"] enabled was measured on 0.153.4. Not found in the official Config Reference (undocumented)',
    confidence: 'medium',
    since: '0.153.4',
    until: null,
  },
  {
    rule_id: 'codex.mcp.config_toml',
    rule_source: `docs:codex/config-reference ${CODEX_DOCS.configReference}`,
    description: 'MCP is config.toml\'s [mcp_servers.<id>], with a nested tools.<tool>.approval_mode. Reflecting enabled=false is not yet supported (coverage)',
    confidence: 'high',
  },
  {
    rule_id: 'codex.exec_policy.rules_dir',
    rule_source: `docs:codex/rules ${CODEX_DOCS.rules}`,
    description:
      '$CODEX_HOME/rules/*.rules is an execution-permission policy in the prefix_rule(...) DSL (experimental). Scanned at startup but not loaded into the prompt; evaluated when a command matches a pattern. ' +
      'Not treated the same as a prompt rule (kind=exec_policy, load_mode=unknown). Project rules only apply for a trusted project',
    confidence: 'medium',
  },
  {
    rule_id: 'codex.launcher.explicit_only',
    rule_source: 'measured:2026-09-07',
    description: 'Only launcher scripts explicitly named via --launcher are collected. Whether that launcher was actually used cannot be proven statically',
    confidence: 'medium',
  },
];

export function rulesFor(_version: string | null): DiscoveryRule[] {
  // ponytail: since/until は codex_home_skills / plugin.enabled_flag に付けたが、版で絞る実装は
  // 版差が 2 つ以上観測されてから。今は全版共通で返す
  return CODEX_RULES;
}

export function ruleById(rule_id: string): DiscoveryRule {
  const r = CODEX_RULES.find((x) => x.rule_id === rule_id);
  if (!r) throw new Error(`unknown rule_id: ${rule_id}`);
  return r;
}

/**
 * Codex の探索パス。
 * Claude 側と対称にするため、Claude 専用パス（~/.claude/skills）も
 * in_search_path=false で収集する。これが CROSS_RUNTIME_DRIFT の両側になる。
 */
export function codexSearchPaths(home: string, project: string | null, configHome?: string): SearchPath[] {
  const ch = configHome ?? join(home, '.codex');
  const paths: SearchPath[] = [
    { path: join(home, '.agents', 'skills'), owner: 'shared', kind: 'skill', precedence: 1, in_search_path: true, shape: 'dir_with_skill_md' },
    // undocumented（confidence low）。収集はするが規則側で隔離する
    { path: join(ch, 'skills'), owner: 'user', kind: 'skill', precedence: 2, in_search_path: true, shape: 'dir_with_skill_md' },
    { path: join(ch, 'agents'), owner: 'user', kind: 'agent_def', precedence: 2, in_search_path: true, shape: 'flat_toml' },
    { path: join(ch, 'rules'), owner: 'user', kind: 'exec_policy', precedence: 2, in_search_path: true, shape: 'rules_dsl' },
    { path: join(ch, 'plugins', 'cache'), owner: 'builtin', kind: 'plugin', precedence: 4, in_search_path: true, shape: 'any' },
    // Codex の標準探索場所ではないが、cross-runtime 突合のために収集する
    { path: join(home, '.claude', 'skills'), owner: 'shared', kind: 'skill', precedence: 99, in_search_path: false, shape: 'dir_with_skill_md' },
  ];
  if (project) {
    paths.push({ path: join(project, '.codex'), owner: 'project', kind: 'settings', precedence: 1, in_search_path: true, shape: 'any' });
  }
  return paths;
}

/** CODEX_HOME を尊重した config home の解決 */
export function resolveCodexHome(home: string, configHome?: string): string {
  return configHome ?? process.env['CODEX_HOME'] ?? join(home, '.codex');
}
