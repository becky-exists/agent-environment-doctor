/**
 * coverage 宣言が README と Snapshot の両方に同じ内容で出ていること
 * （未対応なのに診断できるふりをしない。宣言を 1 箇所変えたら README も変える）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT, collectFixture, loadExpectation } from './helpers.js';
import { PHASE0_COVERAGE } from '../src/coverage.js';

/**
 * `src/coverage.ts`'s declaration was translated to English (Issue #77, CLI/UI-facing
 * surface follow-up to the M3 README/SECURITY docs task). README.md's Coverage section
 * is a line-for-line English translation written independently at M3 time; since both
 * are now English, this map keys each source line to a short, distinctive anchor that
 * must appear in the README's Coverage section. If you add or remove a line in
 * `src/coverage.ts`, this map must be updated (and the README's English prose written
 * to match) or this test fails with "no anchor registered for". This preserves the
 * original anti-drift guarantee (source and README can't silently diverge).
 */
const COVERAGE_LINE_ANCHORS_EN: Record<string, string> = {
  'claude-code: ~/.claude/CLAUDE.md, <project>/CLAUDE.md (walking up parent directories is not supported)': '<project>/CLAUDE.md',
  'claude-code: ~/.claude/skills/*/SKILL.md and flat *.md, <project>/.claude/skills, plugin skills (only the version pointed to by installed_plugins.json)': '~/.claude/skills/*/SKILL.md',
  'claude-code: ~/.claude/agents/*.md, plugin agents/*.md (named <plugin>:<agent>), ~/.claude/rules/*.md, <project>/.claude/rules, ~/.claude/output-styles/*.md': '~/.claude/output-styles/*.md',
  'claude-code: settings.json#hooks (with array position), plugin hooks.json / .mcp.json': 'settings.json#hooks',
  'claude-code: ~/.claude.json#mcpServers and #projects.<path>.mcpServers (only the necessary keys), installed_plugins.json + settings.json#enabledPlugins': '#projects.<path>.mcpServers',
  'claude-code: ~/.claude/projects/<slug>/memory/MEMORY.md (protected by default), ~/.claude.json#skillUsage (invocation)': '~/.claude/projects/<slug>/memory/MEMORY.md',
  'codex: $CODEX_HOME/AGENTS.md and <project>/AGENTS.md (AGENTS.override.md, hierarchical concatenation, project_doc_max_bytes are not supported)': '$CODEX_HOME/AGENTS.md',
  "codex: ~/.agents/skills/*/SKILL.md (symlinks record real_path), $CODEX_HOME/skills (undocumented, low confidence), config.toml's [[skills.config]] path": '[[skills.config]]',
  "codex: $CODEX_HOME/agents/*.toml, $CODEX_HOME/hooks.json, config.toml's [mcp_servers.*] / [plugins.*]": '$CODEX_HOME/agents/*.toml',
  'codex: $CODEX_HOME/rules/*.rules (kind=exec_policy. Presence and line count only; the DSL itself is not parsed)': '$CODEX_HOME/rules/*.rules',
  'common: an explicitly declared launch script\'s (--launcher) --append-system-prompt "$(cat <path>)" is collected as an append_system_prompt Binding':
    'append_system_prompt',
  'common: ~/.agents/skills from claude-code, and ~/.claude/skills from codex, are each collected as "outside the standard search location" (for cross-runtime drift comparisons)':
    'outside the standard search location',
  "common: the outcome of a lookup itself (read successfully / didn't exist / no permission / failed / not applicable) is recorded as an access record. **Something that couldn't be read is never reported as a count of 0**":
    'reported as a count of 0',
  'Anything not recorded in a session transcript: what a claude-code instruction body (CLAUDE.md / rules / memory) actually was inside a running session. Only mtime comparison is possible':
    'Only mtime comparison is possible',
  "Linking a session record to a process (pid ↔ session_id) with --probe is only done when the runtime matches, the start times are within 5 seconds of each other, and there's exactly one candidate from both sides (#69). Anything else (multiple candidates, times far apart) is left as ambiguous / unmapped — never guessed into a single match. The live judgment itself remains a heuristic based on record file modification time":
    'unmapped',
  "Codex-side skill/agent listing (rollouts don't record it). Conversely, Claude-side instruction bodies aren't available either": 'Codex-side skill/agent listing',
  'Codex-side MCP connection status / API errors (there is currently no equivalent structural record obtainable from rollouts without reading conversation content; claude-code is observed via --probe, #69)':
    'Codex-side MCP connection status',
  'Automatic discovery of shell config (.zshrc etc.), launchd plists, or cron. Launch scripts are only considered when passed via --launcher': 'launchd plists',
  'claude-code: walking up parent directories for CLAUDE.md, Enterprise deployments other than managed-settings, cross-checking against settings.json#outputStyle':
    'settings.json#outputStyle',
  'codex: AGENTS.override.md, hierarchical concatenation from the project root to cwd, project_doc_max_bytes, <project>/.codex/{agents,hooks.json,config.toml}, inline [hooks], plugin-bundled hooks, hook trust state, admin/system skill placement':
    '<project>/.codex/{agents,hooks.json,config.toml}',
  'codex: collecting multiple CODEX_HOMEs in one run (one home per run), MCP enabled=false, semantic evaluation of the rules DSL': 'rules DSL',
  'Actual token measurement via tiktoken vs. the chars/4 estimate — the crude estimate is never used': 'chars/4',
  'Ingesting the official /skill-doctor, connecting to MCP servers': '/skill-doctor',
  'Temporal identity of Observations (multiple points in time for the same kind/method within one snapshot are not retained)': 'Temporal identity of Observations',
  "Windows load average (Node's os.loadavg() always returns [0,0,0], so it's unsupported) and swap (not implemented as of #69; real-machine Windows verification is still pending)":
    'os.loadavg()',
  'Disk I/O, the official Anthropic / OpenAI status pages (bundle generation prioritizes never reaching the network; provider outages are something the recipient checks separately)':
    'Anthropic / OpenAI',
};

test('coverage: docs/coverage.md（英語）に collected / not_collected の対訳 anchor が全部載っている', async () => {
  // README compression pass 2 (2026-09-09) で Coverage 節は README.md から docs/coverage.md へ
  // 移設された（README側は6 bulletの要約+リンクのみ）。以前はREADME内の「## Coverage」節を
  // split して検査していたが、今はファイル全体が Coverage 宣言なのでファイル全文を検査対象にする。
  const section = await readFile(join(ROOT, 'docs/coverage.md'), 'utf8');
  for (const line of [...PHASE0_COVERAGE.collected, ...PHASE0_COVERAGE.not_collected]) {
    const anchor = COVERAGE_LINE_ANCHORS_EN[line];
    assert.ok(anchor, `no anchor registered for (add one to COVERAGE_LINE_ANCHORS_EN and to docs/coverage.md's English Coverage section): ${line}`);
    assert.ok(section.includes(anchor), `docs/coverage.md に対応する英語記述が無い（anchor "${anchor}"）: ${line}`);
  }
});

test('coverage: Snapshot に同じ宣言が入る', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  assert.deepEqual(s.coverage, PHASE0_COVERAGE);
  assert.equal(s.schema_version, 4);
  // probe を付けていない収集では sessions / processes は空（観測していない、を空で表す）
  assert.deepEqual(s.sessions, []);
  assert.deepEqual(s.processes, []);
});

test('coverage: --probe を付けた収集では active runtime が Snapshot に載る', async () => {
  const exp = await loadExpectation('session-staleness');
  const s = await collectFixture('session-staleness', exp);
  assert.ok(s.sessions.length >= 3, 'セッション記録が読めていない');
  assert.ok(s.probe_notes.some((n) => /No session was started/.test(n)), '観測方法の宣言が無い');
  for (const x of s.sessions) assert.equal(typeof x.comparable_capabilities, 'boolean');
});

test('coverage: not_collected に挙げた領域は Finding の入力にならない（宣言の形）', () => {
  assert.ok(
    PHASE0_COVERAGE.not_collected.some((x) => x.includes('instruction body')) && PHASE0_COVERAGE.not_collected.some((x) => x.includes('pid')),
    'active runtime の限界（instruction body が読めない / pid と紐付かない）が宣言されていない',
  );
  assert.ok(PHASE0_COVERAGE.not_collected.some((x) => x.includes('launchd')), '起動系の全域探索の未対応が宣言されていない');
  assert.ok(PHASE0_COVERAGE.not_collected.some((x) => x.includes('chars/4')), 'token 換算を作らない方針が宣言されていない');
});
