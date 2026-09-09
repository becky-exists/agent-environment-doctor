/**
 * 正規化と hash
 *
 * normalized_hash の規則（docs/phase0-implementation-handoff.md §2.1）:
 *   1. 改行を \n に統一
 *   2. 行末の空白を除去
 *   3. 末尾の空行を除去
 *   4. frontmatter は含める（description の差分も本物の drift として見たい）
 *   5. それ以外は変更しない（本文の意味を変える正規化はしない）
 *
 * 目的: 改行コード差だけで CROSS_RUNTIME_DRIFT の偽陽性が出るのを防ぐ。
 */

import { createHash } from 'node:crypto';

export function normalizeContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '\n');
}

export function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashes(text: string): { content_hash: string; normalized_hash: string } {
  return { content_hash: sha256(text), normalized_hash: sha256(normalizeContent(text)) };
}

/** 行単位の差分行数。normalized_hash が違うペアにだけ使う（全ペアに diff をかけない） */
export function diffLineCount(a: string, b: string): number {
  const la = normalizeContent(a).split('\n');
  const lb = normalizeContent(b).split('\n');
  // ponytail: LCS ではなく多重集合の対称差。上限 = 行数の合計、順序変更は差分として数えない。
  // 正確な編集距離が必要になったら diff ライブラリへ差し替える
  const count = new Map<string, number>();
  for (const l of la) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of lb) count.set(l, (count.get(l) ?? 0) - 1);
  let d = 0;
  for (const v of count.values()) d += Math.abs(v);
  return d;
}

function demo(): void {
  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error('demo failed: ' + m);
  };
  // 改行コード差は normalized_hash を変えない（偽陽性防止の核）
  const crlf = hashes('a\r\nb\r\n');
  const lf = hashes('a\nb\n');
  assert(crlf.normalized_hash === lf.normalized_hash, 'CRLF/LF must normalize equal');
  assert(crlf.content_hash !== lf.content_hash, 'content_hash must stay sensitive');
  // 行末空白と末尾空行も無視
  assert(hashes('a  \nb\n\n\n').normalized_hash === lf.normalized_hash, 'trailing ws/blank lines');
  // description の差は本物の drift として残る
  assert(hashes('---\ndescription: x\n---\n').normalized_hash !== hashes('---\ndescription: y\n---\n').normalized_hash, 'frontmatter counts');
  // 差分行数
  assert(diffLineCount('a\nb\n', 'a\nb\n') === 0, 'identical = 0');
  assert(diffLineCount('a\nb\n', 'a\nc\n') === 2, 'one line changed = 2 (removed + added)');
  console.log('normalize.ts demo: ok');
}

if (process.argv[1]?.endsWith('normalize.ts')) demo();
