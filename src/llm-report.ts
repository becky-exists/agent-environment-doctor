/**
 * `report --llm` — 修正役の LLM（Emma / Claude / Codex）へ渡すレポート
 *
 * 設計: docs/llm-report-format-v0.1.md。
 * Doctor が渡すのは「何が起きているか」「なぜそう判断したか」「どこまで確かか」まで。
 * 直し方は決め打ちしない。判断は受け手（と人）がする。
 *
 * 必ず入れるもの:
 *   report_scope / coverage / Finding type / severity / confidence / affected resources /
 *   evidence refs + 展開した要約 / protected か / unknown・unsupported の明示 / no-finding guards /
 *   Doctor 自身は何も変更していないこと
 */
import type { Coverage, EvidenceRef, Finding, Snapshot } from './ir/types.js';
import type { FindingsResult } from './findings/index.js';
import { TOOL_VERSION } from './adapters/claude-code/index.js';
import { summarize } from './summary.js';
import { isProtected } from './findings/context.js';

export const LLM_REPORT_FORMAT = 'agent-doctor-llm-report/1' as const;

export interface LlmReportOptions {
  /** HOME を ~ に置換する（既定 true） */
  redactHome?: boolean;
  /** 特定の Finding だけ（F-001 形式の id） */
  only?: string[];
  /** 本文の読み手。reference の前後 2 行を excerpt に入れる。無ければ excerpt は null */
  readText?: (path: string) => Promise<string | null>;
}

export interface LlmEvidence {
  type: EvidenceRef['type'];
  /** 受け手が読む 1 行要約。事実だけ */
  summary: string;
  /** 型ごとの展開。参照 id ではなく中身 */
  data: Record<string, unknown>;
}

export interface LlmFinding {
  id: string;
  finding_id: Finding['finding_id'];
  subtype: string | null;
  severity: Finding['severity'];
  confidence: Finding['confidence'];
  axes: Finding['axes'];
  scope: Finding['scope'];
  summary: string;
  subject: Finding['subject'];
  affected_resources: Array<{ path: string; kind: string | null; runtime: string; mechanism: string; discovered: boolean; load_mode: string; rule_id: string }>;
  evidence: LlmEvidence[];
  protected: boolean;
  /** subject または affected のうち protected glob に当たるパス。編集提案がここに触れるなら明示承認 */
  protected_paths: string[];
  /** protected の意味。severity は下げない。自動変更・削除の提案を止めるだけ */
  protected_handling: string | null;
  /** なぜこの severity / confidence か（等級の根拠。実害の測定ではない） */
  basis: { severity: string; confidence: string };
  /** 同じ根本原因でまとめた cluster の id */
  cluster: string | null;
  /** Doctor が判断していないこと。受け手が勝手に埋めないための柵 */
  doctor_did_not_conclude: string[];
  /** 人の判断が要る問い。選択肢は出さない（決め打ちしない） */
  human_decision_needed: string[];
  /** この Finding について Doctor が確定できていないこと */
  unknowns: string[];
  detail: Record<string, unknown>;
  applies_on: 'next_session';
}

export interface LlmReport {
  format: typeof LLM_REPORT_FORMAT;
  tool_version: string;
  generated_at: string;
  /** 証拠の帰属を固定する。再実行の結果と突合する時はこれを見る */
  snapshot_id: string;
  report_scope: {
    observed: 'next_session';
    meaning: string;
    probe_available: false;
  };
  doctor_actions: {
    files_written: string[];
    files_modified: string[];
    statement: string;
  };
  coverage: Coverage;
  environment: {
    runtimes: Array<{ runtime: string; version: string | null; config_home: string; present: boolean }>;
    project: string | null;
    launchers: string[];
    home_redacted: boolean;
  };
  handoff_contract: string[];
  summary: {
    findings: { error: number; warn: number; info: number };
    resources: number;
    bindings: number;
    observations: number;
    protected_count: number;
    suppressed_count: number;
    not_evaluated_count: number;
  };
  findings: LlmFinding[];
  /** 同じ根本原因の Finding をまとめる。人への問いは cluster 単位で 1 つ */
  clusters: Array<{ id: string; kind: string; title: string; members: string[]; shared_question: string; context: Record<string, unknown> }>;
  /** 数が大きいが Finding にしなかったもの。受け手が自分で問題にしないための宣言 */
  no_finding_guards: Array<{ reason: string; detail: string; count: number | null }>;
  protected: Array<{ path: string; real_path: string | null; size_bytes: number; glob: string; handling: string }>;
  /** 判定に必要な入力が無くて評価しなかった検出器。PASS ではない */
  not_evaluated: Array<{ detector: string; reason: string }>;
  /** 収集していない領域。ここに関する症状はこのレポートに無いだけで、無いとは言えない */
  unsupported: string[];
  /** active runtime を観測した時だけ埋まる。空 = 観測していない（そのぶん next_session の話しかしていない） */
  active_runtime: {
    observed: boolean;
    method: string;
    notes: string[];
    sessions: Array<{
      session_id: string;
      runtime: string;
      started_at: string | null;
      last_activity_at: string;
      live: boolean;
      live_is_heuristic: true;
      runtime_version: string | null;
      cwd: string | null;
      entrypoint: string | null;
      is_self: boolean;
      is_sidechain: boolean;
      observed_capability_kinds: string[];
      capability_counts: Record<string, number | null>;
      capabilities_from_startup: boolean;
      compared_by_capability: boolean;
      compared_by_timestamp: boolean;
      excluded_from_findings: string | null;
    }>;
    processes: Array<{ pid: number; runtime: string; started_at: string | null; flags: string[]; appended_system_prompt_bytes: number | null; argv_bytes: number }>;
  };
  resources_referenced: Record<string, { path: string; kind: string; name: string; size_bytes: number; mtime: string; normalized_hash_prefix: string }>;
}

const CONTRACT = [
  'You are receiving a diagnosis, not a work order. The Doctor observed, kept evidence, and named symptoms. It did not decide how to fix anything.',
  'For each finding, decide for yourself whether a change is warranted. If you propose one, present it as a reviewable change (diff, command, or step list). Do not execute anything.',
  'Where human_decision_needed is non-empty, ask the human before proposing.',
  'Do not propose changes for anything in no_finding_guards[] or for the size/usage of anything in protected[]. Those are not findings.',
  'A finding on a protected resource keeps its severity. Protected only means: do not propose removing, trimming, or rewriting the resource wholesale; a targeted fix of the reported fact may still be appropriate, subject to human review.',
  'Do not describe resources as unnecessary, bloat, waste, or cleanup candidates. The Doctor did not conclude that.',
  'Config changes apply on the next launched session. Say so in every proposal. Running sessions, including the one you may be in, keep their startup state.',
  'unsupported[] lists what the Doctor did not look at. Absence of a finding there is not evidence of health.',
];

export async function buildLlmReport(snapshot: Snapshot, result: FindingsResult, opts: LlmReportOptions = {}): Promise<LlmReport> {
  const redact = opts.redactHome !== false;
  const home = snapshot.env.home;
  const R = (p: string) => (redact && p.startsWith(home) ? '~' + p.slice(home.length) : p);

  const referenced: LlmReport['resources_referenced'] = {};
  const byIdPath = new Map(snapshot.resources.map((r) => [`${r.resource_id}|${r.path}`, r]));
  const touch = (resource_id: string, path: string) => {
    const r = byIdPath.get(`${resource_id}|${path}`);
    if (!r) return;
    referenced[`${r.resource_id}@${R(r.path)}`] = { path: R(r.path), kind: r.kind, name: r.name, size_bytes: r.size_bytes, mtime: r.mtime, normalized_hash_prefix: r.normalized_hash.slice(0, 19) };
  };

  const findings: LlmFinding[] = [];
  const all = result.findings;
  for (let i = 0; i < all.length; i++) {
    const f = all[i]!;
    const id = `F-${String(i + 1).padStart(3, '0')}`;
    if (opts.only && !opts.only.includes(id)) continue;

    const evidence: LlmEvidence[] = [];
    for (const e of f.evidence_refs) evidence.push(await expandEvidence(e, snapshot, R, opts.readText));
    for (const e of f.evidence_refs) {
      if ('resource_id' in e && 'path' in e) touch(e.resource_id, e.path);
      if (e.type === 'binding') touch(e.resource_id, e.resource_path);
      if (e.type === 'observation') touch(e.resource_id, e.resource_path);
    }
    if (f.subject.resource_id && f.subject.path) touch(f.subject.resource_id, f.subject.path);

    const affected = affectedResources(f, snapshot, R);
    const protectedPaths = [...new Set([f.subject.path, ...f.evidence_refs.map((e) => ('path' in e ? e.path : e.type === 'binding' ? e.resource_path : null))])]
      .filter((p): p is string => !!p && isProtected(p, result.protected_globs))
      .map(R);

    findings.push({
      id,
      finding_id: f.finding_id,
      subtype: f.subtype ?? null,
      severity: f.severity,
      confidence: f.confidence,
      axes: f.axes,
      scope: f.scope,
      summary: redact ? f.summary.split(home).join('~') : f.summary,
      subject: { ...f.subject, ...(f.subject.path ? { path: R(f.subject.path) } : {}) },
      affected_resources: affected,
      evidence,
      protected: f.protected,
      protected_paths: protectedPaths,
      protected_handling:
        f.protected || protectedPaths.length
          ? `Protected resource(s) involved: ${protectedPaths.join(', ')}. Severity and confidence are unchanged. Do not propose removing, trimming, or rewriting them wholesale; a targeted change of the reported fact inside them needs explicit human approval.`
          : null,
      basis: basisFor(f, snapshot),
      cluster: clusterKey(f),
      doctor_did_not_conclude: didNotConclude(f),
      human_decision_needed: humanDecision(f),
      unknowns: unknownsFor(f, snapshot),
      detail: redactDetail(f.detail ?? {}, home, redact),
      applies_on: 'next_session',
    });
  }

  const sev = { error: 0, warn: 0, info: 0 };
  for (const f of all) sev[f.severity]++;

  // cluster: 同じ根本原因をまとめ、人への問いを 1 つに
  const sum = summarize(snapshot);
  const clusters: LlmReport['clusters'] = [];
  const byCluster = new Map<string, LlmFinding[]>();
  for (const lf of findings) if (lf.cluster) (byCluster.get(lf.cluster) ?? byCluster.set(lf.cluster, []).get(lf.cluster)!).push(lf);
  for (const [id, members] of byCluster) {
    if (id.startsWith('plugin:')) {
      const ns = id.slice('plugin:'.length);
      clusters.push({
        id,
        kind: 'missing_target_same_plugin',
        title: `${members.length} reference(s) into plugin namespace \`${ns}\``,
        members: members.map((m) => m.id),
        shared_question: `Is the \`${ns}\` plugin meant to be available, and in which runtime(s)?`,
        context: { plugin_status_by_runtime: members[0]?.detail['plugin_status_by_runtime'] ?? null, references: members.map((m) => m.detail['reference']) },
      });
    } else if (id.startsWith('drift:')) {
      // パターン観測（結論なし、事実のみ）: 受け手がサブグループ分けを自力でやらなくて済むように
      const sidesAll = members.map((m) => (m.detail['sides'] as Array<{ runtime: string; mtime: string; real_path: string | null }>) ?? []);
      const byRt = new Map<string, string[]>();
      for (const ss of sidesAll) for (const x of ss) (byRt.get(x.runtime) ?? byRt.set(x.runtime, []).get(x.runtime)!).push(x.mtime.slice(0, 16));
      const mtimeClusters = Object.fromEntries([...byRt].map(([rt, ms]) => {
        const counts = new Map<string, number>();
        for (const m of ms) counts.set(m, (counts.get(m) ?? 0) + 1);
        const top = [...counts].sort((a, b) => b[1] - a[1])[0];
        return [rt, top ? `${top[1]} of ${ms.length} copies share mtime minute ${top[0]}` : 'n/a'];
      }));
      const substitutionHints = members.filter((m) => {
        const dx = m.detail['diff_excerpt'] as { lines: string[] } | null;
        return dx?.lines.some((l) => /CLAUDE\.md|\bClaude\b/.test(l) && l.startsWith('-')) && dx?.lines.some((l) => /AGENTS\.md|\bCodex\b/.test(l) && l.startsWith('+'));
      }).length;
      clusters.push({
        id,
        kind: 'cross_runtime_drift_same_pair',
        title: `${members.length} same-name skill(s) differ between ${id.slice('drift:'.length).replace('|', ' and ')}`,
        members: members.map((m) => m.id),
        shared_question: 'Are the two skill directories meant to hold the same content, or to diverge per runtime? If the same, what should the shared content be (either side, a merge, or a generation rule with runtime-specific substitutions)?',
        context: {
          pattern_observations: {
            mtime_clusters: mtimeClusters,
            diffs_containing_claude_to_codex_substitution: `${substitutionHints} of ${members.length} (lines with CLAUDE.md/Claude on '-' and AGENTS.md/Codex on '+'; a hint of a mirror with word substitution, not a conclusion)`,
            lines_differ_distribution: members.map((m) => m.detail['lines_differ']),
            diff_direction: "'-' = only on the first-listed runtime's copy, '+' = only on the second's",
          },
          same_name_pairs_total: sum.same_name_skills.pairs,
          identical_pairs: sum.same_name_skills.identical,
          drifted_pairs: sum.same_name_skills.drifted,
          normalization: 'CRLF→LF, trailing whitespace stripped, trailing blank lines stripped, frontmatter INCLUDED. Differences reported are after this normalization.',
          sides: members.map((m) => ({ id: m.id, name: m.subject.name, sides: m.detail['sides'], lines_differ: m.detail['lines_differ'] })),
        },
      });
    }
  }

  return {
    format: LLM_REPORT_FORMAT,
    tool_version: TOOL_VERSION,
    generated_at: new Date().toISOString(),
    snapshot_id: snapshot.snapshot_id,
    report_scope: {
      observed: 'next_session',
      meaning:
        'State that the NEXT launched session will see, derived statically from files. Sessions already running keep the state they started with. Any change you propose takes effect on next launch and will not alter a running session, including the one you may be running in.',
      probe_available: false,
    },
    doctor_actions: {
      files_written: [],
      files_modified: [],
      statement: 'The Doctor read files and wrote nothing into the examined environment. No fix was applied. Nothing in this report has been acted on.',
    },
    coverage: snapshot.coverage,
    environment: {
      runtimes: snapshot.runtimes.map((r) => ({ runtime: r.runtime, version: r.version, config_home: R(r.config_home), present: r.present })),
      project: snapshot.env.project,
      launchers: snapshot.env.launchers.map(R),
      home_redacted: redact,
    },
    handoff_contract: CONTRACT,
    summary: {
      findings: sev,
      resources: snapshot.resources.length,
      bindings: snapshot.bindings.length,
      observations: snapshot.observations.length,
      protected_count: result.protected.length,
      suppressed_count: result.suppressed.length,
      not_evaluated_count: result.skipped.length,
    },
    findings,
    clusters,
    no_finding_guards: result.suppressed.map((x) => ({ reason: x.reason, detail: redact ? x.detail.split(home).join('~') : x.detail, count: x.count ?? null })),
    protected: result.protected.map((p) => {
      const r = snapshot.resources.find((x) => x.path === p.path);
      return { path: R(p.path), real_path: r?.real_path ? R(r.real_path) : null, size_bytes: p.size_bytes, glob: p.glob, handling: 'No proposal about its size or existence. Findings that cite it keep their severity.' };
    }),
    not_evaluated: result.skipped.map((x) => ({ detector: x.detector, reason: redact ? x.reason.split(home).join('~') : x.reason })),
    unsupported: snapshot.coverage.not_collected,
    active_runtime: {
      observed: snapshot.sessions.length > 0 || snapshot.processes.length > 0,
      method: 'records already on disk (session transcripts / rollouts, `ps` argv). No session was started; no tokens were spent; nothing was written.',
      notes: snapshot.probe_notes,
      sessions: snapshot.sessions.map((x) => ({
        session_id: x.session_id,
        runtime: x.runtime,
        started_at: x.started_at,
        last_activity_at: x.last_activity_at,
        live: x.live,
        live_is_heuristic: true as const,
        runtime_version: x.runtime_version,
        cwd: x.cwd,
        entrypoint: x.entrypoint,
        is_self: x.is_self,
        is_sidechain: x.is_sidechain,
        observed_capability_kinds: x.observed_capability_kinds,
        capability_counts: Object.fromEntries(Object.entries(x.capabilities).map(([k, v]) => [k, v === null ? null : v.length])),
        capabilities_from_startup: x.capabilities_from_startup,
        compared_by_capability: x.comparable_capabilities,
        compared_by_timestamp: x.comparable_timestamps,
        excluded_from_findings: x.not_comparable_reason,
      })),
      processes: snapshot.processes.map((x) => ({ pid: x.pid, runtime: x.runtime, started_at: x.started_at, flags: x.flags, appended_system_prompt_bytes: x.appended_system_prompt?.bytes ?? null, argv_bytes: x.argv_bytes })),
    },
    resources_referenced: referenced,
  };
}

function affectedResources(f: Finding, s: Snapshot, R: (p: string) => string): LlmFinding['affected_resources'] {
  const paths = new Set<string>();
  if (f.subject.path) paths.add(f.subject.path);
  for (const e of f.evidence_refs) {
    if (e.type === 'reference' || e.type === 'resource') paths.add(e.path);
    if (e.type === 'binding') paths.add(e.resource_path);
  }
  const out: LlmFinding['affected_resources'] = [];
  for (const p of paths) {
    const r = s.resources.find((x) => x.path === p);
    for (const b of s.bindings.filter((x) => x.resource_path === p)) {
      out.push({ path: R(p), kind: r?.kind ?? null, runtime: b.runtime, mechanism: b.mechanism, discovered: b.discovered, load_mode: b.load_mode, rule_id: b.rule_id });
    }
  }
  return out;
}

async function expandEvidence(e: EvidenceRef, s: Snapshot, R: (p: string) => string, readText?: LlmReportOptions['readText']): Promise<LlmEvidence> {
  switch (e.type) {
    case 'resource': {
      const r = s.resources.find((x) => x.resource_id === e.resource_id && x.path === e.path);
      return {
        type: 'resource',
        summary: `${R(e.path)}${e.line ? `:${e.line}` : ''} exists (${r?.kind ?? '?'}, ${r?.size_bytes ?? '?'} B, mtime ${r?.mtime ?? '?'})`,
        data: { path: R(e.path), line: e.line ?? null, kind: r?.kind ?? null, name: r?.name ?? null, size_bytes: r?.size_bytes ?? null, mtime: r?.mtime ?? null, normalized_hash_prefix: r?.normalized_hash.slice(0, 19) ?? null, excerpt: e.line && readText ? await excerpt(e.path, e.line, readText) : null },
      };
    }
    case 'reference': {
      return {
        type: 'reference',
        summary: `${R(e.path)}:${e.line} contains \`${e.raw}\` (extracted as a reference; not resolved by the collector)`,
        data: { path: R(e.path), line: e.line, raw: e.raw, excerpt: readText ? await excerpt(e.path, e.line, readText) : null },
      };
    }
    case 'binding': {
      const b = s.bindings.find((x) => x.binding_id === e.binding_id);
      const src = b?.source_ref;
      const srcText = !src ? null : src.type === 'discovery' ? `discovery of ${R(src.search_path)}` : src.type === 'resource' ? `${R(src.resource_path)}${src.locator ?? ''}` : `${R(src.ref)}${src.locator ? '#' + src.locator : ''}`;
      return {
        type: 'binding',
        summary: `${e.runtime}: ${R(e.resource_path)} via ${e.mechanism} → discovered=${b?.discovered ?? '?'}, load_mode=${b?.load_mode ?? '?'} (rule ${e.rule_id}, ${b?.rule_source ?? '?'}, confidence ${b?.confidence ?? '?'})`,
        data: { runtime: e.runtime, path: R(e.resource_path), mechanism: e.mechanism, source: srcText, discovered: b?.discovered ?? null, load_mode: b?.load_mode ?? null, scope_condition: b?.scope_condition ?? null, applies_to: b?.applies_to ?? null, rule_id: e.rule_id, rule_source: b?.rule_source ?? null, rule_confidence: b?.confidence ?? null, runtime_version: b?.runtime_version ?? null },
      };
    }
    case 'observation': {
      const o = s.observations.find((x) => x.resource_id === e.resource_id && x.resource_path === e.resource_path && x.kind === e.kind && x.method === e.method && x.scope === e.scope && x.measured_at === e.measured_at);
      return {
        type: 'observation',
        summary: `${R(e.resource_path)}: ${e.kind} = ${String(o?.value ?? '?')}${o?.unit ? ' ' + o.unit : ''} (method ${e.method}, scope ${e.scope}, measured ${e.measured_at})`,
        data: { path: R(e.resource_path), runtime: e.runtime, kind: e.kind, value: o?.value ?? null, unit: o?.unit ?? null, method: e.method, scope: e.scope, measured_at: e.measured_at, confidence: o?.confidence ?? null, source_ref: o?.source_ref ? R(o.source_ref) : null },
      };
    }
    case 'absence':
      return {
        type: 'absence',
        summary: `Looked for "${e.target}" in ${e.searched.length} places and found nothing`,
        data: { target: e.target, searched: e.searched.map(R) },
      };
    case 'contrast':
      return {
        type: 'contrast',
        summary: `Contrast (a case that is fine): ${R(e.path)} — ${e.note}`,
        data: { path: R(e.path), note: e.note },
      };
    case 'session': {
      const sess = s.sessions.find((x) => x.session_id === e.session_id);
      return {
        type: 'session',
        summary:
          `Session ${e.session_id} (${e.runtime}, started ${e.started_at ?? 'unknown'}, ${e.live ? 'recently active' : 'not recently active'}): ${e.note}. ` +
          `Read from the session record at ${R(e.record_path)} (structural fields only; no message content was read).`,
        data: {
          session_id: e.session_id,
          runtime: e.runtime,
          record_path: R(e.record_path),
          started_at: e.started_at,
          last_activity_at: sess?.last_activity_at ?? null,
          live: e.live,
          live_is_heuristic: true,
          runtime_version: sess?.runtime_version ?? null,
          observed_capability_kinds: sess?.observed_capability_kinds ?? [],
          is_self: sess?.is_self ?? null,
          is_sidechain: sess?.is_sidechain ?? null,
          note: e.note,
        },
      };
    }
    case 'process': {
      const proc = s.processes.find((x) => x.pid === e.pid);
      return {
        type: 'process',
        summary: `Process ${e.pid} (${e.runtime}, started ${e.started_at ?? 'unknown'}): ${e.note}. Read from \`ps\` argv; the injected text itself is not stored.`,
        data: {
          pid: e.pid,
          runtime: e.runtime,
          started_at: e.started_at,
          flags: proc?.flags ?? [],
          appended_system_prompt: proc?.appended_system_prompt ?? null,
          argv_bytes: proc?.argv_bytes ?? null,
          note: e.note,
          attribution: 'This process is not tied to a session id; the pid is the evidence.',
        },
      };
    }
  }
}

async function excerpt(path: string, line: number, readText: NonNullable<LlmReportOptions['readText']>): Promise<{ from: number; to: number; lines: string[] } | null> {
  const t = await readText(path);
  if (t === null) return null;
  const ls = t.split(/\r\n?|\n/);
  const from = Math.max(1, line - 2);
  const to = Math.min(ls.length, line + 2);
  // 意図的に単純化: 1 行は 200 字で切る（表の行など長い行で受け手の token を食わないため）。上限 = 200 字、必要なら --full-excerpt を足す
  const clip = (l: string) => (l.length > 200 ? l.slice(0, 200) + ' …[truncated]' : l);
  return { from, to, lines: ls.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)} | ${clip(l)}`) };
}

function didNotConclude(f: Finding): string[] {
  switch (f.finding_id) {
    case 'UNREACHABLE_REFERENCE':
      return f.subtype === 'missing_target'
        ? ['whether the reference should be dropped, or the target installed / enabled', 'whether other copies of the same reference (other runtime) should change together', 'whether the string is a reference at all, when the namespace is unknown']
        : ['whether the file should be moved into <dir>/SKILL.md form, or is intentionally parked'];
    case 'CROSS_RUNTIME_DRIFT':
      return ['which side is canonical', 'whether the two copies are meant to diverge', 'whether either copy should be edited'];
    case 'SCOPE_MISMATCH':
      return ['what the paths: glob should be', 'whether the rule should move out of rules/ instead of being scoped', 'whether the launch condition in the text is still accurate'];
    case 'SESSION_STALENESS':
      return [
        'whether the running session should be restarted, left alone, or finished first',
        'whether the configuration change was meant to apply to sessions already running',
        'which state is the intended one (the configuration or what the session holds)',
      ];
    default:
      return [];
  }
}

function humanDecision(f: Finding): string[] {
  switch (f.finding_id) {
    case 'UNREACHABLE_REFERENCE':
      return f.subtype === 'missing_target'
        ? [`Is \`${String(f.detail?.['reference'] ?? '')}\` meant to be a live skill/agent reference, and if so, in which runtime?`]
        : ['Is this file meant to be a live skill?'];
    case 'CROSS_RUNTIME_DRIFT':
      return [`Are the two copies of "${String(f.subject.name)}" meant to be the same? If so, what should the shared content be (either side, a merge, or a generated variant)?`];
    case 'SESSION_STALENESS':
      return [`Session ${String(f.subject.session_id ?? '?')} is running with a state that differs from the configuration. Does that session need to see the change now?`];
    case 'SCOPE_MISMATCH':
      return ['Which sessions should this rule apply to?'];
    default:
      return [];
  }
}

function clusterKey(f: Finding): string | null {
  // ns 未知でも severity=error（agent 定義の中）なら参照として束ねる。warn（ラベルかもしれない）は束ねない
  if (f.finding_id === 'UNREACHABLE_REFERENCE' && f.subtype === 'missing_target' && !(f.detail?.['status'] === 'namespace_unknown' && f.severity === 'warn')) return `plugin:${String(f.detail?.['plugin_namespace'])}`;
  if (f.finding_id === 'CROSS_RUNTIME_DRIFT') {
    const sides = (f.detail?.['sides'] as Array<{ runtime: string }> | undefined) ?? [];
    return `drift:${sides.map((x) => x.runtime).sort().join('|')}`;
  }
  return null;
}

/** 等級の根拠。実害の測定ではないことを毎回書く */
function basisFor(f: Finding, s: Snapshot): { severity: string; confidence: string } {
  const bindingConf = f.evidence_refs
    .filter((e) => e.type === 'binding')
    .map((e) => s.bindings.find((b) => b.binding_id === (e as { binding_id: string }).binding_id)?.confidence)
    .filter(Boolean);
  const weakest = bindingConf.includes('probe_required') ? 'probe_required' : bindingConf.includes('low') ? 'low' : bindingConf.includes('medium') ? 'medium' : bindingConf.length ? 'high' : 'n/a';
  switch (f.finding_id) {
    case 'UNREACHABLE_REFERENCE':
      return f.subtype === 'missing_target'
        ? {
            severity: `${f.severity}: a \`ns:name\` string in a place where such strings conventionally name skills/agents resolves to nothing. error when the namespace is a known plugin or the referrer is an agent definition; warn when the namespace is unknown (may be a label). Severity does not measure runtime impact; whether anything invokes this reference was not observed.`,
            confidence: `${f.confidence}: the string and its absence are static facts. Supporting binding rules have weakest confidence ${weakest}.`,
          }
        : {
            severity: `${f.severity}: a declaration sits inside a runtime search path in a shape the runtime does not read. Severity does not measure how often it would have been used.`,
            confidence: `${f.confidence}: shape rule is documented; weakest supporting rule confidence ${weakest}.`,
          };
    case 'CROSS_RUNTIME_DRIFT':
      return {
        severity: `${f.severity}: two runtimes discover different content under the same skill name. It is not known whether the divergence is intended, so this is never error.`,
        confidence: `${f.confidence}: content hashes after normalization are static facts; weakest supporting rule confidence ${weakest}.`,
      };
    case 'SCOPE_MISMATCH':
      return {
        severity: `${f.severity}: warn when a sibling rule already uses paths: (the mechanism exists and is unused); info when only the text heuristic matched.`,
        confidence: `${f.confidence}: the load_mode is documented; the launch-condition detection is a vocabulary heuristic.`,
      };
    case 'SESSION_STALENESS':
      return {
        severity: `${f.severity}: the configured state and a running session's state differ. Never error, because a running session holding its startup state is how the runtime works, not a defect in itself. info when the collected facts already explain the difference (a file created after the session started).`,
        confidence: `${f.confidence}: ${f.subtype === 'capability_present_but_unconfigured' ? 'the session record lists the capability by name and the current configuration does not; both are direct facts' : f.subtype === 'resource_changed_after_start' ? 'only timestamps were compared — the session record does not store instruction text for this runtime, so the content the session holds was not read' : f.subtype === 'injection_digest_divergence' ? '`ps` can alter whitespace in argv, so a digest mismatch is evidence rather than proof' : 'derived from the session record'}. Weakest supporting rule confidence ${weakest}.`,
      };
    default:
      return { severity: f.severity, confidence: f.confidence };
  }
}

function unknownsFor(f: Finding, s: Snapshot): string[] {
  const out: string[] = [];
  if (f.confidence === 'medium' || f.confidence === 'low') out.push(`confidence is ${f.confidence}: the Doctor could not confirm this statically`);
  if (f.confidence === 'probe_required') out.push('needs a probe of a running session to confirm');
  if (f.detail?.['status'] === 'namespace_unknown') out.push('the namespace is not a known plugin; the string may be a label, not a reference');
  if (f.finding_id === 'CROSS_RUNTIME_DRIFT') {
    if (f.detail?.['lines_differ'] === null) out.push('lines_differ / diff not computed (no file reader)');
    out.push('whether the two copies are meant to differ per runtime cannot be determined statically; only the content difference is observed');
    out.push('no owner / canonical-source record exists in the collected data');
  }
  if (f.finding_id === 'SESSION_STALENESS') {
    out.push('session records are not tied to a process id, so "running" is inferred from how recently the record file was written');
    if (f.subtype === 'resource_changed_after_start') out.push('the content the session actually holds was not read (not recorded for this runtime); only mtime vs session start was compared');
    if (f.subtype === 'injection_digest_divergence') out.push('which session (if any) this process belongs to is not established');
  }
  if (f.finding_id === 'UNREACHABLE_REFERENCE' && f.subtype === 'missing_target') {
    const st = f.detail?.['status'];
    if (st === 'plugin_disabled') out.push('why the plugin is disabled is not recorded; whether enabling it would provide this exact skill was not inspected (plugin contents are outside coverage)');
    if (st === 'plugin_absent') out.push('the plugin may exist under another name or marketplace; only the collected plugin manifests were checked');
    out.push('whether anything actually tries to use this reference at runtime is not observed (static analysis only)');
  }
  const lowRules = f.evidence_refs.filter((e) => e.type === 'binding').map((e) => s.bindings.find((b) => b.binding_id === (e as { binding_id: string }).binding_id)).filter((b) => b && (b.confidence === 'low' || b.confidence === 'probe_required'));
  for (const b of lowRules) out.push(`binding rule ${b!.rule_id} has confidence ${b!.confidence} (${b!.rule_source})`);
  return out;
}

function redactDetail(d: Record<string, unknown>, home: string, redact: boolean): Record<string, unknown> {
  if (!redact) return d;
  return JSON.parse(JSON.stringify(d).split(home).join('~')) as Record<string, unknown>;
}

// ─────────────────────────── Markdown ───────────────────────────

export function formatLlmReportMarkdown(r: LlmReport): string {
  const L: string[] = [];
  L.push(`# agent-doctor report (LLM handoff) — ${r.format}`);
  L.push('');
  L.push(`**Scope:** NEXT SESSION. ${r.report_scope.meaning}`);
  L.push('');
  L.push(`**Doctor actions:** ${r.doctor_actions.statement}`);
  L.push('');
  L.push(`**Snapshot:** ${r.snapshot_id} (tool ${r.tool_version})`);
  L.push('');
  L.push('## Contract');
  for (const c of r.handoff_contract) L.push(`- ${c}`);
  L.push('');
  L.push('## Environment');
  for (const rt of r.environment.runtimes) L.push(`- ${rt.runtime} ${rt.version ?? '(version unknown)'} — ${rt.config_home}${rt.present ? '' : ' (not present)'}`);
  if (r.environment.project) L.push(`- project: ${r.environment.project}`);
  if (r.environment.launchers.length) L.push(`- launchers given: ${r.environment.launchers.join(', ')}`);
  L.push(`- resources ${r.summary.resources} / bindings ${r.summary.bindings} / observations ${r.summary.observations}`);
  L.push('');
  L.push('## Coverage (what was looked at)');
  for (const c of r.coverage.collected) L.push(`- ${c}`);
  L.push('');
  L.push('## Unsupported (not looked at — no finding here means nothing)');
  for (const c of r.unsupported) L.push(`- ${c}`);
  L.push('');
  L.push('## Active runtime');
  if (!r.active_runtime.observed) {
    L.push('- Not observed. This report describes only the next session; a session already running may still hold an older state.');
  } else {
    L.push(`- Method: ${r.active_runtime.method}`);
    for (const n of r.active_runtime.notes) L.push(`- ${n}`);
    L.push('');
    L.push('| session | runtime | entrypoint | started | live | capabilities observed | compared (capability / timestamp) |');
    L.push('|---|---|---|---|---|---|---|');
    for (const x of r.active_runtime.sessions) {
      const caps = Object.entries(x.capability_counts).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join(' ') || 'none recorded';
      const cm = `${x.compared_by_capability ? 'yes' : 'no'} / ${x.compared_by_timestamp ? 'yes' : 'no'}${x.excluded_from_findings ? ` — ${x.excluded_from_findings}` : ''}`;
      L.push(`| ${x.session_id.slice(0, 8)} | ${x.runtime} | ${x.entrypoint ?? '?'} | ${x.started_at ?? '?'} | ${x.live ? 'yes' : 'no'} | ${caps} | ${cm} |`);
    }
    if (r.active_runtime.processes.length) {
      L.push('');
      L.push('| pid | runtime | started | injected system prompt |');
      L.push('|---|---|---|---|');
      for (const p of r.active_runtime.processes) L.push(`| ${p.pid} | ${p.runtime} | ${p.started_at ?? '?'} | ${p.appended_system_prompt_bytes === null ? '—' : `${p.appended_system_prompt_bytes} B`} |`);
    }
  }
  L.push('');
  if (r.clusters.length) {
    L.push('## Clusters (same root cause — one question each)');
    for (const c of r.clusters) {
      L.push(`- **${c.id}** — ${c.title}: ${c.members.join(', ')}`);
      L.push(`  - question: ${c.shared_question}`);
      if (c.kind === 'cross_runtime_drift_same_pair') {
        const ctx = c.context as { same_name_pairs_total: number; identical_pairs: number; drifted_pairs: number; normalization: string };
        L.push(`  - same-name pairs: ${ctx.same_name_pairs_total} total, ${ctx.identical_pairs} identical, ${ctx.drifted_pairs} differ`);
        L.push(`  - normalization: ${ctx.normalization}`);
        const po = (c.context as { pattern_observations?: { mtime_clusters: Record<string, string>; diffs_containing_claude_to_codex_substitution: string; lines_differ_distribution: unknown[]; diff_direction: string } }).pattern_observations;
        if (po) {
          L.push(`  - pattern (facts, no conclusion): mtime — ${Object.entries(po.mtime_clusters).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
          L.push(`  - pattern: word-substitution hint — ${po.diffs_containing_claude_to_codex_substitution}`);
          L.push(`  - pattern: lines_differ distribution — ${po.lines_differ_distribution.join(' / ')}`);
          L.push(`  - diff direction: ${po.diff_direction}`);
        }
      }
      if (c.kind === 'missing_target_same_plugin') L.push(`  - plugin status by runtime: ${JSON.stringify((c.context as { plugin_status_by_runtime: unknown }).plugin_status_by_runtime)}`);
    }
    L.push('');
  }
  L.push(`## Findings (${r.summary.findings.error} error / ${r.summary.findings.warn} warn / ${r.summary.findings.info} info)`);
  L.push('');
  if (!r.findings.length) L.push('_No findings._');
  for (const f of r.findings) {
    L.push(`### ${f.id}  ${f.severity.toUpperCase()}  ${f.finding_id}${f.subtype ? ' / ' + f.subtype : ''}  (confidence: ${f.confidence}${f.protected_paths.length ? ', touches protected' : ''}${f.cluster ? `, cluster ${f.cluster}` : ''})`);
    L.push('');
    L.push(f.summary);
    L.push('');
    L.push(`Severity basis: ${f.basis.severity}`);
    L.push(`Confidence basis: ${f.basis.confidence}`);
    L.push('');
    L.push('Affected:');
    for (const a of f.affected_resources) L.push(`- ${a.runtime} ${a.path} [${a.mechanism}] discovered=${a.discovered} load_mode=${a.load_mode} (${a.rule_id})`);
    L.push('');
    L.push('Evidence:');
    for (const e of f.evidence) {
      L.push(`- (${e.type}) ${e.summary}`);
      if (e.type === 'absence') for (const sp of e.data['searched'] as string[]) L.push(`  - searched: ${sp}`);
      const ex = e.data['excerpt'] as { lines: string[] } | null | undefined;
      if (ex?.lines) {
        L.push('  ```');
        for (const l of ex.lines) L.push(`  ${l}`);
        L.push('  ```');
      }
    }
    const dx = f.detail['diff_excerpt'] as { lines: string[]; added: number; removed: number; truncated: boolean } | null | undefined;
    if (dx) {
      L.push('');
      L.push(`Diff (normalized, +${dx.added} / -${dx.removed}${dx.truncated ? ', truncated' : ''}):`);
      L.push('```diff');
      for (const l of dx.lines) L.push(l);
      L.push('```');
    }
    const inv = f.detail['invocations'] as Record<string, { value: unknown; method: string; confidence: string } | null> | undefined;
    // null = その runtime の使用記録は coverage 外（Codex の thread_history は未収集）。「使われていない」ではなく「測っていない」
    if (inv) L.push(`\nRecorded invocations: ${Object.entries(inv).map(([k, v]) => `${k}=${v ? `${String(v.value)} (${v.method}, ${v.confidence})` : 'not collected (no usage source in coverage for this runtime)'}`).join(', ')} — absence of recorded use is not a finding.`);
    const pst = f.detail['plugin_status_by_runtime'] as Record<string, string> | undefined;
    if (pst) L.push(`\nPlugin status by runtime: ${Object.entries(pst).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (typeof f.detail['referrer_context'] === 'string') L.push(`\nReferrer context: ${f.detail['referrer_context']}`);
    if (f.protected_handling) L.push(`\nProtected: ${f.protected_handling}`);
    if (f.unknowns.length) {
      L.push('');
      L.push('Unknown / unconfirmed:');
      for (const u of f.unknowns) L.push(`- ${u}`);
    }
    L.push('');
    L.push('Doctor did not conclude:');
    for (const d of f.doctor_did_not_conclude) L.push(`- ${d}`);
    if (f.human_decision_needed.length) {
      L.push('');
      L.push('Human decision needed:');
      for (const q of f.human_decision_needed) L.push(`- ${q}`);
    }
    L.push('');
    L.push(`Applies on: next session`);
    L.push('');
  }
  L.push('## No-finding guards (do not propose changes for these)');
  for (const g of r.no_finding_guards) L.push(`- ${g.detail}`);
  L.push('');
  L.push(`## Protected resources (${r.protected.length}) — no proposal about size or existence; findings that touch them keep their severity`);
  const byGlob = new Map<string, typeof r.protected>();
  for (const p of r.protected) (byGlob.get(p.glob) ?? byGlob.set(p.glob, []).get(p.glob)!).push(p);
  for (const [g, ps] of byGlob) {
    L.push(`- \`${g}\` (${ps.length}):`);
    for (const p of ps) L.push(`  - ${p.path} (${p.size_bytes.toLocaleString()} B)${p.real_path ? ` → symlink to ${p.real_path}` : ''}`);
  }
  if (r.not_evaluated.length) {
    L.push('');
    L.push('## Not evaluated (input missing — not a pass)');
    for (const x of r.not_evaluated) L.push(`- ${x.detector}: ${x.reason}`);
  }
  L.push('');
  return L.join('\n');
}
