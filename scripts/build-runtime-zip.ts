/**
 * runtime ZIP 生成（Issue #76）
 *
 * v1.0 の公式配布経路は「単独 project の prebuilt GitHub Release ZIP 1本」に固定する
 * （standalone public repo/project root の確定自体は #77 の仕事、ここでは配布物の
 * 構造と生成手順だけを成立させる）。
 *
 * allowlist 方式でファイルを集めて zip する。同梱するのは:
 * - dist/            （`npm run build` 済みであること。無ければここで失敗する）
 * - package.json
 * - package-lock.json
 * - README.md
 * - LICENSE           （存在すれば同梱。無くてもこのスクリプトは失敗しない — LICENSE の
 *                       実体承認は #77 の仕事で、ここでのブロッカーにしない）
 * - NOTICE / NOTICE.md（存在すれば同梱）
 *
 * test/ / src/ / .git / fixtures/ / node_modules/ は一切含めない（allowlist の外）。
 *
 * 出力: release/agent-doctor-runtime-<version>.zip + 同名 .sha256
 *
 * 再現性についての注記: `zip` コマンドの実装は OS によって異なる（Info-ZIP on macOS/Linux、
 * Windows は Compress-Archive や 7z 等）。同じコミット・同じ手順でも zip バイナリ自体が
 * bit-identical になる保証はしない。今回は「SHA-256 を記録して残す」ところまでで、
 * macOS/Windows 実機間の実際の一致検証は次回の Windows dogfood で行う（#76 コメント参照）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { cp, mkdtemp, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// 固定 mtime。同じ commit から作った zip が、ビルドを打ち直すたびに mtime 差だけで
// 別バイナリになってしまうのを防ぐ（同一 OS 上での再現性のため。OS 間の bit-identical までは保証しない、
// 上のコメント参照）
const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');

async function pinMtimes(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      await pinMtimes(p);
    }
    await utimes(p, FIXED_MTIME, FIXED_MTIME);
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const RELEASE_DIR = join(ROOT, 'release');

// allowlist: [リポジトリからの相対パス, 必須か]
const ALLOWLIST: Array<{ path: string; required: boolean }> = [
  { path: 'dist', required: true },
  { path: 'package.json', required: true },
  { path: 'package-lock.json', required: true },
  { path: 'README.md', required: true },
  { path: 'LICENSE', required: false },
  { path: 'NOTICE', required: false },
  { path: 'NOTICE.md', required: false },
];

async function main() {
  if (!existsSync(DIST)) {
    console.error('build-runtime-zip: dist/ が無い。先に `npm run build` を実行してください。');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const staging = await mkdtemp(join(tmpdir(), 'agent-doctor-runtime-'));

  const included: string[] = [];
  for (const entry of ALLOWLIST) {
    const src = join(ROOT, entry.path);
    if (!existsSync(src)) {
      if (entry.required) {
        console.error(`build-runtime-zip: 必須ファイルが無い: ${entry.path}`);
        process.exit(1);
      }
      continue;
    }
    await cp(src, join(staging, entry.path), { recursive: true });
    included.push(entry.path);
  }

  await pinMtimes(staging);

  mkdirSync(RELEASE_DIR, { recursive: true });
  const zipName = `agent-doctor-runtime-${pkg.version}.zip`;
  const zipPath = join(RELEASE_DIR, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);

  // -X: extra file attribute（拡張属性 / タイムスタンプの一部）を落として差分要因を減らす
  // ソートされたファイル列挙順（zip はディレクトリを渡すと自身のトラバース順に従うため
  // 完全な bit-identical 保証はしない。上のコメント参照）
  execFileSync('zip', ['-X', '-r', '-q', zipPath, ...included], { cwd: staging });

  const buf = readFileSync(zipPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);

  console.log(`build-runtime-zip: included = ${included.join(', ')}`);
  console.log(`build-runtime-zip: ${zipPath}`);
  console.log(`build-runtime-zip: sha256 = ${sha256}`);

  rmSync(staging, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
