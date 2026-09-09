/**
 * 人間向け要約層 — 検査結果を「人間語の事実」に翻訳する
 *
 * ここは診断しない。Finding を増やさない。severity も confidence も変えない。
 * やるのは 3 つだけ:
 *
 *   1. 同じ原因の Finding を **観測された共有条件だけ**で束ねる
 *      （見た目を整えるための推測で束ねない。安全に束ねられないものは 1 件 1 束のまま）
 *   2. 束ねたものに人間語の見出しを付ける
 *      **書いてよいのは事実の翻訳だけ。** 修正案・正本の決定・Evidence に無い原因の推測は書かない
 *   3. 「見たが症状にしなかったこと」を同じ画面に並べる（Doctor が Optimizer でないことの提示）
 *
 * 数字はすべて渡されたデータから導出する。実環境の値を焼き込まない。
 */
import type { UiFindingView, UiResourceView } from './data.js';
import type { ContextCost } from '../observe/context-cost.js';

/** 要約層が書いてはいけない語（助言・最適化・正本の決定）。テストが見張る */
export const NO_ADVICE =
  /削除|消す|外す|やめ|べきだ|べきで|推奨|直した|直すべき|修正案|不要|無駄|最適化|整理する|\bshould\b|\bmust\b|\bremove\b|\bdelete\b|\bfix\b|\boptimi[sz]e\b/i;

export function runtimeLabel(runtime: string): string {
  if (runtime === 'claude-code') return 'Claude';
  if (runtime === 'codex') return 'Codex';
  return runtime;
}

/** 一覧の狭い列で使う 1 文字記号。凡例を必ず一緒に出す前提 */
export function runtimeMark(runtime: string): string {
  if (runtime === 'claude-code') return 'C';
  if (runtime === 'codex') return 'X';
  return runtime.slice(0, 1).toUpperCase();
}

export interface UiCluster {
  id: string;
  /** 束ね方の種別（機械可読） */
  kind: 'unresolved_plugin_namespace' | 'cross_runtime_drift' | 'session_staleness' | 'hook_amplification' | 'unknown_namespace' | 'single';
  /** 人間語の見出し。事実だけ */
  headline: string;
  /** 右肩の数え方（"10 skills" のような単位つき） */
  count_label: string;
  /** 追加の事実（0〜2 行） */
  facts: string[];
  /** なぜ同じ原因と言えるのか＝束ねた根拠。推測でないことをここで示す */
  grouped_by: string;
  members: string[];
  severity: 'error' | 'warn' | 'info';
  runtimes: string[];
  /** protected 資源に関わるか（severity は下げない） */
  touches_protected: boolean;
  /** 人に聞くこと（llm-report と同じ問い。無ければ null） */
  question: string | null;
}

export interface UiNotProblem {
  label: string;
  /** 元の宣言文。Expert 層で確かめられるように捨てない */
  detail: string;
  /** どのタブへ潜るか */
  goto: 'cost' | 'notfindings' | 'coverage' | 'hooks' | 'history';
}

export interface UiOverview {
  /** 見出しの N。**Finding の件数ではなく cluster の数** */
  attention_count: number;
  finding_count: number;
  headline: string;
  headline_note: string;
  clusters: UiCluster[];
  not_problems: UiNotProblem[];
  comparison: {
    runtimes: Array<{ runtime: string; label: string; version: string | null; present: boolean; discovered: number; resources_discovered: number }>;
    same_name_skills: { pairs: number; identical: number; drifted: number };
    same_path_both: number;
    only: Array<{ runtime: string; label: string; count: number }>;
    note: string;
  };
  recent: {
    snapshots: number;
    gaps: number;
    events: Array<{ observed_at: string; since: string; kind: string; summary: string; direction: string }>;
    total_events: number;
    note: string[];
  };
  /** 内部の数。主役にしない（Overview の隅） */
  internals: { resources: number; bindings: number; observations: number; sessions: number; processes: number };
  /** 観測範囲の短い版と全文（長文は畳む） */
  observing: { short: string; full: string };
}

/* ───────────────────────── cluster ───────────────────────── */

function severityRank(s: string): number {
  return s === 'error' ? 0 : s === 'warn' ? 1 : 2;
}

function runtimeOf(f: UiFindingView): string {
  const sess = f.detail['session'] as { runtime?: string } | undefined;
  if (sess && typeof sess.runtime === 'string') return sess.runtime;
  const ev = f.evidence.find((e) => e.type === 'binding' || e.type === 'session');
  const m = ev?.text.match(/([a-z][a-z-]+)/);
  return m?.[1] ?? '?';
}

/**
 * 束ねる鍵。**観測された共有条件だけ**を鍵にする。
 *
 *  1. llm-report が既に付けた cluster（plugin:<ns> / drift:<rtA>|<rtB>）はそのまま使う
 *  2. 付いていないものは、同じ finding_id の中で、共有条件が事実として言えるものだけ束ねる
 *  3. それ以外は 1 件 1 束（見た目のために束ねない）
 *
 * finding_id を跨いで束ねることは無い。
 */
function keyOf(f: UiFindingView): { key: string; kind: UiCluster['kind'] } {
  if (f.cluster) {
    return { key: f.cluster, kind: f.cluster.startsWith('plugin:') ? 'unresolved_plugin_namespace' : 'cross_runtime_drift' };
  }
  switch (f.finding_id) {
    case 'SESSION_STALENESS':
      return { key: `stale:${f.subtype ?? '-'}:${runtimeOf(f)}`, kind: 'session_staleness' };
    case 'HOOK_AMPLIFICATION': {
      const cmd = typeof f.detail['command'] === 'string' ? f.detail['command'] : f.subject_display;
      return { key: `hook:${f.subtype ?? '-'}:${cmd}`, kind: 'hook_amplification' };
    }
    case 'UNREACHABLE_REFERENCE': {
      const ns = f.detail['plugin_namespace'];
      // llm-report が warn（ラベルかもしれない未知 namespace）を束ねないのに合わせ、namespace ごとに分ける
      if (typeof ns === 'string' && ns) return { key: `ns:${ns}`, kind: 'unknown_namespace' };
      return { key: `single:${f.id}`, kind: 'single' };
    }
    default:
      return { key: `single:${f.id}`, kind: 'single' };
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function nums(xs: unknown[]): number[] {
  return xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

function range(xs: number[], unit: string): string | null {
  if (!xs.length) return null;
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? `${lo} ${unit}` : `${lo}-${hi} ${unit}`;
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length <= 3 ? p : `.../${parts.slice(-2).join('/')}`;
}

function describeSingle(f: UiFindingView): { headline: string; facts: string[] } {
  const name = f.subject_display;
  switch (f.finding_id) {
    case 'UNREACHABLE_REFERENCE':
      return f.subtype === 'undiscovered_declaration'
        ? { headline: `${shortPath(name)} is within the search scope but is not in a shape the runtime reads`, facts: [] }
        : { headline: `A reference written in ${shortPath(name)} does not resolve anywhere`, facts: [] };
    case 'CROSS_RUNTIME_DRIFT':
      return { headline: `Another copy with the same name as ${shortPath(name)} has different content`, facts: [] };
    case 'SCOPE_MISMATCH':
      return { headline: `${shortPath(name)} takes effect in a wider range than the condition it declares`, facts: [] };
    case 'SESSION_STALENESS':
      return { headline: `Running session ${name.slice(0, 8)} still has the state it started with`, facts: [] };
    case 'HOOK_AMPLIFICATION':
      return { headline: `hook ${shortPath(name)} takes effect through more paths than intended`, facts: [] };
    default:
      return { headline: `${f.finding_id}: ${shortPath(name)}`, facts: [] };
  }
}

export interface ClusterContext {
  /** 同名で内容が一致している skill の組数（drift cluster に「一致している方」も併記するため） */
  same_name_identical?: number;
}

export function clusterFindings(
  findings: UiFindingView[],
  llmClusters: Array<{ id: string; title: string; question: string; members: string[] }> = [],
  ctx: ClusterContext = {},
): UiCluster[] {
  const questionById = new Map(llmClusters.map((c) => [c.id, c.question]));
  const groups = new Map<string, { kind: UiCluster['kind']; members: UiFindingView[] }>();
  for (const f of findings) {
    const { key, kind } = keyOf(f);
    const g = groups.get(key) ?? { kind, members: [] };
    g.members.push(f);
    groups.set(key, g);
  }

  const out: UiCluster[] = [];
  for (const [id, g] of groups) {
    const ms = g.members;
    const n = ms.length;
    const severity = ms.map((m) => m.severity).sort((a, b) => severityRank(a) - severityRank(b))[0] as UiCluster['severity'];
    const runtimes = uniq(
      ms.flatMap((m) =>
        m.finding_id === 'CROSS_RUNTIME_DRIFT'
          ? ((m.detail['sides'] as Array<{ runtime: string }> | undefined) ?? []).map((s) => s.runtime)
          : [runtimeOf(m)],
      ),
    ).filter((x) => x !== '?');
    let headline = '';
    let count_label = `${n} findings`;
    let facts: string[] = [];
    let grouped_by = '';

    switch (g.kind) {
      case 'unresolved_plugin_namespace': {
        const ns = id.slice('plugin:'.length);
        headline = `${n} reference(s) written under the name "${ns}" do not resolve anywhere`;
        count_label = `${n} refs`;
        grouped_by = `Observed fact: they all point to the same namespace ${ns}`;
        const referrers = uniq(ms.flatMap((m) => ((m.detail['referrers'] as string[] | undefined) ?? []).map((r) => r.split(':')[0]!)));
        if (referrers.length) {
          facts.push(`Referenced from ${referrers.length} file(s) (${referrers.slice(0, 2).map(shortPath).join(', ')}${referrers.length > 2 ? ' and more' : ''})`);
        }
        const st = ms.map((m) => m.detail['plugin_status_by_runtime'] as Record<string, string> | undefined).find(Boolean);
        if (st) facts.push(`Status of this namespace: ${Object.entries(st).map(([rt, v]) => `${runtimeLabel(rt)} = ${v}`).join(' / ')}`);
        break;
      }
      case 'cross_runtime_drift': {
        const [a, b] = id.slice('drift:'.length).split('|');
        headline = `${runtimeLabel(a ?? '?')} and ${runtimeLabel(b ?? '?')} see different copies with the same name, ${n} with different content`;
        count_label = `${n} skills`;
        grouped_by = 'Observed fact: same-name content differs within the same runtime pair';
        const lines = nums(ms.map((m) => m.detail['lines_differ']));
        const r = range(lines, 'lines');
        if (r) facts.push(`Difference: ${r}`);
        if (typeof ctx.same_name_identical === 'number') facts.push(`${ctx.same_name_identical} other same-name pair(s) have matching content`);
        break;
      }
      case 'session_staleness': {
        const rt = runtimeLabel(id.split(':')[2] ?? '?');
        count_label = `${n} sessions`;
        grouped_by = `Observed fact: the same kind of mismatch (${ms[0]?.subtype ?? '-'}) is happening in the same runtime`;
        if (ms[0]?.subtype === 'resource_changed_after_start') {
          headline = `${n} running ${rt} session(s) are still holding files that changed after they started`;
          const counts = nums(ms.map((m) => m.detail['changed_count']));
          const r = range(counts, 'files');
          if (r) facts.push(`always files changed since start: ${r}`);
          const sets = new Map<string, number>();
          for (const m of ms) {
            const changed = (m.detail['changed'] as Array<{ file: string }> | undefined) ?? [];
            const sig = changed.map((c) => c.file).sort().join(' ');
            sets.set(sig, (sets.get(sig) ?? 0) + 1);
          }
          if (sets.size > 1) {
            const top = [...sets.values()].sort((x, y) => y - x)[0]!;
            facts.push(`${sets.size} distinct combinations (${top} share the same file set)`);
          }
        } else if (ms[0]?.subtype === 'capability_present_but_unconfigured') {
          headline = `${n} running ${rt} session(s) still hold a capability that the current config no longer has`;
        } else {
          headline = `${n} running ${rt} session(s) differ from the current state on disk`;
        }
        break;
      }
      case 'hook_amplification': {
        const cmd = typeof ms[0]?.detail['command'] === 'string' ? (ms[0]!.detail['command'] as string) : '';
        const events = (ms[0]?.detail['events'] as string[] | undefined) ?? [];
        const regs = (ms[0]?.detail['registrations'] as unknown[] | undefined) ?? [];
        count_label = n === 1 ? '1 hook' : `${n} hooks`;
        grouped_by = 'Observed fact: the same command is registered';
        if (ms[0]?.subtype === 'same_registration_multiple_events') {
          headline = `The same hook is registered on ${events.length} event(s) and can enter through ${regs.length} path(s)`;
          if (events.length) facts.push(`event: ${events.join(', ')}`);
        } else if (ms[0]?.subtype === 'identical_payload_repeated') {
          headline = 'The same hook\'s output is repeated within a single session';
        } else if (ms[0]?.subtype === 'scope_includes_subagents') {
          headline = 'The hook is registered with a scope that also reaches subagents';
        } else {
          headline = 'The hook takes effect through more paths than intended';
        }
        const measured = ms[0]?.detail['measured'] as { firings?: number; total_bytes?: number } | undefined;
        if (measured) {
          facts.push(
            measured.total_bytes
              ? `Recorded: ${measured.total_bytes.toLocaleString()} B injected across ${measured.firings ?? 0} firing(s)`
              : `Recorded: 0 bytes injected (${measured.firings ?? 0} firing(s))`,
          );
        }
        if (cmd) facts.push(`command: ${shortPath(cmd)}`);
        break;
      }
      case 'unknown_namespace': {
        const ns = id.slice('ns:'.length);
        headline = `${n} reference(s) to the namespace "${ns}" do not resolve. This namespace is unknown to Doctor`;
        count_label = `${n} refs`;
        grouped_by = `Observed fact: they all point to the same namespace ${ns}`;
        facts.push('Stays at warn since this could be a label rather than a plugin name');
        break;
      }
      case 'single': {
        const d = describeSingle(ms[0]!);
        headline = d.headline;
        facts = d.facts;
        count_label = '1 finding';
        grouped_by = 'Not grouped (no observed fact ties this to the same cause as another finding)';
        break;
      }
    }

    out.push({
      id,
      kind: g.kind,
      headline,
      count_label,
      facts: facts.slice(0, 2),
      grouped_by,
      members: ms.map((m) => m.id),
      severity,
      runtimes,
      touches_protected: ms.some((m) => m.protected || m.touches_protected),
      question: questionById.get(id) ?? null,
    });
  }

  return out.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.members.length - a.members.length || a.id.localeCompare(b.id),
  );
}

/* ───────────────────────── 症状にしなかったこと ───────────────────────── */

const GUARD_JA: Record<string, { text: (c: number | null) => string; goto: UiNotProblem['goto'] }> = {
  size_is_not_a_symptom: { text: (c) => `${c} item(s) load every time. Size is stated as a fact and is not treated as a symptom`, goto: 'cost' },
  count_is_not_a_symptom: { text: (c) => `${c} registration(s) exist. A high count by itself is not treated as a symptom`, goto: 'cost' },
  deferred_cost_is_near_zero: { text: (c) => `${c} deferred item(s) load only their name at startup`, goto: 'cost' },
  unused_is_not_unnecessary: { text: (c) => `${c} skill(s) have no usage record. No record is not treated as a symptom`, goto: 'notfindings' },
  invisible_by_specification: { text: (c) => `${c} binding(s) are "invisible because they belong to another runtime's territory." Invisibility is not treated as a symptom`, goto: 'notfindings' },
  intentional_disable: { text: (c) => `${c} entr(y/ies) were intentionally disabled. Being disabled is not itself a symptom`, goto: 'notfindings' },
  sessions_excluded_by_design: { text: (c) => `${c} session record(s) were read. Mismatches in Doctor's own session and subagent sessions are not reported`, goto: 'coverage' },
};

export interface NotProblemsInput {
  cost: ContextCost;
  suppressed: Array<{ reason: string; detail: string; count: number | null }>;
  protectedCount: number;
  notEvaluated: Array<{ detector: string; reason: string }>;
  notCollected: string[];
}

export function notProblems(inp: NotProblemsInput): UiNotProblem[] {
  const out: UiNotProblem[] = [];
  // 大きさの立場は毎回出す（載るものが 0 でも「大きさだけでは症状にしない」は言い続ける）
  const always = inp.cost.by_load_mode['always'];
  const prot = inp.cost.protected_total.token_estimate;
  out.push({
    label: `Fixed startup cost is ${(always?.token_estimate ?? 0).toLocaleString()} token(s) (${prot.toLocaleString()} of which is protected). Size alone is not treated as a symptom`,
    detail: inp.cost.method_note,
    goto: 'cost',
  });
  for (const s of inp.suppressed) {
    const g = GUARD_JA[s.reason];
    out.push({ label: g ? g.text(s.count) : s.reason.replace(/_/g, ' '), detail: s.detail, goto: g?.goto ?? 'notfindings' });
  }
  if (inp.protectedCount) {
    out.push({
      label: `${inp.protectedCount} protected item(s). No suggestions are made about their size or existence (if a finding fires, its severity is never lowered)`,
      detail: 'These fall under memory / identity / instruction. The full list is shown in Not findings.',
      goto: 'notfindings',
    });
  }
  if (inp.notEvaluated.length) {
    out.push({
      label: `${inp.notEvaluated.length} check(s) were not evaluated due to missing input (this is not the same as passing)`,
      detail: inp.notEvaluated.map((x) => `${x.detector}: ${x.reason}`).join(' / '),
      goto: 'notfindings',
    });
  }
  if (inp.notCollected.length) {
    out.push({
      label: `${inp.notCollected.length} area(s) are not observed. No finding here does not mean there is no problem`,
      detail: inp.notCollected.join(' / '),
      goto: 'coverage',
    });
  }
  return out;
}

/* ───────────────────────── Structure の「つまり何？」 ───────────────────────── */

/**
 * 1 資源の要約（1〜2 行）。**Observation → Evidence → 症状を人間語に訳すだけ。**
 * 修正案・正本の決定・原因の推測は書かない。
 */
export function resourceHumanSummary(r: UiResourceView, runtimeOrder: string[]): string[] {
  const discovered = runtimeOrder.filter((rt) => (r.by_runtime[rt] ?? []).some((b) => b.discovered));
  const bound = runtimeOrder.filter((rt) => (r.by_runtime[rt] ?? []).length > 0);
  const lines: string[] = [];

  if (discovered.length >= 2) {
    lines.push(`${discovered.map(runtimeLabel).join(' and ')} both see this same file.`);
  } else if (discovered.length === 1) {
    const me = discovered[0]!;
    const others = r.siblings.filter((s) => s.runtime_discovered.some((rt) => rt !== me));
    const differ = others.find((s) => !s.content_matches);
    const same = others.find((s) => s.content_matches);
    if (differ) {
      const who = differ.runtime_discovered.filter((rt) => rt !== me).map(runtimeLabel).join(' / ');
      lines.push(
        `${runtimeLabel(me)} sees this file, while ${who} sees ${differ.path}. It's a different copy with the same name, and the content differs${differ.lines_differ != null ? ` by ${differ.lines_differ} line(s)` : ''}.`,
      );
    } else if (same) {
      const who = same.runtime_discovered.filter((rt) => rt !== me).map(runtimeLabel).join(' / ');
      lines.push(`${runtimeLabel(me)} sees this file, while ${who} sees the same-named ${same.path}. The content matches.`);
    } else {
      lines.push(`Only ${runtimeLabel(me)} sees this file.`);
    }
  } else if (bound.length) {
    lines.push(`This file is within the search scope of ${bound.map(runtimeLabel).join(' / ')}, but is not discovered.`);
  } else {
    lines.push('No runtime collects this file.');
  }

  const second: string[] = [];
  const always = r.cost.find((c) => c.load_mode === 'always');
  const onDemand = r.cost.find((c) => c.load_mode === 'on_demand');
  const deferred = r.cost.find((c) => c.load_mode === 'deferred');
  if (always) {
    second.push(`Loads every time at startup (${always.token_estimate ? `${always.token_estimate.toLocaleString()} token(s)` : `${always.bytes.toLocaleString()} B`}).`);
  } else if (onDemand) {
    second.push(`Only the description loads at startup (${onDemand.token_estimate.toLocaleString()} token(s)). The body loads when invoked.`);
  } else if (deferred) {
    second.push('Only the name loads at startup.');
  }
  if (r.finding_ids.length) second.push(`${r.finding_ids.length} finding(s) are attached.`);
  if (r.protected) second.push('protected (no suggestions are made about its size or existence).');
  if (second.length) lines.push(second.join(' '));

  return lines;
}
