/**
 * SCOPE_MISMATCH — 起動条件を本文に書いた rule が、無条件（load_mode=always）で全セッションに載る
 *
 * 条件A（静的・確定）: kind=rule、Binding(rule_autoload).load_mode == always、かつ同じ探索パスに
 *                     load_mode == path_conditional の rule がある（条件付きにできる機構があるのに使っていない）
 * 条件B（heuristic）: 本文に起動条件を示す語がある（語彙は scope-mismatch-vocab.json）
 * severity: A+B = warn（confidence high）/ B のみ = info（confidence medium）/ A のみ = 出さない（全域 rule は正常）
 *
 * 同じファイルが launcher 経由（append_system_prompt）でも入っていれば、その Binding も証拠に添える。
 * Codex の rules/*.rules は kind=exec_policy なのでここには来ない（prompt rule ではない）。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceRef, Finding } from '../ir/types.js';
import { bindingsFor, tilde, type DetectorResult, type FindingContext } from './context.js';

interface Vocab {
  ja: string[];
  en: string[];
}

let vocabCache: Vocab | null = null;
export async function loadVocab(): Promise<Vocab> {
  if (vocabCache) return vocabCache;
  const p = join(dirname(fileURLToPath(import.meta.url)), 'scope-mismatch-vocab.json');
  const raw = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
  vocabCache = { ja: (raw['ja'] as string[]) ?? [], en: (raw['en'] as string[]) ?? [] };
  return vocabCache;
}

export async function detectScopeMismatch(ctx: FindingContext): Promise<DetectorResult> {
  const s = ctx.snapshot;
  const home = s.env.home;
  const findings: Finding[] = [];
  const skipped: DetectorResult['skipped'] = [];

  const rules = s.resources.filter((r) => r.kind === 'rule');
  const candidates = rules.filter((r) => bindingsFor(s, r).some((b) => b.mechanism === 'rule_autoload' && b.discovered && b.load_mode === 'always'));
  if (candidates.length === 0) return { findings, skipped };

  if (!ctx.readText) {
    skipped.push({ detector: 'SCOPE_MISMATCH', reason: `${candidates.length} always-loaded rule(s) not evaluated: condition B needs file text and no file reader was given (saved snapshot)` });
    return { findings, skipped };
  }

  const vocab = await loadVocab();
  const patterns = [
    ...vocab.ja.map((p) => ({ lang: 'ja', re: new RegExp(p, 'i'), src: p })),
    ...vocab.en.map((p) => ({ lang: 'en', re: new RegExp(p, 'i'), src: p })),
  ];

  for (const r of candidates) {
    const auto = bindingsFor(s, r).find((b) => b.mechanism === 'rule_autoload')!;
    const text = await ctx.readText(r.path);
    if (text === null) {
      skipped.push({ detector: 'SCOPE_MISMATCH', reason: `${tilde(r.path, home)}: could not read` });
      continue;
    }

    // 条件B: 最初に一致した行
    let hit: { line: number; text: string; pattern: string; lang: string } | null = null;
    const lines = text.split(/\r\n?|\n/);
    for (let i = 0; i < lines.length && !hit; i++) {
      for (const p of patterns) {
        if (p.re.test(lines[i]!)) {
          hit = { line: i + 1, text: lines[i]!.trim(), pattern: p.src, lang: p.lang };
          break;
        }
      }
    }
    if (!hit) continue;

    // 条件A: 同じ探索パスに path_conditional の rule
    const sibling = rules.find(
      (x) => x.path !== r.path && auto.search_path !== null && x.path.startsWith(auto.search_path) && bindingsFor(s, x).some((b) => b.mechanism === 'rule_autoload' && b.load_mode === 'path_conditional'),
    );
    const siblingBinding = sibling ? bindingsFor(s, sibling).find((b) => b.mechanism === 'rule_autoload')! : null;

    // 同じファイルが別機構でも入っているか（launcher 由来）
    const others = bindingsFor(s, r).filter((b) => b !== auto && b.discovered);

    const evidence: EvidenceRef[] = [
      { type: 'binding', binding_id: auto.binding_id, resource_id: auto.resource_id, resource_path: auto.resource_path, runtime: auto.runtime, mechanism: auto.mechanism, rule_id: auto.rule_id },
      { type: 'resource', resource_id: r.resource_id, path: r.path, line: hit.line },
    ];
    if (sibling && siblingBinding) {
      evidence.push({ type: 'contrast', resource_id: sibling.resource_id, path: sibling.path, note: `same directory, declares paths: ${JSON.stringify(siblingBinding.scope_condition)}, load_mode=path_conditional` });
    }
    for (const b of others) evidence.push({ type: 'binding', binding_id: b.binding_id, resource_id: b.resource_id, resource_path: b.resource_path, runtime: b.runtime, mechanism: b.mechanism, rule_id: b.rule_id });

    const condA = !!sibling;
    findings.push({
      finding_id: 'SCOPE_MISMATCH',
      severity: condA ? 'warn' : 'info',
      confidence: condA ? 'high' : 'medium',
      // #73: 起動条件の実際の行文字列は要約に埋め込まない。本文は detail.condition.text にだけ置く
      // （bundle 投影ではそこだけを狙って落とせる。通常の report では detail 経由で見える）
      summary:
        `${tilde(r.path, home)} loads into every ${auto.runtime} session (no paths: frontmatter, load_mode=always), but line ${hit.line} states a launch condition (see detail.condition for the matched line). ` +
        (condA ? `${tilde(sibling!.path, home)} in the same directory scopes itself with paths:. ` : 'No sibling rule in the same directory uses paths:, so this is a heuristic match only. ') +
        (others.length ? `The same file also enters through ${others.map((b) => b.mechanism).join(', ')} (${others.map((b) => describeSource(b.source_ref, home)).join('; ')}).` : ''),
      subject: { resource_id: r.resource_id, path: r.path, name: r.name, runtime: auto.runtime },
      evidence_refs: evidence,
      axes: ['activation'],
      protected: false,
      scope: 'next_session',
      detail: {
        condition: { line: hit.line, text: hit.text, detector: `heuristic:launch_condition_${hit.lang}`, pattern: hit.pattern },
        condition_a_static: condA,
        mechanism_available: sibling ? { kind: 'paths_frontmatter', example: sibling.path, scope_condition: siblingBinding?.scope_condition ?? null } : null,
        also_bound_via: others.map((b) => ({ mechanism: b.mechanism, source: describeSource(b.source_ref, home), binding_id: b.binding_id })),
      },
    });
  }

  return { findings, skipped };
}

function describeSource(src: import('../ir/types.js').SourceRef, home: string): string {
  if (src.type === 'discovery') return `discovery ${tilde(src.search_path, home)}`;
  if (src.type === 'resource') return `${tilde(src.resource_path, home)}${src.locator ?? ''}`;
  return `${tilde(src.ref, home)}${src.locator ? '#' + src.locator : ''}`;
}
