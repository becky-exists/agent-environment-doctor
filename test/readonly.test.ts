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
 *
 * #86 (Case C) 対応（2026-09-09）: 旧実装は `PATH: dirname(process.execPath)` で
 * codex/claude を丸ごと ENOENT 化しており、adapter の exec 経路（`execFileAsync('codex', ...)`）
 * を一度も通していなかった。これでは「exec しても副作用が無い」ことは検証できず、「exec しない
 * fallback 分岐だけが green」という盲点があった（v1.0.0 の Case C 欠陥はこの盲点を通り抜けていた）。
 * ここでは fixture 内にダミーの codex/claude 実行可能ファイルを置いて exec 経路を実際に通し、
 * かつ ambient HOME/CODEX_HOME を実行者の本物ではなく fixture の隔離領域へリダイレクトすることで、
 * 「実バイナリが起動されたら診断対象環境に副作用が出る」状況を再現できるようにしている。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, chmod, readdir, lstat, appendFile, utimes, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, delimiter } from 'node:path';

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
  bin: string; // ダミー codex / claude 実行可能ファイルの置き場（PATH の唯一の実体）
  execLog: string; // ダミーが起動されたら追記する（起動有無の証拠。out/ 配下 = 許容領域）
}

/**
 * fixture 内にダミーの `<name>`（POSIX）と `<name>.cmd`（Windows）を置く。
 * どちらも: (1) execLog に起動された事実を残す (2) touchPatientDir が渡されていれば
 * そこに `.lock` を作る（#86 実測の codex 実バイナリの副作用 $CODEX_HOME/tmp/arg0/(random)/.lock を模す）。
 * 本物の codex/claude バイナリを呼ばずに「exec されたら何が起きるか」だけを再現する非破壊スタブ。
 */
async function writeFakeBinary(binDir: string, name: string, opts: { execLog: string; touchPatientDir?: string }): Promise<void> {
  const touch = opts.touchPatientDir;
  const posix = ['#!/bin/sh', `echo "${name}" >> "${opts.execLog}"`, ...(touch ? [`mkdir -p "${touch}"`, `: > "${touch}/.lock"`] : []), 'echo "9.9.9"', ''].join('\n');
  const posixPath = join(binDir, name);
  await writeFile(posixPath, posix);
  await chmod(posixPath, 0o755);

  // Windows: `.cmd` は CreateProcess が直接解釈できる（シバン不要）。node の execFile はバイナリ名に
  // 拡張子を含めなくても Windows 上で PATHEXT を通じて解決する
  const cmd = ['@echo off', `echo ${name}>>"${opts.execLog}"`, ...(touch ? [`mkdir "${touch}" >NUL 2>NUL`, `type NUL>"${touch}\\.lock"`] : []), 'echo 9.9.9', ''].join('\r\n');
  await writeFile(join(binDir, `${name}.cmd`), cmd);
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
  const bin = join(root, 'bin');
  await mkdir(out);
  await mkdir(cwd);
  await mkdir(bin);
  const execLog = join(out, 'exec-calls.log');
  // codex: 修正前は detect() が無条件で exec し、$CODEX_HOME/tmp/arg0/* に書き込んでいた（#86 Case C）。
  // 修正後は exec 自体が無いので、このダミーは一度も起動されないはず
  await writeFakeBinary(bin, 'codex', { execLog, touchPatientDir: join(home, '.codex', 'tmp', 'arg0', 'exec-marker') });
  // claude: 実バイナリは実測で fs 副作用ゼロ（#86 の対象外、コード変更なし）。ここでは
  // 「PATH 制限でテストが exec 経路を素通りしていないか」だけを execLog で確認する
  await writeFakeBinary(bin, 'claude', { execLog });
  return { root, patient, home, out, cwd, bin, execLog };
}

function runCli(w: Ward, args: string[], launchers: string[] = []) {
  const codexHome = join(w.home, '.codex');
  const env: Record<string, string> = {
    // 実環境の変数を持ち込まない。
    // PATH は fixture 内のダミー codex/claude（w.bin）+ node だけ — 実バイナリではなくダミーへ解決させることで
    // 「exec 経路は本当に通っているか」を検証可能にする（旧実装は PATH を node だけに絞り、ENOENT で
    // exec 自体を素通りさせていた = #86 Case C を検知できなかった根本原因の一つ、A-5）。
    // HOME / CODEX_HOME も実行者の本物ではなく fixture の隔離領域へ向ける — exec された実バイナリの
    // 書き込み先は Doctor の --config-home 上書きとは別に ambient env で決まるため（#86 A-3 クレア発見）、
    // ここを本物のままにすると実バイナリが実 HOME を汚染しても本テストは気づけない
    PATH: `${w.bin}${delimiter}${dirname(process.execPath)}`,
    HOME: w.home,
    CODEX_HOME: codexHome,
    TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
    NODE_OPTIONS: '',
    ...(process.platform === 'win32'
      ? {
          // cmd.exe 経由での .cmd 起動・DLL 検索に要る最小限。Windows 未実機検証（#86 Fix Handoff 参照）
          PATHEXT: process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD',
          SystemRoot: process.env['SystemRoot'] ?? '',
          ComSpec: process.env['ComSpec'] ?? '',
        }
      : {}),
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

    // #86 Case C 回帰ガード: exec 経路が本当に通っていること（claude ダミーは起動される。
    // PATH 制限だけでテストが exec を素通りしていないかの証拠）、かつ codex は一度も
    // exec されていないこと（Step 1 の修正前はここで codex が記録され FAIL する）
    //
    // Windows実機で判明（CI run 34312825347）: execFileAsync('claude', [...]) は拡張子無しの
    // bare name を渡しており、Node の child_process は shell を介さない限り .cmd ファイルへの
    // PATHEXT 解決を行わない（このプロジェクト既知の制約 #81 と同根: execFileSync('npm', ...) が
    // ENOENT/EINVAL になった件と同じ Windows child_process の落とし穴）。このためダミーの
    // claude.cmd/codex.cmd は Windows 上で一度も起動されず exec-log が空のままになり、
    // execCalls ベースのこの sanity check は Windows では何も証明できない。
    // 本題の患者不変性チェック（このテスト冒頭の fingerprint diff、Windows でも実測 PASS 済み）は
    // execの成否と無関係にOS非依存で機能するため、このexec-logベースのメタ検証はPOSIX限定にする。
    if (process.platform !== 'win32') {
      const execCalls = (await readFile(w.execLog, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.ok(
        execCalls.includes('claude'),
        `claude ダミーが一度も exec されていない（PATH 制限で exec 経路が空振りしている疑い）: [${execCalls.join(',')}]`,
      );
      assert.ok(!execCalls.includes('codex'), `codex ダミーが exec された（#86 Case C 回帰）: [${execCalls.join(',')}]`);
    }
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
