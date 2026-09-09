/**
 * Phase 1 — history / context cost / hook amplification
 *
 * history は合成 snapshot で検証する（実環境を触らずに「増えた・消えた・drift した・stale になった」を作る）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { collectFixture, lastProbe, loadExpectation } from './helpers.js';
import { runFindings } from '../src/findings/index.js';
import { buildHistory, eventsBetween, loadSeries } from '../src/history/events.js';
import { computeContextCost, countTokens, TOKEN_METHOD } from '../src/observe/context-cost.js';
import { isProtected } from '../src/findings/context.js';
import { SCHEMA_VERSION } from '../src/snapshot.js';
import type { Binding, Resource, SessionInfo, Snapshot } from '../src/ir/types.js';

const readText = async (p: string) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

// ───────────────────── 合成 snapshot ─────────────────────

function res(over: Partial<Resource> & { path: string; name: string }): Resource {
  return {
    resource_id: `sha256:${over.name}-${over.normalized_hash ?? 'v1'}`,
    kind: 'skill',
    owner: 'user',
    content_hash: `sha256:${over.name}-c`,
    normalized_hash: `sha256:${over.name}-v1`,
    mtime: '2026-01-01T00:00:00.000Z',
    size_bytes: 100,
    declared: { frontmatterKeys: [], description: `desc of ${over.name}` },
    references: [],
    ...over,
  } as Resource;
}

function bind(r: Resource, over: Partial<Binding> & { runtime: Binding['runtime'] }): Binding {
  return {
    binding_id: `binding:${over.runtime}-${r.path}-${over.mechanism ?? 'skill_description'}`,
    resource_id: r.resource_id,
    resource_path: r.path,
    runtime_version: '1.0.0',
    mechanism: 'skill_description',
    source_ref: { type: 'discovery', search_path: '/h/.claude/skills' },
    discovered: true,
    rule_id: 'test.rule',
    rule_source: 'test',
    confidence: 'high',
    load_mode: 'on_demand',
    scope_condition: null,
    applies_to: ['session'],
    search_path: '/h/.claude/skills',
    precedence: 1,
    ...over,
  } as Binding;
}

function snap(id: string, resources: Resource[], bindings: Binding[], sessions: SessionInfo[] = []): Snapshot {
  return {
    snapshot_id: id,
    schema_version: SCHEMA_VERSION,
    tool_version: 'test',
    runtimes: [
      { runtime: 'claude-code', version: '2.1.263', config_home: '/h/.claude', present: true },
      { runtime: 'codex', version: '0.153.4', config_home: '/h/.codex', present: true },
    ],
    env: { os: 'test', project: null, home: '/h', launchers: [] },
    coverage: { phase: 'test', collected: [], not_collected: [] },
    resources,
    bindings,
    observations: [],
    sessions,
    processes: [],
    probe_notes: [],
  };
}

function session(over: Partial<SessionInfo> & { session_id: string }): SessionInfo {
  return {
    runtime: 'claude-code',
    record_path: `/h/.claude/projects/x/${over.session_id}.jsonl`,
    started_at: '2026-01-01T00:00:00.000Z',
    last_activity_at: '2026-01-01T01:00:00.000Z',
    live: true,
    runtime_version: '2.1.263',
    cwd: null,
    git_branch: null,
    entrypoint: 'cli',
    is_self: false,
    is_sidechain: false,
    observed_capability_kinds: ['skills'],
    capabilities: { skills: [], agents: null, deferred_tools: null, mcp_instructions: null, failed_mcp_servers: null },
    capabilities_from_startup: true,
    non_initial_listings: 0,
    comparable_capabilities: true,
    comparable_timestamps: true,
    not_comparable_reason: null,
    instruction_digest: null,
    ...over,
  } as SessionInfo;
}

// ───────────────────── history ─────────────────────

test('history: 同じ環境を 2 回撮ったら出来事は 0（同一性が安定している）', () => {
  const a = res({ path: '/h/.claude/skills/x/SKILL.md', name: 'x' });
  const s1 = snap('2026-01-01T00:00:00.000Z', [a], [bind(a, { runtime: 'claude-code' })]);
  const s2 = snap('2026-01-01T00:01:00.000Z', [a], [bind(a, { runtime: 'claude-code' })]);
  assert.deepEqual(eventsBetween(s1, s2), []);
});

test('history: 増えた / 消えた / 変わった', () => {
  const a = res({ path: '/h/.claude/skills/a/SKILL.md', name: 'a' });
  const b = res({ path: '/h/.claude/skills/b/SKILL.md', name: 'b' });
  const a2 = res({ path: '/h/.claude/skills/a/SKILL.md', name: 'a', normalized_hash: 'sha256:a-v2', size_bytes: 220, mtime: '2026-01-02T00:00:00.000Z' });
  const s1 = snap('2026-01-01T00:00:00.000Z', [a, b], [bind(a, { runtime: 'claude-code' }), bind(b, { runtime: 'claude-code' })]);
  const s2 = snap('2026-01-02T00:00:00.000Z', [a2], [bind(a2, { runtime: 'claude-code' })]);
  const ev = eventsBetween(s1, s2);
  const kinds = ev.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['binding_removed', 'resource_changed', 'resource_disappeared']);
  const changed = ev.find((e) => e.kind === 'resource_changed')!;
  assert.match(changed.summary, /100 → 220 B/);
  // 「増えた = 悪」にしない: direction は持つが評価語は無い
  assert.ok(!/unnecessary|bloat|waste|should/i.test(ev.map((e) => e.summary).join(' ')));
});

test('history: 同一内容が複数パスに在る変更は 1 件に畳む（symlink で 29 件に膨れた実測の回帰）', () => {
  const mk = (v: string) => [1, 2, 3].map((i) => res({ path: `/h/p${i}/MEMORY.md`, name: 'MEMORY.md', kind: 'memory', normalized_hash: `sha256:m-${v}`, resource_id: `sha256:m-${v}` }));
  const s1 = snap('2026-01-01T00:00:00.000Z', mk('v1'), []);
  const s2 = snap('2026-01-02T00:00:00.000Z', mk('v2'), []);
  const ev = eventsBetween(s1, s2).filter((e) => e.kind === 'resource_changed');
  assert.equal(ev.length, 1, `1 件に畳めていない: ${ev.length}`);
  assert.equal((ev[0]!.detail['paths'] as string[]).length, 3);
  assert.match(ev[0]!.summary, /2 more path\(s\) sharing the same content/);
});

test('history: drift の開始と解消', () => {
  const mkPair = (agentsHash: string) => {
    const c = res({ path: '/h/.claude/skills/f/SKILL.md', name: 'f', normalized_hash: 'sha256:f-claude', resource_id: 'sha256:f-claude' });
    const g = res({ path: '/h/.agents/skills/f/SKILL.md', name: 'f', normalized_hash: agentsHash, resource_id: agentsHash });
    return {
      resources: [c, g],
      bindings: [bind(c, { runtime: 'claude-code' }), bind(g, { runtime: 'codex', search_path: '/h/.agents/skills' })],
    };
  };
  const same = mkPair('sha256:f-claude');
  const diff = mkPair('sha256:f-codex');
  const s1 = snap('2026-01-01T00:00:00.000Z', same.resources, same.bindings);
  const s2 = snap('2026-01-02T00:00:00.000Z', diff.resources, diff.bindings);
  const started = eventsBetween(s1, s2).filter((e) => e.kind === 'drift_started');
  assert.equal(started.length, 1);
  assert.match(started[0]!.summary, /now differs between claude-code and codex/);
  const resolved = eventsBetween(s2, s1).filter((e) => e.kind === 'drift_resolved');
  assert.equal(resolved.length, 1);
});

test('history: セッションが stale になった瞬間', () => {
  const rule = (mtime: string) =>
    res({ path: '/h/.claude/rules/r.md', name: 'r', kind: 'rule', mtime, normalized_hash: `sha256:r-${mtime}`, resource_id: `sha256:r-${mtime}` });
  const sess = session({ session_id: 'sess-1', started_at: '2026-01-01T12:00:00.000Z' });
  const before = rule('2026-01-01T06:00:00.000Z'); // セッション開始より前
  const after = rule('2026-01-01T18:00:00.000Z'); // 開始より後
  const mkB = (r: Resource) => bind(r, { runtime: 'claude-code', mechanism: 'rule_autoload', load_mode: 'always' });
  const s1 = snap('2026-01-01T13:00:00.000Z', [before], [mkB(before)], [sess]);
  const s2 = snap('2026-01-01T19:00:00.000Z', [after], [mkB(after)], [sess]);
  const ev = eventsBetween(s1, s2).filter((e) => e.kind === 'session_became_stale');
  assert.equal(ev.length, 1);
  assert.match(ev[0]!.summary, /1 always-loaded file\(s\) that changed after it started/);
  assert.equal(ev[0]!.subject.session_id, 'sess-1');
});

test('history: 「観測していない」を「存在しなかった」にしない（偽の session_appeared 35 件の回帰）', () => {
  const sess = session({ session_id: 'sess-1' });
  // probe 無しの snapshot（sessions / processes / probe_notes すべて空）
  const noProbe = snap('2026-01-01T00:00:00.000Z', [], []);
  const probed = snap('2026-01-01T00:01:00.000Z', [], [], [sess]);
  probed.probe_notes = ['observed'];
  assert.deepEqual(
    eventsBetween(noProbe, probed).filter((e) => e.kind.startsWith('session_')),
    [],
    'probe 無しの snapshot との比較でセッションの増減を語っている',
  );
  // 逆向きも同じ
  assert.deepEqual(eventsBetween(probed, noProbe).filter((e) => e.kind.startsWith('session_')), []);
  // trend では 0 件と「観測していない」を区別する
  const h = buildHistory({ refs: [], usable: [noProbe, probed], skipped: [], gaps: [] });
  assert.equal(h.trend[0]!.sessions, null);
  assert.equal(h.trend[1]!.sessions, 1);
});

test('history: 走査窓に入っただけのセッションを「現れた」にしない', () => {
  const old = session({ session_id: 'old-one', started_at: '2025-12-01T00:00:00.000Z' });
  const fresh = session({ session_id: 'new-one', started_at: '2026-01-01T00:00:30.000Z' });
  const a = snap('2026-01-01T00:00:00.000Z', [], [], []);
  a.probe_notes = ['observed'];
  const b = snap('2026-01-01T00:01:00.000Z', [], [], [old, fresh]);
  b.probe_notes = ['observed'];
  const ev = eventsBetween(a, b).filter((e) => e.kind === 'session_appeared');
  assert.equal(ev.length, 1, `窓に入っただけのものを数えている: ${ev.map((x) => x.subject.session_id).join(',')}`);
  assert.equal(ev[0]!.subject.session_id, 'new-one');
});

test('history: 版違いの snapshot は比較不能として落とし、理由を残す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-doctor-hist-'));
  try {
    const good = snap('2026-01-01T00:00:00.000Z', [], []);
    await writeFile(join(dir, 'a.json'), JSON.stringify(good), 'utf8');
    await writeFile(join(dir, 'old.json'), JSON.stringify({ ...good, schema_version: 1, snapshot_id: '2025-01-01T00:00:00.000Z' }), 'utf8');
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
    const series = await loadSeries(dir);
    assert.equal(series.usable.length, 1);
    assert.equal(series.skipped.length, 2);
    assert.ok(series.skipped.some((r) => /schema_version 1/.test(r.reason ?? '')));
    assert.ok(series.skipped.some((r) => /unreadable/.test(r.reason ?? '')));
    const h = buildHistory(series);
    assert.ok(h.notes.some((n) => /not comparable/.test(n)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history: 観測していない期間は gap として出す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-doctor-gap-'));
  try {
    await writeFile(join(dir, 'a.json'), JSON.stringify(snap('2026-01-01T00:00:00.000Z', [], [])), 'utf8');
    await writeFile(join(dir, 'b.json'), JSON.stringify(snap('2026-01-05T00:00:00.000Z', [], [])), 'utf8');
    const series = await loadSeries(dir);
    assert.equal(series.gaps.length, 1);
    assert.equal(series.gaps[0]!.hours, 96);
    assert.ok(buildHistory(series).notes.some((n) => /no snapshot was taken/.test(n)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ───────────────────── context cost ─────────────────────

test('context cost: token は tiktoken で数える（chars/4 を使わない）', () => {
  const ja = 'こんにちは、ベッキーです。';
  const t = countTokens(ja);
  assert.ok(t > 0);
  // chars/4 なら 3。実測 7。2 倍以上ずれるので換算を使わない、という設計の裏付け
  assert.ok(t > Math.ceil(ja.length / 4), `chars/4=${Math.ceil(ja.length / 4)} tokens=${t}`);
});

test('context cost: load_mode で分け、protected を合計から切り離す。Finding は出さない', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  const cost = await computeContextCost(s, (p) => isProtected(p, ['**/MEMORY.md', '**/memory/**']), readText);
  assert.ok(cost.by_load_mode['always'], 'always が無い');
  assert.ok(cost.by_load_mode['deferred'], 'deferred が無い');
  // MEMORY.md は protected 側に入り、unprotected の合計には入らない
  assert.ok(cost.protected_total.items > 0);
  assert.ok(cost.largest.some((x) => /MEMORY\.md$/.test(x.path) && x.protected));
  // deferred は名前だけ = 小さい
  const deferred = cost.items.filter((x) => x.load_mode === 'deferred');
  assert.ok(deferred.length > 0 && deferred.every((x) => x.measured_part === 'name_only'));
  // on_demand は description だけ（本文は起動時に載らない）
  assert.ok(cost.items.filter((x) => x.load_mode === 'on_demand').every((x) => x.measured_part === 'declared_description'));
  // 測っていないものを宣言している
  assert.ok(cost.not_measured.length >= 3);
  assert.equal(cost.method_note.includes('not the tokenizer'), true);

  // ★ 大きさは Finding にしない
  const res = await runFindings(s, { readText });
  assert.deepEqual(res.findings, []);
  assert.ok(res.suppressed.some((x) => x.reason === 'size_is_not_a_symptom'));
  assert.ok(res.suppressed.some((x) => x.reason === 'deferred_cost_is_near_zero'));
  assert.equal(res.context_cost.by_load_mode['always']!.items > 0, true);
});

test('context cost: 同じ内容が複数パスに在っても二重に数えない / 他プロジェクトの memory は数えない', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  const cost = await computeContextCost(s, () => false, readText);
  // 同一 (runtime, 内容, 機構, 部分) は 1 件
  const keys = cost.items.map((i) => `${i.runtime}|${i.resource_id}|${i.mechanism}|${i.measured_part}`);
  assert.equal(new Set(keys).size, keys.length, '畳めていない');
  // 本文を読んだので always の token が測れている
  const always = cost.items.filter((i) => i.load_mode === 'always' && i.measured_part === 'whole_file');
  if (always.length) assert.ok(always.every((i) => i.token_measured && i.token_estimate > 0), 'always の token が測れていない');
});

test('context cost: method を必ず添える', async () => {
  const exp = await loadExpectation('unreachable-reference');
  const s = await collectFixture('unreachable-reference', exp);
  const cost = await computeContextCost(s, () => false, readText);
  for (const i of cost.items) assert.ok(i.method === TOKEN_METHOD || i.method === 'filesystem', `method が無い: ${i.path}`);
});

// ───────────────────── hook amplification ─────────────────────

test('hook amplification: 発火回数が多いだけでは症状にしない', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  // 注入 0 バイトの hook が 200 回発火した記録
  const firings = new Map([
    ['sess-1', new Map([['quiet|PreToolUse', { name: 'quiet', event: 'PreToolUse', count: 200, total_bytes: 0, command: 'echo', payload_digests: new Map<string, number>() }]])],
  ]);
  const res = await runFindings(s, { readText, hookFirings: firings });
  assert.deepEqual(
    res.findings.filter((f) => f.finding_id === 'HOOK_AMPLIFICATION'),
    [],
    '注入 0 バイトの hook を症状にしている',
  );
  assert.ok(res.skipped.some((x) => x.detector.includes('no_injection') && /200 time/.test(x.reason)));
});

test('hook amplification: バイト同一の本文が繰り返し入っている時だけ出す', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  const same = new Map([['sha256:aaa', 4]]);
  const varied = new Map([
    ['sha256:b1', 1],
    ['sha256:b2', 1],
  ]);
  const firings = new Map([
    [
      'sess-1',
      new Map([
        ['loud|SessionStart', { name: 'loud', event: 'SessionStart', count: 4, total_bytes: 40000, command: 'cat persona.md', payload_digests: same }],
        ['varied|SessionStart', { name: 'varied', event: 'SessionStart', count: 2, total_bytes: 2000, command: 'date', payload_digests: varied }],
      ]),
    ],
  ]);
  const res = await runFindings(s, { readText, hookFirings: firings });
  const hooks = res.findings.filter((f) => f.finding_id === 'HOOK_AMPLIFICATION');
  assert.equal(hooks.length, 1, `期待 1 件、実際: ${hooks.map((f) => `${f.subtype}:${f.subject.name}`).join(',')}`);
  assert.equal(hooks[0]!.subtype, 'identical_payload_repeated');
  assert.equal(hooks[0]!.subject.name, 'loud');
  assert.match(hooks[0]!.summary, /injected byte-identical text 4 times/);
  assert.match(hooks[0]!.summary, /evidence rather than proof/);
  assert.equal(hooks[0]!.confidence, 'medium');
});

test('hook amplification: --probe が無ければ実測分は評価せず skipped に残す', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  const res = await runFindings(s, { readText });
  assert.ok(res.skipped.some((x) => x.detector === 'HOOK_AMPLIFICATION' && /--probe/.test(x.reason)));
});

test('phase 1: probe つき fixture で context cost の実測が Snapshot に載る', async () => {
  const exp = await loadExpectation('session-staleness');
  const s = await collectFixture('session-staleness', exp);
  const res = await runFindings(s, { readText, argvTails: lastProbe.argvTails, capabilityDescriptions: lastProbe.capabilityDescriptions });
  assert.ok(res.context_cost.items.length > 0);
  // セッションを見た事実が suppressed に出る
  assert.ok(res.suppressed.some((x) => x.reason === 'sessions_excluded_by_design'));
});
