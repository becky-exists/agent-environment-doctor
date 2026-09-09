/**
 * Snapshot の要約（Golden Snapshot の回帰基準）
 *
 * Snapshot 本体は環境固有のパスと hash を大量に含むので、リポジトリには
 * この要約（件数だけ）を固定する。要約の計算はここ 1 箇所に置き、
 * Gate A / golden-check / 将来の report が同じ数字を見るようにする。
 *
 * ここは分析ではない。数えるだけ。Finding を出す場所でもない。
 */

import type { Snapshot } from './ir/types.js';

export interface SnapshotSummary {
  counts: { resources: number; bindings: number; observations: number };
  per_runtime: Record<string, { bindings: number; observations: number }>;
  by_kind: Record<string, number>;
  by_load_mode: Record<string, number>;
  /** 同名 skill の組（CROSS_RUNTIME_DRIFT の土台）。identical + drifted = pairs */
  same_name_skills: { pairs: number; identical: number; drifted: number };
  /** discovered=false の内訳。仕様どおりの不可視は Finding にしない（README 参照） */
  undiscovered: { total: number; by_rule: Record<string, number> };
  /** 同一内容が複数パスに在る resource_id の数 */
  same_content_multi_path: number;
  /** active_runtime を観測した時だけ。0 = 観測していない */
  sessions: { total: number; live: number; by_runtime: Record<string, number> };
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  // キー順で固定し、JSON 差分が並び順で揺れないようにする
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function summarize(s: Snapshot): SnapshotSummary {
  const perRuntime: SnapshotSummary['per_runtime'] = {};
  for (const b of s.bindings) {
    const p = (perRuntime[b.runtime] ??= { bindings: 0, observations: 0 });
    p.bindings++;
  }
  for (const o of s.observations) {
    if (o.runtime === null) continue; // filesystem の事実は runtime に属さない
    const p = (perRuntime[o.runtime] ??= { bindings: 0, observations: 0 });
    p.observations++;
  }

  const byName = new Map<string, Set<string>>();
  for (const r of s.resources) {
    if (r.kind !== 'skill') continue;
    const set = byName.get(r.name) ?? new Set<string>();
    set.add(r.normalized_hash);
    byName.set(r.name, set);
  }
  // 同名の組 = 同じ name の resource が 2 件以上（hash が全部同じでも 1 組と数える）
  const byNameCount = new Map<string, number>();
  for (const r of s.resources) if (r.kind === 'skill') byNameCount.set(r.name, (byNameCount.get(r.name) ?? 0) + 1);
  const pairs = [...byNameCount.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  const drifted = pairs.filter((name) => (byName.get(name)?.size ?? 0) > 1).length;

  const undiscovered = s.bindings.filter((b) => !b.discovered);

  const ids = new Map<string, Set<string>>();
  for (const r of s.resources) {
    const set = ids.get(r.resource_id) ?? new Set<string>();
    set.add(r.path);
    ids.set(r.resource_id, set);
  }

  return {
    counts: { resources: s.resources.length, bindings: s.bindings.length, observations: s.observations.length },
    per_runtime: Object.fromEntries(Object.entries(perRuntime).sort(([a], [b]) => (a < b ? -1 : 1))),
    by_kind: countBy(s.resources, (r) => r.kind),
    by_load_mode: countBy(s.bindings, (b) => b.load_mode),
    same_name_skills: { pairs: pairs.length, identical: pairs.length - drifted, drifted },
    undiscovered: { total: undiscovered.length, by_rule: countBy(undiscovered, (b) => b.rule_id) },
    same_content_multi_path: [...ids.values()].filter((ps) => ps.size > 1).length,
    sessions: {
      total: s.sessions.length,
      live: s.sessions.filter((x) => x.live).length,
      by_runtime: countBy(s.sessions, (x) => x.runtime),
    },
  };
}

/** 2 つの要約の差。空配列なら一致 */
export function compareSummaries(expected: SnapshotSummary, actual: SnapshotSummary): string[] {
  const diffs: string[] = [];
  const walk = (e: unknown, a: unknown, path: string) => {
    if (typeof e === 'number' || typeof e === 'string' || typeof e === 'boolean' || e === null) {
      if (e !== a) diffs.push(`${path}: expected ${String(e)}, actual ${String(a)}`);
      return;
    }
    if (e && typeof e === 'object') {
      const eo = e as Record<string, unknown>;
      const ao = (a ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(eo), ...Object.keys(ao)])) {
        if (!(k in eo)) diffs.push(`${path}.${k}: unexpected in actual (${String(ao[k])})`);
        else if (!(k in ao)) diffs.push(`${path}.${k}: missing in actual (expected ${String(eo[k])})`);
        else walk(eo[k], ao[k], `${path}.${k}`);
      }
    }
  };
  walk(expected, actual, 'summary');
  return diffs;
}
