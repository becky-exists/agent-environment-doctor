/**
 * raw reference の抽出
 *
 * 原則: 解決しない。生文字列と行番号だけを一次事実として残す。
 * 誤検出は許容し、confidence で表現する。解決フェーズ（分析時）が
 * 「参照先が存在しない」を判定して UNREACHABLE_REFERENCE を出す。
 */

import type { RawReference } from '../../ir/types.js';

/** バッククォート内の <ns>:<name>。plugin skill 参照の主な書き方。ns は英字始まり（`123456789:AAH…` のようなトークン例を拾わない） */
const SKILL_REF = /`([a-z][a-z0-9_-]*):([a-z0-9][a-z0-9._-]*)`/gi;
/** name 側がこれなら `key:value` の記法であって参照ではない（`read:false` 等） */
const NON_REF_NAME = /^(true|false|null|none|yes|no|on|off|\d+(\.\d+)?|\.{3})$/i;
/** ~/ で始まるパス、または絶対パス。バッククォート内外の両方 */
const PATH_REF = /(?:`|^|[\s(])(~\/[\w./@+-]+|\/(?:Users|Volumes|opt|etc|var)\/[\w./@+-]+)/g;
/** <plugin>@<marketplace> */
const PLUGIN_REF = /`?\b([a-z0-9][a-z0-9_-]*)@([a-z0-9][a-z0-9_-]*)\b`?/gi;

/** ここに一致する ns は skill 参照として扱わない（英文中のコロンや既知の非 skill 語） */
const NS_DENYLIST = new Set(['http', 'https', 'file', 'note', 'e', 'ex', 'tel', 'mailto', 'data']);

export function extractReferences(text: string): RawReference[] {
  const out: RawReference[] = [];
  const lines = text.split(/\r\n?|\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    for (const m of line.matchAll(SKILL_REF)) {
      const ns = (m[1] ?? '').toLowerCase();
      if (NS_DENYLIST.has(ns)) continue;
      if (NON_REF_NAME.test(m[2] ?? '')) continue;
      out.push({
        raw: `${m[1]}:${m[2]}`,
        line: lineNo,
        syntax: 'skill_ref',
        // バッククォートで囲まれた ns:name は参照の意図が強い
        confidence: 'high',
      });
    }

    for (const m of line.matchAll(PATH_REF)) {
      const raw = m[1];
      if (!raw) continue;
      out.push({
        raw,
        line: lineNo,
        syntax: 'path_ref',
        // 文中のパスは説明目的のこともある
        confidence: 'medium',
      });
    }

    for (const m of line.matchAll(PLUGIN_REF)) {
      const raw = `${m[1]}@${m[2]}`;
      // メールアドレスや @ を含む単語との衝突を避ける: 既知の marketplace 語形のみ
      if (!/@(?:[a-z0-9-]*(?:official|codex|plugins?|marketplace|skill|ponytail|thedotmack)[a-z0-9-]*)$/i.test(raw)) continue;
      out.push({ raw, line: lineNo, syntax: 'plugin_ref', confidence: 'medium' });
    }
  });

  // 同一 (raw, line) の重複を落とす
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.syntax}|${r.raw}|${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function demo(): void {
  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error('demo failed: ' + m);
  };
  // 実環境の実例: agents/andy.md の死んだ参照
  const sample = [
    '## 自動起動 / 連携スキル',
    '',
    '- `vercel:react-best-practices`: TSX 編集後の React 品質レビュー',
    '- `firebase`: Firestore rules',
    '詳細は ~/.claude/rules/telegram-channels.md を見る',
    'plugin は codex@openai-codex を使う',
    'URL は https://example.com なので参照ではない',
  ].join('\n');

  const refs = extractReferences(sample);
  const skill = refs.filter((r) => r.syntax === 'skill_ref');
  assert(skill.length === 1 && skill[0]!.raw === 'vercel:react-best-practices', 'skill_ref 抽出');
  assert(skill[0]!.line === 3, 'skill_ref の行番号');

  const paths = refs.filter((r) => r.syntax === 'path_ref');
  assert(paths.some((p) => p.raw === '~/.claude/rules/telegram-channels.md'), 'path_ref 抽出');

  const plugins = refs.filter((r) => r.syntax === 'plugin_ref');
  assert(plugins.some((p) => p.raw === 'codex@openai-codex'), 'plugin_ref 抽出');

  // https: を skill 参照として拾わない
  assert(!refs.some((r) => r.syntax === 'skill_ref' && r.raw.startsWith('https')), 'URL は skill_ref にしない');
  // key:value 記法とトークン例は skill_ref にしない（実環境で偽陽性になった 2 例）
  const noise = extractReferences('- `read:false` と `123456789:AAH...` は参照ではない。`superpowers:test-driven-development` は参照');
  assert(noise.filter((r) => r.syntax === 'skill_ref').map((r) => r.raw).join() === 'superpowers:test-driven-development', 'key:value / token は除外');

  console.log(`references.ts demo: ok (${refs.length} refs)`);
}

if (process.argv[1]?.endsWith('references.ts')) demo();
