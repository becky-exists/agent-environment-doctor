/**
 * context cost — 起動時に何がどれだけ載るか
 *
 * **大きい = 悪 にしない。** 大きさは事実として記録する。症状かどうかは Finding が別に決める。
 * この層は Finding を出さない。数字を出すだけ。
 *
 * 測り方の等級（method を必ず添える。chars/4 は使わない）:
 *   tiktoken_o200k_approx : js-tiktoken の o200k_base で数えた token。**Claude の tokenizer ではない**ので近似。
 *                           日本語で chars/4 が 2 倍以上外れるのを避けるために使う。比較可能性が目的で、絶対値ではない
 *   filesystem            : バイト数・文字数（そのまま）
 *   transcript_scan       : セッション記録に残っていた**実際に注入されたテキスト**の長さ（MCP instructions / hook 出力）
 *
 * 数え方の落とし穴（実測で踏んだ 2 つ）:
 *   - **同じ内容が複数パスに在るものを二重に数えない。** ~/.claude/projects/<slug>/memory/MEMORY.md は
 *     29 個の slug に symlink で置かれていて、素朴に足すと 974 KB になった。実際に載るのは今のプロジェクトの 1 本。
 *     (runtime, 内容, 機構) で畳み、重複していたパスの数を duplicate_paths に残す
 *   - **今のプロジェクトに関係しない memory を数えない。** 他プロジェクトの slug 配下は載らない
 *
 * 何が起動時に載るか（load_mode で分ける）:
 *   always     : instruction（CLAUDE.md / AGENTS.md）、memory（MEMORY.md）、paths 無しの rule、hook 登録、launcher の注入
 *   on_demand  : skill / agent / command は **description だけ**が起動時に載り、本文は呼ばれた時
 *   deferred   : MCP tool は名前だけ。スキーマ本文は要求時（固定費はほぼゼロ）
 */
import { recordAccess } from '../ir/access.js';
import { matchProjectSlug, memorySlugOf } from '../ir/slug.js';
import { getEncoding, type Tiktoken } from 'js-tiktoken';

import type { Resource, Snapshot } from '../ir/types.js';

export const TOKEN_METHOD = 'tiktoken_o200k_approx' as const;
export const TOKEN_METHOD_NOTE =
  'Token counts come from js-tiktoken o200k_base. That is not the tokenizer Claude or Codex use, so treat the numbers as a consistent yardstick for comparison, not as the exact cost. Character and byte counts are exact.';

let enc: Tiktoken | null = null;
function tokens(text: string): number {
  enc ??= getEncoding('o200k_base');
  return enc.encode(text).length;
}

export interface CostItem {
  resource_id: string;
  path: string;
  /** 同じ内容が置かれていた他のパスの数（symlink / コピー）。1 = 重複なし */
  duplicate_paths: number;
  kind: string;
  name: string;
  runtime: string;
  mechanism: string;
  load_mode: string;
  /** 起動時に載る部分の測定。description だけ載るものは description の分 */
  measured_part: 'whole_file' | 'declared_description' | 'registration_only' | 'name_only';
  /** context に入る分のバイト数。registration_only は 0（登録自体は context に載らない） */
  bytes: number;
  /** ファイル自体の大きさ。registration_only で「登録の宣言はこの大きさ」を示すのに使う */
  declared_bytes: number;
  chars: number;
  token_estimate: number;
  /** token を実測したか。false = 本文を読んでいない、または context に入らない部分 */
  token_measured: boolean;
  method: typeof TOKEN_METHOD | 'filesystem';
  protected: boolean;
}

export interface ContextCost {
  scope: 'next_session';
  method_note: string;
  /** load_mode 別の合計。always が「毎回必ず払う分」 */
  by_load_mode: Record<string, { items: number; bytes: number; token_estimate: number }>;
  /** mechanism 別の合計 */
  by_mechanism: Record<string, { items: number; bytes: number; token_estimate: number }>;
  /** runtime 別の起動時固定費 */
  by_runtime: Record<string, { always_token_estimate: number; on_demand_description_token_estimate: number; deferred_items: number }>;
  /** protected と、それ以外の分離。**protected は「減らす対象」ではない**ので合計から切り離して示す */
  protected_total: { items: number; bytes: number; token_estimate: number };
  unprotected_total: { items: number; bytes: number; token_estimate: number };
  /** 重い順。大きさの事実。ここに載ること自体は症状ではない */
  largest: CostItem[];
  items: CostItem[];
  /** 測っていないもの。ここを黙って 0 にしない */
  not_measured: string[];
}

/** protected glob に当たるか（findings/context.ts と同じ規則を使う） */
type IsProtected = (path: string) => boolean;

/**
 * 今のプロジェクトの memory slug を、**snapshot に実在する slug の中から**選ぶ。
 * cwd から符号化した文字列で決め打ちしない（Windows の符号化規則が確定していないため。src/ir/slug.ts）。
 * 突合できなかった時は **絞り込みを行わない**。ここで黙って全部落とすと memory が 0 になる。
 */
function resolveActiveSlug(s: Snapshot): { slug: string | null; observed: string[]; note: string | null } {
  const observed = [...new Set(s.resources.map((r) => memorySlugOf(r.path)).filter((x): x is string => x !== null))];
  const m = matchProjectSlug(s.env.project, observed);
  if (m.slug) return { slug: m.slug, observed, note: null };
  if (m.how === 'not_applicable') return { slug: null, observed, note: null };
  if (observed.length === 0) return { slug: null, observed, note: null };
  return {
    slug: null,
    observed,
    note:
      `the current project could not be matched to any of the ${observed.length} project memory directories that exist ` +
      `(tried: ${m.candidates.join(', ')}). Memory files were therefore NOT filtered by project, so this figure is wider than one session — it is not zero.`,
  };
}

export async function computeContextCost(s: Snapshot, isProtected: IsProtected, readText?: (p: string) => Promise<string | null>): Promise<ContextCost> {
  const items: CostItem[] = [];
  const byPath = new Map(s.resources.map((r) => [`${r.resource_id}|${r.path}`, r]));
  const active = resolveActiveSlug(s);
  const slug = active.slug;
  if (active.note) {
    recordAccess({
      target: 'project_slug_match',
      collector: 'context-cost',
      what: 'current project memory directory',
      status: 'failed',
      reason: active.note,
    });
  }
  // (runtime, 内容, 機構, 測った部分) で畳む。symlink / コピーで同じものを何度も数えない
  const seen = new Map<string, CostItem>();
  let skippedOtherProjects = 0;

  for (const b of s.bindings) {
    if (!b.discovered) continue;
    const r = byPath.get(`${b.resource_id}|${b.resource_path}`);
    if (!r) continue;

    // 他プロジェクトの memory は今のセッションには載らない
    const mslug = memorySlugOf(r.path);
    if (mslug !== null && slug !== null && mslug !== slug) {
      skippedOtherProjects++;
      continue;
    }

    let part: CostItem['measured_part'];
    let text: string | null = null;
    let bytes = 0;
    let chars = 0;

    if (b.load_mode === 'always') {
      // 常時ロード = ファイル全体が載る（instruction / memory / 無条件 rule）
      if (b.mechanism === 'hook_registration' || b.mechanism === 'plugin_manifest' || b.mechanism === 'settings_file') {
        // 登録の宣言そのものは context に載らない。載るのは hook の**出力**（セッション記録から別に測る）
        part = 'registration_only';
        bytes = 0;
        chars = 0;
      } else {
        part = 'whole_file';
        bytes = r.size_bytes;
        chars = 0;
      }
    } else if (b.load_mode === 'on_demand') {
      // 起動時に載るのは description だけ。本文は呼ばれた時
      part = 'declared_description';
      text = r.declared.description ?? null;
      bytes = text ? Buffer.byteLength(text, 'utf8') : 0;
      chars = text ? text.length : 0;
    } else if (b.load_mode === 'deferred') {
      part = 'name_only';
      bytes = Buffer.byteLength(r.name, 'utf8');
      chars = r.name.length;
    } else {
      continue; // never / unknown / path_conditional は起動時の固定費に入れない
    }

    // ファイル全体が載るものは、readText があれば本文を読んで token を実測する。
    // 読めない時は 0 のままにして token_measured=false（chars/4 のような換算はしない）
    let token_estimate = 0;
    let token_measured = false;
    if (text !== null) {
      token_estimate = tokens(text);
      token_measured = true;
    } else if (b.load_mode === 'deferred') {
      token_estimate = tokens(r.name);
      token_measured = true;
    } else if (part === 'whole_file' && readText) {
      const body = await readText(r.path);
      if (body !== null) {
        token_estimate = tokens(body);
        token_measured = true;
        chars = body.length;
      }
    }

    const key = `${b.runtime}|${r.resource_id}|${b.mechanism}|${part}`;
    const dup = seen.get(key);
    if (dup) {
      dup.duplicate_paths++;
      continue;
    }
    const item: CostItem = {
      resource_id: r.resource_id,
      path: r.path,
      declared_bytes: r.size_bytes,
      duplicate_paths: 1,
      kind: r.kind,
      name: r.name,
      runtime: b.runtime,
      mechanism: b.mechanism,
      load_mode: b.load_mode,
      measured_part: part,
      bytes,
      chars,
      token_estimate,
      token_measured,
      method: token_measured ? TOKEN_METHOD : 'filesystem',
      protected: isProtected(r.path),
    };
    seen.set(key, item);
    items.push(item);
  }

  const group = (key: (i: CostItem) => string) => {
    const m: Record<string, { items: number; bytes: number; token_estimate: number }> = {};
    for (const i of items) {
      const k = key(i);
      m[k] ??= { items: 0, bytes: 0, token_estimate: 0 };
      m[k]!.items++;
      m[k]!.bytes += i.bytes;
      m[k]!.token_estimate += i.token_estimate;
    }
    return m;
  };

  const byRuntime: ContextCost['by_runtime'] = {};
  for (const i of items) {
    byRuntime[i.runtime] ??= { always_token_estimate: 0, on_demand_description_token_estimate: 0, deferred_items: 0 };
    if (i.load_mode === 'always') byRuntime[i.runtime]!.always_token_estimate += i.token_estimate;
    if (i.load_mode === 'on_demand') byRuntime[i.runtime]!.on_demand_description_token_estimate += i.token_estimate;
    if (i.load_mode === 'deferred') byRuntime[i.runtime]!.deferred_items++;
  }

  const sum = (xs: CostItem[]) => ({ items: xs.length, bytes: xs.reduce((n, x) => n + x.bytes, 0), token_estimate: xs.reduce((n, x) => n + x.token_estimate, 0) });

  return {
    scope: 'next_session',
    method_note: TOKEN_METHOD_NOTE,
    by_load_mode: group((i) => i.load_mode),
    by_mechanism: group((i) => i.mechanism),
    by_runtime: byRuntime,
    protected_total: sum(items.filter((i) => i.protected)),
    unprotected_total: sum(items.filter((i) => !i.protected)),
    largest: [...items].sort((a, b) => b.bytes - a.bytes || b.token_estimate - a.token_estimate).slice(0, 20),
    items,
    not_measured: [
      ...(items.some((i) => i.measured_part === 'registration_only')
        ? [
            `${items.filter((i) => i.measured_part === 'registration_only').length} registration(s) (hooks, plugin entries, settings files) count as 0 context bytes: the registration itself is not placed in the context. What a hook puts there is its output, measured separately from session records.`,
          ]
        : []),
      ...(items.some((i) => !i.token_measured && i.measured_part === 'whole_file')
        ? [`Token counts for ${items.filter((i) => !i.token_measured && i.measured_part === 'whole_file').length} whole-file item(s): the body was not readable in this run, so only bytes are given. No character-to-token conversion is applied.`]
        : []),
      ...(skippedOtherProjects ? [`${skippedOtherProjects} memory file(s) belonging to other project slugs were left out: they do not load into a session for this project.`] : []),
      ...(active.note ? [`Project memory could not be narrowed down: ${active.note}`] : []),
      ...(items.some((i) => i.duplicate_paths > 1)
        ? [`Items whose identical content sits at several paths (symlinks or copies) are counted once; the number of paths is kept per item. Without this, ${items.reduce((n, i) => n + i.duplicate_paths - 1, 0)} extra copies would have been added to the totals.`]
        : []),
      'The runtime\'s own system prompt and built-in tool definitions: they are not files in the configuration and are not collected.',
      'Skill and command bodies: they load when invoked, not at startup, so they are not part of the fixed cost.',
      'Hook output and MCP instruction text as loaded at startup: measured separately from session records when --probe is used (see measured_context_cost).',
    ],
  };
}

// ───────────────── 実測（セッション記録から）─────────────────

export interface MeasuredContextItem {
  session_id: string;
  runtime: string;
  source: 'mcp_instructions' | 'hook_output' | 'skill_listing';
  label: string;
  bytes: number;
  chars: number;
  token_estimate: number;
  method: typeof TOKEN_METHOD;
  /** 起動時の 1 回か、セッション中に繰り返し入ったか */
  occurrences: number;
}

export interface MeasuredContextCost {
  scope: 'active_runtime';
  method_note: string;
  items: MeasuredContextItem[];
  by_source: Record<string, { items: number; bytes: number; token_estimate: number; occurrences: number }>;
  notes: string[];
}

/** セッション記録に残っていた「実際に注入されたテキスト」の長さ。text は保持しない */
export function measureFromRecords(measured: MeasuredContextItem[]): MeasuredContextCost {
  const by: MeasuredContextCost['by_source'] = {};
  for (const i of measured) {
    by[i.source] ??= { items: 0, bytes: 0, token_estimate: 0, occurrences: 0 };
    by[i.source]!.items++;
    by[i.source]!.bytes += i.bytes;
    by[i.source]!.token_estimate += i.token_estimate;
    by[i.source]!.occurrences += i.occurrences;
  }
  return {
    scope: 'active_runtime',
    method_note: TOKEN_METHOD_NOTE,
    items: measured,
    by_source: by,
    notes: [
      'These are lengths of text that session records show was actually injected. The text itself is not stored here.',
      'Hook output is counted per firing, so a hook that fires on every prompt shows a higher total than one that fires once at startup. That is a fact about frequency, not a defect.',
    ],
  };
}

export function countTokens(text: string): number {
  return tokens(text);
}
