/**
 * build 後アセットコピー（Issue #76）
 *
 * tsc は .ts → .js のコンパイルしかしない。src/ 配下にある「実行時に読まれる」非TS
 * アセット（現状は scope-mismatch-vocab.json 1本、将来同種のものが増える可能性がある）を
 * dist/ の対応する位置へコピーする。
 *
 * 意図的に単純化: 対象は src 配下を再帰的に見た全ての .json ファイルのみ（テスト用 fixture は fixtures/ 配下にあり
 * src/ には置かれないため、このパターンで巻き込む心配はない）。それ以上の拡張子・除外リスト
 * は今は不要、必要になったら足す。
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(p)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(p);
    }
  }
  return files;
}

async function main() {
  const jsonFiles = await walk(SRC);
  if (jsonFiles.length === 0) {
    console.log('copy-assets: src/**/*.json が見つからなかった（コピー対象なし）');
    return;
  }
  for (const src of jsonFiles) {
    const rel = relative(SRC, src);
    const dest = join(DIST, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
    console.log(`copy-assets: ${join('src', rel)} -> ${join('dist', rel)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
