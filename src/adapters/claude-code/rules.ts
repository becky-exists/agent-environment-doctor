/**
 * Claude Code の discovery 規則テーブル
 *
 * 出典は docs:<file>#<anchor>（公式ドキュメント code.claude.com/docs/en/）か
 * measured:<date>（実測で確定させたもの）。
 *
 * Claude Code の仕様は短い周期で動く。確定できない規則は書かず、
 * confidence: 'probe_required' にして断定しない。
 */

import { join } from 'node:path';

import type { DiscoveryRule, SearchPath } from '../types.js';

export const CLAUDE_RULES: DiscoveryRule[] = [
  {
    rule_id: 'claude.skill.requires_dir_skill_md',
    rule_source: 'docs:skills.md#discovery-locations',
    description: 'A skill is only discovered in <dir>/SKILL.md form. A flat .md placed directly under skills/ is not read',
    confidence: 'high',
  },
  {
    rule_id: 'claude.skill.search_paths',
    rule_source: 'docs:skills.md#discovery-locations',
    description: 'Search precedence: Enterprise > Personal(~/.claude/skills) > Project(.claude/skills) > Plugin > Bundled',
    confidence: 'high',
  },
  {
    rule_id: 'claude.skill.not_in_search_path',
    rule_source: 'docs:skills.md#discovery-locations',
    description: '~/.agents/skills/ is outside Claude Code\'s search scope (another runtime\'s territory)',
    confidence: 'high',
  },
  {
    rule_id: 'claude.agent_def.agents_dir',
    rule_source: 'docs:sub-agents.md',
    description: 'Agent definitions live in ~/.claude/agents/*.md and <project>/.claude/agents/*.md. A plugin\'s agents/*.md is named <plugin>:<agent>. Body loads only when invoked',
    confidence: 'high',
  },
  {
    rule_id: 'claude.command.commands_dir',
    rule_source: 'measured:2026-09-07',
    description:
      'Slash commands live in ~/.claude/commands/*.md and <project>/.claude/commands/*.md. ' +
      'Measured: they appear in a session\'s skill list under the same namespace as skills (~/.claude/commands/agmsg.md appears as "agmsg"). ' +
      'Names can collide with skills, so matching by name alone leads to misdiagnosis',
    confidence: 'medium',
  },
  {
    rule_id: 'claude.rule.paths_optional',
    rule_source: 'docs:memory.md#path-specific-rules',
    description: 'rules/*.md is path-conditional if frontmatter has paths:, otherwise always loaded',
    confidence: 'high',
  },
  {
    rule_id: 'claude.instruction.always_loaded',
    rule_source: 'docs:memory.md#how-claude-md-files-load',
    description: 'CLAUDE.md files are concatenated in Managed > User > Project > parent-walk order (not overwritten)',
    confidence: 'high',
  },
  {
    rule_id: 'claude.skill.description_always_loaded',
    rule_source: 'docs:skills.md',
    description: 'For a discovered skill, only its description loads at startup; the body loads on invocation',
    confidence: 'high',
  },
  {
    rule_id: 'claude.skill.disable_model_invocation',
    rule_source: 'docs:skills.md',
    description: 'A skill with disable-model-invocation: true is excluded from automatic model invocation',
    confidence: 'high',
  },
  {
    rule_id: 'claude.subagent.no_instruction_inherit',
    rule_source: 'docs:memory.md',
    description: 'SubagentStart does not inherit the parent\'s CLAUDE.md / auto memory',
    confidence: 'high',
  },
  {
    rule_id: 'claude.plugin.disabled_not_loaded',
    rule_source: 'docs:plugins.md',
    description: 'A disabled plugin\'s skill / MCP tool / hook is not loaded into the session',
    confidence: 'high',
  },
  {
    rule_id: 'claude.output_style.only_selected',
    rule_source: 'measured:2026-09-07',
    description: 'Of output-styles/, only the one pointed to by settings.json#outputStyle is active',
    confidence: 'high',
  },
  {
    rule_id: 'claude.mcp.tool_schema_deferred',
    rule_source: 'measured:2026-09-07',
    description:
      'When the deferred-load mechanism is active, an MCP tool loads only its name; the schema body does not load. ' +
      'The control flag name is undocumented, so we do not hard-code it — reflect it only when observed',
    confidence: 'probe_required',
  },
  {
    rule_id: 'claude.mcp.instructions_always_loaded',
    rule_source: 'docs:mcp.md#tool-list-discovery',
    description: 'A successfully connected MCP server\'s instructions are always loaded',
    confidence: 'medium',
  },
  {
    rule_id: 'claude.hook.registered_in_settings',
    rule_source: 'docs:hooks-guide.md',
    description: 'Hooks are aggregated from settings.json#hooks and plugin hooks.json; all matching entries run in parallel',
    confidence: 'high',
  },
];

export function rulesFor(_version: string | null): DiscoveryRule[] {
  // ponytail: 今は全版共通。since/until が必要になった時点で version で絞る
  return CLAUDE_RULES;
}

export function ruleById(rule_id: string): DiscoveryRule {
  const r = CLAUDE_RULES.find((x) => x.rule_id === rule_id);
  if (!r) throw new Error(`unknown rule_id: ${rule_id}`);
  return r;
}

/**
 * 探索パス。in_search_path=false は「収集はするが Claude からは見えない」もの。
 * ~/.agents/skills を含めるのは、CROSS_RUNTIME_DRIFT の起点として必要なため。
 */
export function claudeSearchPaths(home: string, project: string | null, configHome?: string): SearchPath[] {
  const cc = configHome ?? join(home, '.claude');
  const paths: SearchPath[] = [
    { path: join(cc, 'skills'), owner: 'user', kind: 'skill', precedence: 2, in_search_path: true, shape: 'dir_with_skill_md' },
    { path: join(cc, 'agents'), owner: 'user', kind: 'agent_def', precedence: 2, in_search_path: true, shape: 'flat_md' },
    { path: join(cc, 'rules'), owner: 'user', kind: 'rule', precedence: 2, in_search_path: true, shape: 'flat_md' },
    { path: join(cc, 'output-styles'), owner: 'user', kind: 'output_style', precedence: 2, in_search_path: true, shape: 'flat_md' },
    { path: join(cc, 'commands'), owner: 'user', kind: 'command', precedence: 2, in_search_path: true, shape: 'flat_md' },
    { path: join(cc, 'plugins', 'cache'), owner: 'builtin', kind: 'plugin', precedence: 4, in_search_path: true, shape: 'any' },
    // Claude からは見えないが、cross-runtime 突合のために収集する
    { path: join(home, '.agents', 'skills'), owner: 'shared', kind: 'skill', precedence: 99, in_search_path: false, shape: 'dir_with_skill_md' },
  ];
  if (project) {
    paths.push(
      { path: join(project, '.claude', 'skills'), owner: 'project', kind: 'skill', precedence: 3, in_search_path: true, shape: 'dir_with_skill_md' },
      { path: join(project, '.claude', 'agents'), owner: 'project', kind: 'agent_def', precedence: 3, in_search_path: true, shape: 'flat_md' },
      { path: join(project, '.claude', 'rules'), owner: 'project', kind: 'rule', precedence: 1, in_search_path: true, shape: 'flat_md' },
      { path: join(project, '.claude', 'commands'), owner: 'project', kind: 'command', precedence: 1, in_search_path: true, shape: 'flat_md' },
    );
  }
  return paths;
}
