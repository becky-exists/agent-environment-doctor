/**
 * Finding 3 本 — fixture の expected.json と照合する
 *
 *   findings[]     : 出るべきもの（finding_id / subtype / subject / evidence_must_include / must_not_contain）
 *   no_findings[]  : 出てはいけないもの（path / name / runtime）
 *   件数は expected と完全一致（余計な Finding も不合格）
 *   guard-false-bloat は findings: []。ここが落ちたら他が全部通っても不合格
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FIXTURE_NAMES, collectFixture, expand, fixtureHome, lastProbe, loadExpectation } from './helpers.js';
import { runFindings } from '../src/findings/index.js';
import { FORBIDDEN_WORDS } from '../src/findings/context.js';
import type { EvidenceRef, Finding, Snapshot } from '../src/ir/types.js';

const readText = async (p: string) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

function evidenceMatches(s: Snapshot, e: EvidenceRef, want: Record<string, unknown>, home: string): boolean {
  if (e.type !== want['type']) return false;
  const exp = (k: string) => (typeof want[k] === 'string' ? expand(String(want[k]), home) : undefined);
  switch (e.type) {
    case 'binding': {
      if (want['runtime'] && e.runtime !== want['runtime']) return false;
      if (want['rule_id'] && e.rule_id !== want['rule_id']) return false;
      if (want['mechanism'] && e.mechanism !== want['mechanism']) return false;
      if (exp('resource_path') && e.resource_path !== exp('resource_path')) return false;
      const b = s.bindings.find((x) => x.binding_id === e.binding_id);
      if (!b) return false;
      if ('discovered' in want && b.discovered !== want['discovered']) return false;
      if (want['load_mode'] && b.load_mode !== want['load_mode']) return false;
      return true;
    }
    case 'contrast':
      return !exp('path') || e.path === exp('path');
    case 'resource':
      return (!exp('path') || e.path === exp('path')) && (want['line'] === undefined || e.line === want['line']);
    case 'reference':
      return (!exp('path') || e.path === exp('path')) && (!want['raw'] || e.raw === want['raw']) && (want['line'] === undefined || e.line === want['line']);
    case 'absence': {
      if (want['target'] && e.target !== want['target']) return false;
      const must = (want['searched_must_include'] as string[] | undefined) ?? [];
      return must.every((m) => e.searched.some((x) => x === expand(m, home)));
    }
    case 'observation':
      return true;
    case 'session':
      return (!want['session_id'] || e.session_id === want['session_id']) && (!want['runtime'] || e.runtime === want['runtime']);
    case 'process':
      return want['pid'] === undefined || e.pid === want['pid'];
  }
}

function subjectMatches(f: Finding, want: Record<string, unknown>, home: string): boolean {
  const subj = (want['subject'] ?? {}) as Record<string, unknown>;
  if (typeof subj['path'] === 'string' && f.subject.path !== expand(subj['path'], home)) return false;
  if (typeof subj['name'] === 'string' && f.subject.name !== subj['name']) return false;
  if (typeof subj['line'] === 'number') {
    // subject.line は evidence の reference / resource 行で表現される
    const line = subj['line'];
    if (!f.evidence_refs.some((e) => (e.type === 'reference' || e.type === 'resource') && e.line === line)) return false;
  }
  return true;
}

for (const name of FIXTURE_NAMES) {
  test(`findings ${name}: expected.json と一致（件数も）`, async () => {
    const exp = await loadExpectation(name);
    const s = await collectFixture(name, exp);
    const home = fixtureHome(name, exp);
    const res = await runFindings(s, { readText, argvTails: lastProbe.argvTails, capabilityDescriptions: lastProbe.capabilityDescriptions });

    // 件数完全一致
    assert.equal(res.findings.length, exp.findings.length, `Finding 件数。実際: ${res.findings.map((f) => `${f.finding_id}/${f.subtype ?? '-'} ${f.subject.path ?? f.subject.name}`).join(' | ')}`);

    for (const want of exp.findings) {
      const hits = res.findings.filter((f) => f.finding_id === want['finding_id'] && (want['subtype'] === undefined || f.subtype === want['subtype']) && subjectMatches(f, want, home));
      assert.equal(hits.length, 1, `期待 ${JSON.stringify(want['subject'])} に一致する Finding が ${hits.length} 件`);
      const f = hits[0]!;
      if (want['severity']) assert.equal(f.severity, want['severity'], `${f.finding_id}: severity`);
      if (want['confidence']) assert.equal(f.confidence, want['confidence'], `${f.finding_id}: confidence`);
      for (const ev of (want['evidence_must_include'] as Record<string, unknown>[]) ?? []) {
        assert.ok(f.evidence_refs.some((e) => evidenceMatches(s, e, ev, home)), `${f.finding_id}: evidence が無い ${JSON.stringify(ev)}\n実際: ${JSON.stringify(f.evidence_refs, null, 1).slice(0, 1500)}`);
      }
      for (const w of (want['must_not_contain'] as string[]) ?? []) assert.ok(!f.summary.toLowerCase().includes(w.toLowerCase()), `${f.finding_id}: summary に "${w}"`);
      if (want['reference'] && typeof want['reference'] === 'object') {
        const r = want['reference'] as { raw: string };
        assert.equal(f.detail?.['reference'], r.raw);
      }
    }

    for (const no of exp.no_findings) {
      const path = typeof no['path'] === 'string' ? expand(no['path'], home) : null;
      const nm = typeof no['name'] === 'string' ? no['name'] : null;
      const ref = typeof no['reference'] === 'string' ? no['reference'] : null;
      const sid = typeof no['session_id'] === 'string' ? no['session_id'] : null;
      const cap = typeof no['capability'] === 'string' ? no['capability'] : null;
      const bad = ref
        ? res.findings.filter((f) => f.detail?.['reference'] === ref)
        : sid && cap
          ? res.findings.filter((f) => f.subject.session_id === sid && f.detail?.['capability_name'] === cap)
          : sid
            ? res.findings.filter((f) => f.subject.session_id === sid)
            : res.findings.filter((f) => (path && f.subject.path === path) || (nm && f.subject.name === nm));
      assert.deepEqual(bad.map((f) => `${f.finding_id}/${f.subtype ?? '-'}`), [], `出てはいけない Finding: ${no['path'] ?? no['name']} — ${no['why']}`);
    }

    // 言葉の規律と証拠の必須
    for (const f of res.findings) {
      assert.ok(!FORBIDDEN_WORDS.test(f.summary), `禁止語: ${f.summary}`);
      assert.ok(f.evidence_refs.length > 0, 'evidence が空');
    }
  });
}

test('guard-false-bloat: findings は空、suppressed が「なぜ出さないか」を列挙する', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  const res = await runFindings(s, { readText });
  assert.deepEqual(res.findings, []);
  const reasons = res.suppressed.map((x) => x.reason);
  assert.ok(reasons.includes('count_is_not_a_symptom'), 'MCP の数を抑制した宣言が無い');
  assert.ok(reasons.includes('invisible_by_specification'), '仕様どおりの不可視を抑制した宣言が無い');
  assert.ok(reasons.includes('intentional_disable'), '無効化 plugin を抑制した宣言が無い');
  assert.ok(reasons.includes('unused_is_not_unnecessary'), '未使用 skill を抑制した宣言が無い');
  assert.ok(res.protected.some((p) => /MEMORY\.md$/.test(p.path)), 'MEMORY.md が protected に載っていない');
});

test('scope-mismatch: 本文の読み手が無い（保存済み snapshot）なら評価せず skipped に残す。できるふりをしない', async () => {
  const exp = await loadExpectation('scope-mismatch');
  const s = await collectFixture('scope-mismatch', exp);
  const res = await runFindings(s);
  assert.equal(res.findings.filter((f) => f.finding_id === 'SCOPE_MISMATCH').length, 0);
  assert.ok(res.skipped.some((x) => x.detector === 'SCOPE_MISMATCH'));
});

test('cross-runtime-drift: 読み手が無くても drift 自体は出る（行数だけ null）', async () => {
  const exp = await loadExpectation('cross-runtime-drift');
  const s = await collectFixture('cross-runtime-drift', exp);
  const res = await runFindings(s);
  const d = res.findings.filter((f) => f.finding_id === 'CROSS_RUNTIME_DRIFT');
  assert.equal(d.length, 1);
  assert.equal(d[0]!.detail?.['lines_differ'], null);
  const withText = await runFindings(s, { readText });
  assert.ok(Number(withText.findings[0]!.detail?.['lines_differ']) > 0);
  // 差分の本文が付く（行数だけでは受け手が判断できない）
  const dx = withText.findings[0]!.detail?.['diff_excerpt'] as { lines: string[]; added: number; removed: number };
  // 向きは claude-code 側（a）→ codex 側（b）: '-' が claude 側にだけある行、'+' が codex 側にだけある行
  assert.ok(dx && dx.lines.some((l) => l.startsWith('-') && l.includes('rev 3')) && dx.lines.some((l) => l.startsWith('+') && l.includes('rev 1')), JSON.stringify(dx));
  assert.ok(dx.added > 0 && dx.removed > 0);
  // mtime を正しさの根拠にしない文言
  assert.match(withText.findings[0]!.summary, /not which is correct|same mtime/);
});
