/**
 * history — 「いつからそうなったか」
 *
 * snapshot の系列から**環境に起きた出来事**を導出する。snapshot の一覧ではない。
 * 見たいのは「いつ増えた / いつ消えた / いつ drift した / いつセッションが古くなった」。
 *
 * 原則:
 *   - 出来事は snapshot 間の差分から**導出**する。保存するのは snapshot（4 種の事実データ）だけ
 *   - 版が違う snapshot は比較しない（黙って壊れた差分を出さない）
 *   - 「増えた = 悪」「大きくなった = 悪」にしない。増減は事実として並べる
 *   - 観測していない期間は「観測していない」と言う。snapshot が無い間に起きたことは分からない
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Binding, Finding, Resource, Snapshot } from '../ir/types.js';
import { SCHEMA_VERSION } from '../snapshot.js';

export type EventKind =
  | 'resource_appeared'
  | 'resource_disappeared'
  | 'resource_changed'
  | 'binding_added'
  | 'binding_removed'
  | 'binding_changed'
  | 'drift_started'
  | 'drift_resolved'
  | 'session_appeared'
  | 'session_went_quiet'
  | 'session_became_stale'
  | 'runtime_version_changed'
  | 'observation_moved';

export interface EnvironmentEvent {
  /** 出来事が観測された時刻 = 後側 snapshot の時刻。**起きた時刻ではない**（間隔の中のどこか） */
  observed_at: string;
  /** 前側 snapshot の時刻。この 2 点の間に起きた、としか言えない */
  since: string;
  kind: EventKind;
  /** 何について */
  subject: { kind?: string; name?: string; path?: string; runtime?: string; session_id?: string };
  /** 事実だけ。評価語を入れない */
  summary: string;
  detail: Record<string, unknown>;
  /** 出来事の向き。増減の判断には使うが「良い / 悪い」には使わない */
  direction: 'added' | 'removed' | 'changed';
}

export interface SnapshotRef {
  path: string;
  snapshot_id: string;
  schema_version: number;
  tool_version: string;
  file_mtime: string;
  /** 読み込めたか。版違い・壊れは理由つきで落とす */
  usable: boolean;
  reason?: string;
}

export interface HistorySeries {
  refs: SnapshotRef[];
  /** 実際に比較できた snapshot（時刻順） */
  usable: Snapshot[];
  /** 比較できなかったもの（版違い等）。黙って落とさない */
  skipped: SnapshotRef[];
  /** 観測の空白。snapshot が無い間に起きたことは分からない */
  gaps: Array<{ from: string; to: string; hours: number }>;
}

/** snapshot ディレクトリを時刻順に読む。壊れ・版違いは理由つきで落とす */
export async function loadSeries(dir: string, opts: { max?: number } = {}): Promise<HistorySeries> {
  const refs: SnapshotRef[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return { refs: [], usable: [], skipped: [], gaps: [] };
  }
  const loaded: Snapshot[] = [];
  for (const n of names) {
    const p = join(dir, n);
    let mtime = '';
    try {
      mtime = (await stat(p)).mtime.toISOString();
    } catch {
      continue;
    }
    try {
      const s = JSON.parse(await readFile(p, 'utf8')) as Snapshot;
      const ref: SnapshotRef = {
        path: p,
        snapshot_id: s.snapshot_id ?? mtime,
        schema_version: s.schema_version as unknown as number,
        tool_version: s.tool_version ?? '?',
        file_mtime: mtime,
        usable: s.schema_version === SCHEMA_VERSION,
      };
      if (!ref.usable) ref.reason = `schema_version ${String(s.schema_version)} ≠ ${SCHEMA_VERSION} — not comparable with the current tool`;
      refs.push(ref);
      if (ref.usable) loaded.push(s);
    } catch (e) {
      refs.push({ path: p, snapshot_id: mtime, schema_version: -1, tool_version: '?', file_mtime: mtime, usable: false, reason: `unreadable: ${e instanceof Error ? e.message.slice(0, 80) : 'parse error'}` });
    }
  }
  loaded.sort((a, b) => (a.snapshot_id < b.snapshot_id ? -1 : 1));
  const limited = opts.max ? loaded.slice(-opts.max) : loaded;

  const gaps: HistorySeries['gaps'] = [];
  for (let i = 1; i < limited.length; i++) {
    const a = Date.parse(limited[i - 1]!.snapshot_id);
    const b = Date.parse(limited[i]!.snapshot_id);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const hours = (b - a) / 3_600_000;
      if (hours > 24) gaps.push({ from: limited[i - 1]!.snapshot_id, to: limited[i]!.snapshot_id, hours: Math.round(hours) });
    }
  }
  return { refs, usable: limited, skipped: refs.filter((r) => !r.usable), gaps };
}

/** 同名 skill が runtime 間で内容違いか（drift の状態）。Finding を再実行せずに状態だけ見る */
function driftState(s: Snapshot): Map<string, { hashes: string[]; runtimes: string[] }> {
  const byName = new Map<string, Resource[]>();
  for (const r of s.resources) {
    if (r.kind !== 'skill') continue;
    (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push(r);
  }
  const out = new Map<string, { hashes: string[]; runtimes: string[] }>();
  for (const [name, rs] of byName) {
    if (rs.length < 2) continue;
    const perRuntime = new Map<string, Set<string>>();
    for (const r of rs) {
      for (const b of s.bindings) {
        if (b.resource_id !== r.resource_id || b.resource_path !== r.path || !b.discovered) continue;
        (perRuntime.get(b.runtime) ?? perRuntime.set(b.runtime, new Set()).get(b.runtime)!).add(r.normalized_hash);
      }
    }
    if (perRuntime.size < 2) continue;
    const sets = [...perRuntime.values()];
    const shared = [...sets[0]!].some((h) => sets.every((x) => x.has(h)));
    if (!shared) out.set(name, { hashes: [...new Set(rs.map((r) => r.normalized_hash))], runtimes: [...perRuntime.keys()].sort() });
  }
  return out;
}

const bkey = (b: Binding) => b.binding_id;

/** 2 つの snapshot の間に起きた出来事 */
export function eventsBetween(prev: Snapshot, next: Snapshot): EnvironmentEvent[] {
  if (prev.schema_version !== next.schema_version) return [];
  const out: EnvironmentEvent[] = [];
  const at = next.snapshot_id;
  const since = prev.snapshot_id;
  const base = { observed_at: at, since };

  // ── Resource
  //   同じ内容が複数パスに在る（symlink 等）と 1 つの変更が何十件にも見えるので、**内容で畳んで**
  //   パスを列挙する（実測: MEMORY.md の symlink 29 本で 1 つの変更が 29 件になった）
  const prevByPath = new Map(prev.resources.map((r) => [r.path, r]));
  const nextByPath = new Map(next.resources.map((r) => [r.path, r]));

  const appeared = new Map<string, { r: Resource; paths: string[] }>();
  for (const r of next.resources) {
    if (prevByPath.has(r.path)) continue;
    const e = appeared.get(r.resource_id);
    if (e) e.paths.push(r.path);
    else appeared.set(r.resource_id, { r, paths: [r.path] });
  }
  for (const { r, paths } of appeared.values()) {
    out.push({
      ...base,
      kind: 'resource_appeared',
      subject: { kind: r.kind, name: r.name, path: paths[0]! },
      summary: `${r.kind} "${r.name}" appeared at ${paths[0]}${paths.length > 1 ? ` (and ${paths.length - 1} more path(s) with the same content)` : ''} (${r.size_bytes} B, mtime ${r.mtime})`,
      detail: { size_bytes: r.size_bytes, mtime: r.mtime, owner: r.owner, normalized_hash: r.normalized_hash, paths },
      direction: 'added',
    });
  }

  const gone = new Map<string, { r: Resource; paths: string[] }>();
  for (const r of prev.resources) {
    if (nextByPath.has(r.path)) continue;
    const e = gone.get(r.resource_id);
    if (e) e.paths.push(r.path);
    else gone.set(r.resource_id, { r, paths: [r.path] });
  }
  for (const { r, paths } of gone.values()) {
    out.push({
      ...base,
      kind: 'resource_disappeared',
      subject: { kind: r.kind, name: r.name, path: paths[0]! },
      summary: `${r.kind} "${r.name}" is no longer at ${paths[0]}${paths.length > 1 ? ` (nor at ${paths.length - 1} other path(s))` : ''} (it was ${r.size_bytes} B, mtime ${r.mtime})`,
      detail: { size_bytes: r.size_bytes, mtime: r.mtime, owner: r.owner, paths, note: 'moved, renamed, or removed — the snapshots do not say which' },
      direction: 'removed',
    });
  }

  const changed = new Map<string, { before: Resource; after: Resource; paths: string[] }>();
  for (const [p, before] of prevByPath) {
    const after = nextByPath.get(p);
    if (!after || before.normalized_hash === after.normalized_hash) continue;
    const k = `${before.normalized_hash}|${after.normalized_hash}`;
    const e = changed.get(k);
    if (e) e.paths.push(p);
    else changed.set(k, { before, after, paths: [p] });
  }
  for (const { before, after, paths } of changed.values()) {
    out.push({
      ...base,
      kind: 'resource_changed',
      subject: { kind: after.kind, name: after.name, path: paths[0]! },
      summary:
        `${after.kind} "${after.name}" changed at ${paths[0]}${paths.length > 1 ? ` (and ${paths.length - 1} more path(s) sharing the same content — symlinks or copies)` : ''} ` +
        `(${before.size_bytes} → ${after.size_bytes} B, mtime ${after.mtime})`,
      detail: { size_before: before.size_bytes, size_after: after.size_bytes, mtime_before: before.mtime, mtime_after: after.mtime, hash_before: before.normalized_hash, hash_after: after.normalized_hash, paths },
      direction: 'changed',
    });
  }

  // ── Binding（結合そのものの増減。同一性は binding_id）
  const prevB = new Map(prev.bindings.map((b) => [bkey(b), b]));
  const nextB = new Map(next.bindings.map((b) => [bkey(b), b]));
  for (const [k, b] of nextB) {
    if (prevB.has(k)) continue;
    const r = nextByPath.get(b.resource_path);
    out.push({
      ...base,
      kind: 'binding_added',
      subject: { kind: r?.kind, name: r?.name, path: b.resource_path, runtime: b.runtime },
      summary: `${b.runtime} gained a binding to ${b.resource_path} via ${b.mechanism} (discovered=${b.discovered}, load_mode=${b.load_mode}, rule ${b.rule_id})`,
      detail: { mechanism: b.mechanism, discovered: b.discovered, load_mode: b.load_mode, rule_id: b.rule_id, source_ref: b.source_ref },
      direction: 'added',
    });
  }
  for (const [k, b] of prevB) {
    if (nextB.has(k)) continue;
    out.push({
      ...base,
      kind: 'binding_removed',
      subject: { path: b.resource_path, runtime: b.runtime },
      summary: `${b.runtime} no longer has a binding to ${b.resource_path} via ${b.mechanism} (it was discovered=${b.discovered}, ${b.rule_id})`,
      detail: { mechanism: b.mechanism, discovered: b.discovered, load_mode: b.load_mode, rule_id: b.rule_id },
      direction: 'removed',
    });
  }
  for (const [k, before] of prevB) {
    const after = nextB.get(k);
    if (!after) continue;
    if (before.discovered === after.discovered && before.load_mode === after.load_mode && before.rule_id === after.rule_id) continue;
    out.push({
      ...base,
      kind: 'binding_changed',
      subject: { path: after.resource_path, runtime: after.runtime },
      summary:
        `${after.runtime}'s binding to ${after.resource_path} (${after.mechanism}) changed: ` +
        [
          before.discovered !== after.discovered ? `discovered ${before.discovered} → ${after.discovered}` : null,
          before.load_mode !== after.load_mode ? `load_mode ${before.load_mode} → ${after.load_mode}` : null,
          before.rule_id !== after.rule_id ? `rule ${before.rule_id} → ${after.rule_id}` : null,
        ]
          .filter(Boolean)
          .join(', '),
      detail: { before: { discovered: before.discovered, load_mode: before.load_mode, rule_id: before.rule_id }, after: { discovered: after.discovered, load_mode: after.load_mode, rule_id: after.rule_id } },
      direction: 'changed',
    });
  }

  // ── drift の開始 / 解消
  const dPrev = driftState(prev);
  const dNext = driftState(next);
  for (const [name, st] of dNext) {
    if (dPrev.has(name)) continue;
    out.push({
      ...base,
      kind: 'drift_started',
      subject: { kind: 'skill', name },
      summary: `"${name}" now differs between ${st.runtimes.join(' and ')} (it matched in the previous snapshot)`,
      detail: { runtimes: st.runtimes, hashes: st.hashes },
      direction: 'changed',
    });
  }
  for (const [name, st] of dPrev) {
    if (dNext.has(name)) continue;
    out.push({
      ...base,
      kind: 'drift_resolved',
      subject: { kind: 'skill', name },
      summary: `"${name}" no longer differs between ${st.runtimes.join(' and ')}`,
      detail: { runtimes: st.runtimes },
      direction: 'changed',
    });
  }

  // ── runtime のバージョン
  for (const rt of next.runtimes) {
    const before = prev.runtimes.find((x) => x.runtime === rt.runtime);
    if (!before || before.version === rt.version) continue;
    out.push({
      ...base,
      kind: 'runtime_version_changed',
      subject: { runtime: rt.runtime },
      summary: `${rt.runtime} version changed ${before.version ?? '?'} → ${rt.version ?? '?'}. Discovery rules can differ between versions, so bindings may be recomputed.`,
      detail: { before: before.version, after: rt.version },
      direction: 'changed',
    });
  }

  // ── セッション（**両方が active runtime を観測している時だけ**）
  //   片方が --probe 無しで撮られていると sessions が空になる。それを「セッションが無かった」と
  //   読むと 35 件の偽の session_appeared が出た（実測 2026-09-07）。観測していないことを
  //   存在しなかったことにしない
  const bothObserved = observedActiveRuntime(prev) && observedActiveRuntime(next);
  if (bothObserved) {
    const pS = new Map(prev.sessions.map((x) => [x.session_id, x]));
    const nS = new Map(next.sessions.map((x) => [x.session_id, x]));
    for (const [id, s] of nS) {
      if (pS.has(id)) continue;
      // 走査窓（--max-sessions）が動いただけのものを「現れた」にしない。
      // 前回の観測時刻より後に開始したものだけが本当に新しい
      if (s.started_at !== null && s.started_at <= since) continue;
      out.push({
        ...base,
        kind: 'session_appeared',
        subject: { runtime: s.runtime, session_id: id },
        summary: `${s.runtime} session ${id.slice(0, 8)} appeared (started ${s.started_at ?? 'unknown'}, entrypoint ${s.entrypoint ?? '?'})`,
        detail: { started_at: s.started_at, entrypoint: s.entrypoint, live: s.live, capability_counts: Object.fromEntries(Object.entries(s.capabilities).map(([k, v]) => [k, v?.length ?? null])) },
        direction: 'added',
      });
    }
    for (const [id, s] of pS) {
      const after = nS.get(id);
      if (!after) {
        out.push({
          ...base,
          kind: 'session_went_quiet',
          subject: { runtime: s.runtime, session_id: id },
          summary: `${s.runtime} session ${id.slice(0, 8)} is no longer in the scanned set (last activity ${s.last_activity_at})`,
          detail: { last_activity_at: s.last_activity_at, note: 'it may have ended, or it may have fallen outside the scanned range' },
          direction: 'removed',
        });
        continue;
      }
      // stale になった瞬間: 前は「開始後に変わった always 資源」が無く、後は在る
      const staleBefore = countStale(prev, s.session_id);
      const staleAfter = countStale(next, after.session_id);
      if (staleBefore === 0 && staleAfter > 0) {
        out.push({
          ...base,
          kind: 'session_became_stale',
          subject: { runtime: after.runtime, session_id: id },
          summary: `${after.runtime} session ${id.slice(0, 8)} (started ${after.started_at ?? '?'}) now has ${staleAfter} always-loaded file(s) that changed after it started`,
          detail: { stale_files: staleAfter, started_at: after.started_at, note: 'the content the session holds was not read; only timestamps were compared' },
          direction: 'changed',
        });
      }
    }
  }

  return out.sort((a, b) => a.kind.localeCompare(b.kind) || (a.subject.name ?? a.subject.path ?? '').localeCompare(b.subject.name ?? b.subject.path ?? ''));
}

/**
 * その snapshot が active runtime を観測したか。
 * sessions が空でも probe_notes があれば「観測したが 0 件だった」。
 * 両方無ければ「観測していない」なので、セッションの増減を語ってはいけない。
 */
function observedActiveRuntime(s: Snapshot): boolean {
  return s.sessions.length > 0 || s.processes.length > 0 || s.probe_notes.length > 0;
}

/** そのセッションについて「開始後に変わった always 資源」の数 */
function countStale(s: Snapshot, sessionId: string): number {
  const sess = s.sessions.find((x) => x.session_id === sessionId);
  if (!sess?.started_at) return 0;
  const files = new Set<string>();
  for (const r of s.resources) {
    const b = s.bindings.find((x) => x.resource_id === r.resource_id && x.resource_path === r.path && x.runtime === sess.runtime && x.discovered && x.load_mode === 'always');
    if (!b) continue;
    if (r.mtime > sess.started_at) files.add(r.path.split('#')[0]!);
  }
  return files.size;
}

export interface HistoryResult {
  series: HistorySeries;
  events: EnvironmentEvent[];
  /** 系列全体の推移。数字は事実として並べる。増減を良し悪しにしない */
  trend: Array<{ at: string; resources: number; bindings: number; observations: number; discovered: number; drifted_skills: number; sessions: number | null }>;
  notes: string[];
}

export function buildHistory(series: HistorySeries): HistoryResult {
  const events: EnvironmentEvent[] = [];
  for (let i = 1; i < series.usable.length; i++) events.push(...eventsBetween(series.usable[i - 1]!, series.usable[i]!));
  const trend = series.usable.map((s) => ({
    at: s.snapshot_id,
    resources: s.resources.length,
    bindings: s.bindings.length,
    observations: s.observations.length,
    discovered: s.bindings.filter((b) => b.discovered).length,
    drifted_skills: driftState(s).size,
    // null = active runtime を観測していない snapshot（0 件と区別する）
    sessions: observedActiveRuntime(s) ? s.sessions.length : null,
  }));
  const notes = [
    'Events are derived by comparing consecutive snapshots. An event is dated by the snapshot that first showed it, so what it really says is "this happened somewhere between these two times".',
    'Nothing that happened while no snapshot was taken is visible here. Gaps are listed separately.',
    'Counts going up or down is not itself a defect. Growth is recorded as a fact; whether anything is wrong is decided by the findings, not by the trend.',
    'Session events are only derived between snapshots that both observed the active runtime (taken with --probe). A snapshot without it records no sessions, and that absence is not treated as sessions having gone away.',
    'A session is only reported as appearing if it started after the previous observation. Sessions that merely entered the scanned window (--max-sessions keeps the newest N records) are not reported as new.',
  ];
  if (series.usable.length < 2) notes.push(`Only ${series.usable.length} comparable snapshot(s) available, so no event can be derived yet. Take snapshots over time (\`agent-doctor snapshot --out …\`) to build a history.`);
  if (series.skipped.length) notes.push(`${series.skipped.length} snapshot file(s) were not comparable and were left out: ${series.skipped.map((r) => `${r.path.split('/').pop()} (${r.reason})`).join('; ')}`);
  return { series, events, trend, notes };
}
