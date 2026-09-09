/**
 * 行単位の unified diff（抜粋用）
 *
 * 用途: CROSS_RUNTIME_DRIFT の「差分行数」だけでは受け手が判断できない（ドッグフード 2026-09-07 で Codex が 2/5 と採点、
 * 最大の不足は「実際に異なる行の内容が無い」）。差分の本文を上限つきで添える。
 * 意図的に単純化: LCS の DP（O(n·m)）。行数が上限を超えたら先頭だけで打ち切る。上限 = 各 1500 行、出力 = 80 行。
 */
import { normalizeContent } from './normalize.js';

export interface DiffExcerpt {
  /** unified 形式の行（'+' / '-' / ' ' 始まり、hunk 見出しは '@@'） */
  lines: string[];
  added: number;
  removed: number;
  /** 出力上限で切ったか */
  truncated: boolean;
  method: 'lcs_unified';
}

const MAX_INPUT_LINES = 1500;
const MAX_OUTPUT_LINES = 80;
const CONTEXT = 1;

export function unifiedDiffExcerpt(aText: string, bText: string, labelA: string, labelB: string, maxOutputLines = MAX_OUTPUT_LINES): DiffExcerpt {
  const a = normalizeContent(aText).split('\n').slice(0, MAX_INPUT_LINES);
  const b = normalizeContent(bText).split('\n').slice(0, MAX_INPUT_LINES);
  const n = a.length;
  const m = b.length;
  // LCS 表
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
  }
  // 経路復元 → ops
  type Op = { t: ' ' | '-' | '+'; line: string; ia: number; ib: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i]!, ia: i, ib: j });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: '-', line: a[i]!, ia: i, ib: j });
      i++;
    } else {
      ops.push({ t: '+', line: b[j]!, ia: i, ib: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', line: a[i]!, ia: i++, ib: j });
  while (j < m) ops.push({ t: '+', line: b[j]!, ia: i, ib: j++ });

  // 変更行の周り CONTEXT 行だけを hunk にまとめる
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.t === ' ') return;
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (ops[k + d]) keep[k + d] = true;
  });

  const out: string[] = [`--- ${labelA}   ('-' = lines only on this side)`, `+++ ${labelB}   ('+' = lines only on this side)`];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let inHunk = false;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]!;
    if (op.t === '+') added++;
    if (op.t === '-') removed++;
    if (!keep[k]) {
      inHunk = false;
      continue;
    }
    if (out.length >= maxOutputLines) {
      truncated = true;
      continue; // 件数だけ数え続ける
    }
    if (!inHunk) {
      out.push(`@@ -${op.ia + 1} +${op.ib + 1} @@`);
      inHunk = true;
    }
    out.push(`${op.t}${op.line.length > 160 ? op.line.slice(0, 160) + ' …' : op.line}`);
  }
  if (truncated) out.push(`… (truncated at ${maxOutputLines} lines: ${added} '+' / ${removed} '-' lines in total; rerun with --diff-lines <n> for more)`);
  return { lines: out, added, removed, truncated, method: 'lcs_unified' };
}

function demo(): void {
  const d = unifiedDiffExcerpt('a\nb\nc\n', 'a\nx\nc\nd\n', 'A', 'B');
  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error('demo failed: ' + m + ' ' + JSON.stringify(d));
  };
  assert(d.added === 2 && d.removed === 1, 'counts');
  assert(d.lines.includes('-b') && d.lines.includes('+x') && d.lines.includes('+d'), 'ops');
  assert(!d.truncated, 'no truncation');
  console.log('linediff.ts demo: ok');
}
if (process.argv[1]?.endsWith('linediff.ts')) demo();
