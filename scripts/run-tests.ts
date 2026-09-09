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

// Zero-Match-Is-Failure（#83 と同種の穴を塞ぐ）: TEST_DIR の指定ミスや一時的な
// 空ディレクトリ化で 0 件になった場合、node:test の run({ files: [] }) は
// 何も実行せず 'end' を正常に発火する。そのまま抜けると npm test が「全部green」を
// 報告してしまう — 実際には1つもテストが走っていないのに、を許さない
if (files.length === 0) {
  console.error('run-tests: no test files discovered under', TEST_DIR, '— refusing to report success');
  process.exit(1);
}

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
