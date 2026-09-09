/**
 * 人間向け要約層（Overview / cluster / つまり何？）
 *
 * ここで守るのは 2 つ。
 *   1. **見た目のために束ねない** — 同じ原因と言える観測事実がある時だけ束ねる
 *   2. **診断意味論を変えない** — 大きさで warning を作らない、未観測を「変化なし」と言わない、
 *      Not findings への導線を消さない、Expert 層を消さない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { collectFixture, lastProbe, loadExpectation } from './helpers.js';
import { runFindings } from '../src/findings/index.js';
import { buildLlmReport } from '../src/llm-report.js';
import { buildUiData } from '../src/ui/data.js';
import { clusterFindings, notProblems, resourceHumanSummary, NO_ADVICE } from '../src/ui/summary.js';
import { renderPage } from '../src/ui/page.js';
import type { UiFindingView, UiResourceView } from '../src/ui/data.js';
import type { ContextCost } from '../src/observe/context-cost.js';

const readText = async (p: string) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

async function uiOf(fixture: string) {
  const exp = await loadExpectation(fixture);
  const snapshot = await collectFixture(fixture, exp);
  const result = await runFindings(snapshot, {
    readText,
    argvTails: lastProbe.argvTails,
    capabilityDescriptions: lastProbe.capabilityDescriptions,
  });
  const llm = await buildLlmReport(snapshot, result, { readText });
  return buildUiData({
    snapshot,
    result,
    history: null,
    readText,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
}

/** 合成 Finding（cluster 規則だけを見るための最小形） */
function f(over: Partial<UiFindingView> & { id: string; finding_id: string }): UiFindingView {
  return {
    subtype: null,
    severity: 'warn',
    confidence: 'high',
    scope: 'next_session',
    summary: 'x',
    subject_path: null,
    subject_display: over.id,
    cluster: null,
    protected: false,
    touches_protected: false,
    protected_note: null,
    axes: [],
    evidence: [],
    unknowns: [],
    did_not_conclude: [],
    human_decision: [],
    detail: {},
    ...over,
  } as UiFindingView;
}

// ───────────────────── cluster の規則 ─────────────────────

test('cluster: 同じ原因（同じ plugin namespace）は 1 つに束ねる', () => {
  const cs = clusterFindings([
    f({ id: 'F-001', finding_id: 'UNREACHABLE_REFERENCE', subtype: 'missing_target', severity: 'error', cluster: 'plugin:vercel', detail: { plugin_namespace: 'vercel', referrers: ['~/a.md:1'] } }),
    f({ id: 'F-002', finding_id: 'UNREACHABLE_REFERENCE', subtype: 'missing_target', severity: 'error', cluster: 'plugin:vercel', detail: { plugin_namespace: 'vercel', referrers: ['~/a.md:2'] } }),
    f({ id: 'F-003', finding_id: 'UNREACHABLE_REFERENCE', subtype: 'missing_target', severity: 'error', cluster: 'plugin:vercel', detail: { plugin_namespace: 'vercel', referrers: ['~/b.md:3'] } }),
  ]);
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.members.length, 3);
  assert.match(cs[0]!.headline, /vercel/);
  assert.match(cs[0]!.count_label, /3 refs/);
  assert.ok(cs[0]!.grouped_by.length > 0, '束ねた根拠を必ず書く');
});

test('cluster: 原因が違うもの（別 namespace / 別 runtime / 別 command）を混ぜない', () => {
  const cs = clusterFindings([
    f({ id: 'F-001', finding_id: 'UNREACHABLE_REFERENCE', subtype: 'missing_target', cluster: 'plugin:vercel', detail: { plugin_namespace: 'vercel' } }),
    f({ id: 'F-002', finding_id: 'UNREACHABLE_REFERENCE', subtype: 'missing_target', cluster: 'plugin:superpowers', detail: { plugin_namespace: 'superpowers' } }),
    f({ id: 'F-003', finding_id: 'SESSION_STALENESS', subtype: 'resource_changed_after_start', detail: { session: { runtime: 'claude-code' }, changed_count: 2, changed: [{ file: 'a' }, { file: 'b' }] } }),
    f({ id: 'F-004', finding_id: 'SESSION_STALENESS', subtype: 'resource_changed_after_start', detail: { session: { runtime: 'codex' }, changed_count: 1, changed: [{ file: 'c' }] } }),
    f({ id: 'F-005', finding_id: 'HOOK_AMPLIFICATION', subtype: 'same_registration_multiple_events', detail: { command: '~/x.sh', events: ['A', 'B'], registrations: [1, 2] } }),
    f({ id: 'F-006', finding_id: 'HOOK_AMPLIFICATION', subtype: 'same_registration_multiple_events', detail: { command: '~/y.sh', events: ['A', 'B'], registrations: [1, 2] } }),
  ]);
  assert.equal(cs.length, 6, '別の原因は別の束のまま');
  for (const c of cs) assert.equal(c.members.length, 1);
});

test('cluster: 同じ runtime の同じ種類のズレは束ね、件数は cluster 単位で数える', () => {
  const stale = (id: string, files: string[]) =>
    f({ id, finding_id: 'SESSION_STALENESS', subtype: 'resource_changed_after_start', detail: { session: { runtime: 'claude-code' }, changed_count: files.length, changed: files.map((x) => ({ file: x })) } });
  const cs = clusterFindings([stale('F-001', ['a', 'b']), stale('F-002', ['a', 'b']), stale('F-003', ['a', 'b', 'c'])]);
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.members.length, 3);
  assert.match(cs[0]!.count_label, /3 sessions/);
  // 内訳が 1 通りでないことを事実として書く（同じ束にしても差を隠さない）
  assert.ok(cs[0]!.facts.some((x) => /distinct combination|2-3 files/.test(x)), `内訳の事実が無い: ${JSON.stringify(cs[0]!.facts)}`);
});

test('cluster: finding_id を跨いで束ねない', () => {
  const cs = clusterFindings([
    f({ id: 'F-001', finding_id: 'CROSS_RUNTIME_DRIFT', cluster: 'drift:claude-code|codex', detail: { sides: [{ runtime: 'claude-code' }, { runtime: 'codex' }], lines_differ: 8 } }),
    f({ id: 'F-002', finding_id: 'SCOPE_MISMATCH', subject_display: '~/.claude/rules/x.md' }),
  ]);
  assert.equal(cs.length, 2);
  assert.ok(cs.every((c) => new Set(c.members).size === c.members.length));
});

test('cluster: 見出しに助言・最適化の語を入れない（事実の翻訳だけ）', () => {
  const cs = clusterFindings([
    f({ id: 'F-001', finding_id: 'UNREACHABLE_REFERENCE', subtype: 'missing_target', severity: 'error', cluster: 'plugin:vercel', detail: { plugin_namespace: 'vercel', referrers: ['~/a.md:1'], plugin_status_by_runtime: { 'claude-code': 'not_installed' } } }),
    f({ id: 'F-002', finding_id: 'CROSS_RUNTIME_DRIFT', cluster: 'drift:claude-code|codex', detail: { sides: [{ runtime: 'claude-code' }, { runtime: 'codex' }], lines_differ: 8 } }),
    f({ id: 'F-003', finding_id: 'SESSION_STALENESS', subtype: 'resource_changed_after_start', detail: { session: { runtime: 'claude-code' }, changed_count: 3, changed: [{ file: 'a' }] } }),
    f({ id: 'F-004', finding_id: 'HOOK_AMPLIFICATION', subtype: 'same_registration_multiple_events', detail: { command: '~/x.sh', events: ['A', 'B'], registrations: [1, 2], measured: { firings: 0, total_bytes: 0 } } }),
  ]);
  for (const c of cs) {
    for (const line of [c.headline, ...c.facts, c.grouped_by]) {
      assert.ok(!NO_ADVICE.test(line), `助言の語が混ざった: ${line}`);
    }
  }
});

// ───────────────────── Overview（実 fixture） ─────────────────────

test('Overview: 見出しの N は Finding の件数ではなく cluster の数', async () => {
  const d = await uiOf('unreachable-reference');
  assert.ok(d.findings.length > 0, 'この fixture は Finding が出る前提');
  assert.equal(d.overview.attention_count, d.overview.clusters.length);
  assert.ok(d.overview.attention_count <= d.findings.length);
  assert.match(d.overview.headline, /^\d+ areas? need attention$/);
  assert.equal(d.overview.finding_count, d.findings.length);
});

test('Overview: cluster の member は必ず実在する Finding を指す（詳細 Evidence へ辿れる）', async () => {
  for (const name of ['unreachable-reference', 'cross-runtime-drift', 'session-staleness']) {
    const d = await uiOf(name);
    const ids = new Set(d.findings.map((x) => x.id));
    const covered = new Set<string>();
    for (const c of d.overview.clusters) {
      for (const m of c.members) {
        assert.ok(ids.has(m), `${name}: cluster ${c.id} が実在しない Finding ${m} を指している`);
        covered.add(m);
      }
      const first = d.findings.find((x) => x.id === c.members[0]);
      assert.ok(first && first.evidence.length > 0, `${name}: 潜った先に Evidence が無い`);
    }
    assert.equal(covered.size, d.findings.length, `${name}: cluster に入らない Finding がある（Overview から辿れない）`);
  }
});

test('Overview: Finding 0 でも壊れない（guard fixture）', async () => {
  const d = await uiOf('guard-false-bloat');
  assert.equal(d.findings.length, 0);
  assert.equal(d.overview.attention_count, 0);
  assert.equal(d.overview.clusters.length, 0);
  assert.match(d.overview.headline, /0 areas need attention/);
  // 0 件を「問題が無い」と言い切らない
  assert.match(d.overview.headline_note, /range that was not looked at/);
  assert.ok(d.overview.not_problems.length > 0, '0 件でも「症状にしなかったこと」は出す');
});

test('Overview: 大きさだけでは attention を作らない', async () => {
  const d = await uiOf('guard-false-bloat');
  assert.equal(d.overview.clusters.length, 0, 'context cost が大きくても cluster にしない');
  const cost = d.overview.not_problems.find((x) => x.goto === 'cost');
  assert.ok(cost, 'context cost は「問題とは診断していないこと」側に出す');
  assert.match(cost!.label, /Size alone is not treated as a symptom/);
  // cost 由来の Finding が 1 つも無いこと
  assert.equal(d.findings.filter((x) => /COST|SIZE|BLOAT/i.test(x.finding_id)).length, 0);
});

test('Overview: Not findings / Coverage への導線が残っている', async () => {
  const d = await uiOf('cross-runtime-drift');
  const gotos = new Set(d.overview.not_problems.map((x) => x.goto));
  assert.ok(gotos.has('notfindings'), 'Not findings への導線が消えた');
  assert.ok(gotos.has('cost'), 'Context cost への導線が消えた');
  assert.ok(d.overview.not_problems.every((x) => x.detail.length > 0), '判断の宣言文を捨てない');
});

test('Overview: 未観測の履歴を「変化なし」と言わない', async () => {
  const d = await uiOf('cross-runtime-drift');
  assert.equal(d.overview.recent.snapshots, 0);
  assert.ok(
    d.overview.recent.note.some((x) => /can be derived yet/.test(x) && /does not mean.*nothing changed/.test(x)),
    `未観測の断りが無い: ${JSON.stringify(d.overview.recent.note)}`,
  );
  assert.ok(!d.overview.recent.note.some((x) => /変化なし/.test(x)));
});

test('Overview: 観測の空白を「その間は何も起きていない」として扱わない', async () => {
  const exp = await loadExpectation('cross-runtime-drift');
  const snapshot = await collectFixture('cross-runtime-drift', exp);
  const result = await runFindings(snapshot, { readText });
  // 2 本の snapshot はあるが、その間に観測の空白がある状態を作る
  const history = {
    series: { refs: [], usable: [snapshot, snapshot], skipped: [], gaps: [{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z', hours: 96 }] },
    events: [],
    trend: [],
    notes: [],
  } as never;
  const d = await buildUiData({ snapshot, result, history, readText });
  assert.equal(d.overview.recent.gaps, 1);
  assert.ok(
    d.overview.recent.note.some((x) => /unobserved gap/.test(x)),
    `空白の断りが無い: ${JSON.stringify(d.overview.recent.note)}`,
  );
  assert.ok(!d.overview.recent.note.some((x) => /変化なし|問題なし/.test(x)));
});

test('Overview: 内部の数（resources / bindings / observations）は主役にしない', async () => {
  const d = await uiOf('unreachable-reference');
  // 見出しと副題に内部の数を出さない
  assert.ok(!/resources|bindings|observations/.test(d.overview.headline + d.overview.headline_note));
  // 数そのものは internals として保持する（Coverage の理解に要る）
  assert.equal(d.overview.internals.resources, d.counts.resources);
  assert.equal(d.overview.internals.bindings, d.counts.bindings);
});

test('Overview: Claude / Codex の比較は事実だけ（正本を決めない）', async () => {
  const d = await uiOf('cross-runtime-drift');
  const c = d.overview.comparison;
  assert.equal(c.same_name_skills.identical + c.same_name_skills.drifted, c.same_name_skills.pairs);
  assert.ok(c.runtimes.length >= 2);
  assert.ok(!NO_ADVICE.test(c.note), '比較に助言を書かない');
  assert.match(c.note, /does not decide/);
});

// ───────────────────── Structure の「つまり何？」 ─────────────────────

test('つまり何？: 両 runtime が別コピーを見ている資源は、その関係と差分行数を人間語で言う', async () => {
  const d = await uiOf('cross-runtime-drift');
  const drifted = d.resources.find((r) => r.siblings.some((s) => !s.content_matches) && Object.values(r.by_runtime).flat().some((b) => b.discovered));
  assert.ok(drifted, 'drift している資源が見つからない');
  const [first] = drifted!.human_summary;
  assert.ok(first, '要約が空');
  assert.match(first!, /Claude|Codex/);
  assert.match(first!, /different copy|matches/);
  assert.ok(drifted!.human_summary.length <= 2, '1〜2 行に収める');
  for (const line of drifted!.human_summary) assert.ok(!NO_ADVICE.test(line), `助言が混ざった: ${line}`);
});

test('つまり何？: すべての資源に要約が付き、助言を含まない', async () => {
  const d = await uiOf('unreachable-reference');
  for (const r of d.resources) {
    assert.ok(r.human_summary.length >= 1 && r.human_summary.length <= 2, `${r.display_path}: 要約が 1〜2 行でない`);
    for (const line of r.human_summary) assert.ok(!NO_ADVICE.test(line), `${r.display_path}: ${line}`);
  }
});

test('つまり何？: 誰も発見していない資源を「壊れている」と言わない', () => {
  const r = {
    resource_id: 'x',
    path: '/h/.claude/skills/flat.md',
    display_path: '~/.claude/skills/flat.md',
    real_path: null,
    kind: 'skill',
    name: 'flat',
    owner: 'user',
    size_bytes: 10,
    mtime: '2026-01-01T00:00:00.000Z',
    normalized_hash: 'sha256:x',
    description: null,
    by_runtime: { 'claude-code': [{ discovered: false } as never] },
    siblings: [],
    finding_ids: [],
    cost: [],
    references: [],
    events: [],
    protected: false,
    human_summary: [],
  } as unknown as UiResourceView;
  const lines = resourceHumanSummary(r, ['claude-code', 'codex']);
  assert.match(lines[0]!, /not discovered/);
  assert.ok(!/壊れ|異常|問題/.test(lines.join(' ')));
});

// ───────────────────── Expert 層を消していない ─────────────────────

test('画面: Overview が先頭かつ既定で、Expert 層のタブが全部残っている', () => {
  const html = renderPage();
  const order = ['overview', 'structure', 'findings', 'cost', 'hooks', 'history', 'notfindings', 'coverage'];
  const at = order.map((id) => html.indexOf(`'${id}','`));
  assert.ok(at.every((x) => x > 0), `タブが欠けている: ${JSON.stringify(order.map((id, i) => [id, at[i]]))}`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! > at[i - 1]!, `${order[i]} が ${order[i - 1]} より前にある`);
  assert.match(html, /show\(TABS\.some\(\[x\]\)=>x===h0\)\?h0:'overview'\)|:'overview'\)/, '既定タブが overview でない');
  // Not findings は Doctor の信用の柱。消さない
  assert.ok(html.includes('renderNotFindings'), 'Not findings の描画が消えた');
  // Health Score という語が出るのは「作らない」という宣言の中だけ
  assert.match(html, /Health Score は作らない/);
  assert.ok(!/healthScore|health_score|\/\s*100\b/.test(html), '点数の実装が入り込んでいる');
});

test('画面: C / X の凡例がある（初見で意味が分かる）', () => {
  const html = renderPage();
  assert.match(html, /C = Claude Code \/ X = Codex/);
  assert.match(html, /Discovered by runtime/);
});

test('画面: Observing は既定で短く、全文は畳んで残す', () => {
  const html = renderPage();
  assert.match(html, /observing\.short/);
  assert.match(html, /observing\.full/);
});

// ───────────────────── notProblems の単体 ─────────────────────

test('notProblems: 未知の guard を黙って落とさない', () => {
  const cost = {
    scope: 's',
    method_note: 'note',
    by_load_mode: { always: { items: 1, bytes: 10, token_estimate: 3 } },
    by_mechanism: {},
    by_runtime: {},
    protected_total: { items: 0, bytes: 0, token_estimate: 0 },
    unprotected_total: { items: 1, bytes: 10, token_estimate: 3 },
    largest: [],
    items: [],
    not_measured: [],
  } as unknown as ContextCost;
  const out = notProblems({
    cost,
    suppressed: [{ reason: 'brand_new_guard', detail: 'something the UI does not know yet', count: 7 }],
    protectedCount: 0,
    notEvaluated: [],
    notCollected: [],
  });
  assert.ok(out.some((x) => x.detail.includes('something the UI does not know yet')), '未知 guard の宣言文が消えた');
});
