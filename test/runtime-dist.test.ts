/**
 * compiled dist の runtime asset regression（#76）
 *
 * 発見の経緯: `tsc` は .ts → .js のコンパイルしかしない。src/findings/scope-mismatch-vocab.json
 * のような非TSアセットは dist/ へ自動では出てこない。`npm run build` → `dist/` だけを別ディレクトリへ
 * コピー → `node dist/cli.js scan` を実行すると、SCOPE_MISMATCH 検出時に vocab JSON の ENOENT で
 * scan 全体が丸ごとクラッシュする（1 finding だけ落ちるのではなく exit code 1 で終わる）。
 *
 * `npm pack --dry-run` には（git 追跡ファイルである）src 側の同名 JSON が含まれるため、
 * 「pack には入っているのに、コンパイル後の実行では読めない」という一見矛盾した壊れ方をする。
 *
 * ここでは「dist だけを別ディレクトリへコピーした状態」を都度作って、
 * 二度とこの経路が壊れないことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT, FIXTURES } from './helpers.js';

test(
  'runtime dist: build 済み dist だけを別ディレクトリへコピーしても scan がクラッシュしない（vocab JSON 同梱の regression, #76）',
  { timeout: 120_000 },
  async () => {
    // 毎回フルビルドし直す（stale な dist に頼らない）。
    // `npm run build`（package.json: "tsc && tsx scripts/copy-assets.ts"）と等価な処理を、
    // npm 自体の解決を経由せず tsc/tsx の実体（拡張子なし JS ファイル）を node で直接呼んで再現する。
    // Windows では npm の実体が npm.cmd（バッチファイル）で、shell 経由なしの execFileSync/spawnSync では
    // 直接execできず ENOENT（#81）、npm.cmd を明示しても引数の渡り方の違いで EINVAL になる
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'scripts', 'copy-assets.ts')], {
      cwd: ROOT,
      stdio: 'pipe',
    });

    const distSrc = join(ROOT, 'dist');
    const vocabInDist = join(distSrc, 'findings', 'scope-mismatch-vocab.json');
    await assert.doesNotReject(
      access(vocabInDist),
      `dist/findings/scope-mismatch-vocab.json が build 後に無い（build asset copy が壊れている）`,
    );

    const tmpRoot = await mkdtemp(join(tmpdir(), 'agent-doctor-dist-only-'));
    try {
      // dist だけをコピーする。src/ .git/ test/ は一切持ち込まない
      await cp(distSrc, join(tmpRoot, 'dist'), { recursive: true });
      // package.json は実際の配布 ZIP（scripts/build-runtime-zip.ts の ALLOWLIST）でも
      // dist/ と必ず同梱される（TOOL_VERSION が package.json の "version" を読むため、#77 M5）。
      // ここで持ち込まないと「実際には起きない dist-only, no-package.json」という
      // より厳しすぎる前提になってしまう
      await cp(join(ROOT, 'package.json'), join(tmpRoot, 'package.json'));
      // 依存解決のため node_modules だけは同じリポジトリのものを symlink（ネットワーク不要）
      await symlink(join(ROOT, 'node_modules'), join(tmpRoot, 'node_modules'), 'dir');

      const home = join(FIXTURES, 'scope-mismatch', 'env', 'home');
      let stdout: string;
      try {
        stdout = execFileSync(process.execPath, [join(tmpRoot, 'dist', 'cli.js'), 'scan', '--home', home], {
          encoding: 'utf8',
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        assert.fail(
          `dist-only 実行で scan がクラッシュした（vocab JSON の ENOENT 疑い）:\n--- stdout ---\n${e.stdout ?? ''}\n--- stderr ---\n${e.stderr ?? e.message}`,
        );
        return;
      }

      assert.match(stdout, /SCOPE_MISMATCH/, `dist-only 実行で SCOPE_MISMATCH finding が出なかった:\n${stdout}`);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  },
);
