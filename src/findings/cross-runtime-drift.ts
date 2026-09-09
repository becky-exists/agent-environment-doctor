/**
 * CROSS_RUNTIME_DRIFT — 同名 skill が runtime 間で内容違い
 *
 * 条件: 同一 name・kind=skill の Resource が 2 つ以上あり、それぞれが**異なる runtime** の Binding で
 *       discovered=true、かつ normalized_hash が異なる。
 * 出さないもの: どちらを正本にすべきか（人が決める）。同一 runtime 内の重複（DUPLICATE_RESOURCE、Phase 2）。
 * 差分行数は normalized_hash が違うペアにだけ、readText がある時だけ計算する。
 */
import { diffLineCount } from '../ir/normalize.js';
import { unifiedDiffExcerpt, type DiffExcerpt } from '../ir/linediff.js';
import type { EvidenceRef, Finding, Resource, RuntimeId } from '../ir/types.js';
import { bindingsFor, newer, tilde, type DetectorResult, type FindingContext } from './context.js';

export async function detectCrossRuntimeDrift(ctx: FindingContext): Promise<DetectorResult> {
  const s = ctx.snapshot;
  const home = s.env.home;
  const findings: Finding[] = [];
  const skipped: DetectorResult['skipped'] = [];

  const byName = new Map<string, Resource[]>();
  for (const r of s.resources) {
    if (r.kind !== 'skill') continue;
    const arr = byName.get(r.name) ?? [];
    arr.push(r);
    byName.set(r.name, arr);
  }

  let needsTextButNoReader = 0;

  for (const [name, rs] of byName) {
    if (rs.length < 2) continue;
    // runtime ごとに「その runtime が発見している occurrence」
    const perRuntime = new Map<RuntimeId, Resource[]>();
    for (const r of rs) {
      for (const b of bindingsFor(s, r)) {
        if (!b.discovered) continue;
        const arr = perRuntime.get(b.runtime) ?? [];
        if (!arr.includes(r)) arr.push(r);
        perRuntime.set(b.runtime, arr);
      }
    }
    if (perRuntime.size < 2) continue; // 片方の runtime にしか無い、または片方は領域外 → drift ではない

    const runtimes = [...perRuntime.keys()].sort();
    // 2 runtime の組で、共通の normalized_hash が無ければ drift
    for (let i = 0; i < runtimes.length; i++) {
      for (let j = i + 1; j < runtimes.length; j++) {
        const a = perRuntime.get(runtimes[i]!)!;
        const b = perRuntime.get(runtimes[j]!)!;
        const ha = new Set(a.map((r) => r.normalized_hash));
        const shared = b.some((r) => ha.has(r.normalized_hash));
        if (shared) continue; // 同じ内容が両側にある。名前が同じだけで drift ではない（crlf-twin もここ）

        // 代表 = 各 runtime の一番新しい occurrence
        const ra = a.reduce((x, y) => (newer(x, y) ?? x));
        const rb = b.reduce((x, y) => (newer(x, y) ?? x));
        const nw = newer(ra, rb);

        let lines: number | null = null;
        let excerpt: DiffExcerpt | null = null;
        if (ctx.readText) {
          const [ta, tb] = await Promise.all([ctx.readText(ra.path), ctx.readText(rb.path)]);
          if (ta !== null && tb !== null) {
            lines = diffLineCount(ta, tb);
            // 受け手が「意図的な差か更新漏れか」を判断するには行数でなく本文が要る（ドッグフード 2026-09-07）
            excerpt = unifiedDiffExcerpt(ta, tb, `${runtimes[i]}:${tilde(ra.path, home)}`, `${runtimes[j]}:${tilde(rb.path, home)}`, ctx.diffLines);
          }
        } else needsTextButNoReader++;

        // 発火記録（usage_record）。どちらが使われているかは判断材料になるが、使われていない = 不要ではない
        const inv = (r: Resource) => s.observations.find((o) => o.resource_id === r.resource_id && o.resource_path === r.path && o.kind === 'invocation');
        const ia = inv(ra);
        const ib = inv(rb);

        const ba = bindingsFor(s, ra).find((x) => x.discovered && x.runtime === runtimes[i])!;
        const bb = bindingsFor(s, rb).find((x) => x.discovered && x.runtime === runtimes[j])!;
        const oa = s.observations.find((o) => o.resource_id === ra.resource_id && o.resource_path === ra.path && o.kind === 'mtime');
        const ob = s.observations.find((o) => o.resource_id === rb.resource_id && o.resource_path === rb.path && o.kind === 'mtime');

        const evidence: EvidenceRef[] = [
          { type: 'resource', resource_id: ra.resource_id, path: ra.path },
          { type: 'resource', resource_id: rb.resource_id, path: rb.path },
          { type: 'binding', binding_id: ba.binding_id, resource_id: ba.resource_id, resource_path: ba.resource_path, runtime: ba.runtime, mechanism: ba.mechanism, rule_id: ba.rule_id },
          { type: 'binding', binding_id: bb.binding_id, resource_id: bb.resource_id, resource_path: bb.resource_path, runtime: bb.runtime, mechanism: bb.mechanism, rule_id: bb.rule_id },
        ];
        for (const o of [oa, ob, ia, ib]) {
          if (o) evidence.push({ type: 'observation', resource_id: o.resource_id, resource_path: o.resource_path, runtime: o.runtime, kind: o.kind, method: o.method, scope: o.scope, measured_at: o.measured_at });
        }

        findings.push({
          finding_id: 'CROSS_RUNTIME_DRIFT',
          severity: 'warn',
          confidence: 'high',
          summary:
            `Skill "${name}" is discovered by ${runtimes[i]} at ${tilde(ra.path, home)} (${ra.mtime.slice(0, 10)}) and by ${runtimes[j]} at ${tilde(rb.path, home)} (${rb.mtime.slice(0, 10)}). ` +
            `Normalized content differs${lines !== null ? ` in ${lines} lines` : ''}. ` +
            (nw ? `The ${nw === ra ? runtimes[i] : runtimes[j]} copy has the later mtime; mtime says which was touched last, not which is correct.` : 'Both have the same mtime.'),
          subject: { name, resource_id: ra.resource_id, path: ra.path },
          evidence_refs: evidence,
          axes: ['provenance', 'temporal'],
          protected: false,
          scope: 'next_session',
          detail: {
            sides: [
              { runtime: runtimes[i], path: ra.path, real_path: ra.real_path ?? null, size_bytes: ra.size_bytes, mtime: ra.mtime, normalized_hash: ra.normalized_hash, later_mtime: nw === ra },
              { runtime: runtimes[j], path: rb.path, real_path: rb.real_path ?? null, size_bytes: rb.size_bytes, mtime: rb.mtime, normalized_hash: rb.normalized_hash, later_mtime: nw === rb },
            ],
            lines_differ: lines,
            diff_method: lines === null ? null : 'multiset_symmetric_difference',
            diff_excerpt: excerpt,
            invocations: {
              [runtimes[i]!]: ia ? { value: ia.value, method: ia.method, confidence: ia.confidence } : null,
              [runtimes[j]!]: ib ? { value: ib.value, method: ib.method, confidence: ib.confidence } : null,
            },
            within_runtime_duplicates: [...perRuntime.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ runtime: k, count: v.length })),
          },
        });
      }
    }
  }

  if (needsTextButNoReader > 0) skipped.push({ detector: 'CROSS_RUNTIME_DRIFT', reason: `lines_differ not computed for ${needsTextButNoReader} pair(s): no file reader (saved snapshot)` });

  // 差分行数の多い順に。同点は名前順
  findings.sort((x, y) => (Number(y.detail?.['lines_differ'] ?? -1) - Number(x.detail?.['lines_differ'] ?? -1)) || String(x.subject.name).localeCompare(String(y.subject.name)));
  return { findings, skipped };
}
