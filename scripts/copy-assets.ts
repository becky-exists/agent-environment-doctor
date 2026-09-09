/**
 * build 後アセットコピー（Issue #76、#87で allowlist 型へ変更）
 *
 * tsc は .ts → .js のコンパイルしかしない。src/ 配下にある「実行時に読まれる」非TS
 * アセットを dist/ の対応する位置へコピーする。
 *
 * 以前は src/ 配下を再帰的に見た全ての .json を対象にしていた（0件でも
 * console.log して正常終了する = Zero-Match-Is-Failure の穴、#83 と同種）。
 * ここでは `build-runtime-zip.ts` の ALLOWLIST 方式に合わせ、ビルドに必須の
 * 既知アセットを明示リストで持ち、それぞれ existsSync で存在確認してからコピーする。
 * 1件でも見つからなければ非ゼロ終了する。
 *
 * 意図的に単純化: allowlist は現状 1 本（scope-mismatch-vocab.json）。
 * 将来同種のアセットが増えたらこの配列に追記する。
 */
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

// allowlist: src/ からの相対パス。ビルドに必須の非TSアセット全て
const ALLOWLIST: string[] = ['findings/scope-mismatch-vocab.json'];

async function main() {
  if (ALLOWLIST.length === 0) {
    console.error('copy-assets: ALLOWLIST が空 — アセットコピー自体が壊れている可能性');
    process.exit(1);
  }

  const missing: string[] = [];
  for (const rel of ALLOWLIST) {
    const src = join(SRC, rel);
    if (!existsSync(src)) {
      missing.push(rel);
      continue;
    }
    const dest = join(DIST, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
    console.log(`copy-assets: ${join('src', rel)} -> ${join('dist', rel)}`);
  }

  if (missing.length > 0) {
    console.error('copy-assets: 必須アセットが無い:', missing.join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
