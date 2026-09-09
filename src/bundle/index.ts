/**
 * Portable Diagnostic Bundle v0.1 — 他人の環境を、安全に持ち出せる 1 ファイルにする
 *
 * 使い方の形:
 *   本人「最近 Claude Code が調子悪い」
 *     → その人の機械で `agent-doctor bundle --out bundle.json --symptom "..."`
 *     → できた 1 ファイルを渡してもらう
 *     → Becky / Emma / 任意の LLM が読んで hypothesis を立てる
 *
 * 守ること:
 *   - **ローカルで redact してから完成する。** 送信は一切しない（この module はネットワークを触らない）
 *   - **本文を持ち出さない。** transcript / memory / CLAUDE.md / AGENTS.md / source の中身は入れない。
 *     比較に要るものは hash・byte 数・行数・diff 量・kind・mechanism・timestamp で持つ
 *   - **「取れなかった」を 0 件にしない。** observation_status に読み取り結果をそのまま入れる
 *   - **Doctor は治療しない。** 入るのは Observation → Evidence → Symptom まで。
 *     hypothesis / 優先順位 / 修正案は受け取った側（人と LLM）が決める
 */
import { platform, release, arch, version as osVersion } from 'node:os';
import { createHash } from 'node:crypto';

import type { AccessRecord, AccessStatus, Snapshot } from '../ir/types.js';
import type { FindingsResult } from '../findings/index.js';
import type { LlmReport } from '../llm-report.js';
import type { HistoryResult } from '../history/events.js';
import type { UiCluster } from '../ui/summary.js';
import { memorySlugOf } from '../ir/slug.js';
import { extractReferences } from '../adapters/claude-code/references.js';
import { Redactor, scanForLeaks, type Leak, type RedactionLevel, type RedactionSummary } from './redact.js';

export const BUNDLE_FORMAT = 'agent-doctor-diagnostic-bundle/0.1';

export interface BundleResource {
  /** bundle 内だけで通じる id。参照整合性のためにこれで指す */
  ref: string;
  name: string;
  kind: string;
  owner: string;
  path: string;
  real_path: string | null;
  size_bytes: number;
  line_count: number | null;
  mtime: string;
  /** 内容の同一性。**本文は入れない**。先頭 16 桁だけ持つ */
  content_fingerprint: string;
  /** frontmatter の**キー名だけ**。値は入れない */
  frontmatter_keys: string[];
  has_description: boolean;
  description_bytes: number;
  reference_count: number;
  protected: boolean;
  by_runtime: Record<string, { discovered: boolean; load_mode: string; mechanism: string; rule_id: string; confidence: string }[]>;
}

export interface DiagnosticBundle {
  format: string;
  generated_at: string;
  snapshot_id: string;
  schema_version: number;
  tool_version: string;

  /** 生成した人が書いた主訴。任意。書かれた文字列も redact を通る */
  reported_symptom: string | null;

  doctor_actions: {
    files_written_to_examined_environment: string[];
    network_calls: string[];
    statement: string;
  };

  environment: {
    os: string;
    os_release: string;
    arch: string;
    node: string;
    runtimes: Array<{ runtime: string; version: string | null; present: boolean; config_home: string }>;
    launchers: number;
    project_present: boolean;
  };

  coverage: { phase: string; collected: string[]; not_collected: string[] };

  /** **0 件と「読めなかった」を分ける**ための記録 */
  observation_status: {
    note: string;
    summary: Record<AccessStatus, number>;
    records: AccessRecord[];
    /** 読めなかったもの。0 の隣に必ず出す */
    could_not_observe: AccessRecord[];
  };

  /** 同じ原因で束ねた症状（人間語の見出しつき） */
  clusters: UiCluster[];

  /** `report --llm` 相当。Finding / Evidence / confidence / unknown / Doctor が判断していないこと */
  llm_report: LlmReport;

  /** Expert Evidence へ辿るための構造（本文なし） */
  structure: {
    resources: BundleResource[];
    counts: { resources: number; bindings: number; observations: number };
    same_name_groups: Array<{ name: string; kind: string; refs: string[]; contents_identical: boolean }>;
  };

  /** 起動時に何がどれだけ載るか。**大きい = 悪 にしない** */
  context_cost: {
    method_note: string;
    by_load_mode: Record<string, { items: number; bytes: number; token_estimate: number }>;
    by_runtime: Record<string, unknown>;
    protected_total: { items: number; bytes: number; token_estimate: number };
    unprotected_total: { items: number; bytes: number; token_estimate: number };
    not_measured: string[];
    note: string;
  };

  /** 動いているセッションとプロセス（--probe を付けた時だけ。本文は digest のみ） */
  active_runtime: {
    observed: boolean;
    sessions: Array<{ ref: string; runtime: string; entrypoint: string | null; started_at: string | null; last_activity_at: string; live: boolean; is_self: boolean; is_sidechain: boolean; capability_counts: Record<string, number | null>; compared_capabilities: boolean; compared_timestamps: boolean; not_compared_reason: string | null }>;
    processes: Array<{ ref: string; runtime: string; started_at: string | null; injected_bytes: number | null; flag_names: string[] }>;
    notes: string[];
  };

  history: {
    snapshots_compared: number;
    gaps: Array<{ from: string; to: string; hours: number }>;
    events: Array<{ observed_at: string; since: string; kind: string; summary: string; direction: string }>;
    notes: string[];
  };

  redaction: RedactionSummary & { self_check: { leaks_found: number; leaks: Leak[]; passed: boolean } };

  /**
   * Host / Runtime Signals v0.1（#69）。--probe を付けた時だけ埋まる。**新しい Finding は作らない
   * ——ここは Observation のまま**。数値だけから病名を作らないので、優先順位・判断はここでは付けない。
   */
  host_signals: {
    observed: boolean;
    mcp_status: Array<{
      mcp_server: string;
      status: string;
      observed_at: string;
      connection_attempts: number | null;
      failures: number;
      last_error_kind: string | null;
      latency_ms: number | null;
      latency_method: string | null;
      session_refs: string[];
      runtime: string;
      method: string;
      note: string;
    }>;
    rate_limit_events: Array<{
      provider: string;
      kind: string;
      status_code: number | null;
      count: number;
      first_observed_at: string;
      last_observed_at: string;
      session_refs: string[];
      runtime: string;
      retry_after_ms: null;
    }>;
    process_session_map: {
      entries: Array<{
        pid: number;
        process_ref: string | null;
        runtime: string;
        session_ref: string | null;
        started_at: string | null;
        argv_fingerprint: string | null;
        cwd: string | null;
        status: string;
        confidence: string | null;
        candidate_session_refs: string[];
        evidence: string;
      }>;
      live_sessions_without_process_refs: string[];
      note: string;
    };
    host: {
      observed_at: string;
      platform: string;
      load: { load1: number | null; load5: number | null; load15: number | null; status: string; method: string | null; reason: string | null };
      memory: { total_bytes: number | null; used_bytes: number | null; available_bytes: number | null; status: string; method: string | null; reason: string | null };
      swap: { total_bytes: number | null; used_bytes: number | null; status: string; method: string | null; reason: string | null };
      processes: Array<{ process_ref: string | null; runtime: string; cpu_percent: number | null; rss_bytes: number | null; status: string; method: string | null }>;
    } | null;
    note: string;
  };

  /** 受け取った側への契約。Doctor が何をしていないかを毎回書く */
  handoff_contract: string[];
}

export interface BuildBundleInput {
  snapshot: Snapshot;
  result: FindingsResult;
  llm: LlmReport;
  clusters: UiCluster[];
  history: HistoryResult | null;
  symptom?: string | null;
  level?: RedactionLevel;
  /** 行数を数えるために本文を読む（read only。**中身は bundle に入らない**） */
  readText?: (p: string) => Promise<string | null>;
}

const HANDOFF_CONTRACT = [
  'This bundle is a diagnosis, not a work order. It stops at Observation → Evidence → Symptom.',
  'The Doctor did not change anything in the examined environment, and did not send anything anywhere. This file was written locally and handed over by a person.',
  'Nothing here is a conclusion about a root cause. Findings that share an observed condition are grouped, and the grounds for each grouping are stated; anything that could not be grouped on observed facts is left on its own.',
  'A count is only present when something was actually observed. Where a read failed, the status says so instead of a number. Treat "could not observe" as unknown, never as zero and never as absent.',
  'Coverage lists what was not collected at all. The absence of a finding in those areas is not evidence that nothing is wrong there.',
  'Size is reported as a fact. Large is not a defect, unused is not unnecessary, invisible is not broken. Do not turn a number into a problem on your own.',
  'Findings on protected resources keep their severity. Protection means no proposal about their size or existence, not a lower grade.',
  'File contents are not in this bundle. If a hypothesis needs the text of a file, ask the person who generated it — do not assume the content from the name.',
  'What is expected from the reader: primary hypothesis, secondary hypotheses, what is ruled out, what evidence is missing, what to verify next, and remediation options. The human decides.',
];

export async function buildBundle(inp: BuildBundleInput): Promise<DiagnosticBundle> {
  const s = inp.snapshot;
  const level = inp.level ?? 'strict';
  const slugs = [...new Set(s.resources.map((r) => memorySlugOf(r.path)).filter((x): x is string => x !== null))];
  const R = new Redactor({ home: s.env.home, project: s.env.project, projectSlugs: slugs, level });

  // 資源の識別セグメント（skill のディレクトリ名など）を先に登録する。
  // 登録しないと structure の名前だけ匿名化され、パスの中に生の名前が残る
  const refOf = new Map<string, string>();
  const resources: BundleResource[] = [];
  let n = 0;
  for (const r of s.resources) {
    const ref = `R-${String(++n).padStart(3, '0')}`;
    refOf.set(`${r.resource_id}|${r.path}`, ref);
    const identity = identitySegment(r.path);
    if (identity) R.registerIdentity(r.kind, identity);
    R.registerIdentity(r.kind, r.name);
  }

  // 行数は本文を読んで数えるが、**本文は保持しない**
  const lineCounts = new Map<string, number | null>();
  if (inp.readText) {
    for (const r of s.resources) {
      if (lineCounts.has(r.path)) continue;
      const t = await inp.readText(r.path);
      lineCounts.set(r.path, t === null ? null : t.split('\n').length);
    }
  }

  n = 0;
  for (const r of s.resources) {
    const ref = refOf.get(`${r.resource_id}|${r.path}`)!;
    const bs = s.bindings.filter((b) => b.resource_id === r.resource_id && b.resource_path === r.path);
    const by_runtime: BundleResource['by_runtime'] = {};
    for (const b of bs) {
      (by_runtime[b.runtime] ??= []).push({
        discovered: b.discovered,
        load_mode: b.load_mode,
        mechanism: b.mechanism,
        rule_id: b.rule_id,
        confidence: b.confidence,
      });
    }
    const desc = r.declared.description ?? '';
    resources.push({
      ref,
      name: R.name(r.kind, r.name),
      kind: r.kind,
      owner: r.owner,
      path: R.path(r.path),
      real_path: r.real_path ? R.path(r.real_path) : null,
      size_bytes: r.size_bytes,
      line_count: lineCounts.get(r.path) ?? null,
      mtime: r.mtime,
      // 同一性の比較にはこれで足りる。**本文も全長 hash も入れない**
      content_fingerprint: r.normalized_hash.replace(/^sha256:/, '').slice(0, 16),
      frontmatter_keys: r.declared.frontmatterKeys,
      has_description: desc.length > 0,
      description_bytes: Buffer.byteLength(desc, 'utf8'),
      reference_count: r.references.length,
      protected: result_protected(inp.result).has(r.path),
      by_runtime,
    });
  }

  // 同名グループ（drift の土台。名前は匿名化済み）
  const groups = new Map<string, { kind: string; name: string; refs: string[]; hashes: Set<string> }>();
  for (const r of s.resources) {
    const key = `${r.kind}|${r.name}`;
    const g = groups.get(key) ?? { kind: r.kind, name: R.name(r.kind, r.name), refs: [], hashes: new Set<string>() };
    g.refs.push(refOf.get(`${r.resource_id}|${r.path}`)!);
    g.hashes.add(r.normalized_hash);
    groups.set(key, g);
  }
  const same_name_groups = [...groups.values()]
    .filter((g) => g.refs.length > 1)
    .map((g) => ({ name: g.name, kind: g.kind, refs: g.refs, contents_identical: g.hashes.size === 1 }));

  const access = s.access ?? [];
  const statuses: AccessStatus[] = ['observed', 'absent', 'permission_denied', 'failed', 'unsupported', 'not_applicable', 'unobserved'];
  const summary = Object.fromEntries(statuses.map((k) => [k, access.filter((a) => a.status === k).length])) as Record<AccessStatus, number>;

  const cost = inp.result.context_cost;

  // #69 Host / Runtime Signals: active_runtime と同じ S-XX / P-XX の ref を使い回して参照整合性を保つ
  const sessionRefOf = new Map<string, string>(s.sessions.map((x, i) => [x.session_id, `S-${String(i + 1).padStart(2, '0')}`]));
  const processRefOf = new Map<number, string>(s.processes.map((p, i) => [p.pid, `P-${String(i + 1).padStart(2, '0')}`]));
  const hostSignals = buildHostSignals(s, R, sessionRefOf, processRefOf);

  const bundle: DiagnosticBundle = {
    format: BUNDLE_FORMAT,
    generated_at: new Date().toISOString(),
    snapshot_id: s.snapshot_id,
    schema_version: s.schema_version,
    tool_version: s.tool_version,
    reported_symptom: inp.symptom ? R.text(inp.symptom) : null,
    doctor_actions: {
      files_written_to_examined_environment: [],
      network_calls: [],
      statement:
        'The Doctor only read. It wrote nothing into the examined environment, started no session, spent no tokens, and made no network call. This bundle was written to the path the person chose, on their own machine.',
    },
    environment: {
      os: platform(),
      os_release: release(),
      arch: arch(),
      node: process.version,
      runtimes: s.runtimes.map((r) => ({ runtime: r.runtime, version: r.version, present: r.present, config_home: R.path(r.config_home) })),
      launchers: s.env.launchers.length,
      project_present: s.env.project !== null,
    },
    coverage: { phase: s.coverage.phase, collected: s.coverage.collected, not_collected: s.coverage.not_collected },
    observation_status: {
      note:
        'Each entry is the outcome of actually going to look. A count exists only where status is "observed". ' +
        'permission_denied / failed / unsupported / unobserved mean the value is unknown — they do not mean zero and do not mean absent.',
      summary,
      records: access,
      could_not_observe: access.filter((a) => a.status === 'permission_denied' || a.status === 'failed' || a.status === 'unsupported'),
    },
    // #73: UI 用の cluster は overview（ローカルの人間画面）向けに command 等の本文をそのまま持つことがある
    // （ローカル表示は本文を保持してよい契約）。bundle 投影だけ、その本文を落とす
    clusters: stripClusterBodies(inp.clusters),
    llm_report: stripBodies(inp.llm),
    structure: {
      resources,
      counts: { resources: s.resources.length, bindings: s.bindings.length, observations: s.observations.length },
      same_name_groups,
    },
    context_cost: {
      method_note: cost.method_note,
      by_load_mode: cost.by_load_mode,
      by_runtime: cost.by_runtime,
      protected_total: cost.protected_total,
      unprotected_total: cost.unprotected_total,
      not_measured: cost.not_measured,
      note: 'Size is a fact, not a symptom. Nothing here is a finding. Whether any of it matters is decided by the findings, not by the size.',
    },
    active_runtime: {
      observed: s.sessions.length > 0,
      sessions: s.sessions.map((x, i) => ({
        ref: sessionRefOf.get(x.session_id) ?? `S-${String(i + 1).padStart(2, '0')}`,
        runtime: x.runtime,
        entrypoint: x.entrypoint,
        started_at: x.started_at,
        last_activity_at: x.last_activity_at,
        live: x.live,
        is_self: x.is_self,
        is_sidechain: x.is_sidechain,
        capability_counts: Object.fromEntries(Object.entries(x.capabilities).map(([k, v]) => [k, v === null ? null : v.length])),
        compared_capabilities: x.comparable_capabilities,
        compared_timestamps: x.comparable_timestamps,
        not_compared_reason: x.not_comparable_reason,
      })),
      processes: s.processes.map((p, i) => ({
        ref: processRefOf.get(p.pid) ?? `P-${String(i + 1).padStart(2, '0')}`,
        runtime: p.runtime,
        started_at: p.started_at,
        injected_bytes: p.appended_system_prompt?.bytes ?? null,
        // フラグの**名前だけ**。値は取らない（値には注入本文やパスが載る）
        flag_names: [...new Set(p.flags.map((f) => String(f).split('=')[0]!).filter((f) => f.startsWith('--')))],
      })),
      notes: s.probe_notes,
    },
    history: {
      snapshots_compared: inp.history?.series.usable.length ?? 0,
      gaps: inp.history?.series.gaps ?? [],
      events: (inp.history?.events ?? []).slice(-40).map((e) => ({ observed_at: e.observed_at, since: e.since, kind: e.kind, summary: e.summary, direction: e.direction })),
      notes: inp.history?.notes ?? ['No snapshot series was available, so no history was derived. That is not the same as nothing having changed.'],
    },
    redaction: { ...R.summary(), self_check: { leaks_found: 0, leaks: [], passed: false } },
    host_signals: hostSignals,
    handoff_contract: HANDOFF_CONTRACT,
  };

  // 全体をもう一度歩いて、文字列に混ざったものを落とす（構造側で落とし切れなかった分の保険）
  const redacted = R.deep(bundle);
  redacted.redaction = { ...R.summary(), self_check: { leaks_found: 0, leaks: [], passed: false } };

  // 自分で確かめる。「たぶん入っていない」で済ませない
  const serialised = JSON.stringify(redacted);
  // #91: rules[] が約束している project 根と slug も針にする（約束を自分で確かめる）
  const leaks = scanForLeaks(redacted, { home: s.env.home, projects: [s.env.project, ...slugs].filter((x): x is string => !!x) });
  // strict では「登録した名前が 1 つも生で残っていない」ことまで確かめる
  for (const sample of R.sweep(serialised)) leaks.push({ kind: 'resource_name', where: '$ (serialised)', sample });
  // #73: 個別の field 名当てに頼らない最後の網。①危険な形の key/value がそのまま残っていないか
  // ②rule / hook_script の本文が、field 名に関係なく文字列としてどこかに出ていないか（独立した canary 検査）
  leaks.push(...scanForUnsafeBodyKeys(redacted));
  leaks.push(...(await scanForResourceBodyLeaks(serialised, s, inp.readText)));
  redacted.redaction.self_check = { leaks_found: leaks.length, leaks: leaks.slice(0, 20), passed: leaks.length === 0 };
  return redacted;
}

/**
 * #73 自己検査 ①key/value 検査。個別修正の見落としに備えた構造側の保険。
 * 「本文が乗ることが分かっている形」を、それが安全化された後の形と突き合わせて確かめる。
 * ここで拾うのは「まだ直っていない」ではなく「直したはずが崩れた」——回帰の検出が目的。
 */
export function scanForUnsafeBodyKeys(bundle: DiagnosticBundle): Leak[] {
  const out: Leak[] = [];
  const walk = (v: unknown, where: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`));
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(o)) {
      const at = `${where}.${k}`;
      // `lines` は stripLines() の後に必ず null になっているはず
      if (k === 'lines' && val !== null) out.push({ kind: 'unsafe_key:lines', where: at, sample: clipLocal(JSON.stringify(val)) });
      // `condition` の下の `text` は stripBodies() の後に必ず null になっているはず（SCOPE_MISMATCH）
      if (k === 'condition' && val && typeof val === 'object' && (val as Record<string, unknown>)['text'] !== null && (val as Record<string, unknown>)['text'] !== undefined) {
        out.push({ kind: 'unsafe_key:condition.text', where: at, sample: clipLocal(String((val as Record<string, unknown>)['text'])) });
      }
      // `command` は shellShape() を通っているはず。空白を含む複数語がそのまま残っていたら本文が漏れている
      if (k === 'command' && typeof val === 'string' && / /.test(val) && !/\(\+\d+ argument/.test(val)) {
        out.push({ kind: 'unsafe_key:command', where: at, sample: clipLocal(val) });
      }
      walk(val, at);
    }
  };
  walk(bundle, '$');
  return out;
}

/**
 * #73 自己検査 ②独立した canary 検査。field 名当てに頼らない。
 * SCOPE_MISMATCH / HOOK_AMPLIFICATION の入力そのもの（rule 本文の行、hook の command 宣言値）を
 * もう一度読み直し、bundle の完成文字列にそのまま出ていないかを確かめる。production 側の
 * summary/detail 修正が将来別の経路で崩れても、ここが独立に拾う。
 * 意図的に単純化: 短い行（24 文字未満）・行 200 本以上は誤検知/重量が増えるだけなので対象にしない。
 */
export async function scanForResourceBodyLeaks(serialised: string, s: Snapshot, readText: BuildBundleInput['readText']): Promise<Leak[]> {
  const out: Leak[] = [];
  for (const r of s.resources) {
    if (out.length >= 20) break;
    if (r.kind === 'hook_script') {
      const raw = (r.declared.raw ?? {}) as Record<string, unknown>;
      const cmd = typeof raw['command'] === 'string' ? raw['command'] : null;
      if (cmd) {
        // 全体一致だけでなく、引数部分（先頭トークンを除いた残り）でも見る。
        // 先頭は実行ファイルのパスで home 置換を受けるため、全体一致は home 部分の違いで簡単にすり抜ける。
        // 引数（--token 等）には home が乗らないことが多く、そこがそのまま出ていれば本文が漏れている
        if (cmd.trim().length >= 12 && serialised.includes(cmd)) out.push({ kind: 'canary:hook_command_body', where: r.path, sample: clipLocal(cmd) });
        const tail = cmd.trim().split(/\s+/).slice(1).join(' ');
        if (tail.length >= 8 && serialised.includes(tail)) out.push({ kind: 'canary:hook_command_args', where: r.path, sample: clipLocal(tail) });
      }
      continue;
    }
    // #73 追加調査（Codex）: skill/agent_def も本文 canary の対象に含める。unreachable-reference.ts の
    // UNREACHABLE_REFERENCE は agent/skill 本文中の未解決 `ns:name` 参照を読むが、この2 kind が対象外だと
    // 「行が漏れていないか」の網が effectively 素通りする
    if ((r.kind !== 'rule' && r.kind !== 'instruction' && r.kind !== 'skill' && r.kind !== 'agent_def') || !readText) continue;
    const text = await readText(r.path);
    if (!text) continue;
    let hit = false;
    for (const raw of text.split(/\r\n?|\n/)) {
      const line = raw.trim();
      if (line.length < 24) continue;
      if (serialised.includes(line)) {
        out.push({ kind: 'canary:resource_body_line', where: r.path, sample: clipLocal(line) });
        hit = true;
        break;
      }
    }
    if (hit) continue;
    // 行全体の一致は「地の文プロース」向け。`ns:name` 形式の参照は短い断片（バッククォート1つ分）だけが
    // detail/evidence に伝わる経路がありうるので、行より狭い単位でも独立に見る（既知キー名に依存しない）
    for (const ref of extractReferences(text)) {
      if (ref.syntax !== 'skill_ref' || ref.raw.length < 8) continue;
      if (serialised.includes(ref.raw)) {
        out.push({ kind: 'canary:resource_reference_token', where: r.path, sample: clipLocal(ref.raw) });
        break;
      }
    }
  }
  return out;
}

function clipLocal(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/**
 * #69 Host / Runtime Signals v0.1 の bundle 断面を作る。
 * mcp server 名は strict では resource 名と同じ扱い（顧客名・案件名が住みうる場所）で匿名化する。
 * pid はそのまま持つ（本人が自分の `ps` と突き合わせて確かめられるように）。session/process への参照は
 * S-XX / P-XX の既存 ref を使い、bundle 内の参照整合性を保つ。
 */
export function buildHostSignals(
  s: Snapshot,
  R: Redactor,
  sessionRefOf: Map<string, string>,
  processRefOf: Map<number, string>,
): DiagnosticBundle['host_signals'] {
  const mcp = s.mcp_status ?? [];
  const rate = s.rate_limit_events ?? [];
  const pmap = s.process_session_map ?? null;
  const host = s.host ?? null;

  return {
    observed: mcp.length > 0 || rate.length > 0 || pmap !== null || host !== null,
    mcp_status: mcp.map((m) => ({
      // structure.resources の mcp_server kind と同じ bucket key を使う（同じ実体なら同じ id にするため）
      mcp_server: R.name('mcp_server', m.mcp_server),
      status: m.status,
      observed_at: m.observed_at,
      connection_attempts: m.connection_attempts,
      failures: m.failures,
      last_error_kind: m.last_error_kind ? R.text(m.last_error_kind) : null,
      latency_ms: m.latency_ms,
      latency_method: m.latency_method,
      session_refs: m.session_ids.map((id) => sessionRefOf.get(id)).filter((x): x is string => Boolean(x)),
      runtime: m.runtime,
      method: m.method,
      note: m.note,
    })),
    rate_limit_events: rate.map((e) => ({
      provider: e.provider,
      kind: e.kind,
      status_code: e.status_code,
      count: e.count,
      first_observed_at: e.first_observed_at,
      last_observed_at: e.last_observed_at,
      session_refs: e.session_ids.map((id) => sessionRefOf.get(id)).filter((x): x is string => Boolean(x)),
      runtime: e.runtime,
      retry_after_ms: null,
    })),
    process_session_map: {
      entries: (pmap?.entries ?? []).map((m) => ({
        pid: m.pid,
        process_ref: processRefOf.get(m.pid) ?? null,
        runtime: m.runtime,
        session_ref: m.session_id ? (sessionRefOf.get(m.session_id) ?? null) : null,
        started_at: m.started_at,
        argv_fingerprint: m.argv_fingerprint,
        cwd: m.cwd ? R.path(m.cwd) : null,
        status: m.status,
        confidence: m.confidence,
        candidate_session_refs: m.candidate_session_ids.map((id) => sessionRefOf.get(id)).filter((x): x is string => Boolean(x)),
        evidence: m.evidence,
      })),
      live_sessions_without_process_refs: (pmap?.live_sessions_without_process ?? [])
        .map((id) => sessionRefOf.get(id))
        .filter((x): x is string => Boolean(x)),
      note: pmap?.note ?? 'not observed (no --probe)',
    },
    host: host
      ? {
          observed_at: host.observed_at,
          platform: host.platform,
          load: host.load,
          memory: host.memory,
          swap: host.swap,
          processes: host.processes.map((p) => ({
            process_ref: processRefOf.get(p.pid) ?? null,
            runtime: p.runtime,
            cpu_percent: p.cpu_percent,
            rss_bytes: p.rss_bytes,
            status: p.status,
            method: p.method,
          })),
        }
      : null,
    note:
      'Observation only, same as everything else in this bundle. No HIGH_CPU / LOW_MEMORY / SLOW_MCP / RATE_LIMIT_PROBLEM finding is derived from these numbers — the reader judges relevance together with the reported symptom. mcp_status and rate_limit_events only cover claude-code (codex rollouts have no equivalent structured record without reading into conversation content, see coverage). Swap/load may be "unsupported" on some platforms (see each field\'s status) — that is not zero.',
  };
}

/** protected なパスの集合（bundle 用に 1 回だけ作る） */
const protectedCache = new WeakMap<FindingsResult, Set<string>>();
function result_protected(r: FindingsResult): Set<string> {
  let hit = protectedCache.get(r);
  if (!hit) {
    hit = new Set(r.protected.map((p) => p.path));
    protectedCache.set(r, hit);
  }
  return hit;
}

/** `.../<name>/SKILL.md` なら親ディレクトリ名、そうでなければ拡張子を除いたファイル名 */
function identitySegment(path: string): string | null {
  const clean = path.split('#')[0]!;
  const parts = clean.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (/^(SKILL|AGENTS|CLAUDE|MEMORY|README)\.md$/i.test(last) || last === 'config.toml' || last === 'settings.json') {
    return parts[parts.length - 2] ?? null;
  }
  return last.replace(/\.(md|toml|json|rules|sh)$/i, '');
}

/**
 * #73: UI cluster（Overview 画面向け）から本文を落とす。
 *
 * `keyOf()`（ui/summary.ts）は HOOK_AMPLIFICATION を command の生文字列で束ねていて、その文字列が
 * そのまま `UiCluster.id` になる。ローカルの Overview 画面がそれを表示すること自体は正しい（本人の
 * 機械の中で完結する）が、bundle は持ち出す前提なので、束ねる根拠は保ちつつ本文だけを落とす。
 * id は「同じ command なら同じ id」を保てば十分なので、生文字列の代わりに hash で束ねの同一性を残す。
 */
function stripClusterBodies(clusters: UiCluster[]): UiCluster[] {
  return clusters.map((c) => {
    if (c.kind !== 'hook_amplification') return c;
    const out: UiCluster = { ...c };
    const m = /^hook:([^:]*):([\s\S]*)$/.exec(c.id);
    if (m) out.id = `hook:${m[1]}:${shortHash(m[2]!)}`;
    out.facts = c.facts.map((f) => (/^command: /.test(f) ? 'command: (registered command, not carried in a bundle)' : f));
    return out;
  });
}

/**
 * 束ねの同一性だけを保つための短い hash。復元しない（sha256 の先頭 64bit=16桁、`content_fingerprint` と同じ桁数に揃える）。
 * 48bit（12桁）だと衝突した2本の command が bundle 上で同じ cluster id に見えてしまう（Codex Low 指摘、#73）。
 * members は別途保持されるので衝突しても区別自体はできるが、id を識別子として使う受け手向けに桁を伸ばす。
 */
function shortHash(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

/**
 * LLM report から**本文**を落とす。
 *
 * drift の diff 抜粋は行そのものが両ファイルの中身なので持ち出さない。抜粋は `detail.diff_excerpt` にも
 * `evidence[].data.excerpt` にも出るので、**「string の配列である lines」を全域で潰す**（見落としを構造で防ぐ）。
 */
function stripBodies(report: LlmReport): LlmReport {
  const out = JSON.parse(JSON.stringify(report)) as LlmReport;
  stripLines(out);

  // #73 追加調査（Codex）: UNREACHABLE_REFERENCE の未解決 skill_ref は agent/skill 本文に書かれた生の
  // 参照文字列（`ns:name` の name 側に秘匿性のある識別子が入りうる）。summary / detail.reference /
  // human_decision_needed / evidence(raw) / cluster context の 5 箇所に伝播するので、まとめて安全化する。
  // namespace（`ns`）は探索規則の分類に要る情報として残し、name 側だけを落とす
  const rawByFindingId = new Map<string, string>();
  for (const f of out.findings) {
    if (f.finding_id !== 'UNREACHABLE_REFERENCE') continue;
    const raw = (f.detail as Record<string, unknown> | undefined)?.['reference'];
    if (typeof raw === 'string' && raw) rawByFindingId.set(f.id, raw);
  }

  for (const f of out.findings) {
    const raw = rawByFindingId.get(f.id);
    if (raw) {
      const safe = safeReference(raw);
      f.summary = f.summary.split(raw).join(safe);
      f.human_decision_needed = f.human_decision_needed.map((x) => x.split(raw).join(safe));
      for (const e of f.evidence) {
        // 'reference' = 参照元の行に生値が出る経路。'absence' = 「探したが無かった」の対象（target）に
        // 同じ生値が出る経路（unreachable-reference.ts の evidence.push({ type: 'absence', target: raw, ... })）
        if (e.type !== 'reference' && e.type !== 'absence') continue;
        e.summary = e.summary.split(raw).join(safe);
        if (typeof e.data['raw'] === 'string') e.data['raw'] = safe;
        if (typeof e.data['target'] === 'string') e.data['target'] = safe;
      }
    }
    const d = f.detail as Record<string, unknown> | undefined;
    if (!d) continue;
    // hook の command は実行文字列。パス以外の引数まで持ち出さない
    if (typeof d['command'] === 'string') d['command'] = shellShape(d['command'] as string);
    // #73: SCOPE_MISMATCH の detail.condition.text は一致した行の本文そのもの。行番号・検出器名は残し、本文だけ落とす
    const condition = d['condition'] as Record<string, unknown> | undefined;
    if (condition && typeof condition['text'] === 'string') {
      condition['text'] = null;
      condition['text_note'] = 'The matched line is the content of the examined file, so it is not carried in a bundle. Only the line number and detector pattern remain.';
    }
    if (typeof d['reference'] === 'string' && raw) {
      d['reference'] = safeReference(raw);
      d['reference_note'] = 'The unresolved name is written in the source file (may be arbitrary text), so it is not carried in a bundle. Only the namespace remains.';
    }
  }

  // llm-report が cluster 単位で独立にコピーした raw も同じ規則で置き換える（finding.detail を後から
  // 書き換えても、既にコピー済みの clusters[].context.references には反映されないため）
  for (const c of out.clusters) {
    if (c.kind !== 'missing_target_same_plugin') continue;
    const refs = c.context['references'];
    if (Array.isArray(refs)) {
      c.context['references'] = c.members.map((mid) => {
        const raw = rawByFindingId.get(mid);
        return raw ? safeReference(raw) : null;
      });
    }
  }

  return out;
}

/** `ns:name` の name 側（秘匿性のある識別子が入りうる部分）だけを落とす。namespace 分類の意味論は変えない */
function safeReference(raw: string): string {
  const ns = raw.split(':')[0] || raw;
  return `${ns}:<redacted>`;
}

/** どこにあっても、行の配列は数だけにする。**本文を 1 行も持ち出さないことを構造で保証する** */
function stripLines(v: unknown): void {
  if (Array.isArray(v)) {
    for (const x of v) stripLines(x);
    return;
  }
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  for (const [k, val] of Object.entries(o)) {
    if (k === 'lines' && Array.isArray(val) && val.every((x) => typeof x === 'string')) {
      o['line_count'] = val.length;
      o['lines'] = null;
      o['lines_note'] = 'The excerpt lines are the contents of the examined files, so they are not carried in a bundle. Only counts remain. Ask the person for the text if a hypothesis needs it.';
      continue;
    }
    stripLines(val);
  }
}

/** コマンド行を「形」だけにする。実行ファイルの位置と引数の個数まで */
function shellShape(cmd: string): string {
  const parts = cmd.trim().split(/\s+/);
  const head = parts[0] ?? '';
  return parts.length > 1 ? `${head} (+${parts.length - 1} argument(s), not carried)` : head;
}
