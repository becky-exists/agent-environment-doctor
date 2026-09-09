/**
 * Finding 検出の共通部品
 *
 * 検出器は Snapshot（4 種の事実データ）だけを入力にする。本文が要る判定（SCOPE_MISMATCH の
 * 条件文、CROSS_RUNTIME_DRIFT の差分行数）は readText を通して読み、readText が無ければ
 * その判定をスキップして skipped に理由を残す（保存済み snapshot からの分析でも嘘をつかない）。
 */
import type { Binding, Finding, Resource, Snapshot } from '../ir/types.js';
import { toPosixPath } from '../ir/slug.js';

export interface FindingContext {
  snapshot: Snapshot;
  /** ファイル本文。READ ONLY。null = 読めない */
  readText?: (path: string) => Promise<string | null>;
  /** protected にする glob（安全側の既定 + 設定） */
  protectedGlobs: string[];
  /** drift の diff 抜粋の上限行数。未指定なら linediff の既定（80） */
  diffLines?: number;
  /** pid → --append-system-prompt 以降の argv 末尾。Snapshot には載せず、突合にだけ使う */
  argvTails?: Map<number, string>;
  /** session_id → (capability 名 → 説明の先頭)。名前照合の裏取りに使う。Snapshot には載せない */
  capabilityDescriptions?: Map<string, Map<string, string>>;
  /** session_id → (`<name>|<event>` → hook の発火実測)。Snapshot には載せない */
  hookFirings?: Map<string, Map<string, import('./hook-amplification.js').HookFiring>>;
}

export interface Skipped {
  detector: string;
  reason: string;
}

export interface Suppressed {
  reason: string;
  detail: string;
  count?: number;
}

export interface DetectorResult {
  findings: Finding[];
  skipped: Skipped[];
}

/** occurrence = (resource_id, path) に付いた Binding */
export function bindingsFor(s: Snapshot, r: Resource): Binding[] {
  return s.bindings.filter((b) => b.resource_id === r.resource_id && b.resource_path === r.path);
}

/** 「他 runtime の領域に在るだけ」を表す規則。これで discovered=false になっても症状ではない */
export const TERRITORY_RULE = /\.(not_in_search_path|not_in_standard_locations)$/;
/** 「探索対象の場所に、発見されない形式で置いてある」を表す規則。こちらは症状 */
export const SHAPE_RULE = /\.requires_dir_skill_md$/;
/** 意図的な無効化（plugin）。症状ではない（TOMBSTONE_ENTRY は Phase 2） */
export const DISABLE_RULE = /\.(disabled_not_loaded|enabled_flag)$/;

export function tilde(p: string, home: string): string {
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** `**\/memory/**` / `**\/MEMORY.md` 程度の glob を正規表現に。意図的に単純化: `**` と `*` のみ対応 */
export function globToRegExp(glob: string): RegExp {
  // トークン化してから組む（置換の順序で `.*` の `*` を再置換しないため）
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      re += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else re += /[.+^${}()|[\]\\?]/.test(c) ? '\\' + c : c;
  }
  return new RegExp('^' + re + '$');
}

/**
 * glob は `**\/MEMORY.md` のように `/` 区切り固定（protectedDefaults() 参照）。path 側は
 * join() で作られる native path（Windows では `\` 区切り）が渡ってくるため、比較の直前だけ
 * posix 形式に正規化する（表示・slug 化には使わない、toPosixPath と同じ比較専用の意図）。
 */
export function isProtected(path: string, globs: string[]): boolean {
  const posixPath = toPosixPath(path);
  return globs.some((g) => globToRegExp(g).test(posixPath));
}

/**
 * 言葉の規律。Doctor の出力に「削除」「不要」「無駄」「最適化」を書かない。
 * 破ったら Finding を出さずに例外にする（Optimizer に堕ちた瞬間に止まる）。
 */
export const FORBIDDEN_WORDS = /削除|不要|無駄|最適化|\bdelete\b|\bremove\b|unnecessary|\bbloat\b|clean\s?up|\bwasted?\b/i;

export function assertLanguageDiscipline(f: Finding): void {
  const m = FORBIDDEN_WORDS.exec(f.summary);
  if (m) throw new Error(`Finding ${f.finding_id} summary contains a forbidden word "${m[0]}". State facts only: ${f.summary}`);
}

/** mtime の新しい方を返す（同時刻なら null） */
export function newer<T extends { mtime: string }>(a: T, b: T): T | null {
  if (a.mtime === b.mtime) return null;
  return a.mtime > b.mtime ? a : b;
}
