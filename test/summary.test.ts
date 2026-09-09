/**
 * Golden Snapshot の要約が決定的で、動いた時に検知できること
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ROOT, collectFixture, loadExpectation } from './helpers.js';
import { summarize, compareSummaries, type SnapshotSummary } from '../src/summary.js';
import { loadSnapshot } from '../src/snapshot.js';

test('summarize: cross-runtime-drift fixture で同名 3 組 / 一致 2 / drift 1', async () => {
  const exp = await loadExpectation('cross-runtime-drift');
  const s = await collectFixture('cross-runtime-drift', exp);
  const sum = summarize(s);
  assert.deepEqual(sum.same_name_skills, { pairs: 3, identical: 2, drifted: 1 });
  // 同一内容が複数パス = same のみ（crlf-twin は content_hash が違うので数えない）
  assert.equal(sum.same_content_multi_path, 1);
  // 両向きの not_in_search_path が 3 件ずつ
  assert.equal(sum.undiscovered.by_rule['claude.skill.not_in_search_path'], 3);
  assert.equal(sum.undiscovered.by_rule['codex.skill.not_in_standard_locations'], 3);
  // 決定的: 2 回要約して同じ
  assert.deepEqual(summarize(s), sum);
});

test('compareSummaries: 1 件動けば 1 行で言える', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  const s = await collectFixture('guard-false-bloat', exp);
  const a = summarize(s);
  const b: SnapshotSummary = JSON.parse(JSON.stringify(a));
  assert.deepEqual(compareSummaries(a, b), []);
  b.counts.resources += 1;
  b.undiscovered.by_rule['codex.plugin.enabled_flag'] = 0;
  const d = compareSummaries(a, b);
  assert.equal(d.length, 2, d.join('\n'));
  assert.ok(d[0]!.startsWith('summary.counts.resources: expected'));
});

test('golden baseline: リポジトリの基準値が Phase 0 の数字を保持している', async () => {
  const b = JSON.parse(await readFile(join(ROOT, 'test', 'golden', 'phase0-baseline.json'), 'utf8')) as { summary: SnapshotSummary; schema_version: number };
  assert.equal(b.schema_version, 4);
  // 2026-09-07 の Phase 0 実測 203/275/510 → plugin agent 収集 → invocation の範囲修正 → commands 収集で 206/278/484（baseline の history 参照）。動かす時は golden-check --update で意図的に
  assert.deepEqual(b.summary.counts, { resources: 206, bindings: 278, observations: 484 });
  assert.ok(Array.isArray((b as any).history) && (b as any).history.length >= 3, 'history に移動の理由が無い');
  assert.deepEqual(b.summary.same_name_skills, { pairs: 26, identical: 16, drifted: 10 });
  assert.equal(b.summary.undiscovered.total, 73);
});

test('golden baseline: ローカルに保存した golden snapshot と要約が一致する（無ければ skip）', async (t) => {
  const local = join(ROOT, 'snapshots', 'golden-phase0-2026-09-07.json');
  try {
    await access(local);
  } catch {
    t.skip('snapshots/golden-phase0-2026-09-07.json が無い（gitignore、実測マシン限定）');
    return;
  }
  const b = JSON.parse(await readFile(join(ROOT, 'test', 'golden', 'phase0-baseline.json'), 'utf8')) as { summary: SnapshotSummary };
  const s = await loadSnapshot(local);
  assert.deepEqual(compareSummaries(b.summary, summarize(s)), []);
});
