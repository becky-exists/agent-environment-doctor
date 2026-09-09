/**
 * npm test のクロスプラットフォーム版ランナー（#83）
 *
 * 元の `tsx --test test/*.test.ts` はテストファイルの列挙をシェルの
 * glob展開に依存していた。bash（macOS/Linux）では動くが、Windows CI runner上の
 * `npm test` は PowerShell 経由で実行され、globが展開されないまま
 * `tsx --test` へリテラル文字列 `test/*.test.ts` が渡り、
 * "Could not find 'test/*.test.ts'" で即失敗していた（full test suiteが
 * 1件も実行されない）。
 *
 * ここでは test/*.test.ts の列挙を Node.js 側で行い、node:test の run() へ
 * ファイルパスの配列として明示的に渡すことで、シェルのglob展開に一切
 * 依存しないようにする。
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

const files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join(TEST_DIR, f));

console.log(`run-tests: ${files.length} test file(s) — ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);

let failed = false;
const stream = run({ files });
stream.on('test:fail', () => {
  failed = true;
});
stream.on('end', () => {
  process.exitCode = failed ? 1 : 0;
});
stream.compose(spec).pipe(process.stdout);
