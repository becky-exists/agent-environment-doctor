/**
 * Issue #75 regression — snapshot/bundle の --out が既存ファイルを上書きできない
 *
 * RED（修正前）: `--out` に既存ファイル（診断対象の設定ファイル相当）を指定すると、
 * exit 0 のままそのファイルが snapshot/bundle JSON に置換されていた
 * （`src/cli.ts` の `saveJson()` と `src/snapshot.ts` の `saveSnapshot()` が既定の
 * writeFile = 上書きモードだったため）。
 *
 * ここでは意図的に「患者を chmod a-w にしない」——OS のパーミッションではなく、
 * アプリケーション側の排他書き込み（`src/safe-write.ts`）が上書きを止めていることを確認するため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FIXTURES } from './helpers.js';

const TSX = join(FIXTURES, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(FIXTURES, '..', 'src', 'cli.ts');

const roots: string[] = [];
test.after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true }).catch(() => {});
});

async function setup(): Promise<{ root: string; home: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-outsafety-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  await cp(join(FIXTURES, 'unreachable-reference', 'env', 'home'), home, { recursive: true, verbatimSymlinks: true });
  await mkdir(cwd, { recursive: true });
  return { root, home, cwd };
}

function runCli(cwd: string, home: string, args: string[]) {
  const env: Record<string, string> = {
    PATH: dirname(process.execPath),
    HOME: process.env['HOME'] ?? '',
    TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
    NODE_OPTIONS: '',
  };
  return spawnSync(process.execPath, [TSX, CLI, ...args, '--home', home, '--project'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

async function fileSignature(p: string): Promise<{ content: string; mtimeMs: number }> {
  const [content, st] = await Promise.all([readFile(p, 'utf8'), stat(p)]);
  return { content, mtimeMs: st.mtimeMs };
}

for (const cmd of ['snapshot', 'bundle'] as const) {
  test(`${cmd} --out: 患者の既存ファイル（settings.json）へ直接書こうとすると非0で拒否され、中身/mtimeが変わらない`, async () => {
    const { home, cwd } = await setup();
    const target = join(home, '.claude', 'settings.json');
    const before = await fileSignature(target);

    const r = runCli(cwd, home, [cmd, '--out', target]);

    assert.notEqual(r.status, 0, `exit code が 0 のまま（上書きを拒否できていない）:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /Will not overwrite an existing file/, `分かりやすいエラーメッセージが無い:\n${r.stderr}`);

    const after = await fileSignature(target);
    assert.deepEqual(after, before, '患者の settings.json の中身/mtime が変わった');
  });

  test(`${cmd} --out: 既存の出力ファイル（前回の snapshot/bundle 自身）への再書き込みも拒否される`, async () => {
    const { home, cwd, root } = await setup();
    const out = join(root, 'out', `${cmd}.json`);
    await mkdir(dirname(out), { recursive: true });

    const first = runCli(cwd, home, [cmd, '--out', out]);
    assert.equal(first.status, 0, `1 回目の書き込みが失敗した:\n${first.stderr}`);
    const afterFirst = await fileSignature(out);

    const second = runCli(cwd, home, [cmd, '--out', out]);
    assert.notEqual(second.status, 0, `2 回目（既存の出力ファイルへの上書き）が非0で拒否されていない:\n${second.stdout}\n${second.stderr}`);
    assert.match(second.stderr, /Will not overwrite an existing file/, `分かりやすいエラーメッセージが無い:\n${second.stderr}`);

    const afterSecond = await fileSignature(out);
    assert.deepEqual(afterSecond, afterFirst, '2 回目の失敗した実行で 1 回目の出力ファイルが変わった');
  });

  test(`${cmd} --out: settings.json を指す symlink 経由の衝突も拒否される`, async () => {
    const { home, cwd, root } = await setup();
    const real = join(home, '.claude', 'settings.json');
    const link = join(root, 'link-to-settings.json');
    await symlink(real, link);
    const before = await fileSignature(real);

    const r = runCli(cwd, home, [cmd, '--out', link]);

    assert.notEqual(r.status, 0, `symlink 経由の衝突が拒否されていない:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /Will not overwrite an existing file/, `分かりやすいエラーメッセージが無い:\n${r.stderr}`);

    const after = await fileSignature(real);
    assert.deepEqual(after, before, 'symlink 経由で target（settings.json）が変わった');
  });

  test(`${cmd} --out: dangling symlink（存在しない実体を指す）でも拒否される（症状は違っても既存パスとして扱う）`, async () => {
    const { home, cwd, root } = await setup();
    const link = join(root, 'dangling-link.json');
    await symlink(join(root, 'nonexistent-target.json'), link);

    const r = runCli(cwd, home, [cmd, '--out', link]);

    assert.notEqual(r.status, 0, `dangling symlink が拒否されていない:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /Will not overwrite an existing file/, `分かりやすいエラーメッセージが無い:\n${r.stderr}`);
  });

  test(`${cmd} --out: 新規パスへの出力は今まで通り成功する`, async () => {
    const { home, cwd, root } = await setup();
    const out = join(root, 'fresh', 'nested', `${cmd}.json`);

    const r = runCli(cwd, home, [cmd, '--out', out]);

    assert.equal(r.status, 0, `新規パスへの出力が失敗した:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
    assert.ok(parsed && typeof parsed === 'object', '出力が JSON として読めない');
  });
}

test('safe-write: 同時に同じ新規パスへ書こうとした時、片方だけが成功し既存内容がもう一方に黙って上書きされない', async () => {
  const { writeExclusive, OutputAlreadyExistsError } = await import('../src/safe-write.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-race-'));
  roots.push(root);
  const target = join(root, 'race.json');

  const results = await Promise.allSettled([writeExclusive(target, 'A'), writeExclusive(target, 'B')]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, `ちょうど 1 つだけ成功するはずが ${fulfilled.length} 個成功した`);
  assert.equal(rejected.length, 1, `ちょうど 1 つだけ失敗するはずが ${rejected.length} 個失敗した`);
  assert.ok(
    (rejected[0] as PromiseRejectedResult).reason instanceof OutputAlreadyExistsError,
    '負けた側の理由が OutputAlreadyExistsError ではない',
  );

  const content = await readFile(target, 'utf8');
  assert.ok(content === 'A' || content === 'B', '中身が壊れている（部分書き込みが混ざった）');
});

test('safe-write: 事前に何も無ければ新規作成に成功する（親ディレクトリの再帰作成も維持）', async () => {
  const { writeExclusive } = await import('../src/safe-write.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-fresh-write-'));
  roots.push(root);
  const target = join(root, 'a', 'b', 'c', 'new.json');

  await writeExclusive(target, '{"ok":true}');

  const content = await readFile(target, 'utf8');
  assert.equal(content, '{"ok":true}');
});

test('safe-write: 既存の通常ファイルは拒否され、中身が変わらない', async () => {
  const { writeExclusive, OutputAlreadyExistsError } = await import('../src/safe-write.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-existing-'));
  roots.push(root);
  const target = join(root, 'existing.json');
  await writeFile(target, 'original', 'utf8');

  await assert.rejects(() => writeExclusive(target, 'overwritten'), OutputAlreadyExistsError);

  const content = await readFile(target, 'utf8');
  assert.equal(content, 'original', '既存ファイルが上書きされた');
});
