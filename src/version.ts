/**
 * 唯一のバージョン source。package.json の "version" を実行時に読む。
 *
 * 以前は package.json とは別に、claude-code / codex 両アダプタが
 * `TOOL_VERSION` を個別にハードコードしていた（#77 M5 で発覚した drift）。
 * この 2 箇所と package.json が同時に食い違い得るのを塞ぐため、
 * ビルド後（dist/version.js）でも開発時（tsx 経由の src/version.ts）でも
 * 同じ相対位置（このファイルの 1 つ上）にある package.json を都度読む。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readToolVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

export const TOOL_VERSION = readToolVersion();
