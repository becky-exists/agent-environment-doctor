/**
 * READ ONLY 保証の回帰テスト — Doctor が患者を触ったら FAIL
 *
 * 方法:
 *   1. fixture を一時ディレクトリへ複製し、患者（home）を chmod a-w にする
 *   2. 実行前に患者の指紋（sha256 / size / mtime / mode / ディレクトリのエントリ一覧）を取る
 *   3. CLI を子プロセスで一通り叩く（collect / gate-a / snapshot / diff / explain）
 *      snapshot の出力先は患者の外。cwd も患者の外
 *   4. 実行後に指紋を取り直し、患者側が 1 バイトも変わっていないこと、
 *      一時ルート全体で「増えたもの」が snapshot 出力先だけであることを確認する
 *
 * さらに、この検査機自体が壊れていないことを確かめる自己試験を 1 本入れる
 * （わざと患者を触り、diff が検知することを見る）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, chmod, readdir, lstat, appendFile, utimes, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { FIXTURES, FIXTURE_NAMES, diffFingerprints, fingerprint, loadExpectation, toPosixKey } from './helpers.js';

// exports に無いので直接パスで指す（tsx 4.x の CLI 実体）
const TSX = join(FIXTURES, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(FIXTURES, '..', 'src', 'cli.ts');

const roots: string[] = [];
after(async () => {
  for (const r of roots) {
    await setWritable(r, true).catch(() => {});
    await rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

async function setWritable(root: string, writable: boolean): Promise<void> {
  async function walk(p: string): Promise<void> {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      // 先に中を処理してから自分（読めるうちに）
      if (writable) await chmod(p, 0o755);
      for (const n of await readdir(p)) await walk(join(p, n));
      if (!writable) await chmod(p, 0o555);
    } else {
      await chmod(p, writable ? 0o644 : 0o444);
    }
  }
  await walk(root);
}

interface Ward {
  root: string;
  patient: string; // <root>/patient  (home = <root>/patient/home)
  home: string;
  out: string; // snapshot 出力先
  cwd: string; // CLI の cwd（既定の ./snapshots/ がここに落ちる）
}

async function admit(fixture: string): Promise<Ward> {
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-ro-'));
  roots.push(root);
  const patient = join(root, 'patient');
  const home = join(patient, 'home');
  await mkdir(patient, { recursive: true });
  await cp(join(FIXTURES, fixture, 'env', 'home'), home, { recursive: true, verbatimSymlinks: true });
  const out = join(root, 'out');
  const cwd = join(root, 'cwd');
  await mkdir(out);
  await mkdir(cwd);
  return { root, patient, home, out, cwd };
}

function runCli(w: Ward, args: string[], launchers: string[] = []) {
  const env: Record<string, string> = {
    // 実環境の変数を持ち込まない。PATH は node だけ（claude / codex の --version を呼ばせない）
    PATH: dirname(process.execPath),
    HOME: process.env['HOME'] ?? '',
    TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
    NODE_OPTIONS: '',
  };
  const extra = launchers.length ? ['--launcher', launchers.join(',')] : [];
  const r = spawnSync(process.execPath, [TSX, CLI, ...args, '--home', w.home, '--project', ...extra], {
    cwd: w.cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return r;
}

for (const name of FIXTURE_NAMES) {
  test(`read-only: ${name} — scan の前後で患者の hash / mtime が変わらない`, async () => {
    const w = await admit(name);
    const exp = await loadExpectation(name);
    // 起動スクリプトも患者の一部として渡す（読むだけ。触ったら FAIL）
    const launchers = (exp.launchers ?? []).map((l) => join(w.patient, l.replace(/^env\//, '')));
    await setWritable(w.patient, false);
    const before = await fingerprint(w.root);

    const snap1 = join(w.out, 's1.json');
    const runs: Array<[string, string[]]> = [
      ['collect', ['collect']],
      ['collect --json', ['collect', '--json']],
      ['gate-a', ['gate-a']],
      ['snapshot --out', ['snapshot', '--out', snap1]],
      ['snapshot (default path)', ['snapshot']],
      ['diff', ['diff', snap1]],
      ['explain', ['explain', '.claude']],
      // --probe はセッション記録と ps を読む。患者を 1 バイトも触らないことをここでも保証する
      ['scan --probe', ['scan', '--probe', '--live-window', '5256000']],
      ['report --llm --probe', ['report', '--llm', '--probe', '--live-window', '5256000']],
      // UI のデータ構築（人間向け要約層を含む）も患者を触らない
      ['ui --print --probe', ['ui', '--print', '--probe', '--live-window', '5256000']],
      // bundle は患者の外にだけ書く。患者を触ったら FAIL
      ['bundle --out', ['bundle', '--out', join(w.out, 'bundle.json'), '--symptom', 'read-only test']],
    ];
    for (const [label, args] of runs) {
      const r = runCli(w, args, launchers);
      // gate-a は fixture では一部チェック（同名 drift 等）が成立せず非ゼロになりうる。ここで見るのは副作用だけ
      assert.ok(r.error === undefined, `${label}: 起動失敗 ${String(r.error)}`);
      assert.ok(!/EACCES|EPERM|EROFS/.test(r.stderr), `${label}: 書き込みを試みた形跡\n${r.stderr}`);
    }

    const after_ = await fingerprint(w.root);
    const diff = diffFingerprints(before, after_);

    // 許される変化 = out/ と cwd/ 配下だけ（snapshot の出力先）
    // fingerprint() のキーは toPosixKey で `/` 統一済み。ここで作る比較用文字列も合わせる（#72）
    const patientRel = toPosixKey(relative(w.root, w.patient));
    const touchedPatient = diff.filter((d) => d.includes(`: ${patientRel}/`) || d.endsWith(`: ${patientRel}`));
    assert.deepEqual(touchedPatient, [], `Doctor が患者を触った:\n${touchedPatient.join('\n')}`);

    const outside = diff.filter((d) => !/^(added|changed): (out|cwd)(\/|\n|$)/.test(d));
    assert.deepEqual(outside, [], `snapshot 出力先以外への書き込み:\n${outside.join('\n')}`);

    // 検査が本当に走った証拠: 明示出力先と既定出力先の両方に snapshot がある
    assert.ok(diff.some((d) => d === 'added: out/s1.json'), '--out の snapshot が無い');
    assert.ok(diff.some((d) => /^added: cwd\/snapshots\/.+\.json$/.test(d)), '既定パス ./snapshots/ の snapshot が無い（cwd の外に落ちた可能性）');
    const s1 = JSON.parse(await readFile(snap1, 'utf8')) as { resources: unknown[] };
    assert.ok(s1.resources.length > 0, 'snapshot が空');
  });
}

test('read-only 自己試験: 患者を触ると検知される（検査機が壊れていない）', async () => {
  const w = await admit('scope-mismatch');
  const before = await fingerprint(w.root);

  const rule = join(w.home, '.claude', 'rules', 'channels-only.md');
  const other = join(w.home, '.claude', 'rules', 'family-scope.md');
  // 1. 1 バイト追記
  await appendFile(rule, '\n');
  // 2. mtime だけ動かす（内容そのまま）
  const later = new Date(Date.now() + 60_000);
  await utimes(other, later, later);
  // 3. ファイル追加
  await writeFile(join(w.home, '.claude', 'rules', 'injected.md'), 'x');

  const after_ = await fingerprint(w.root);
  const diff = diffFingerprints(before, after_);
  assert.ok(diff.some((d) => d.startsWith('changed: patient/home/.claude/rules/channels-only.md')), '追記を検知できない');
  assert.ok(diff.some((d) => d.startsWith('changed: patient/home/.claude/rules/family-scope.md')), 'mtime の変化を検知できない');
  assert.ok(diff.some((d) => d === 'added: patient/home/.claude/rules/injected.md'), '追加を検知できない');
  assert.ok(diff.some((d) => d.startsWith('changed: patient/home/.claude/rules\n')), 'ディレクトリのエントリ変化を検知できない');
});
