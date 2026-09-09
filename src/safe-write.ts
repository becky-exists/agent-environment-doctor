/**
 * 出力ファイルの排他的書き込み（#75）
 *
 * `snapshot --out` / `bundle --out` は診断対象の外へ書く前提だが、writeFile の既定（上書き）
 * モードのままだと、利用者が `--out` に既存ファイル（例: 診断対象の `.claude/settings.json`）を
 * 指定した時、exit 0 のままそのファイルが snapshot/bundle JSON に置換されてしまう。
 * Doctor の主要保証は READ ONLY —— 出力先の指定ミスで観測対象を破壊できる経路を残さない。
 *
 * 二段構え:
 *   1. lstat で事前チェック（symlink も辿らず検知。分かりやすいエラーを早く返すため）
 *   2. 実書き込みは flag: 'wx'（O_CREAT|O_EXCL）。1 と 2 の間に何か作られても、
 *      ここが唯一の権威ある関門（TOCTOU の隙間を OS の排他制御で埋める。1 だけに頼らない）
 *
 * 実測（Node v24, macOS）: 通常ファイル・有効な symlink・dangling symlink のいずれも
 * 'wx' で EEXIST になる（symlink は target を辿らず、その場所に「エントリがある」ことで拒否される）。
 * Windows の junction / hardlink 相当は実機未検証 —— 1 の lstat 事前チェックが追加の保険になる。
 */
import { writeFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class OutputAlreadyExistsError extends Error {
  constructor(public readonly path: string) {
    super(`Will not overwrite an existing file: ${path}\nSpecify a different --out path.`);
    this.name = 'OutputAlreadyExistsError';
  }
}

function isEexist(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'EEXIST';
}

/**
 * 新規パスにのみ書く。既存ファイル・既存 symlink（有効/dangling 問わず）には書かない。
 * 親ディレクトリを新規に作ること自体は許容する（mkdir recursive はこれまで通り）。
 */
export async function writeExclusive(out: string, content: string): Promise<void> {
  const target = resolve(out);
  await mkdir(dirname(target), { recursive: true });

  // 1. 事前チェック（lstat は symlink を辿らない = symlink 自身の存在で検知できる）
  const preExisting = await lstat(target).then(
    () => true,
    () => false,
  );
  if (preExisting) throw new OutputAlreadyExistsError(out);

  // 2. 権威ある関門。1 との間に他プロセス/他呼び出しが同じパスへ書いていても、ここで弾く
  try {
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if (isEexist(e)) throw new OutputAlreadyExistsError(out);
    throw e;
  }
}
