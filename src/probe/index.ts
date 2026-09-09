/**
 * active runtime の観測（Phase 1）
 *
 * **これは「起動して聞く probe」ではない。** すでにディスクにある記録（transcript / session rollout / ps）を
 * 読むだけ。token を使わず、副作用が無く、新規セッションではなく実際に動いているセッションを観測できる。
 * Issue #55 の当初案（--debug ログ / 自己申告）より強い経路が実測で見つかったので、そちらを採らない。
 *
 * 観測できるもの / できないもの（method ごとの等級を落とさないために明記する）:
 *   claude-code transcript : skill / agent / deferred tool / MCP instructions の**名前の集合**と開始時刻。
 *                            命令本文（CLAUDE.md / rules / memory）は記録が無い → 内容比較は不可
 *   codex session rollout  : 起動時に載った**命令本文の指紋**と開始時刻。skill / agent の一覧は記録が無い
 *   process argv           : 起動スクリプトが実際に注入した本文の指紋と起動時刻
 */
import { beginAccessLog, takeAccessLog, type AccessRecord } from '../ir/access.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { scanClaudeSessions,  type SessionObservation } from './transcript.js';
import { scanCodexSessions } from './codex-session.js';
import { listRuntimeProcesses, promptDigest, type RuntimeProcess } from './process.js';
import type { HostProcessUsage, McpServerStatus, Observation, ProcessInfo, ProcessSessionMap, ProcessSessionMapping, RateLimitEvidence, Resource, SessionInfo, Snapshot } from '../ir/types.js';

export type { SessionObservation } from './transcript.js';
export type { RuntimeProcess } from './process.js';
export { promptDigest } from './process.js';

export interface ProbeOptions {
  home: string;
  claudeConfigHome: string;
  codexConfigHome: string;
  project: string | null;
  /** last_activity がこの分数以内なら live とみなす（heuristic） */
  liveWindowMinutes: number;
  /** 走査する記録ファイルの上限（新しい順） */
  maxSessions: number;
  /** この session_id は Doctor 自身が動いている session。異常として報告しない */
  selfSessionId: string | null;
  /** 全プロジェクトを見るか（既定は cwd のプロジェクトだけ） */
  allProjects: boolean;
}

export interface ActiveRuntimeObservation {
  sessions: SessionObservation[];
  processes: RuntimeProcess[];
  /** 観測方法とその限界。レポートにそのまま出す */
  notes: string[];
  /** 自分自身のセッションを特定できたか */
  self_session_id: string | null;
  self_attribution: 'given' | 'env' | 'unknown';
  live_window_minutes: number;
  /** 見に行った結果。**0 件と「読めなかった」を区別するための記録** */
  access: AccessRecord[];
}

export async function observeActiveRuntime(opts: ProbeOptions): Promise<ActiveRuntimeObservation> {
  // probe 中に「見に行ったが取れなかった」を記録する（collect の記録とは別に集める）
  beginAccessLog();
  const liveWindowMs = opts.liveWindowMinutes * 60_000;
  // 絞り込みは「cwd → slug 文字列」で決め打ちせず、列挙結果との突合で行う（scanClaudeSessions の中）
  const projectFilter = opts.project && !opts.allProjects ? opts.project : null;

  const [claudeSessions, codexSessions, processes] = await Promise.all([
    scanClaudeSessions(opts.claudeConfigHome, { liveWindowMs, max: opts.maxSessions, projectFilter }),
    scanCodexSessions(opts.codexConfigHome, { liveWindowMs, max: opts.maxSessions }),
    listRuntimeProcesses(),
  ]);

  const envSelf = process.env['CLAUDE_SESSION_ID'] ?? null;
  const self = opts.selfSessionId ?? envSelf;

  const notes = [
    'Active-runtime facts come from records already on disk (session transcripts / rollouts and `ps`). No session was started, no tokens were spent, nothing was written.',
    `"live" means the record file was touched within ${opts.liveWindowMinutes} minutes. It is a heuristic: session records are not tied to a process id, so a live-looking session may have exited and a quiet one may still be running.`,
    'claude-code transcripts record the skill / agent / tool name sets a session was given, but not instruction text (CLAUDE.md, rules, memory). For those, only "changed after the session started" can be observed, never the content the session actually holds.',
    'codex rollouts record the instruction text a session started with (kept here as a digest only), but not skill or agent listings.',
    'Process argv shows what a launcher actually injected. Content is kept as a digest; the raw text is never stored.',
  ];
  if (!self) {
    notes.push(
      'The session the Doctor itself runs in could not be identified (no --self-session and no CLAUDE_SESSION_ID). If one of the sessions below is this one, its divergence from the configured state is expected, not a defect.',
    );
  }

  return {
    sessions: [...claudeSessions, ...codexSessions],
    processes,
    notes,
    self_session_id: self,
    self_attribution: opts.selfSessionId ? 'given' : envSelf ? 'env' : 'unknown',
    live_window_minutes: opts.liveWindowMinutes,
    access: takeAccessLog(),
  };
}

/**
 * 起動スクリプトが「今」注入するはずの本文の指紋を作る。
 * process argv の指紋と比べて違えば、そのプロセスは古い本文で動いている。
 */
export async function currentInjectionDigest(launcherText: string, home: string, readText: (p: string) => Promise<string | null>): Promise<Array<{ target: string; digest: { bytes: number; sha256: string } | null }>> {
  const { extractLauncherInjections } = await import('../ir/binding.js');
  const out: Array<{ target: string; digest: { bytes: number; sha256: string } | null }> = [];
  for (const inj of extractLauncherInjections(launcherText, home)) {
    const t = await readText(inj.target);
    out.push({ target: inj.target, digest: t === null ? null : promptDigest(t) });
  }
  return out;
}

/** fixture などで使う: config home の既定 */
export function defaultConfigHomes(home: string): { claude: string; codex: string } {
  return { claude: join(home, '.claude'), codex: process.env['CODEX_HOME'] ?? join(home, '.codex') };
}

export async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

// ─────────────────────── IR へ載せる ───────────────────────

const TOOL = 'agent-doctor';

/**
 * 対話セッションの entrypoint。これ以外（sdk-py / codex_exec 等）は capability を絞って起動されるため
 * 設定との差は仕様。実測: claude-code は 'cli'、codex の対話 TUI は 'codex-tui'、
 * 非対話は 'sdk-py' / 'sdk-ts' / 'codex_exec'。
 */
const INTERACTIVE_ENTRYPOINTS = new Set<string | null>(['cli', 'codex-tui', null]);

/** SessionObservation → SessionInfo（Snapshot の環境層） */
export function toSessionInfo(o: SessionObservation, selfSessionId: string | null): SessionInfo {
  const kinds: string[] = [];
  for (const [k, v] of Object.entries(o.capabilities)) if (v !== null) kinds.push(k);
  const isSelf = selfSessionId !== null && o.session_id === selfSessionId;
  const interactive = INTERACTIVE_ENTRYPOINTS.has(o.entrypoint);

  // 時刻比較の可否（capability の記録が無い runtime でも成立する）
  let comparable_timestamps = true;
  let reason: string | null = null;
  if (isSelf) {
    comparable_timestamps = false;
    reason = "the Doctor's own session (its divergence from the configured state is expected)";
  } else if (o.is_sidechain) {
    comparable_timestamps = false;
    reason = 'subagent session (it inherits a narrower state by design)';
  } else if (!o.live) {
    comparable_timestamps = false;
    reason = 'not recently active';
  } else if (!o.started_at) {
    comparable_timestamps = false;
    reason = 'no start time recorded';
  }

  // capability 比較の可否（さらに厳しい: 対話セッションで、起動時の集合が記録されていること）
  let comparable_capabilities = comparable_timestamps;
  if (comparable_capabilities && !interactive) {
    comparable_capabilities = false;
    reason = `entrypoint "${o.entrypoint}" — non-interactive sessions are launched with restricted capability flags, so a difference in the capability set is expected (timestamps are still compared)`;
  } else if (comparable_capabilities && !o.capabilities_from_startup) {
    comparable_capabilities = false;
    reason = `no startup capability record (this runtime does not record capability listings, or it is not in the scanned range), so the set it began with is unknown (timestamps are still compared)`;
  }
  return {
    session_id: o.session_id,
    runtime: o.runtime,
    record_path: o.record_path,
    started_at: o.started_at,
    last_activity_at: o.last_activity_at,
    live: o.live,
    runtime_version: o.runtime_version,
    cwd: o.cwd,
    git_branch: o.git_branch,
    entrypoint: o.entrypoint,
    is_self: isSelf,
    is_sidechain: o.is_sidechain,
    observed_capability_kinds: kinds,
    capabilities: o.capabilities,
    capabilities_from_startup: o.capabilities_from_startup,
    non_initial_listings: o.non_initial_listings,
    comparable_capabilities,
    comparable_timestamps,
    not_comparable_reason: reason,
    instruction_digest: o.instruction_digest,
  };
}

export function toProcessInfo(p: RuntimeProcess): ProcessInfo {
  // appended_tail は Snapshot に載せない（argv に秘密が混ざりうる）。指紋だけ残す
  return {
    pid: p.pid,
    ppid: p.ppid,
    started_at: p.started_at,
    runtime: p.runtime,
    flags: p.flags,
    appended_system_prompt: p.appended_system_prompt,
    config_paths: p.config_paths,
    argv_bytes: p.argv_bytes,
  };
}

/**
 * hook の発火実測を session_id → (`<name>|<event>` → 実測) で返す。**Snapshot には入れない。**
 * #57 HOOK_AMPLIFICATION と #56 context cost の実測に使う。
 */
export function hookFirings(sessions: SessionObservation[]): Map<string, Map<string, import('../findings/hook-amplification.js').HookFiring>> {
  const m = new Map<string, Map<string, import('../findings/hook-amplification.js').HookFiring>>();
  for (const s of sessions) if (s.hook_firings.size) m.set(s.session_id, s.hook_firings);
  return m;
}

/** #56: セッション記録に残っていた実際の注入量。text は保持しない */
export function measuredContextItems(sessions: SessionObservation[]): import('../observe/context-cost.js').MeasuredContextItem[] {
  const out: import('../observe/context-cost.js').MeasuredContextItem[] = [];
  for (const s of sessions) {
    for (const [name, bytes] of s.mcp_instruction_bytes) {
      out.push({ session_id: s.session_id, runtime: s.runtime, source: 'mcp_instructions', label: name, bytes, chars: 0, token_estimate: 0, method: 'tiktoken_o200k_approx', occurrences: 1 });
    }
    for (const h of s.hook_firings.values()) {
      if (h.total_bytes === 0) continue;
      out.push({ session_id: s.session_id, runtime: s.runtime, source: 'hook_output', label: `${h.name} on ${h.event}`, bytes: h.total_bytes, chars: 0, token_estimate: 0, method: 'tiktoken_o200k_approx', occurrences: h.count });
    }
  }
  return out;
}

/**
 * 突合用の capability 説明を session_id → (name → 説明の先頭) で返す。**Snapshot には入れない。**
 * 名前だけの突合が誤診を生んだため（agmsg 事件、2026-09-07）、同一性の裏取りに使う。
 */
export function capabilityDescriptions(sessions: SessionObservation[]): Map<string, Map<string, string>> {
  const m = new Map<string, Map<string, string>>();
  for (const s of sessions) if (s.capability_descriptions.size) m.set(s.session_id, s.capability_descriptions);
  return m;
}

/**
 * 突合用の argv 末尾を pid → text で返す。**Snapshot には入れない。**
 * 検出器はこれを FindingContext 経由で受け取り、prefixMatches で判定する。
 */
export function argvTails(processes: RuntimeProcess[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const p of processes) if (p.appended_tail) m.set(p.pid, p.appended_tail);
  return m;
}

/**
 * active_runtime の Observation を作る。
 * 名前が今の設定の Resource に紐付くものだけ（紐付かない名前は SessionInfo.capabilities 側に残る）。
 * kind='context_present'、method='transcript_scan'、scope='active_runtime'、session_id 付き。
 */
export function activeRuntimeObservations(snapshot: Snapshot, sessions: SessionInfo[], toolVersion: string): Observation[] {
  const now = new Date().toISOString();
  const out: Observation[] = [];
  const byName = new Map<string, Resource[]>();
  for (const r of snapshot.resources) {
    const k = `${r.kind}|${r.name}`;
    const arr = byName.get(k) ?? [];
    arr.push(r);
    byName.set(k, arr);
  }
  for (const sess of sessions) {
    const pairs: Array<[string, string[] | null]> = [
      ['skill', sess.capabilities.skills],
      ['agent_def', sess.capabilities.agents],
    ];
    for (const [kind, names] of pairs) {
      if (!names) continue;
      for (const name of names) {
        for (const r of byName.get(`${kind}|${name}`) ?? []) {
          out.push({
            resource_id: r.resource_id,
            resource_path: r.path,
            runtime: sess.runtime,
            kind: 'context_present',
            value: true,
            unit: null,
            measured_at: now,
            method: 'transcript_scan',
            confidence: 'high',
            scope: 'active_runtime',
            session_id: sess.session_id,
            tool: TOOL,
            tool_version: toolVersion,
            source_ref: sess.record_path,
          });
        }
      }
    }
  }
  return out;
}

// ─────────────── Host / Runtime Signals v0.1（#69） ───────────────
// MCP 接続状況・rate limit・pid↔session はここで sessions/processes から集約する。
// Finding は作らない。数値だけから病名を作らないので、集約先も Snapshot の別枠（mcp_status / rate_limit_events / process_session_map）。

/**
 * MCP server の接続状況を、claude-code transcript が記録した delta（成功=mcp_instructions_delta、
 * 失敗=deferred_tools_delta.failedMcpServers）から server 名単位で束ねる。
 * **新しい接続は試みない。** codex は rollout に同等の記録が無いため対象外（note に明記）。
 */
export function mcpServerStatuses(sessions: SessionObservation[]): McpServerStatus[] {
  interface Agg {
    successes: number;
    failures: number;
    lastError: string | null;
    first: string;
    last: string;
    sessionIds: Set<string>;
    runtime: SessionObservation['runtime'];
  }
  const byServer = new Map<string, Agg>();
  for (const s of sessions) {
    for (const e of s.mcp_events) {
      const agg = byServer.get(e.server) ?? { successes: 0, failures: 0, lastError: null, first: e.at, last: e.at, sessionIds: new Set(), runtime: s.runtime };
      if (e.ok) agg.successes++;
      else {
        agg.failures++;
        agg.lastError = e.error;
      }
      if (e.at < agg.first) agg.first = e.at;
      if (e.at > agg.last) agg.last = e.at;
      agg.sessionIds.add(s.session_id);
      byServer.set(e.server, agg);
    }
  }
  const out: McpServerStatus[] = [];
  for (const [server, agg] of byServer) {
    const status: McpServerStatus['status'] = agg.failures > 0 && agg.successes > 0 ? 'intermittent' : agg.failures > 0 ? 'failed' : 'connected';
    out.push({
      mcp_server: server,
      status,
      observed_at: agg.last,
      connection_attempts: null,
      failures: agg.failures,
      last_error_kind: agg.lastError,
      latency_ms: null,
      latency_method: null,
      session_ids: [...agg.sessionIds],
      runtime: agg.runtime,
      method: 'transcript_scan',
      note:
        'failures counts how many times a failure for this server was reported in session records — the runtime may report the same cached failure again on later deltas, so this is not necessarily one independent connection attempt per count. latency is not recorded by this data source (no timing field observed), so it is left null rather than estimated. codex is not covered: its rollout has no equivalent structured record without reading into conversation content.',
    });
  }
  return out.sort((a, b) => a.mcp_server.localeCompare(b.mcp_server));
}

/**
 * API エラー（`isApiErrorMessage`）を kind ごとに束ねる。**Doctor から新規 request は投げない。**
 * すでに記録されている transcript の構造フィールド（apiErrorStatus / error）だけを読む。
 */
export function rateLimitEvidence(sessions: SessionObservation[]): RateLimitEvidence[] {
  interface Agg {
    count: number;
    first: string;
    last: string;
    sessionIds: Set<string>;
    runtime: SessionObservation['runtime'];
    statusCode: number | null;
  }
  const byKey = new Map<string, Agg>();
  const kindOf = (statusCode: number | null, errorType: string | null): RateLimitEvidence['kind'] => {
    if (statusCode === 429 || errorType === 'rate_limit') return 'rate_limit';
    if (errorType === 'overloaded_error') return 'overloaded';
    if (statusCode !== null) return 'other_api_error';
    return 'network_or_unknown';
  };
  for (const s of sessions) {
    for (const e of s.api_errors) {
      const kind = kindOf(e.status_code, e.error_type);
      const key = `${s.runtime}|${kind}|${e.status_code ?? '-'}`;
      const agg = byKey.get(key) ?? { count: 0, first: e.at, last: e.at, sessionIds: new Set(), runtime: s.runtime, statusCode: e.status_code };
      agg.count++;
      if (e.at < agg.first) agg.first = e.at;
      if (e.at > agg.last) agg.last = e.at;
      agg.sessionIds.add(s.session_id);
      byKey.set(key, agg);
    }
  }
  const out: RateLimitEvidence[] = [];
  for (const key of byKey.keys()) {
    const agg = byKey.get(key)!;
    const kind = key.split('|')[1] as RateLimitEvidence['kind'];
    out.push({
      provider: 'anthropic',
      kind,
      status_code: agg.statusCode,
      count: agg.count,
      first_observed_at: agg.first,
      last_observed_at: agg.last,
      session_ids: [...agg.sessionIds],
      runtime: agg.runtime,
      method: 'transcript_scan',
      retry_after_ms: null,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

function processFingerprint(p: RuntimeProcess): string {
  if (p.appended_system_prompt) return p.appended_system_prompt.sha256;
  return 'sha256:' + createHash('sha256').update(`${p.flags.join(',')}|${p.argv_bytes}`).digest('hex').slice(0, 16);
}

/**
 * pid ↔ session_id を、**高確度で結べる時だけ**結ぶ。
 * 鍵は (runtime 一致 + 起動時刻が閾値内で近い)。process 側・session 側どちらから見ても候補が 1 つの時だけ mapped。
 * 候補が複数あれば ambiguous、無ければ unmapped のまま残す（推測で埋めない）。
 */
export function mapProcessesToSessions(processes: RuntimeProcess[], sessions: SessionObservation[]): ProcessSessionMap {
  const THRESHOLD_MS = 5000;
  const candidatesForProcess = new Map<number, SessionObservation[]>();
  const candidatesForSession = new Map<string, RuntimeProcess[]>();
  for (const p of processes) {
    if (!p.started_at) continue;
    const pt = Date.parse(p.started_at);
    if (Number.isNaN(pt)) continue;
    for (const s of sessions) {
      if (s.runtime !== p.runtime || !s.started_at) continue;
      const st = Date.parse(s.started_at);
      if (Number.isNaN(st)) continue;
      if (Math.abs(pt - st) <= THRESHOLD_MS) {
        (candidatesForProcess.get(p.pid) ?? candidatesForProcess.set(p.pid, []).get(p.pid)!).push(s);
        (candidatesForSession.get(s.session_id) ?? candidatesForSession.set(s.session_id, []).get(s.session_id)!).push(p);
      }
    }
  }

  const entries: ProcessSessionMapping[] = [];
  for (const p of processes) {
    const fp = processFingerprint(p);
    const cands = candidatesForProcess.get(p.pid) ?? [];
    if (cands.length === 0) {
      entries.push({
        pid: p.pid,
        runtime: p.runtime,
        session_id: null,
        started_at: p.started_at,
        argv_fingerprint: fp,
        cwd: null,
        status: 'unmapped',
        confidence: null,
        candidate_session_ids: [],
        evidence: `no session record started within ${THRESHOLD_MS}ms of this process`,
      });
    } else if (cands.length === 1 && (candidatesForSession.get(cands[0]!.session_id) ?? []).length === 1) {
      const s = cands[0]!;
      const deltaMs = Math.abs(Date.parse(p.started_at!) - Date.parse(s.started_at!));
      entries.push({
        pid: p.pid,
        runtime: p.runtime,
        session_id: s.session_id,
        started_at: p.started_at,
        argv_fingerprint: fp,
        cwd: s.cwd,
        status: 'mapped',
        confidence: 'high',
        candidate_session_ids: [],
        evidence: `unique match: both ${p.runtime}, process started_at is ${deltaMs}ms from session ${s.session_id}'s started_at, and no other candidate exists on either side within ${THRESHOLD_MS}ms`,
      });
    } else {
      entries.push({
        pid: p.pid,
        runtime: p.runtime,
        session_id: null,
        started_at: p.started_at,
        argv_fingerprint: fp,
        cwd: null,
        status: 'ambiguous',
        confidence: null,
        candidate_session_ids: cands.map((c) => c.session_id),
        evidence: `${cands.length} session record(s) started within ${THRESHOLD_MS}ms of this process; cannot pick one without stronger evidence`,
      });
    }
  }

  // 「live（heuristic）なのに対応する process が無い」session。record は残っているが process はもう居ないかもしれない、を分けるための一覧
  const mappedSessionIds = new Set(entries.filter((e) => e.status === 'mapped').map((e) => e.session_id));
  const liveSessionsWithoutProcess = sessions.filter((s) => s.live && !mappedSessionIds.has(s.session_id)).map((s) => s.session_id);

  return {
    observed_at: new Date().toISOString(),
    entries,
    live_sessions_without_process: liveSessionsWithoutProcess,
    note:
      '"live" on a session is still the record-touched-recently heuristic. A session_id here with no mapped process means either the process has already exited (record survives it) or the match could not be made with high confidence (see the entry\'s status) — it does not mean the process is confirmed gone.',
  };
}

/** #69: probe/process.ts が同じ ps 呼び出しで取った %CPU / RSS を Host 側の形へ */
export function hostProcessUsages(processes: RuntimeProcess[]): HostProcessUsage[] {
  return processes.map((p) => ({
    pid: p.pid,
    runtime: p.runtime,
    cpu_percent: p.cpu_percent,
    rss_bytes: p.rss_bytes,
    status: p.cpu_percent === null && p.rss_bytes === null ? 'failed' : 'observed',
    method: 'ps -o pcpu,rss',
  }));
}

/** プロセス由来の Observation（argv の注入本文の大きさ）。resource は launcher */
export function processObservations(snapshot: Snapshot, processes: ProcessInfo[], toolVersion: string): Observation[] {
  const now = new Date().toISOString();
  const out: Observation[] = [];
  const launchers = snapshot.resources.filter((r) => r.kind === 'launcher');
  for (const p of processes) {
    if (!p.appended_system_prompt) continue;
    for (const l of launchers) {
      out.push({
        resource_id: l.resource_id,
        resource_path: l.path,
        runtime: p.runtime,
        kind: 'size',
        value: p.appended_system_prompt.bytes,
        unit: 'bytes',
        measured_at: now,
        method: 'process_argv',
        confidence: 'medium',
        scope: 'active_runtime',
        process_ref: `pid:${p.pid}@${p.started_at ?? 'unknown'}`,
        tool: TOOL,
        tool_version: toolVersion,
        source_ref: `ps argv of pid ${p.pid} (--append-system-prompt)`,
      });
    }
  }
  return out;
}
