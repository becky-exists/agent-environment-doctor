/**
 * Portable Diagnostic Bundle — 他人の環境を安全に持ち出せるか
 *
 * ここで守るのは 3 つ。
 *   1. **本文が 1 行も出ない**（transcript / memory / CLAUDE.md / AGENTS.md / source）
 *   2. **secret・username・顧客名が生で出ない**。出たら bundle を書かない
 *   3. **redaction 後も参照整合性が残る**（同じ実体は同じ id、id は必ず解決できる）
 *
 * 「たぶん入っていない」で済ませないので、fixture に**わざと仕込んだもの**を対象に検査する。
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { collectFixture, lastProbe, loadExpectation, FIXTURES } from './helpers.js';
import { claudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { codexAdapter } from '../src/adapters/codex/index.js';
import { collect, attachActiveRuntime } from '../src/snapshot.js';
import { observeActiveRuntime, toSessionInfo, toProcessInfo } from '../src/probe/index.js';
import { runFindings } from '../src/findings/index.js';
import { detectSessionStaleness } from '../src/findings/session-staleness.js';
import { buildLlmReport } from '../src/llm-report.js';
import { buildUiData } from '../src/ui/data.js';
import { buildBundle, BUNDLE_FORMAT, scanForUnsafeBodyKeys, scanForResourceBodyLeaks, type DiagnosticBundle } from '../src/bundle/index.js';
import { Redactor, SECRET_PATTERNS, scanForLeaks } from '../src/bundle/redact.js';
import type { RedactionLevel } from '../src/bundle/redact.js';
import type { Binding, Resource, SessionInfo, Snapshot } from '../src/ir/types.js';

const readText = async (p: string) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

/**
 * fixture に仕込んだ、bundle に出てはいけない文字列。
 *
 * **本物そっくりの鍵をリポジトリに置かない。** fixture には placeholder を書いておき、
 * ここで組み立てた文字列を一時ディレクトリのコピーへ差し込んでから収集する
 * （リポジトリを走査する secretlint に本物の形を見せない。OSS として配る以上、置いてはいけない）。
 */
const PLANTED_SECRETS: Record<string, string> = {
  __PLANTED_ANTHROPIC_KEY__: ['sk', 'ant', 'api03', 'PLANTEDFIXTURESECRET0000000'].join('-'),
  __PLANTED_ANTHROPIC_KEY_IN_BODY__: ['sk', 'ant', 'api03', 'INSIDEFILEBODYSECRET0000000'].join('-'),
  __PLANTED_GITHUB_TOKEN__: `ghp${'_'}PLANTEDFIXTUREGITHUBTOKEN0000`,
};

const PLANTED = [
  ...Object.values(PLANTED_SECRETS),
  'tanaka',
  'client-alpha',
  'クライアントアルファ',
  '株式会社',
  'tanaka@example.com',
];

/** fixture を一時ディレクトリへ複製し、placeholder に本物の形を差し込む */
async function plantedHome(): Promise<string> {
  const src = join(FIXTURES, 'bundle-privacy', 'env', 'home');
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-planted-'));
  await cp(src, root, { recursive: true });
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      let t = await readFile(full, 'utf8');
      let changed = false;
      for (const [k, v] of Object.entries(PLANTED_SECRETS)) {
        if (t.includes(k)) {
          t = t.split(k).join(v);
          changed = true;
        }
      }
      if (changed) await writeFile(full, t, 'utf8');
    }
  };
  await walk(root);
  planted.push(root);
  return root;
}

const planted: string[] = [];
after(async () => {
  for (const r of planted) await rm(r, { recursive: true, force: true });
});

/** 実環境の変数を持ち込まずに、差し込み済みの home から収集する */
async function collectPlanted(home: string, project: string | null = null) {
  const saved = { CODEX_HOME: process.env['CODEX_HOME'], CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'], PATH: process.env['PATH'] };
  delete process.env['CODEX_HOME'];
  delete process.env['CLAUDE_CONFIG_DIR'];
  process.env['PATH'] = dirname(process.execPath);
  try {
    return (await collect([claudeCodeAdapter, codexAdapter], { home, project })).snapshot;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function privacyBundle(level: RedactionLevel = 'strict'): Promise<DiagnosticBundle> {
  const home = await plantedHome();
  const snapshot = await collectPlanted(home);
  const result = await runFindings(snapshot, { readText });
  const llm = await buildLlmReport(snapshot, result, { readText });
  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    readText,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
  return buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level, readText, symptom: 'テスト用の主訴' });
}

async function bundleOf(fixture: string, level: RedactionLevel = 'strict'): Promise<DiagnosticBundle> {
  const exp = await loadExpectation(fixture);
  const snapshot = await collectFixture(fixture, exp);
  const result = await runFindings(snapshot, {
    readText,
    argvTails: lastProbe.argvTails,
    capabilityDescriptions: lastProbe.capabilityDescriptions,
  });
  const llm = await buildLlmReport(snapshot, result, { readText });
  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    readText,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
  return buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level, readText, symptom: 'テスト用の主訴' });
}

// ───────────────────── privacy ─────────────────────

test('bundle: 仕込んだ secret / username / 顧客名が 1 つも残らない', async () => {
  const b = await privacyBundle();
  const raw = JSON.stringify(b);
  for (const p of PLANTED) {
    assert.ok(!raw.includes(p), `bundle に "${p}" が残っている`);
  }
});

test('bundle: 本文（ファイルの中身）が 1 行も入らない', async () => {
  const b = await privacyBundle();
  const raw = JSON.stringify(b);
  // fixture の本文にしか出てこない語
  for (const body of ['この本文が bundle に 1 行でも出たら失格', '顧客の案件メモ', '本文。ここも bundle には入らない']) {
    assert.ok(!raw.includes(body), `本文が漏れている: ${body}`);
  }
  // 「string の配列である lines」がどこにも残っていない
  const found: string[] = [];
  const walk = (v: unknown, where: string): void => {
    if (Array.isArray(v)) return void v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'lines' && Array.isArray(val) && val.length && val.every((x) => typeof x === 'string')) found.push(where);
      walk(val, `${where}.${k}`);
    }
  };
  walk(b, '$');
  assert.deepEqual(found, [], '本文の行配列が残っている');
});

test('bundle: description の本文を持たず、長さだけを持つ', async () => {
  const b = await privacyBundle();
  const skill = b.structure.resources.find((r) => r.kind === 'skill');
  assert.ok(skill, 'skill が無い');
  assert.equal(skill!.has_description, true);
  assert.ok(skill!.description_bytes > 0, '長さが取れていない（比較に必要）');
  assert.ok(!('description' in skill!), 'description 本文が入っている');
  assert.ok(!JSON.stringify(skill).includes('ブランド規定'), 'description の中身が入っている');
});

test('bundle: 自己検査を通っていて、通らなければ passed=false になる', async () => {
  const b = await privacyBundle();
  assert.equal(b.redaction.self_check.passed, true, `自己検査に落ちている: ${JSON.stringify(b.redaction.self_check.leaks)}`);
  assert.equal(b.redaction.self_check.leaks_found, 0);
});

test('redact: 秘密の形を見つけたら値を捨てて種別だけ残す', () => {
  const R = new Redactor({ home: '/Users/x', level: 'strict' });
  // ここでも本物の形をソースに直書きしない（組み立てる）
  const ANT = ['sk', 'ant', 'api03', 'AAAABBBBCCCCDDDD'].join('-');
  const GH = `ghp${'_'}abcdefghijklmnopqrstuvwxyz012345`;
  const SLACK = `xoxb${'-'}1234567890-abcdefghij`;
  const AWS = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const cases: Array<[string, string]> = [
    [`ANTHROPIC_API_KEY=${ANT}`, 'anthropic_api_key'],
    [`token: ${GH}`, 'github_token'],
    [SLACK, 'slack_token'],
    [AWS, 'aws_access_key'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789', 'bearer_token'],
    [`https://user:${'hunter2'}@example.com/x`, 'url_credentials'],
  ];
  for (const [input, kind] of cases) {
    const out = R.text(input);
    assert.ok(out.includes(`<redacted:${kind}>`), `${kind} を捕まえていない: ${out}`);
    assert.ok(!out.includes(input.split(/[\s:=]/).pop()!.slice(0, 12)), `値が残っている: ${out}`);
  }
  assert.ok(R.summary().secrets_removed.length >= 5);
});

test('scanForLeaks: home と username と秘密の形を見つける', () => {
  const key = ['sk', 'ant', 'api03', 'AAAABBBBCCCCDDDD'].join('-');
  const leaks = scanForLeaks({ a: '/Users/tanaka/x', b: 'ok', c: { d: key } }, { home: '/Users/tanaka' });
  const kinds = leaks.map((l) => l.kind);
  assert.ok(kinds.includes('home_path'));
  assert.ok(kinds.includes('username'));
  assert.ok(kinds.some((k) => k.startsWith('secret:')));
  assert.deepEqual(scanForLeaks({ a: '$HOME/x', b: '<user>' }, { home: '/Users/tanaka' }), []);
});

test('redact: SECRET_PATTERNS は毎回 lastIndex を戻す（g フラグの取りこぼしを作らない）', () => {
  const s = ['sk', 'ant', 'api03', 'AAAABBBBCCCCDDDD'].join('-');
  for (let i = 0; i < 3; i++) {
    const leaks = scanForLeaks({ v: s }, { home: '/nowhere' });
    assert.ok(leaks.length > 0, `${i} 回目で検出できなくなった`);
  }
  for (const { re } of SECRET_PATTERNS) assert.equal(re.lastIndex, 0);
});

// ───────────────────── 参照整合性 ─────────────────────

test('bundle: 匿名化しても参照が壊れない（同じ実体は同じ id、id は必ず解決できる）', async () => {
  const b = await bundleOf('cross-runtime-drift');
  const refs = new Set(b.structure.resources.map((r) => r.ref));
  assert.equal(refs.size, b.structure.resources.length, 'ref が重複している');
  for (const g of b.structure.same_name_groups) {
    for (const r of g.refs) assert.ok(refs.has(r), `same_name_groups が解決できない ref を指している: ${r}`);
    assert.ok(g.refs.length > 1);
  }
  // 同名グループは「同じ名前」で束ねているので、名前も 1 つに寄っている
  for (const g of b.structure.same_name_groups) {
    const names = new Set(g.refs.map((ref) => b.structure.resources.find((r) => r.ref === ref)!.name));
    assert.equal(names.size, 1, `同じ名前のはずが別の id になっている: ${[...names].join(', ')}`);
  }
});

test('bundle: 同じ project は同じ <project-N>、別の project は別の id', async () => {
  const R = new Redactor({
    home: '/Users/t',
    project: '/Users/t/work/alpha',
    projectSlugs: ['-Users-t-work-alpha', '-Users-t-work-beta'],
    level: 'strict',
  });
  const a1 = R.text('/Users/t/work/alpha/CLAUDE.md');
  const a2 = R.text('$HOME/.claude/projects/-Users-t-work-alpha/memory/MEMORY.md');
  const bx = R.text('$HOME/.claude/projects/-Users-t-work-beta/memory/MEMORY.md');
  const id = /<project-\d+>/.exec(a1)![0];
  assert.ok(a2.includes(id), `project 根と slug が別の id になっている: ${a1} / ${a2}`);
  assert.ok(!bx.includes(id), `別の project が同じ id になっている: ${bx}`);
});

test('bundle: strict は資源名を匿名化し、standard は残す', async () => {
  const strict = await privacyBundle('strict');
  const standard = await privacyBundle('standard');
  const sName = strict.structure.resources.find((r) => r.kind === 'skill')!.name;
  const nName = standard.structure.resources.find((r) => r.kind === 'skill')!.name;
  assert.match(sName, /^<skill-\d+>$/, `strict で名前が残っている: ${sName}`);
  assert.equal(nName, 'client-alpha-brand');
  // standard でも secret と本文は出ない（名前を残すことと秘密を残すことは別）
  const raw = JSON.stringify(standard);
  for (const p of [...Object.values(PLANTED_SECRETS), 'クライアントアルファ']) {
    assert.ok(!raw.includes(p), `standard で "${p}" が漏れている`);
  }
});

// ───────────────────── 中身 ─────────────────────

test('bundle: 受け取った側が診断に使うものが揃っている', async () => {
  const b = await bundleOf('unreachable-reference');
  assert.equal(b.format, BUNDLE_FORMAT);
  assert.ok(b.snapshot_id && b.generated_at && b.tool_version);
  assert.ok(b.environment.runtimes.length >= 1);
  assert.ok(b.coverage.collected.length > 0 && b.coverage.not_collected.length > 0);
  assert.ok(b.llm_report.findings.length > 0, 'Finding が入っていない');
  assert.ok(b.llm_report.findings[0]!.evidence.length > 0, 'Evidence まで辿れない');
  assert.ok(b.clusters.length > 0, 'root cause cluster が入っていない');
  assert.ok(b.structure.resources.length > 0);
  assert.ok(b.observation_status.records.length > 0);
  assert.ok(b.handoff_contract.length >= 5);
  assert.ok(b.context_cost.by_load_mode);
  // Doctor が治療していないことを毎回書く
  assert.deepEqual(b.doctor_actions.files_written_to_examined_environment, []);
  assert.deepEqual(b.doctor_actions.network_calls, []);
});

test('bundle: 主訴を添えられる（任意）', async () => {
  const b = await bundleOf('unreachable-reference');
  assert.equal(b.reported_symptom, 'テスト用の主訴');
});

test('bundle: 観測できなかったものを 0 件として出さない', async () => {
  const b = await bundleOf('windows-projects');
  for (const r of b.observation_status.records) {
    if (r.status !== 'observed') assert.equal(r.count, null, `${r.what} が ${r.status} なのに数を持っている`);
  }
  assert.ok(b.observation_status.summary.observed > 0);
  assert.match(b.observation_status.note, /do not mean zero/);
  // 読めなかったものは別枠でも出す
  assert.ok(Array.isArray(b.observation_status.could_not_observe));
});

test('bundle: history が無い時に「変化なし」と言わない', async () => {
  const b = await bundleOf('unreachable-reference');
  assert.equal(b.history.snapshots_compared, 0);
  assert.ok(b.history.notes.some((n) => /not the same as nothing having changed/.test(n)));
});

test('bundle: Doctor が治療しない契約を持ち出す側にも渡す', async () => {
  const b = await bundleOf('unreachable-reference');
  const contract = b.handoff_contract.join(' ');
  assert.match(contract, /diagnosis, not a work order/);
  assert.match(contract, /never as zero and never as absent/);
  assert.match(contract, /Large is not a defect/);
  assert.match(contract, /The human decides/);
});

test('bundle: hook の command を実行文字列のまま持ち出さない', async () => {
  const b = await privacyBundle();
  const raw = JSON.stringify(b);
  assert.ok(!raw.includes('--api-key'), 'command の引数がそのまま入っている');
  assert.ok(!raw.includes('--to tanaka'), 'command の引数がそのまま入っている');
});

test('fixture: bundle-privacy は notes.md に「何を仕込んだか」を書いてある', async () => {
  const notes = await readFile(join(FIXTURES, 'bundle-privacy', 'notes.md'), 'utf8');
  for (const p of ['sk-ant', 'ghp_', 'username', '顧客名']) assert.ok(notes.includes(p), `notes.md に ${p} の記載が無い`);
});

// ───────────────────── #71: Windows slug 化 username の派生表現 ─────────────────────
//
// Windows 実機 Dogfood（2026-09-08）で発見。project の絞り込みが no_match になった時、
// `access` の `project_slug_match` reason に候補文字列（`projectSlugCandidates` の出力）がそのまま
// 埋め込まれ、そこに username の派生表現（`.` が `-` に変わる等）が生で残っていた。
// self-check は username の完全一致しか見ておらず、この派生表現を見逃していた。

test('bundle: Windows project slug が no_match の時、reason に残る username の派生表現も redact される（#71）', async () => {
  const root = await mktempPlanted71();
  // basename が username 相当。わざとドットを含める（Windows slug 化で `-` に変わる文字）
  const home = join(root, 'foo.bar');
  // 実際の slug ディレクトリは、これから絞り込む project とは絶対に一致しないものだけ用意する
  await mkdir(join(home, '.claude', 'projects', 'some-other-project'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });

  const saved = { CODEX_HOME: process.env['CODEX_HOME'], CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'], PATH: process.env['PATH'] };
  delete process.env['CODEX_HOME'];
  delete process.env['CLAUDE_CONFIG_DIR'];
  process.env['PATH'] = dirname(process.execPath);
  // Windows 形式の project パス。実在しなくてよい（matchProjectSlug は列挙結果と突合するだけ）
  const winProject = 'C:\\Users\\foo.bar\\work';
  let snapshot;
  try {
    const { snapshot: base } = await collect([claudeCodeAdapter, codexAdapter], { home, project: winProject });
    const obs = await observeActiveRuntime({
      home,
      claudeConfigHome: join(home, '.claude'),
      codexConfigHome: join(home, '.codex'),
      project: winProject,
      liveWindowMinutes: 30,
      maxSessions: 20,
      selfSessionId: null,
      allProjects: false,
    });
    const sessions = obs.sessions.map((x) => toSessionInfo(x, obs.self_session_id));
    const processes = obs.processes.map(toProcessInfo);
    snapshot = attachActiveRuntime(base, sessions, processes, [], obs.notes, obs.access);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // 再現条件そのものが成立していること（これが無いと何もテストしていないことになる）
  const slugMatch = snapshot.access?.find((a) => a.target === 'project_slug_match');
  assert.ok(slugMatch, '再現条件が成立していない: project_slug_match の access record が無い');
  assert.equal(slugMatch!.status, 'failed', '再現条件が成立していない: no_match になっていない');
  assert.match(slugMatch!.reason ?? '', /foo[.-]bar/i, '再現条件が成立していない: reason に username 由来の候補が無い（そもそも直した後の slug.ts では起きない状態）');

  const result = await runFindings(snapshot, { readText });
  const llm = await buildLlmReport(snapshot, result, { readText });
  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    readText,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
  const bundle = await buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level: 'strict', readText });

  const raw = JSON.stringify(bundle);
  const leakMatch = /.{0,30}foo[.\-_ ]bar.{0,30}/i.exec(raw);
  assert.equal(leakMatch, null, `username の派生表現が bundle に残っている: ${leakMatch?.[0]}`);
  assert.equal(bundle.redaction.self_check.passed, true, `self-check が漏れを見逃している: ${JSON.stringify(bundle.redaction.self_check.leaks)}`);
});

test('scanForLeaks: username の区切り文字/大文字小文字が変わった派生表現も検知する（#71）', () => {
  const leaks = scanForLeaks({ a: 'c--users-foo-bar-downloads-project', b: 'C--Users-Foo-Bar-work' }, { home: '/Users/foo.bar' });
  assert.ok(leaks.every((l) => l.kind === 'username_variant'), `想定外の kind が混ざっている: ${JSON.stringify(leaks)}`);
  assert.equal(leaks.length, 2, '両方の派生表現を検知できていない');
});

/** #71 専用の一時ディレクトリ作成。plantedHome() と同じく after で片付ける */
async function mktempPlanted71(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-71-'));
  planted.push(root);
  return root;
}

// ───────────────────── #73: summary / detail / not_evaluated から本文が漏れない ─────────────────────
//
// Astra（外部レビュアー）の v1.0 Release Readiness Review で発見。既存の denylist（`lines` というキー名を
// 全域で潰す / `detail.command` を shellShape() で潰す）では拾えない経路が 2 つあった。
// SCOPE_MISMATCH と HOOK_AMPLIFICATION(same_registration_multiple_events) の検出器が、
// 本文（rule の起動条件の行・hook の command 文字列）をテンプレートリテラルで **summary** に
// 直接埋め込んでいた。SESSION_STALENESS の name_collision も、skipped.reason（→ bundle の
// not_evaluated 経由）に description の抜粋を埋め込んでいた。
//
// UNREACHABLE_REFERENCE / CROSS_RUNTIME_DRIFT は本文を summary/detail に直接埋め込んでおらず
// （構造化フィールド + 既存の `lines` denylist で保護済み）、ここでは回帰していないことだけ確認する。

function baseSyntheticSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    snapshot_id: 'test-73',
    schema_version: 4,
    tool_version: 'test',
    runtimes: [],
    env: { os: 'test', project: null, home: '/home/canary73', launchers: [] },
    coverage: { phase: 'test', collected: [], not_collected: [] },
    resources: [],
    bindings: [],
    observations: [],
    sessions: [],
    processes: [],
    probe_notes: [],
    ...over,
  };
}

function baseResource(over: Partial<Resource> & Pick<Resource, 'resource_id' | 'kind' | 'name' | 'path'>): Resource {
  return {
    owner: 'user',
    content_hash: 'sha256:' + over.resource_id.slice(-8),
    normalized_hash: 'sha256:' + over.resource_id.slice(-8),
    mtime: '2026-01-01T00:00:00.000Z',
    size_bytes: 10,
    declared: { frontmatterKeys: [] },
    references: [],
    ...over,
  };
}

test('bundle: #73 SCOPE_MISMATCH は起動条件の行を summary にも detail にも残さない（bundle）。通常の report では detail に本文が残る', async () => {
  const exp = await loadExpectation('scope-mismatch');
  const snapshot = await collectFixture('scope-mismatch', exp);
  const result = await runFindings(snapshot, { readText });
  const llm = await buildLlmReport(snapshot, result, { readText });
  const scopeFinding = llm.findings.find((f) => f.finding_id === 'SCOPE_MISMATCH');
  assert.ok(scopeFinding, 'SCOPE_MISMATCH が発火していない（fixture が変わった？）');
  const canary = 'claude --channels telegram` (channels session only)';
  assert.ok(!scopeFinding!.summary.includes(canary), 'production の summary から本文は出さない契約（#73）');
  // 通常の report（bundle 化していない）は detail に本文を残してよい契約
  assert.ok(JSON.stringify(scopeFinding!.detail).includes(canary), '通常の report から起動条件の本文が消えている（保持してよい契約が壊れている）');

  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    readText,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
  // acceptance: standard / strict 両方で canary が 0
  for (const level of ['strict', 'standard'] as const) {
    const bundle = await buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level, readText });
    const raw = JSON.stringify(bundle);
    assert.ok(!raw.includes(canary), `bundle(${level}) に起動条件の本文が残っている: ${canary}`);
    assert.equal(bundle.redaction.self_check.passed, true, `bundle(${level}) の self-check に落ちている: ${JSON.stringify(bundle.redaction.self_check.leaks)}`);
  }
});

test('bundle: #73 HOOK_AMPLIFICATION(same_registration_multiple_events) は command 文字列を summary にも detail にも残さない（bundle）。通常の report の detail.command は宣言値のまま', async () => {
  const cmd = '/home/canary73/bin/notify.sh --token CANARY_HOOK_COMMAND_TOKEN_9f2a1c --to ops';
  const r1 = baseResource({ resource_id: 'sha256:hook1', kind: 'hook_script', name: 'SessionStart[0][0]', path: '/home/canary73/.claude/settings.json#hooks.SessionStart[0].hooks[0]', declared: { frontmatterKeys: [], raw: { command: cmd, event: 'SessionStart' } } });
  const r2 = baseResource({ resource_id: 'sha256:hook2', kind: 'hook_script', name: 'PreToolUse[0][0]', path: '/home/canary73/.claude/settings.json#hooks.PreToolUse[0].hooks[0]', declared: { frontmatterKeys: [], raw: { command: cmd, event: 'PreToolUse' } } });
  const snapshot = baseSyntheticSnapshot({ resources: [r1, r2] });

  const result = await runFindings(snapshot, {});
  const hook = result.findings.find((f) => f.finding_id === 'HOOK_AMPLIFICATION' && f.subtype === 'same_registration_multiple_events');
  assert.ok(hook, 'HOOK_AMPLIFICATION(same_registration_multiple_events) が発火していない（再現条件が崩れている）');
  assert.ok(!hook!.summary.includes(cmd), 'production の summary から command 本文は出さない契約（#73）');

  const llm = await buildLlmReport(snapshot, result, {});
  const llmHook = llm.findings.find((f) => f.finding_id === 'HOOK_AMPLIFICATION');
  assert.ok(llmHook, 'llm report に見つからない');
  // 通常の report は home を ~ に畳む既存の redact は通るが、command の本文（引数含む）は残ってよい契約
  assert.equal(llmHook!.detail['command'], cmd.replace(snapshot.env.home, '~'), '通常の report から command の本文が消えている（保持してよい契約が壊れている）');

  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
  // acceptance: standard / strict 両方で canary が 0
  for (const level of ['strict', 'standard'] as const) {
    const bundle = await buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level });
    const raw = JSON.stringify(bundle);
    assert.ok(!raw.includes(cmd), `bundle(${level}) に hook の command 本文が残っている: ${cmd}`);
    assert.ok(!raw.includes('CANARY_HOOK_COMMAND_TOKEN_9f2a1c'), `bundle(${level}) に command の canary token が残っている`);
    assert.equal(bundle.redaction.self_check.passed, true, `bundle(${level}) の self-check に落ちている: ${JSON.stringify(bundle.redaction.self_check.leaks)}`);
  }
});

test('bundle: #73 SESSION_STALENESS(name_collision) は description の抜粋を skipped.reason / not_evaluated に残さない', async () => {
  // #73 の旧実装は description を 60 文字で切り詰めてから skipped.reason に埋め込んでいた。
  // 60 文字を超える canary だと「切り詰められて偶然消えた」だけになり RED にならないので、60 文字未満に収める
  const sessionDescCanary = 'SESSION DESC CANARY jkQ7x must never leave the machine';
  const fileDescCanary = 'FILE DESC CANARY 4mP2z must never leave the machine';
  const skill = baseResource({
    resource_id: 'sha256:skillnc',
    kind: 'skill',
    name: 'canary-skill',
    path: '/home/canary73/.claude/skills/canary-skill.md',
    declared: { frontmatterKeys: ['name', 'description'], description: fileDescCanary },
  });
  const binding: Binding = {
    binding_id: 'bind-nc-1',
    resource_id: skill.resource_id,
    resource_path: skill.path,
    runtime: 'claude-code',
    runtime_version: null,
    mechanism: 'skill_description',
    source_ref: { type: 'discovery', search_path: '/home/canary73/.claude/skills' },
    discovered: false,
    rule_id: 'test.skill.name_collision_source',
    rule_source: 'test',
    confidence: 'high',
    load_mode: 'on_demand',
    scope_condition: null,
    applies_to: ['session'],
    search_path: '/home/canary73/.claude/skills',
    precedence: null,
  };
  const session: SessionInfo = {
    session_id: 'sess-nc-1',
    runtime: 'claude-code',
    record_path: '/home/canary73/.claude/projects/x/sess-nc-1.jsonl',
    started_at: '2026-01-01T00:00:00.000Z',
    last_activity_at: '2026-01-01T00:05:00.000Z',
    live: true,
    runtime_version: null,
    cwd: null,
    git_branch: null,
    entrypoint: 'cli',
    is_self: false,
    is_sidechain: false,
    observed_capability_kinds: ['skills'],
    capabilities: { skills: ['canary-skill'], agents: null, deferred_tools: null, mcp_instructions: null, failed_mcp_servers: null },
    capabilities_from_startup: true,
    non_initial_listings: 0,
    comparable_capabilities: true,
    comparable_timestamps: false,
    not_comparable_reason: null,
    instruction_digest: null,
  };
  const snapshot = baseSyntheticSnapshot({ resources: [skill], bindings: [binding], sessions: [session] });
  const capabilityDescriptions = new Map([['sess-nc-1', new Map([['canary-skill', sessionDescCanary]])]]);

  // 検出器そのものを直接叩いて、production の skipped.reason を確かめる
  const direct = await detectSessionStaleness({ snapshot, protectedGlobs: [], capabilityDescriptions });
  const collision = direct.skipped.find((x) => x.detector === 'SESSION_STALENESS / name_collision');
  assert.ok(collision, 'name_collision の skipped が発火していない（再現条件が崩れている）');
  assert.ok(!collision!.reason.includes(sessionDescCanary) && !collision!.reason.includes(fileDescCanary), 'skipped.reason に description の抜粋が残っている（#73）');

  const result = await runFindings(snapshot, { capabilityDescriptions });
  const llm = await buildLlmReport(snapshot, result, {});
  const notEvaluated = llm.not_evaluated.find((x) => x.detector === 'SESSION_STALENESS / name_collision');
  assert.ok(notEvaluated, 'not_evaluated に見つからない（再現条件が崩れている）');
  assert.ok(!notEvaluated!.reason.includes(sessionDescCanary) && !notEvaluated!.reason.includes(fileDescCanary), 'not_evaluated.reason に description の抜粋が残っている（#73）');

  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
  // acceptance: standard / strict 両方で canary が 0
  for (const level of ['strict', 'standard'] as const) {
    const bundle = await buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level });
    const raw = JSON.stringify(bundle);
    assert.ok(!raw.includes(sessionDescCanary), `bundle(${level}) に session 側 description が残っている: ${sessionDescCanary}`);
    assert.ok(!raw.includes(fileDescCanary), `bundle(${level}) に file 側 description が残っている: ${fileDescCanary}`);
    assert.equal(bundle.redaction.self_check.passed, true, `bundle(${level}) の self-check に落ちている: ${JSON.stringify(bundle.redaction.self_check.leaks)}`);
  }
});

test('bundle: #73 CROSS_RUNTIME_DRIFT の diff 本文も canary 検査で 0 件（既存 fixture の回帰確認、standard / strict 両方）', async () => {
  for (const level of ['strict', 'standard'] as const) {
    const b = await bundleOf('cross-runtime-drift', level);
    const raw = JSON.stringify(b);
    for (const canary of ['Write the handoff note.', 'Update the status file.', 'Report which of the above were done and which were skipped.']) {
      assert.ok(!raw.includes(canary), `bundle(${level}) に diff 本文が残っている: ${canary}`);
    }
  }
});

test('bundle: #73 UNREACHABLE_REFERENCE の description 本文も canary 検査で 0 件（既存 fixture の回帰確認、standard / strict 両方）', async () => {
  for (const level of ['strict', 'standard'] as const) {
    const b = await bundleOf('unreachable-reference', level);
    const raw = JSON.stringify(b);
    for (const canary of ['Fixture agent definition that references a skill from a plugin that is not installed.', 'review pass after editing']) {
      assert.ok(!raw.includes(canary), `bundle(${level}) に description / 本文が残っている: ${canary}`);
    }
  }
});

// ───────────────────── #73 追加調査（Codex adversarial review, 5番目の漏れ経路） ─────────────────────
//
// UNREACHABLE_REFERENCE(missing_target) は、agent/skill 本文に書かれた未解決の `ns:name` 参照を
// **生のまま** summary / detail.reference / evidence(raw) / human_decision_needed / cluster context の
// 5 箇所へ伝播していた。name 側（`corp:CANARY_SECRET_XXXX` のような、秘匿性のある識別子が入りうる部分）を
// bundle 投影でだけ落とす。namespace（分類に要る `corp` の部分）は残してよい。

test('bundle: #73 追加(Codex) UNREACHABLE_REFERENCE(missing_target) の未解決 skill_ref 生値は summary/detail/evidence/cluster から出ない。通常の report では残ってよい契約', async () => {
  const canaryRaw = 'corp:CANARY_SECRET_9f2a1c';
  const agent = baseResource({
    resource_id: 'sha256:agentcanary',
    kind: 'agent_def',
    name: 'andy',
    path: '/home/canary73/.claude/agents/andy.md',
    references: [{ raw: canaryRaw, line: 3, syntax: 'skill_ref', confidence: 'high' }],
  });
  const snapshot = baseSyntheticSnapshot({ resources: [agent] });

  const result = await runFindings(snapshot, {});
  const finding = result.findings.find((f) => f.finding_id === 'UNREACHABLE_REFERENCE' && f.subtype === 'missing_target');
  assert.ok(finding, '再現条件が崩れている: missing_target が発火していない');
  // 前提確認: production の Finding は raw を保つ（bundle 投影でだけ落とす契約）
  assert.ok(finding!.summary.includes(canaryRaw), '前提が崩れている: production summary に raw が無い');

  const llm = await buildLlmReport(snapshot, result, {});
  const llmFinding = llm.findings.find((f) => f.finding_id === 'UNREACHABLE_REFERENCE' && f.subtype === 'missing_target');
  assert.ok(llmFinding, 'llm report に見つからない');
  assert.equal(llmFinding!.detail['reference'], canaryRaw, '通常の report では detail.reference に raw が残ってよい契約が壊れている');
  assert.ok(llmFinding!.human_decision_needed.some((q) => q.includes(canaryRaw)), '通常の report では human_decision_needed に raw が残ってよい契約が壊れている');
  const refEvidence = llmFinding!.evidence.find((e) => e.type === 'reference');
  assert.ok(refEvidence && String(refEvidence.data['raw']) === canaryRaw, '通常の report では evidence.data.raw に raw が残ってよい契約が壊れている');

  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });

  for (const level of ['strict', 'standard'] as const) {
    const bundle = await buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level });
    const raw = JSON.stringify(bundle);
    assert.ok(!raw.includes(canaryRaw), `bundle(${level}) に未解決 skill_ref の生値が残っている（summary/detail/evidence/cluster のどれか）: ${canaryRaw}`);
    assert.ok(!raw.includes('CANARY_SECRET_9f2a1c'), `bundle(${level}) に識別子部分（name 側）が残っている`);
    // namespace 分類（`corp`）は分類意味論として残ってよい
    const bundleFinding = bundle.llm_report.findings.find((f) => f.finding_id === 'UNREACHABLE_REFERENCE' && f.subtype === 'missing_target');
    assert.ok(bundleFinding, 'bundle 側の finding が消えている（診断そのものを壊してはいけない）');
    assert.equal(bundleFinding!.detail['plugin_namespace'], 'corp', 'namespace の分類情報まで落としている（診断意味論を変えてはいけない）');
    assert.equal(bundle.redaction.self_check.passed, true, `bundle(${level}) の self-check に落ちている: ${JSON.stringify(bundle.redaction.self_check.leaks)}`);
  }
});

test('bundle: #73 追加(Codex) plugin cluster の context.references も未解決 skill_ref の生値を持ち出さない', async () => {
  // strong=true（agent_def からの参照）にして clusterKey() が `plugin:<ns>` で束ねる経路を通す
  const canaryRaw = 'corp:CANARY_CLUSTER_SECRET_7b3e';
  const agent = baseResource({
    resource_id: 'sha256:agentcanary2',
    kind: 'agent_def',
    name: 'becky',
    path: '/home/canary73/.claude/agents/becky.md',
    references: [{ raw: canaryRaw, line: 5, syntax: 'skill_ref', confidence: 'high' }],
  });
  const snapshot = baseSyntheticSnapshot({ resources: [agent] });
  const result = await runFindings(snapshot, {});
  const llm = await buildLlmReport(snapshot, result, {});
  const clusterId = llm.clusters.find((c) => c.id.startsWith('plugin:corp'))?.id;
  assert.ok(clusterId, '再現条件が崩れている: plugin:corp cluster ができていない');

  const ui = await buildUiData({
    snapshot,
    result,
    history: null,
    llmFindings: llm.findings,
    clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
  });
  const bundle = await buildBundle({ snapshot, result, llm, clusters: ui.overview.clusters, history: null, level: 'strict' });
  const raw = JSON.stringify(bundle);
  assert.ok(!raw.includes(canaryRaw), `bundle に cluster context 経由の生値が残っている: ${canaryRaw}`);
  assert.equal(bundle.redaction.self_check.passed, true, `self-check に落ちている: ${JSON.stringify(bundle.redaction.self_check.leaks)}`);
});

test('scanForResourceBodyLeaks: skill/agent_def 本文中の未解決参照トークンが漏れていたら検出する（field 名に依存しない、#73 追加調査）', async () => {
  const snapshot = baseSyntheticSnapshot({
    resources: [
      baseResource({ resource_id: 'sha256:agentB', kind: 'agent_def', name: 'agent-b', path: '/home/canary73/.claude/agents/b.md' }),
    ],
  });
  const readTextFake = async (p: string) => (p.endsWith('b.md') ? '- `corp:CANARY_TOKEN_LEAK_ABCDEFGH`: 未解決の参照' : null);

  const leaked = JSON.stringify({ somewhere: 'reference is corp:CANARY_TOKEN_LEAK_ABCDEFGH raw' });
  const leaks = await scanForResourceBodyLeaks(leaked, snapshot, readTextFake);
  assert.ok(leaks.some((l) => l.kind === 'canary:resource_reference_token'), 'skill/agent_def 本文の参照トークン漏れを検出できていない');

  const safe = JSON.stringify({ somewhere: 'corp:<redacted> only' });
  assert.deepEqual(await scanForResourceBodyLeaks(safe, snapshot, readTextFake), []);
});

// ── #73 自己検査そのものの検査: 意図的に仕込んだ漏れを検出できるか（field 名当てに頼らない最後の網） ──

test('scanForUnsafeBodyKeys: 意図的に仕込んだ漏れ（condition.text / command 未整形 / lines 未 null 化）を検出する（#73）', () => {
  const fakeBundle = {
    llm_report: {
      findings: [
        { detail: { condition: { line: 1, text: 'LEAKED_CONDITION_BODY_CANARY' } } },
        { detail: { command: '/usr/bin/leak --with args here' } },
        { detail: { diff_excerpt: { lines: ['+LEAKED_DIFF_LINE_CANARY'] } } },
      ],
    },
  } as unknown as DiagnosticBundle;
  const leaks = scanForUnsafeBodyKeys(fakeBundle);
  const kinds = leaks.map((l) => l.kind);
  assert.ok(kinds.includes('unsafe_key:condition.text'), 'condition.text の漏れを検出できていない');
  assert.ok(kinds.includes('unsafe_key:command'), '未整形 command の漏れを検出できていない');
  assert.ok(kinds.includes('unsafe_key:lines'), 'null 化していない lines を検出できていない');
});

test('scanForUnsafeBodyKeys: 安全な形（null / shellShape 済み）は何も拾わない（正常系で誤検知しない）', () => {
  const safeBundle = {
    llm_report: {
      findings: [
        { detail: { condition: { line: 1, text: null } } },
        { detail: { command: '/usr/bin/leak (+3 argument(s), not carried)' } },
        { detail: { diff_excerpt: { lines: null } } },
      ],
    },
  } as unknown as DiagnosticBundle;
  assert.deepEqual(scanForUnsafeBodyKeys(safeBundle), []);
});

test('scanForResourceBodyLeaks: rule 本文の行 / hook command 宣言値がそのまま出ていたら検出する（field 名に依存しない独立した canary 検査、#73）', async () => {
  const snapshot = baseSyntheticSnapshot({
    resources: [
      baseResource({ resource_id: 'sha256:ruleA', kind: 'rule', name: 'rule-a', path: '/home/canary73/.claude/rules/a.md' }),
      baseResource({
        resource_id: 'sha256:hookA',
        kind: 'hook_script',
        name: 'hook-a',
        path: '/home/canary73/.claude/settings.json#hooks.X[0]',
        declared: { frontmatterKeys: [], raw: { command: '/usr/bin/leak-hook --token AAAAAAAAAAAAAAAA' } },
      }),
    ],
  });
  const readTextFake = async (p: string) => (p.endsWith('a.md') ? 'This is a rule body line that must never appear in a bundle verbatim.' : null);

  const leaked = JSON.stringify({
    somewhere: 'This is a rule body line that must never appear in a bundle verbatim. And /usr/bin/leak-hook --token AAAAAAAAAAAAAAAA too.',
  });
  const leaks = await scanForResourceBodyLeaks(leaked, snapshot, readTextFake);
  const kinds = leaks.map((l) => l.kind);
  assert.ok(kinds.includes('canary:resource_body_line'), 'rule 本文の漏れを検出できていない');
  assert.ok(kinds.includes('canary:hook_command_body'), 'hook command の漏れを検出できていない');

  const safe = JSON.stringify({ somewhere: 'nothing to see here' });
  assert.deepEqual(await scanForResourceBodyLeaks(safe, snapshot, readTextFake), []);
});

// ───────────────────── #91 project 根の漏れ（第三者レビューで発見） ─────────────────────
//
// 症状: `--project` が HOME 配下にあると、redact strict でも bundle に実フォルダ名が残った。
//       しかも self check は passed のまま（自己検査の針が home / username / secret だけだった）。
// 原因: レポート側が先にパスを `~/...` へ畳むのに、project 置換が**絶対パスの形だけ**を見ていた。
//       素通りしたあと `~ → $HOME` だけが走り、`$HOME/<実名>/...` になって残る。
// ここでは「原因」「自己検査」「要約の正直さ」「E2E」の 4 点を別々に固定する。

test('#91 redact: home が ~ / $HOME に畳まれた表記でも project 名を置き換える', () => {
  const home = '/Users/someone';
  const R = new Redactor({ home, project: `${home}/SECRETCLIENT`, level: 'strict' });
  const forms = [
    `${home}/SECRETCLIENT/.claude/agents/andy.md`, // 絶対パス（従来から通っていた形）
    '~/SECRETCLIENT/.claude/agents/andy.md', // レポート側で畳まれた形 ← 修正前はここが素通り
    '$HOME/SECRETCLIENT/.claude/agents/andy.md', // すでに home が置換された形
    '~\\SECRETCLIENT\\.claude\\agents\\andy.md', // Windows 区切り（報告者の環境）
  ];
  for (const form of forms) {
    const out = R.text(form);
    assert.ok(!out.includes('SECRETCLIENT'), `project 名が残った: ${form} → ${out}`);
  }
});

test('#91 redact: 置換が一度も起きなければ projects_anonymised は 0（id を振った数を「消した数」として報告しない）', () => {
  const R = new Redactor({ home: '/Users/someone', project: '/Users/someone/SECRETCLIENT', level: 'strict' });
  R.text('この文字列には project 名が出てこない');
  const s = R.summary();
  assert.equal(s.projects_anonymised, 0, 'id を振っただけで「匿名化した」と数えている');
  assert.equal(s.project_ids_assigned, 1);
});

test('#91 scanForLeaks: 修正前の形（$HOME/<実名>/…）を自己検査が捕まえる', () => {
  const home = '/Users/someone';
  const projects = [`${home}/SECRETCLIENT`];
  const leaked = {
    llm_report: { findings: [{ summary: '$HOME/SECRETCLIENT/.claude/agents/<agent_def-1>.md:5 references `ghost:<redacted>`' }] },
  };
  const leaks = scanForLeaks(leaked, { home, projects });
  assert.ok(
    leaks.some((l) => l.kind === 'project_root'),
    'rules[] が約束している project 根を自己検査が見ていない（passed が誤解を招く）',
  );

  const clean = { llm_report: { findings: [{ summary: '<project-1>/.claude/agents/<agent_def-1>.md:5' }] } };
  assert.deepEqual(scanForLeaks(clean, { home, projects }), []);
});

test('#91 scanForLeaks: 構造の名前は project 針にしない（誤検知で自己検査の信用を落とさない）', () => {
  const home = '/Users/someone';
  // project が `docs` という名前でも、無関係な docs/ を漏れとして叫ばない
  assert.deepEqual(scanForLeaks({ x: '$HOME/.claude/plugins/p/docs/readme.md' }, { home, projects: [`${home}/docs`] }), []);
});

test('#91 bundle E2E: HOME 配下の project のフォルダ名が bundle に 1 つも残らない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-p91-'));
  planted.push(root);
  const home = join(root, 'home');
  const project = join(home, 'SECRETCLIENT');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(project, '.claude', 'agents'), { recursive: true });
  await writeFile(join(home, '.claude', 'CLAUDE.md'), '# x\n', 'utf8');
  // 未解決参照を 1 本作って、findings の summary にパスを載せる（漏れが出る経路そのもの）
  await writeFile(join(project, '.claude', 'agents', 'andy.md'), '---\nname: a\ndescription: d\n---\nuses `ghost:skill`\n', 'utf8');

  const snapshot = await collectPlanted(home, project);
  const result = await runFindings(snapshot, { readText });
  const llm = await buildLlmReport(snapshot, result, { readText });
  const b = await buildBundle({ snapshot, result, llm, clusters: [], history: null, level: 'strict', readText, symptom: null });

  const raw = JSON.stringify(b);
  assert.ok(!raw.includes('SECRETCLIENT'), 'bundle に project のフォルダ名が残っている');
  assert.equal(b.redaction.self_check.passed, true, `self check が落ちた: ${JSON.stringify(b.redaction.self_check.leaks)}`);
});

// #91 の 2 経路目。実環境での検証中に見つけた——同じ「置換の鍵になっていない形」の別の入口。
// project が `~/.claude/projects` に memory ディレクトリを持たないと、slug 符号化候補が
// 置換鍵に登録されず、「絞り込めなかった（tried: -Users-<user>-<実名>）」に実名が残っていた。

test('#91 redact: memory ディレクトリを持たない project でも、slug に符号化された名前を置き換える', () => {
  const home = '/Users/someone';
  const R = new Redactor({ home, project: `${home}/SECRETCLIENT`, projectSlugs: ['-Users-someone-otherproject'], level: 'strict' });
  const msg = 'Project memory could not be narrowed down: the current project could not be matched (tried: -Users-someone-SECRETCLIENT).';
  const out = R.text(msg);
  assert.ok(!out.includes('SECRETCLIENT'), `slug 符号化された project 名が残った: ${out}`);
});

test('#91 scanForLeaks: slug に符号化された形も自己検査が捕まえる（パス区切りに面していない）', () => {
  const home = '/Users/someone';
  const leaked = { context_cost: { not_measured: ['Project memory could not be narrowed down (tried: -Users-<user>-SECRETCLIENT).'] } };
  const leaks = scanForLeaks(leaked, { home, projects: [`${home}/SECRETCLIENT`] });
  assert.ok(
    leaks.some((l) => l.kind === 'project_root'),
    'パス区切りに面していない形を見逃している（adjacent だけの判定では拾えない）',
  );
});

test('#91 scanForLeaks: Doctor 自身が散文で使う語と同じ project 名は針にしない（置換はされる）', () => {
  const home = '/Users/someone';
  const prose = { x: 'the agent definition lists skills that the runtime discovers' };
  assert.deepEqual(scanForLeaks(prose, { home, projects: [`${home}/agent`] }), []);
});
