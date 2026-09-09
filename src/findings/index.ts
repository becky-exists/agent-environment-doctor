/**
 * Finding の実行 — 観測 → 証拠 → 症状 まで。治療はしない。
 *
 * 5 本:
 *   UNREACHABLE_REFERENCE / CROSS_RUNTIME_DRIFT / SCOPE_MISMATCH（静的、next_session）
 *   SESSION_STALENESS（active_runtime。--probe でセッション記録を読んだ時だけ）
 *   HOOK_AMPLIFICATION（静的な多経路 + --probe での注入実測）
 *
 * context cost（#56）は **Finding を出さない**。大きさは事実として report / UI に出すだけ。
 *
 * 毎回一緒に出すもの:
 *   suppressed : 数が大きい・使っていない・見えない・無効化されている、が Finding ではないもの（Optimizer でないことの証明）
 *   protected  : protected glob に当たった Finding は protected=true を立てる。**severity / confidence は下げない**。
 *                protected は「大きいから削れ / 使ってないから消せ」という最適化提案を止めるための保護であって、
 *                事実ベースの診断（参照先が無い等）の等級を変えるものではない（ゆう、2026-09-07）
 *   skipped    : 判定に必要な入力（本文等）が無くて評価しなかったもの（できるふりをしない）
 */
import type { Finding, Snapshot } from '../ir/types.js';
import { claudeCodeAdapter } from '../adapters/claude-code/index.js';
import { codexAdapter } from '../adapters/codex/index.js';
import { DISABLE_RULE, TERRITORY_RULE, assertLanguageDiscipline, bindingsFor, isProtected, tilde, type FindingContext, type Skipped, type Suppressed } from './context.js';
import { detectUnreachableReference } from './unreachable-reference.js';
import { detectCrossRuntimeDrift } from './cross-runtime-drift.js';
import { detectScopeMismatch } from './scope-mismatch.js';
import { detectSessionStaleness } from './session-staleness.js';
import { detectHookAmplification } from './hook-amplification.js';
import { computeContextCost, type ContextCost } from '../observe/context-cost.js';

export interface FindingsResult {
  findings: Finding[];
  suppressed: Suppressed[];
  protected: Array<{ path: string; size_bytes: number; glob: string }>;
  /** この実行で使った protected glob（report 側が同じ基準で protected_paths を出すため） */
  protected_globs: string[];
  skipped: Skipped[];
  /** 起動時に何がどれだけ載るか。**Finding ではない**。大きさは事実として出すだけ */
  context_cost: ContextCost;
}

export const DEFAULT_PROTECTED_GLOBS = [...new Set([...claudeCodeAdapter.protectedDefaults(), ...codexAdapter.protectedDefaults()])];

export async function runFindings(
  snapshot: Snapshot,
  opts: {
    readText?: FindingContext['readText'];
    protectedGlobs?: string[];
    diffLines?: number;
    argvTails?: Map<number, string>;
    capabilityDescriptions?: Map<string, Map<string, string>>;
    hookFirings?: FindingContext['hookFirings'];
  } = {},
): Promise<FindingsResult> {
  const ctx: FindingContext = { snapshot, protectedGlobs: opts.protectedGlobs ?? DEFAULT_PROTECTED_GLOBS };
  if (opts.readText) ctx.readText = opts.readText;
  if (opts.diffLines) ctx.diffLines = opts.diffLines;
  if (opts.argvTails) ctx.argvTails = opts.argvTails;
  if (opts.capabilityDescriptions) ctx.capabilityDescriptions = opts.capabilityDescriptions;
  if (opts.hookFirings) ctx.hookFirings = opts.hookFirings;

  const results = [detectUnreachableReference(ctx), await detectCrossRuntimeDrift(ctx), await detectScopeMismatch(ctx), await detectSessionStaleness(ctx), detectHookAmplification(ctx)];
  const findings: Finding[] = [];
  const skipped: Skipped[] = [];
  for (const r of results) {
    findings.push(...r.findings);
    skipped.push(...r.skipped);
  }

  // protected: 対象が protected glob に当たれば旗を立てる。severity はそのまま。
  // 意味は recommendation 側（LLM report の protected_handling）で「自動変更・削除は推奨しない」として伝える
  for (const f of findings) {
    if (f.subject.path && isProtected(f.subject.path, ctx.protectedGlobs)) f.protected = true;
    if (f.evidence_refs.length === 0) throw new Error(`Finding ${f.finding_id} has no evidence`);
    assertLanguageDiscipline(f);
  }

  const order = { error: 0, warn: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.finding_id.localeCompare(b.finding_id));

  // active_runtime を観測した時は、セッションを見たという事実自体を suppressed に残す（黙って落とさない）
  

  const context_cost = await computeContextCost(snapshot, (p) => isProtected(p, ctx.protectedGlobs), ctx.readText);
  return {
    findings,
    suppressed: computeSuppressed({ ...ctx, precomputedCost: context_cost }),
    protected: computeProtected(ctx),
    protected_globs: ctx.protectedGlobs,
    skipped,
    context_cost,
  };
}

/** Finding にしなかった「大きい数」。毎回明示する */
function computeSuppressed(ctx: FindingContext & { precomputedCost?: ContextCost }): Suppressed[] {
  const s = ctx.snapshot;
  const home = s.env.home;
  const out: Suppressed[] = [];

  const deferred = s.bindings.filter((b) => b.mechanism === 'mcp_config' && b.load_mode === 'deferred');
  if (deferred.length) {
    const byRt = new Map<string, number>();
    for (const b of deferred) byRt.set(b.runtime, (byRt.get(b.runtime) ?? 0) + 1);
    out.push({
      reason: 'count_is_not_a_symptom',
      detail: `${deferred.length} MCP server binding(s) (${[...byRt].map(([k, v]) => `${k} ${v}`).join(', ')}), load_mode=deferred. Count alone is not reported.`,
      count: deferred.length,
    });
  }

  const territory = s.bindings.filter((b) => !b.discovered && TERRITORY_RULE.test(b.rule_id));
  if (territory.length) {
    const byRule = new Map<string, number>();
    for (const b of territory) byRule.set(b.rule_id, (byRule.get(b.rule_id) ?? 0) + 1);
    out.push({
      reason: 'invisible_by_specification',
      detail: `${territory.length} binding(s) are discovered=false because the path belongs to another runtime (${[...byRule].map(([k, v]) => `${k}=${v}`).join(', ')}). Observation, not a finding.`,
      count: territory.length,
    });
  }

  const disabled = s.bindings.filter((b) => !b.discovered && DISABLE_RULE.test(b.rule_id));
  if (disabled.length) {
    out.push({
      reason: 'intentional_disable',
      detail: `${disabled.length} plugin entr${disabled.length === 1 ? 'y is' : 'ies are'} disabled (${disabled.map((b) => `${b.runtime}: ${b.resource_path.split('#')[1] ?? tilde(b.resource_path, home)}`).join('; ')}). Left as observation (review of disabled entries is out of scope for this phase); a reference that points into a disabled plugin is reported separately as missing_target.`,
      count: disabled.length,
    });
  }

  if (s.sessions.length) {
    const self = s.sessions.filter((x) => x.is_self).length;
    const side = s.sessions.filter((x) => x.is_sidechain).length;
    const notLive = s.sessions.filter((x) => !x.live).length;
    const byCap = s.sessions.filter((x) => x.comparable_capabilities).length;
    const byTs = s.sessions.filter((x) => x.comparable_timestamps).length;
    out.push({
      reason: 'sessions_excluded_by_design',
      detail:
        `${s.sessions.length} session record(s) read; ${byCap} compared by capability set and ${byTs} by timestamp. ` +
        `${self} identified as the Doctor's own session, ${side} subagent session(s), ${notLive} not recently active. ` +
        `Divergence in the Doctor's own session and in subagent sessions is expected and is not reported.`,
      count: s.sessions.length,
    });
  }

  // 大きさは事実。**Finding にしない**ことを毎回示す（suppressed は同期で組むので事前計算を渡す）
  const cost = ctx.precomputedCost!;
  const always = cost.by_load_mode['always'];
  if (always && always.items > 0) {
    const top = cost.largest.filter((x) => x.load_mode === 'always').slice(0, 3);
    out.push({
      reason: 'size_is_not_a_symptom',
      detail:
        `${always.items} item(s) load into every session, ${always.bytes.toLocaleString()} bytes in total` +
        (top.length ? ` (largest: ${top.map((x) => `${tilde(x.path, home)} ${x.bytes.toLocaleString()} B`).join(', ')})` : '') +
        `. Size is recorded as a fact and is not reported as a defect.`,
      count: always.items,
    });
  }
  const deferredCount = cost.by_load_mode['deferred']?.items ?? 0;
  if (deferredCount) {
    out.push({
      reason: 'deferred_cost_is_near_zero',
      detail: `${deferredCount} deferred item(s) contribute only their names at startup (${cost.by_load_mode['deferred']!.token_estimate} tokens by ${'tiktoken o200k (approximate)'}). Their schemas load on request.`,
      count: deferredCount,
    });
  }

  const unused = s.resources.filter((r) => {
    if (r.kind !== 'skill') return false;
    if (!bindingsFor(s, r).some((b) => b.discovered)) return false;
    const inv = s.observations.find((o) => o.resource_id === r.resource_id && o.resource_path === r.path && o.kind === 'invocation');
    return inv !== undefined && inv.value === 0;
  });
  if (unused.length) {
    out.push({
      reason: 'unused_is_not_unnecessary',
      detail: `${unused.length} discovered skill(s) have no recorded invocation (usage_record). Unused is not reported as a finding.`,
      count: unused.length,
    });
  }

  return out;
}

function computeProtected(ctx: FindingContext): FindingsResult['protected'] {
  const s = ctx.snapshot;
  const out: FindingsResult['protected'] = [];
  for (const r of s.resources) {
    const g = ctx.protectedGlobs.find((glob) => isProtected(r.path, [glob]));
    if (g) out.push({ path: r.path, size_bytes: r.size_bytes, glob: g });
  }
  return out.sort((a, b) => b.size_bytes - a.size_bytes);
}
