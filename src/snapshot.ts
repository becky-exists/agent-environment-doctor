/**
 * Snapshot の生成・保存・差分
 *
 * diff は同一 schema_version 間でのみ行う。違えば「比較不能」として落とす
 * （黙って壊れた差分を出さない）。
 *
 * schema_version 2（2026-09-07）: Binding に binding_id / mechanism / source_ref、env.launchers、coverage。
 * schema_version 3（2026-09-07）: sessions / processes（active_runtime の観測）、Observation に session_id / process_ref。
 * schema_version 4（2026-09-07）: binding_id の導出から content hash を外した（位置だけが結合の同一性）。
 *   旧版の binding_id とは値が違うので、版を跨いだ diff / history は成立しない。
 * 版が違う snapshot は読めるが diff できない（同一性の規則が違う）。
 */

import { beginAccessLog, takeAccessLog, type AccessRecord } from './ir/access.js';
import { readFile } from 'node:fs/promises';
import { platform, release } from 'node:os';

import type { Binding, HostResources, McpServerStatus, Observation, ProcessInfo, ProcessSessionMap, RateLimitEvidence, Resource, SessionInfo, Snapshot, RuntimeInfo } from './ir/types.js';
import type { CollectContext, RuntimeAdapter } from './adapters/types.js';
import { TOOL_VERSION } from './adapters/claude-code/index.js';
import { PHASE0_COVERAGE } from './coverage.js';
import { writeExclusive } from './safe-write.js';

export const SCHEMA_VERSION = 4 as const;

/** active_runtime の観測を Snapshot に載せる。--probe を付けた時だけ呼ばれる */
export function attachActiveRuntime(
  snapshot: Snapshot,
  sessions: SessionInfo[],
  processes: ProcessInfo[],
  observations: Observation[],
  notes: string[],
  access: AccessRecord[] = [],
  hostSignals?: { mcpStatus: McpServerStatus[]; rateLimit: RateLimitEvidence[]; processSessionMap: ProcessSessionMap; host: HostResources },
): Snapshot {
  snapshot.sessions = sessions;
  snapshot.processes = processes;
  snapshot.probe_notes = notes;
  if (access.length) snapshot.access = [...(snapshot.access ?? []), ...access];
  if (hostSignals) {
    snapshot.mcp_status = hostSignals.mcpStatus;
    snapshot.rate_limit_events = hostSignals.rateLimit;
    snapshot.process_session_map = hostSignals.processSessionMap;
    snapshot.host = hostSignals.host;
  }
  const seen = new Set(snapshot.observations.map((o) => [o.resource_id, o.resource_path, o.runtime ?? '-', o.kind, o.method, o.scope, o.session_id ?? '-', o.process_ref ?? '-'].join('|')));
  for (const o of observations) {
    const k = [o.resource_id, o.resource_path, o.runtime ?? '-', o.kind, o.method, o.scope, o.session_id ?? '-', o.process_ref ?? '-'].join('|');
    if (!seen.has(k)) {
      seen.add(k);
      snapshot.observations.push(o);
    }
  }
  return snapshot;
}

export interface CollectResult {
  snapshot: Snapshot;
  /** adapter ごとの収集件数（Gate A の目視用）。newResources = 重複排除後に新規だった数 */
  perRuntime: Array<{ runtime: string; resources: number; newResources?: number; bindings: number; observations: number; newObservations?: number; present: boolean }>;
}

export async function collect(adapters: RuntimeAdapter[], ctx: CollectContext): Promise<CollectResult> {
  // 見に行った結果の記録を開始する（読めなかったものを 0 件にしないため）
  beginAccessLog();
  // Resource は runtime 非依存。複数 adapter が同じパスを収集するので (resource_id, path) で重複排除する。
  // 例: ~/.agents/skills/finish/SKILL.md は claude adapter（探索対象外として）と
  //     codex adapter（探索対象として）の両方が収集するが、実体は 1 つ。
  const resourceMap = new Map<string, Resource>();
  const bindings: Binding[] = [];
  const bindingIds = new Set<string>();
  // Observation も重複排除する。runtime=null（filesystem の事実）は runtime を除いたキーで一意化し、
  // 両 adapter が同じファイルを stat しても 1 件にまとめる。
  // 意図的に単純化: 同一 snapshot 内の同 kind/method は 1 件（時系列 identity は Phase 1 前に設計。coverage に明記）
  const obsMap = new Map<string, Observation>();
  const runtimes: RuntimeInfo[] = [];
  const perRuntime: CollectResult['perRuntime'] = [];
  const rkey = (r: Resource) => `${r.resource_id}|${r.path}`;
  // session_id / process_ref まで含める（同じ skill が session A には在り B には無い、を並存させる）
  const okey = (o: Observation) =>
    [o.resource_id, o.resource_path, o.runtime ?? '-', o.kind, o.method, o.scope, o.session_id ?? '-', o.process_ref ?? '-'].join('|');

  for (const a of adapters) {
    const info = await a.detect(ctx);
    runtimes.push(info);
    if (!info.present) {
      perRuntime.push({ runtime: a.id, resources: 0, newResources: 0, bindings: 0, observations: 0, newObservations: 0, present: false });
      continue;
    }
    const rs = await a.collectResources(ctx);
    const bs = a.computeBindings(rs, info, ctx);
    const os = await a.collectObservations(rs, ctx);
    let newly = 0;
    for (const r of rs) {
      const k = rkey(r);
      if (!resourceMap.has(k)) {
        resourceMap.set(k, r);
        newly++;
      }
    }
    for (const b of bs) {
      // binding_id は (runtime, resource_id, resource_path, mechanism, source_ref) の導出値。
      // 同じ adapter が同じ結合を 2 回作ったら設計ミスなので、黙って捨てず例外にする
      if (bindingIds.has(b.binding_id)) throw new Error(`duplicate binding_id from ${a.id}: ${b.resource_path} [${b.mechanism}]`);
      bindingIds.add(b.binding_id);
      bindings.push(b);
    }
    let newObs = 0;
    for (const o of os) {
      const k = okey(o);
      if (!obsMap.has(k)) {
        obsMap.set(k, o);
        newObs++;
      }
    }
    perRuntime.push({
      runtime: a.id,
      resources: rs.length,
      newResources: newly,
      bindings: bs.length,
      observations: os.length,
      newObservations: newObs,
      present: true,
    });
  }

  const snapshot: Snapshot = {
    snapshot_id: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    tool_version: TOOL_VERSION,
    runtimes,
    env: { os: `${platform()} ${release()}`, project: ctx.project, home: ctx.home, launchers: ctx.launchers ?? [] },
    coverage: PHASE0_COVERAGE,
    resources: [...resourceMap.values()],
    bindings,
    observations: [...obsMap.values()],
    sessions: [],
    processes: [],
    probe_notes: [],
    access: takeAccessLog(),
  };
  return { snapshot, perRuntime };
}

export async function saveSnapshot(s: Snapshot, out: string): Promise<void> {
  // 既存ファイル・既存 symlink は上書きしない（#75）。詳細は safe-write.ts
  await writeExclusive(out, JSON.stringify(s, null, 2));
}

export async function loadSnapshot(p: string): Promise<Snapshot> {
  const s = JSON.parse(await readFile(p, 'utf8')) as Snapshot;
  if (s.schema_version !== SCHEMA_VERSION) {
    throw new Error(`schema_version ${String(s.schema_version)} cannot be compared (this tool supports only ${SCHEMA_VERSION}; read older versions with a matching tool version)`);
  }
  return s;
}

export interface SnapshotDiff {
  added: Resource[];
  removed: Resource[];
  /** 同じ path で内容が変わったもの */
  changed: Array<{ path: string; before: Resource; after: Resource }>;
  /** Binding だけ変わったもの（runtime のバージョンアップ等）。同一性は binding_id */
  rebound: Array<{ binding_id: string; before: Binding; after: Binding }>;
  /** 結合そのものが増減したもの（起動スクリプトの注入経路が増えた等） */
  bound: Binding[];
  unbound: Binding[];
}

export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  if (a.schema_version !== b.schema_version) throw new Error('schema_version differs, cannot compare');

  const byPathA = new Map(a.resources.map((r) => [r.path, r]));
  const byPathB = new Map(b.resources.map((r) => [r.path, r]));

  const added = b.resources.filter((r) => !byPathA.has(r.path));
  const removed = a.resources.filter((r) => !byPathB.has(r.path));
  const changed: SnapshotDiff['changed'] = [];
  for (const [p, before] of byPathA) {
    const after = byPathB.get(p);
    if (after && before.normalized_hash !== after.normalized_hash) changed.push({ path: p, before, after });
  }

  const bindA = new Map(a.bindings.map((x) => [x.binding_id, x]));
  const bindB = new Map(b.bindings.map((x) => [x.binding_id, x]));
  const rebound: SnapshotDiff['rebound'] = [];
  for (const nb of b.bindings) {
    const ob = bindA.get(nb.binding_id);
    if (ob && (ob.discovered !== nb.discovered || ob.load_mode !== nb.load_mode || ob.rule_id !== nb.rule_id)) {
      rebound.push({ binding_id: nb.binding_id, before: ob, after: nb });
    }
  }
  const bound = b.bindings.filter((x) => !bindA.has(x.binding_id));
  const unbound = a.bindings.filter((x) => !bindB.has(x.binding_id));
  return { added, removed, changed, rebound, bound, unbound };
}
