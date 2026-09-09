/**
 * npm registry 配布物の regression（#87）
 *
 * `npm pack --dry-run --json` が実際に tarball へ詰めるファイル一覧を検査する。
 * `package.json#files` の allowlist（dist/**, README.md, LICENSE）が正しく効いていて、
 * src/ test/ docs/ fixtures/ .github/ tsconfig.json 等の開発用ファイルが
 * 混入していないこと、逆に dist/cli.js のような必須ファイルが欠落していないことの両方を確認する
 * （クレア設計: Zero-Match-Is-Failure と、意図しない全部混入の両方を防ぐ）。
 *
 * 前提: このテストの前に `npm run build`（dist/ 生成）が済んでいること。
 * ROOT で実行するため npm workspace 等の影響は受けない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ROOT } from './helpers.js';

const execFileAsync = promisify(execFile);

test('npm pack: tarball に docs/src/test/fixtures/tsconfig が含まれない', async () => {
  // Windows実機で判明（#87 RC round 1）: bare name 'npm' は Windows 上では npm.cmd に解決される
  // .cmd ファイルであり、shell を介さない execFile/execFileAsync は spawn npm ENOENT で落ちる
  // （このプロジェクト既知の制約 #81, #86 と同根の Windows child_process の落とし穴）。
  // shell: true でOS標準シェル経由にすることで、PATHEXT解決を含め正しく npm を起動できる
  const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, shell: true });
  const [{ files, size, unpackedSize }] = JSON.parse(stdout) as Array<{
    files: Array<{ path: string }>;
    size: number;
    unpackedSize: number;
  }>;
  const paths = files.map((f) => f.path);

  // 上限・下限の両方をアサート（クレア設計: Zero-Match-Is-Failure + 意図しない全部混入の両方を防ぐ）
  // 実測基準: 127ファイル、265KB前後（2026-09-09 Round 2実測、macOS/Windows一致）
  assert.ok(paths.length >= 100 && paths.length <= 150, `想定外のファイル数: ${paths.length}（期待: 100〜150、実測基準127）`);

  const leaked = paths.filter(
    (p) => p.startsWith('docs/') || p.startsWith('src/') || p.startsWith('test/') || p.startsWith('fixtures/') || p === 'tsconfig.json' || p.startsWith('.github/'),
  );
  assert.deepEqual(leaked, [], `tarballに含めるべきでないファイル: ${leaked.join(', ')}`);

  assert.ok(paths.includes('dist/cli.js'), 'dist/cli.js が無い');
  assert.ok(paths.includes('README.md') && paths.includes('LICENSE'), 'README/LICENSE が無い');

  // size/unpackedSize もゼロでないことを確認（node:child_process の異常終了で
  // stdout が空 JSON になるケースの Zero-Match-Is-Failure）
  assert.ok(size > 0 && unpackedSize > 0, `size/unpackedSize が異常: size=${size}, unpackedSize=${unpackedSize}`);
});
