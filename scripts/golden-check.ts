/**
 * Golden Snapshot 回帰チェック
 *
 *   npx tsx scripts/golden-check.ts [--from <snapshot.json>] [--project <dir>] [--update --note "<理由>"]
 *
 * 既定は BECKY 実環境を今 collect して test/golden/phase0-baseline.json と突合する。
 * --from を渡すと保存済み snapshot を要約して突合する（環境が変わった後でも、
 * 同じ snapshot から同じ数字が出るか = 要約・IR の回帰を見る）。
 *
 * 数字が動いた時の読み方（どちらか、自動では区別しない）:
 *   a. 環境が変わった（skill を足した等）→ 原因を確認してから --update
 *   b. IR / adapter の挙動が変わった → 回帰。コードを見る
 * 判断は人がする。--update を CI から叩かない。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { claudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { codexAdapter } from '../src/adapters/codex/index.js';
import { collect, loadSnapshot } from '../src/snapshot.js';
import { summarize, compareSummaries, type SnapshotSummary } from '../src/summary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(HERE, '..', 'test', 'golden', 'phase0-baseline.json');

interface Baseline {
  baseline_id: string;
  captured_at: string;
  tool_version: string;
  schema_version: number;
  environment: Record<string, string | null>;
  /** 基準値が動いた履歴。--update のたびに --note で 1 行足す */
  history: Array<{ date: string; event: string; note: string }>;
  summary: SnapshotSummary;
}

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : true) : undefined;
};

const from = flag('from');
const update = flag('update') === true;
const project = typeof flag('project') === 'string' ? resolve(String(flag('project'))) : resolve(HERE, '..', '..', '..');

const snapshot =
  typeof from === 'string'
    ? await loadSnapshot(from)
    : (await collect([claudeCodeAdapter, codexAdapter], { home: homedir(), project })).snapshot;
const actual = summarize(snapshot);

if (update) {
  // history は消さない。動かした理由を --note で必ず残す（黙って基準を動かさない）
  const note = flag('note');
  if (typeof note !== 'string' || !note.trim()) {
    console.error('--update には --note "<なぜ動いたか>" が必須（環境が変わったのか、IR が変わったのか）');
    process.exit(2);
  }
  let prevHistory: Array<{ date: string; event: string; note: string }> = [];
  try {
    prevHistory = (JSON.parse(await readFile(BASELINE, 'utf8')) as { history?: typeof prevHistory }).history ?? [];
  } catch {
    /* 初回 */
  }
  const b: Baseline = {
    baseline_id: `phase0-${snapshot.snapshot_id.slice(0, 10)}`,
    captured_at: snapshot.snapshot_id,
    tool_version: snapshot.tool_version,
    schema_version: snapshot.schema_version,
    environment: {
      note: 'Recorded from a real environment. Numbers are environment-specific; the value is in detecting movement, not in the absolute figures.',
      project: snapshot.env.project,
      runtimes: snapshot.runtimes.map((r) => `${r.runtime}@${r.version ?? '?'}`).join(', '),
    },
    history: [...prevHistory, { date: snapshot.snapshot_id.slice(0, 10), event: 'update', note: String(note) }],
    summary: actual,
  };
  await writeFile(BASELINE, JSON.stringify(b, null, 2) + '\n', 'utf8');
  console.log(`baseline updated: ${BASELINE}`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(BASELINE, 'utf8')) as Baseline;
const diffs = compareSummaries(baseline.summary, actual);
console.log(`golden: ${baseline.baseline_id}  (captured ${baseline.captured_at}, ${baseline.environment['runtimes']})`);
console.log(`source: ${typeof from === 'string' ? from : `live collect (project=${project})`}`);
console.log('');
const row = (k: string, e: unknown, a: unknown) => console.log(`  ${k.padEnd(28)} ${String(e).padStart(6)}  ${String(a).padStart(6)}  ${e === a ? '' : '← moved'}`);
console.log(`  ${'metric'.padEnd(28)} ${'golden'.padStart(6)}  ${'now'.padStart(6)}`);
row('resources', baseline.summary.counts.resources, actual.counts.resources);
row('bindings', baseline.summary.counts.bindings, actual.counts.bindings);
row('observations', baseline.summary.counts.observations, actual.counts.observations);
row('same-name skill pairs', baseline.summary.same_name_skills.pairs, actual.same_name_skills.pairs);
row('  identical', baseline.summary.same_name_skills.identical, actual.same_name_skills.identical);
row('  drifted', baseline.summary.same_name_skills.drifted, actual.same_name_skills.drifted);
row('discovered=false', baseline.summary.undiscovered.total, actual.undiscovered.total);
console.log('');
if (diffs.length === 0) {
  console.log('GOLDEN: MATCH');
  process.exit(0);
}
console.log(`GOLDEN: MOVED (${diffs.length} differences)`);
for (const d of diffs) console.log(`  ${d}`);
console.log('');
console.log('Either the environment changed or the IR/adapter changed. Decide which before running --update.');
process.exit(1);
