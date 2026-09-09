/**
 * Host / Runtime Signals v0.1（#69）
 *
 * ここで守るのは 4 つ。
 *   1. MCP 接続状況・rate limit は「観測できた事実」だけを束ねる。latency が無ければ null（0 にしない）
 *   2. pid ↔ session_id は **高確度で結べる時だけ** mapped。それ以外は unmapped/ambiguous のまま残す
 *   3. CPU/RAM は取れなければ 0 でなく AccessStatus で言う。cross-platform = 同じ値を取ることではない
 *   4. Finding は 1 つも増えない。bundle には structured evidence だけが入り、本文・secret は入らない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mcpServerStatuses, rateLimitEvidence, mapProcessesToSessions } from '../src/probe/index.js';
import type { SessionObservation } from '../src/probe/transcript.js';
import type { RuntimeProcess } from '../src/probe/process.js';
import { collectHostResources } from '../src/observe/host.js';
import { buildHostSignals } from '../src/bundle/index.js';
import { Redactor } from '../src/bundle/redact.js';
import type { Snapshot } from '../src/ir/types.js';

/** 合成 SessionObservation（テストに要る最小形） */
function session(over: Partial<SessionObservation> & { session_id: string }): SessionObservation {
  return {
    runtime: 'claude-code',
    record_path: `/home/.claude/projects/x/${over.session_id}.jsonl`,
    started_at: '2026-09-08T00:00:00.000Z',
    last_activity_at: '2026-09-08T00:00:00.000Z',
    live: false,
    runtime_version: null,
    cwd: null,
    git_branch: null,
    entrypoint: 'cli',
    capabilities: { skills: null, agents: null, deferred_tools: null, mcp_instructions: null, failed_mcp_servers: null },
    capabilities_from_startup: false,
    non_initial_listings: 0,
    capability_descriptions: new Map(),
    instruction_text_available: false,
    instruction_digest: null,
    is_sidechain: false,
    mcp_instruction_bytes: new Map(),
    hook_firings: new Map(),
    mcp_events: [],
    api_errors: [],
    ...over,
  };
}

function proc(over: Partial<RuntimeProcess> & { pid: number }): RuntimeProcess {
  return {
    ppid: 1,
    started_at: '2026-09-08T00:00:00.000Z',
    runtime: 'claude-code',
    flags: [],
    appended_system_prompt: null,
    config_paths: [],
    argv_bytes: 100,
    cpu_percent: null,
    rss_bytes: null,
    ...over,
  };
}

// ───────────────────── MCP connection status ─────────────────────

test('mcpServerStatuses: 失敗しか観測していなければ failed、成功と失敗が両方あれば intermittent', () => {
  const sessions = [
    session({
      session_id: 'a',
      mcp_events: [
        { server: 'vercel', ok: false, error: 'Connection closed', at: '2026-09-08T00:01:00.000Z' },
        { server: 'context7', ok: true, error: null, at: '2026-09-08T00:01:00.000Z' },
      ],
    }),
    session({
      session_id: 'b',
      mcp_events: [{ server: 'context7', ok: false, error: 'timeout', at: '2026-09-08T00:02:00.000Z' }],
    }),
  ];
  const out = mcpServerStatuses(sessions);
  const vercel = out.find((x) => x.mcp_server === 'vercel')!;
  const ctx7 = out.find((x) => x.mcp_server === 'context7')!;
  assert.equal(vercel.status, 'failed');
  assert.equal(vercel.failures, 1);
  assert.equal(vercel.last_error_kind, 'Connection closed');
  assert.equal(ctx7.status, 'intermittent', 'context7 は成功(a)と失敗(b)の両方を観測している');
  assert.deepEqual(new Set(ctx7.session_ids), new Set(['a', 'b']));
});

test('mcpServerStatuses: latency はこの観測方法に記録が無いので常に null（0 にしない）', () => {
  const out = mcpServerStatuses([session({ session_id: 'a', mcp_events: [{ server: 'x', ok: true, error: null, at: '2026-09-08T00:00:00.000Z' }] })]);
  assert.equal(out[0]!.latency_ms, null);
  assert.equal(out[0]!.latency_method, null);
  assert.equal(out[0]!.connection_attempts, null, '独立した接続試行の回数はこの観測方法では分からない');
});

test('mcpServerStatuses: 観測が無ければ空配列（0 件の server を捏造しない）', () => {
  assert.deepEqual(mcpServerStatuses([session({ session_id: 'a' })]), []);
});

// ───────────────────── rate limit evidence ─────────────────────

test('rateLimitEvidence: 429 は rate_limit、overloaded_error は overloaded、他は other/network に分ける', () => {
  const sessions = [
    session({
      session_id: 'a',
      api_errors: [
        { status_code: 429, error_type: 'rate_limit', at: '2026-09-08T00:00:00.000Z' },
        { status_code: 429, error_type: 'rate_limit', at: '2026-09-08T00:05:00.000Z' },
        { status_code: 529, error_type: 'overloaded_error', at: '2026-09-08T00:06:00.000Z' },
        { status_code: 400, error_type: 'invalid_request', at: '2026-09-08T00:07:00.000Z' },
        { status_code: null, error_type: null, at: '2026-09-08T00:08:00.000Z' },
      ],
    }),
  ];
  const out = rateLimitEvidence(sessions);
  const rl = out.find((x) => x.kind === 'rate_limit')!;
  assert.equal(rl.count, 2);
  assert.equal(rl.status_code, 429);
  assert.equal(rl.retry_after_ms, null, 'retry-after はこの観測方法に記録が無い');
  assert.ok(out.some((x) => x.kind === 'overloaded'));
  assert.ok(out.some((x) => x.kind === 'other_api_error' && x.status_code === 400));
  assert.ok(out.some((x) => x.kind === 'network_or_unknown' && x.status_code === null));
});

test('rateLimitEvidence: 記録が無ければ空配列（「rate limit が無かった」と断定しない。呼び出し側は not observed と読む）', () => {
  assert.deepEqual(rateLimitEvidence([session({ session_id: 'a' })]), []);
});

// ───────────────────── pid ↔ session_id mapping ─────────────────────

test('mapProcessesToSessions: 一意に近い開始時刻なら high confidence で mapped', () => {
  const processes = [proc({ pid: 100, started_at: '2026-09-08T00:00:01.000Z' })];
  const sessions = [session({ session_id: 's1', started_at: '2026-09-08T00:00:00.500Z', cwd: '/home/x/proj' })];
  const out = mapProcessesToSessions(processes, sessions);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0]!.status, 'mapped');
  assert.equal(out.entries[0]!.session_id, 's1');
  assert.equal(out.entries[0]!.confidence, 'high');
  assert.equal(out.entries[0]!.cwd, '/home/x/proj');
});

test('mapProcessesToSessions: 候補が複数あれば ambiguous のまま残す（推測で 1 つに決めない）', () => {
  const processes = [proc({ pid: 100, started_at: '2026-09-08T00:00:00.000Z' })];
  const sessions = [
    session({ session_id: 's1', started_at: '2026-09-08T00:00:01.000Z' }),
    session({ session_id: 's2', started_at: '2026-09-08T00:00:02.000Z' }),
  ];
  const out = mapProcessesToSessions(processes, sessions);
  assert.equal(out.entries[0]!.status, 'ambiguous');
  assert.equal(out.entries[0]!.session_id, null);
  assert.deepEqual(new Set(out.entries[0]!.candidate_session_ids), new Set(['s1', 's2']));
});

test('mapProcessesToSessions: 近い時刻の記録が無ければ unmapped', () => {
  const processes = [proc({ pid: 100, started_at: '2026-09-08T00:00:00.000Z' })];
  const sessions = [session({ session_id: 's1', started_at: '2026-09-08T05:00:00.000Z' })];
  const out = mapProcessesToSessions(processes, sessions);
  assert.equal(out.entries[0]!.status, 'unmapped');
  assert.equal(out.entries[0]!.session_id, null);
});

test('mapProcessesToSessions: live な session なのに process が結べなければ live_sessions_without_process に残す（record は残っているが process は居ないかもしれない、と本当に動いている、を分ける）', () => {
  const processes: RuntimeProcess[] = [];
  const sessions = [session({ session_id: 's1', live: true, started_at: '2026-09-08T00:00:00.000Z' })];
  const out = mapProcessesToSessions(processes, sessions);
  assert.deepEqual(out.live_sessions_without_process, ['s1']);
});

test('mapProcessesToSessions: runtime が違えば候補にしない', () => {
  const processes = [proc({ pid: 100, runtime: 'codex', started_at: '2026-09-08T00:00:00.000Z' })];
  const sessions = [session({ session_id: 's1', runtime: 'claude-code', started_at: '2026-09-08T00:00:00.500Z' })];
  const out = mapProcessesToSessions(processes, sessions);
  assert.equal(out.entries[0]!.status, 'unmapped');
});

// ───────────────────── CPU / RAM（Host） ─────────────────────

test('collectHostResources: この実機（darwin/linux）では load/memory が observed で、null や 0 の捏造をしない', async () => {
  const h = await collectHostResources();
  assert.ok(['darwin', 'linux', 'win32'].includes(h.platform));
  if (h.platform !== 'win32') {
    assert.equal(h.load.status, 'observed');
    assert.equal(typeof h.load.load1, 'number');
  }
  assert.equal(h.memory.status, 'observed');
  assert.ok(h.memory.total_bytes! > 0);
});

test('collectHostResources: win32 では load average を 0 として出さず unsupported にする（Node の os.loadavg() は Windows で常に [0,0,0] を返すため）', async () => {
  const h = await collectHostResources('win32');
  assert.equal(h.platform, 'win32');
  assert.equal(h.load.status, 'unsupported');
  assert.equal(h.load.load1, null, '観測できないものを 0 にしない');
  assert.match(h.load.reason ?? '', /Windows/);
});

test('collectHostResources: win32 では swap を未実装として unsupported にする（実機未検証を「取れた」と偽装しない）', async () => {
  const h = await collectHostResources('win32');
  assert.equal(h.swap.status, 'unsupported');
  assert.equal(h.swap.total_bytes, null);
});

// ───────────────────── bundle への配線 ─────────────────────

function baseSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    snapshot_id: 'test',
    schema_version: 4,
    tool_version: 'test',
    runtimes: [],
    env: { os: 'test', project: null, home: '/home/tanaka', launchers: [] },
    coverage: { phase: 'test', collected: [], not_collected: [] },
    resources: [],
    bindings: [],
    observations: [],
    sessions: [],
    processes: [],
    probe_notes: [],
    ...over,
  };
}

test('buildHostSignals: --probe 相当のデータが無ければ observed=false で空のまま（0 件を捏造しない）', () => {
  const R = new Redactor({ home: '/home/tanaka', level: 'strict' });
  const hs = buildHostSignals(baseSnapshot(), R, new Map(), new Map());
  assert.equal(hs.observed, false);
  assert.deepEqual(hs.mcp_status, []);
  assert.deepEqual(hs.rate_limit_events, []);
  assert.equal(hs.host, null);
});

test('buildHostSignals: strict では mcp_server 名を匿名化し、structure.resources と同じ id 空間を使う（同じ実体は同じ id）', () => {
  const R = new Redactor({ home: '/home/tanaka', level: 'strict' });
  // structure.resources 側が先に同じ 'mcp_server' kind で名前を登録した、という状況を再現する
  const idFromStructure = R.name('mcp_server', 'client-alpha-tool');
  const snapshot = baseSnapshot({
    mcp_status: [
      {
        mcp_server: 'client-alpha-tool',
        status: 'connected',
        observed_at: '2026-09-08T00:00:00.000Z',
        connection_attempts: null,
        failures: 0,
        last_error_kind: null,
        latency_ms: null,
        latency_method: null,
        session_ids: ['s1'],
        runtime: 'claude-code',
        method: 'transcript_scan',
        note: 'x',
      },
    ],
  });
  const hs = buildHostSignals(snapshot, R, new Map([['s1', 'S-01']]), new Map());
  assert.equal(hs.observed, true);
  assert.equal(hs.mcp_status[0]!.mcp_server, idFromStructure, '同じ実体なのに別の id になっている');
  assert.match(hs.mcp_status[0]!.mcp_server, /^<mcp_server-\d+>$/);
  assert.deepEqual(hs.mcp_status[0]!.session_refs, ['S-01']);
  assert.ok(!JSON.stringify(hs).includes('client-alpha-tool'), '生の名前が残っている');
});

test('buildHostSignals: process_session_map の cwd と host の値は Finding を作らず、そのまま Observation として渡す', () => {
  const R = new Redactor({ home: '/home/tanaka', level: 'strict' });
  const snapshot = baseSnapshot({
    process_session_map: {
      observed_at: '2026-09-08T00:00:00.000Z',
      entries: [
        {
          pid: 123,
          runtime: 'claude-code',
          session_id: 's1',
          started_at: '2026-09-08T00:00:00.000Z',
          argv_fingerprint: 'sha256:abc',
          cwd: '/home/tanaka/work/project-x',
          status: 'mapped',
          confidence: 'high',
          candidate_session_ids: [],
          evidence: 'unique match',
        },
      ],
      live_sessions_without_process: ['s2'],
      note: 'x',
    },
    host: {
      observed_at: '2026-09-08T00:00:00.000Z',
      platform: 'darwin',
      load: { load1: 3.9, load5: 3.7, load15: 4.3, status: 'observed', method: 'os.loadavg', reason: null },
      memory: { total_bytes: 100, used_bytes: 90, available_bytes: 10, status: 'observed', method: 'vm_stat', reason: null },
      swap: { total_bytes: 10, used_bytes: 1, status: 'observed', method: 'sysctl', reason: null },
      processes: [{ pid: 123, runtime: 'claude-code', cpu_percent: 0.5, rss_bytes: 200, status: 'observed', method: 'ps' }],
    },
  });
  const hs = buildHostSignals(snapshot, R, new Map([['s1', 'S-01'], ['s2', 'S-02']]), new Map([[123, 'P-01']]));
  assert.equal(hs.process_session_map.entries[0]!.session_ref, 'S-01');
  assert.equal(hs.process_session_map.entries[0]!.pid, 123, 'pid は本人の ps との突き合わせのため生のまま持つ');
  assert.ok(hs.process_session_map.entries[0]!.cwd!.startsWith('$HOME'), 'home は置換される');
  assert.deepEqual(hs.process_session_map.live_sessions_without_process_refs, ['S-02']);
  assert.equal(hs.host!.processes[0]!.process_ref, 'P-01');
  assert.equal(hs.host!.load.load1, 3.9);
  // Finding を作らないことの構造的な保証: status は observed/unsupported 等の Observation 語彙だけ。severity/confidence のような診断語は無い
  assert.ok(!('severity' in hs.host!.load) && !('severity' in hs.process_session_map.entries[0]!));
});
