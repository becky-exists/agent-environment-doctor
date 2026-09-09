/**
 * UI に渡すデータ — 構造が見えることを優先する
 *
 * ブラウザは**人間向けの顕微鏡**。`report --llm` は Emma / Claude / Codex 向けの診断書。役割を分ける。
 *
 * ここで作るのは「1 つの資源を選んだら、両 runtime からどう見えているかが並ぶ」ための形。
 * 数字を並べるためのデータではない。**Health Score のような総合点は作らない**（雑な点数は思想を壊す）。
 */
import type { Binding, Finding, Resource, Snapshot } from '../ir/types.js';
import type { FindingsResult } from '../findings/index.js';
import type { ContextCost } from '../observe/context-cost.js';
import type { EnvironmentEvent, HistoryResult } from '../history/events.js';
import { diffLineCount } from '../ir/normalize.js';
import { summarize } from '../summary.js';
import { clusterFindings, notProblems, resourceHumanSummary, runtimeLabel, type UiOverview } from './summary.js';

export interface UiBindingView {
  binding_id: string;
  runtime: string;
  mechanism: string;
  discovered: boolean;
  load_mode: string;
  rule_id: string;
  rule_source: string;
  confidence: string;
  scope_condition: string[] | null;
  applies_to: string[];
  search_path: string | null;
  precedence: number | null;
  /** どこから結合されたか（人が読める 1 行） */
  source: string;
  source_type: string;
}

export interface UiSibling {
  path: string;
  runtime_discovered: string[];
  normalized_hash: string;
  content_matches: boolean;
  size_bytes: number;
  mtime: string;
  /** 内容が違う時の差分行数（本文が読めた時だけ） */
  lines_differ: number | null;
}

export interface UiResourceView {
  resource_id: string;
  path: string;
  display_path: string;
  real_path: string | null;
  kind: string;
  name: string;
  owner: string;
  size_bytes: number;
  mtime: string;
  normalized_hash: string;
  description: string | null;
  /** runtime ごとの見え方。これが「Claude からどう見えて Codex からどう見えるか」 */
  by_runtime: Record<string, UiBindingView[]>;
  /** 同名の他資源。内容が一致しているか */
  siblings: UiSibling[];
  /** この資源を主題にした、または証拠に含む Finding の id */
  finding_ids: string[];
  /** 起動時にどれだけ載るか（context cost の該当分） */
  cost: Array<{ runtime: string; load_mode: string; measured_part: string; bytes: number; token_estimate: number; method: string }>;
  /** 参照（解決前の生文字列） */
  references: Array<{ raw: string; line: number; syntax: string; confidence: string }>;
  /** この資源に起きた出来事 */
  events: Array<{ observed_at: string; kind: string; summary: string }>;
  protected: boolean;
  /** 「つまり何？」— 事実の人間語訳（1〜2 行）。修正案は書かない */
  human_summary: string[];
}

export interface UiFindingView {
  id: string;
  finding_id: string;
  subtype: string | null;
  severity: string;
  confidence: string;
  scope: string;
  summary: string;
  subject_path: string | null;
  subject_display: string;
  cluster: string | null;
  protected: boolean;
  touches_protected: boolean;
  protected_note: string | null;
  axes: string[];
  evidence: Array<{ type: string; text: string; extra?: string[] }>;
  unknowns: string[];
  did_not_conclude: string[];
  human_decision: string[];
  detail: Record<string, unknown>;
}

export interface UiData {
  /** 人間向け要約層。Expert 画面を置き換えるものではなく、入口 */
  overview: UiOverview;
  generated_at: string;
  tool_version: string;
  snapshot_id: string;
  schema_version: number;
  /** レポート種別の宣言。UI の一番上に出す */
  scope: { observed: string[]; note: string };
  env: { os: string; project: string | null; home: string; launchers: string[] };
  runtimes: Array<{ runtime: string; version: string | null; config_home: string; present: boolean; resources: number; discovered: number }>;
  coverage: { phase: string; collected: string[]; not_collected: string[] };
  /** 内部の数。Overview の主役にしない */
  counts: { resources: number; bindings: number; observations: number };
  sessions: Array<{
    session_id: string;
    runtime: string;
    entrypoint: string | null;
    started_at: string | null;
    last_activity_at: string;
    live: boolean;
    is_self: boolean;
    is_sidechain: boolean;
    compared_capabilities: boolean;
    compared_timestamps: boolean;
    not_compared_reason: string | null;
    capability_counts: Record<string, number | null>;
    stale_files: number;
  }>;
  processes: Array<{ pid: number; runtime: string; started_at: string | null; injected_bytes: number | null; flags: string[] }>;
  probe_notes: string[];
  /** 見に行った結果。**0 件と「読めなかった」を分ける** */
  access: { records: Snapshot['access']; could_not_observe: NonNullable<Snapshot['access']>; note: string };
  resources: UiResourceView[];
  findings: UiFindingView[];
  clusters: Array<{ id: string; title: string; question: string; members: string[] }>;
  cost: ContextCost;
  hooks: Array<{ path: string; display_path: string; event: string; command: string | null; applies_to: string[]; runtime: string; measured_firings: number; measured_bytes: number }>;
  history: { events: EnvironmentEvent[]; trend: HistoryResult['trend']; notes: string[]; gaps: Array<{ from: string; to: string; hours: number }>; snapshots: number };
  not_findings: {
    suppressed: Array<{ reason: string; detail: string; count: number | null }>;
    protected: Array<{ path: string; display_path: string; size_bytes: number; glob: string; real_path: string | null }>;
    not_evaluated: Array<{ detector: string; reason: string }>;
    unsupported: string[];
  };
}

function tilde(p: string, home: string): string {
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function describeSource(b: Binding, home: string): { text: string; type: string } {
  const s = b.source_ref;
  if (s.type === 'discovery') return { text: `discovered by scanning ${tilde(s.search_path, home)}`, type: 'discovery' };
  if (s.type === 'resource') return { text: `declared in ${tilde(s.resource_path, home)}${s.locator ?? ''}`, type: 'resource' };
  return { text: `declared in ${tilde(s.ref, home)}${s.locator ? '#' + s.locator : ''}`, type: 'external' };
}

export interface BuildUiInput {
  snapshot: Snapshot;
  result: FindingsResult;
  history: HistoryResult | null;
  /** 差分行数を出すために本文を読む（read only） */
  readText?: (p: string) => Promise<string | null>;
  llmFindings?: Array<{ id: string; finding_id: string; subtype: string | null; cluster: string | null; unknowns: string[]; doctor_did_not_conclude: string[]; human_decision_needed: string[]; protected_handling: string | null }>;
  clusters?: Array<{ id: string; title: string; shared_question: string; members: string[] }>;
}

export async function buildUiData(inp: BuildUiInput): Promise<UiData> {
  const { snapshot: s, result, history } = inp;
  const home = s.env.home;
  const T = (p: string) => tilde(p, home);

  // Finding を先に id 付けする（llm-report と同じ順序・同じ id）
  const llmById = new Map((inp.llmFindings ?? []).map((f, i) => [i, f]));
  const findingIdOf = new Map<Finding, string>();
  result.findings.forEach((f, i) => findingIdOf.set(f, llmById.get(i)?.id ?? `F-${String(i + 1).padStart(3, '0')}`));

  // 資源 → 関わる Finding
  const findingsByPath = new Map<string, Set<string>>();
  const add = (path: string | undefined, id: string) => {
    if (!path) return;
    (findingsByPath.get(path) ?? findingsByPath.set(path, new Set()).get(path)!).add(id);
  };
  for (const f of result.findings) {
    const id = findingIdOf.get(f)!;
    add(f.subject.path, id);
    for (const e of f.evidence_refs) {
      if (e.type === 'resource' || e.type === 'reference' || e.type === 'contrast') add(e.path, id);
      if (e.type === 'binding') add(e.resource_path, id);
      if (e.type === 'observation') add(e.resource_path, id);
    }
  }

  // 資源 → 出来事
  const eventsByPath = new Map<string, Array<{ observed_at: string; kind: string; summary: string }>>();
  for (const e of history?.events ?? []) {
    const paths = (e.detail['paths'] as string[] | undefined) ?? (e.subject.path ? [e.subject.path] : []);
    for (const p of paths) {
      (eventsByPath.get(p) ?? eventsByPath.set(p, []).get(p)!).push({ observed_at: e.observed_at, kind: e.kind, summary: e.summary });
    }
  }

  const costByPath = new Map<string, UiResourceView['cost']>();
  for (const c of result.context_cost.items) {
    (costByPath.get(c.path) ?? costByPath.set(c.path, []).get(c.path)!).push({
      runtime: c.runtime,
      load_mode: c.load_mode,
      measured_part: c.measured_part,
      bytes: c.bytes,
      token_estimate: c.token_estimate,
      method: c.method,
    });
  }

  const protectedPaths = new Set(result.protected.map((p) => p.path));
  const byName = new Map<string, Resource[]>();
  for (const r of s.resources) (byName.get(`${r.kind}|${r.name}`) ?? byName.set(`${r.kind}|${r.name}`, []).get(`${r.kind}|${r.name}`)!).push(r);

  const runtimeOrder = s.runtimes.map((x) => x.runtime);
  const resources: UiResourceView[] = [];
  for (const r of s.resources) {
    const bs = s.bindings.filter((b) => b.resource_id === r.resource_id && b.resource_path === r.path);
    const by_runtime: Record<string, UiBindingView[]> = {};
    for (const b of bs) {
      const src = describeSource(b, home);
      (by_runtime[b.runtime] ??= []).push({
        binding_id: b.binding_id,
        runtime: b.runtime,
        mechanism: b.mechanism,
        discovered: b.discovered,
        load_mode: b.load_mode,
        rule_id: b.rule_id,
        rule_source: b.rule_source,
        confidence: b.confidence,
        scope_condition: b.scope_condition,
        applies_to: b.applies_to,
        search_path: b.search_path ? T(b.search_path) : null,
        precedence: b.precedence,
        source: src.text,
        source_type: src.type,
      });
    }

    const siblings: UiSibling[] = [];
    for (const o of byName.get(`${r.kind}|${r.name}`) ?? []) {
      if (o.path === r.path) continue;
      const oBs = s.bindings.filter((b) => b.resource_id === o.resource_id && b.resource_path === o.path && b.discovered);
      let lines: number | null = null;
      if (o.normalized_hash !== r.normalized_hash && inp.readText) {
        const [ta, tb] = await Promise.all([inp.readText(r.path), inp.readText(o.path)]);
        if (ta !== null && tb !== null) lines = diffLineCount(ta, tb);
      }
      siblings.push({
        path: T(o.path),
        runtime_discovered: [...new Set(oBs.map((b) => b.runtime))],
        normalized_hash: o.normalized_hash,
        content_matches: o.normalized_hash === r.normalized_hash,
        size_bytes: o.size_bytes,
        mtime: o.mtime,
        lines_differ: lines,
      });
    }

    const view: UiResourceView = {
      resource_id: r.resource_id,
      path: r.path,
      display_path: T(r.path),
      real_path: r.real_path ? T(r.real_path) : null,
      kind: r.kind,
      name: r.name,
      owner: r.owner,
      size_bytes: r.size_bytes,
      mtime: r.mtime,
      normalized_hash: r.normalized_hash,
      description: r.declared.description ?? null,
      by_runtime,
      siblings,
      finding_ids: [...(findingsByPath.get(r.path) ?? [])],
      cost: costByPath.get(r.path) ?? [],
      references: r.references.map((x) => ({ raw: x.raw, line: x.line, syntax: x.syntax, confidence: x.confidence })),
      events: eventsByPath.get(r.path) ?? [],
      protected: protectedPaths.has(r.path),
      human_summary: [],
    };
    view.human_summary = resourceHumanSummary(view, runtimeOrder);
    resources.push(view);
  }

  // Finding の表示形
  const findings: UiFindingView[] = result.findings.map((f, i) => {
    const meta = llmById.get(i);
    const ev: UiFindingView['evidence'] = f.evidence_refs.map((e) => {
      switch (e.type) {
        case 'resource':
          return { type: 'resource', text: `${T(e.path)}${e.line ? `:${e.line}` : ''} exists` };
        case 'reference':
          return { type: 'reference', text: `${T(e.path)}:${e.line} contains \`${e.raw}\`` };
        case 'binding': {
          const b = s.bindings.find((x) => x.binding_id === e.binding_id);
          return { type: 'binding', text: `${e.runtime}: ${T(e.resource_path)} via ${e.mechanism} → discovered=${b?.discovered ?? '?'}, load_mode=${b?.load_mode ?? '?'} (${e.rule_id})` };
        }
        case 'observation': {
          const o = s.observations.find((x) => x.resource_path === e.resource_path && x.kind === e.kind && x.method === e.method);
          return { type: 'observation', text: `${T(e.resource_path)}: ${e.kind} = ${String(o?.value ?? '?')} (${e.method}, ${e.scope})` };
        }
        case 'absence':
          return { type: 'absence', text: `looked for "${e.target}" and found nothing`, extra: e.searched.map(T) };
        case 'contrast':
          return { type: 'contrast', text: `${T(e.path)} — ${e.note}` };
        case 'session':
          return { type: 'session', text: `session ${e.session_id.slice(0, 8)} (${e.runtime}, started ${e.started_at ?? '?'}) — ${e.note}` };
        case 'process':
          return { type: 'process', text: `pid ${e.pid} (${e.runtime}, started ${e.started_at ?? '?'}) — ${e.note}` };
      }
    });
    return {
      id: findingIdOf.get(f)!,
      finding_id: f.finding_id,
      subtype: f.subtype ?? null,
      severity: f.severity,
      confidence: f.confidence,
      scope: f.scope,
      summary: f.summary.split(home).join('~'),
      subject_path: f.subject.path ? T(f.subject.path) : null,
      subject_display: f.subject.path ? T(f.subject.path) : (f.subject.name ?? '?'),
      cluster: meta?.cluster ?? null,
      protected: f.protected,
      /** subject 以外（証拠に含まれる資源）が protected の場合。pill は出さず本文で伝える */
      touches_protected: (meta?.protected_handling ?? null) !== null && !f.protected,
      protected_note: meta?.protected_handling ?? null,
      axes: f.axes,
      evidence: ev,
      unknowns: meta?.unknowns ?? [],
      did_not_conclude: meta?.doctor_did_not_conclude ?? [],
      human_decision: meta?.human_decision_needed ?? [],
      detail: JSON.parse(JSON.stringify(f.detail ?? {}).split(home).join('~')) as Record<string, unknown>,
    };
  });

  // hook の一覧（登録 × 実測）
  const hooks: UiData['hooks'] = [];
  for (const r of s.resources) {
    if (r.kind !== 'hook_script') continue;
    const raw = (r.declared.raw ?? {}) as Record<string, unknown>;
    const bs = s.bindings.filter((b) => b.resource_path === r.path);
    hooks.push({
      path: r.path,
      display_path: T(r.path),
      event: typeof raw['event'] === 'string' ? raw['event'] : '?',
      command: typeof raw['command'] === 'string' ? raw['command'] : null,
      applies_to: [...new Set(bs.flatMap((b) => b.applies_to))],
      runtime: bs[0]?.runtime ?? '?',
      measured_firings: 0,
      measured_bytes: 0,
    });
  }

  // セッションごとの stale ファイル数（Finding の detail から取る。再計算しない）
  const staleBySession = new Map<string, number>();
  for (const f of result.findings) {
    if (f.finding_id !== 'SESSION_STALENESS' || f.subtype !== 'resource_changed_after_start') continue;
    const id = f.subject.session_id;
    if (id) staleBySession.set(id, Number(f.detail?.['changed_count'] ?? 0));
  }

  // ── 人間向け要約層 ───────────────────────────────────────────
  // ここで診断はしない。既に出ている Finding を、観測された共有条件だけで束ねて人間語に訳す。
  const sameName = summarize(s).same_name_skills;
  const clusters = clusterFindings(findings, inp.clusters?.map((c) => ({ id: c.id, title: c.title, question: c.shared_question, members: c.members })) ?? [], {
    same_name_identical: sameName.identical,
  });
  const discoveredRuntimes = (v: UiResourceView) => runtimeOrder.filter((rt) => (v.by_runtime[rt] ?? []).some((b) => b.discovered));
  const samePathBoth = resources.filter((v) => discoveredRuntimes(v).length >= 2).length;
  const onlyCounts = runtimeOrder.map((rt) => ({
    runtime: rt,
    label: runtimeLabel(rt),
    count: resources.filter((v) => {
      const d = discoveredRuntimes(v);
      return d.length === 1 && d[0] === rt;
    }).length,
  }));

  const recentNotes: string[] = [];
  const snapshotsUsable = history?.series.usable.length ?? 0;
  const gapCount = history?.series.gaps.length ?? 0;
  if (snapshotsUsable < 2) {
    recentNotes.push(`Only ${snapshotsUsable} comparable snapshot(s), so no events can be derived yet (this does not mean "nothing changed").`);
  } else if ((history?.events.length ?? 0) === 0) {
    recentNotes.push('Over the observed interval, 0 events were derived.');
  }
  if (gapCount) recentNotes.push(`${gapCount} unobserved gap(s). Whatever happened there is not shown here.`);
  recentNotes.push('An event\'s date means "happened between these two observations" - not the exact moment it happened.');

  const overview: UiOverview = {
    attention_count: clusters.length,
    finding_count: findings.length,
    headline: `${clusters.length} area${clusters.length === 1 ? '' : 's'} need attention`,
    headline_note:
      findings.length === 0
        ? 'This scan produced no findings. That does not mean there is no problem in the range that was not looked at.'
        : `${findings.length} finding(s) bundled into ${clusters.length} cluster(s), grouped only where an observed cause is shared. This is a count of causes, not of findings.`,
    clusters,
    not_problems: notProblems({
      cost: result.context_cost,
      suppressed: result.suppressed.map((x) => ({ reason: x.reason, detail: x.detail.split(home).join('~'), count: x.count ?? null })),
      protectedCount: result.protected.length,
      notEvaluated: result.skipped.map((x) => ({ detector: x.detector, reason: x.reason.split(home).join('~') })),
      notCollected: s.coverage.not_collected,
    }),
    comparison: {
      runtimes: s.runtimes.map((r) => ({
        runtime: r.runtime,
        label: runtimeLabel(r.runtime),
        version: r.version,
        present: r.present,
        // 結合の本数（同じファイルが 2 経路で入ることがあるので資源数とは別）
        discovered: s.bindings.filter((b) => b.runtime === r.runtime && b.discovered).length,
        resources_discovered: resources.filter((v) => discoveredRuntimes(v).includes(r.runtime)).length,
      })),
      same_name_skills: sameName,
      same_path_both: samePathBoth,
      only: onlyCounts,
      note: 'Doctor does not decide which one is correct or which is the source of truth. This just lays out the differences observed.',
    },
    recent: {
      snapshots: snapshotsUsable,
      gaps: gapCount,
      events: (history?.events ?? []).slice(-6).reverse().map((e) => ({
        observed_at: e.observed_at,
        since: e.since,
        kind: e.kind,
        summary: e.summary.split(home).join('~'),
        direction: e.direction,
      })),
      total_events: history?.events.length ?? 0,
      note: recentNotes,
    },
    internals: {
      resources: s.resources.length,
      bindings: s.bindings.length,
      observations: s.observations.length,
      sessions: s.sessions.length,
      processes: s.processes.length,
    },
    observing: {
      short: s.sessions.length ? 'Next session + active runtime' : 'Next session only',
      full: `${s.sessions.length ? ['next_session (static)', 'active_runtime (session records on disk)'].join(' + ') : 'next_session (static)'} — ${
        s.sessions.length
          ? 'Sessions already running keep the state they started with. Active-runtime facts come from records already on disk; no session was started and no tokens were spent.'
          : 'This describes the state the next launched session will see. A session already running may hold an older state - run with --probe to compare.'
      }`,
    },
  };

  const perRuntime = new Map<string, { resources: number; discovered: number }>();
  for (const b of s.bindings) {
    const e = perRuntime.get(b.runtime) ?? { resources: 0, discovered: 0 };
    e.resources++;
    if (b.discovered) e.discovered++;
    perRuntime.set(b.runtime, e);
  }

  return {
    overview,
    generated_at: new Date().toISOString(),
    tool_version: s.tool_version,
    snapshot_id: s.snapshot_id,
    schema_version: s.schema_version as unknown as number,
    scope: {
      observed: s.sessions.length ? ['next_session (static)', 'active_runtime (session records on disk)'] : ['next_session (static)'],
      note: s.sessions.length
        ? 'Sessions already running keep the state they started with. Active-runtime facts come from records already on disk; no session was started and no tokens were spent.'
        : 'This describes the state the next launched session will see. A session already running may hold an older state — run with --probe to compare.',
    },
    env: { os: s.env.os, project: s.env.project, home: s.env.home, launchers: s.env.launchers.map(T) },
    runtimes: s.runtimes.map((r) => ({
      runtime: r.runtime,
      version: r.version,
      config_home: T(r.config_home),
      present: r.present,
      resources: perRuntime.get(r.runtime)?.resources ?? 0,
      discovered: perRuntime.get(r.runtime)?.discovered ?? 0,
    })),
    coverage: { phase: s.coverage.phase, collected: s.coverage.collected, not_collected: s.coverage.not_collected },
    counts: { resources: s.resources.length, bindings: s.bindings.length, observations: s.observations.length },
    sessions: s.sessions.map((x) => ({
      session_id: x.session_id,
      runtime: x.runtime,
      entrypoint: x.entrypoint,
      started_at: x.started_at,
      last_activity_at: x.last_activity_at,
      live: x.live,
      is_self: x.is_self,
      is_sidechain: x.is_sidechain,
      compared_capabilities: x.comparable_capabilities,
      compared_timestamps: x.comparable_timestamps,
      not_compared_reason: x.not_comparable_reason,
      capability_counts: Object.fromEntries(Object.entries(x.capabilities).map(([k, v]) => [k, v === null ? null : v.length])),
      stale_files: staleBySession.get(x.session_id) ?? 0,
    })),
    processes: s.processes.map((p) => ({ pid: p.pid, runtime: p.runtime, started_at: p.started_at, injected_bytes: p.appended_system_prompt?.bytes ?? null, flags: p.flags })),
    probe_notes: s.probe_notes,
    access: {
      records: (s.access ?? []).map((a) => ({ ...a, target: T(a.target) })),
      could_not_observe: (s.access ?? []).filter((a) => a.status === 'permission_denied' || a.status === 'failed' || a.status === 'unsupported').map((a) => ({ ...a, target: T(a.target) })),
      note: 'A count is only filled in when observed. permission_denied / failed / unsupported / unobserved mean "unknown" - not zero and not absent.',
    },
    resources,
    findings,
    clusters: (inp.clusters ?? []).map((c) => ({ id: c.id, title: c.title, question: c.shared_question, members: c.members })),
    cost: {
      ...result.context_cost,
      items: result.context_cost.items.map((i) => ({ ...i, path: T(i.path) })),
      largest: result.context_cost.largest.map((i) => ({ ...i, path: T(i.path) })),
    },
    hooks,
    history: {
      events: (history?.events ?? []).map((e) => ({ ...e, summary: e.summary.split(home).join('~') })),
      trend: history?.trend ?? [],
      notes: history?.notes ?? [],
      gaps: history?.series.gaps ?? [],
      snapshots: history?.series.usable.length ?? 0,
    },
    not_findings: {
      suppressed: result.suppressed.map((x) => ({ reason: x.reason, detail: x.detail.split(home).join('~'), count: x.count ?? null })),
      protected: result.protected.map((p) => {
        const r = s.resources.find((x) => x.path === p.path);
        return { path: p.path, display_path: T(p.path), size_bytes: p.size_bytes, glob: p.glob, real_path: r?.real_path ? T(r.real_path) : null };
      }),
      not_evaluated: result.skipped.map((x) => ({ detector: x.detector, reason: x.reason.split(home).join('~') })),
      unsupported: s.coverage.not_collected,
    },
  };
}
