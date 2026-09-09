/**
 * HOOK_AMPLIFICATION — 同じものが複数経路で効いている / 意図以上の scope で増幅している
 *
 * **hook が多い = 悪ではない。** 登録されている数も、発火回数も、それ自体は症状ではない。
 * 症状として出すのは次の 3 つだけ:
 *
 *   same_registration_multiple_events : 同じコマンドが複数のイベントに登録されている（静的）。
 *                                        同じ payload が複数経路で入りうる
 *   identical_payload_repeated        : 1 セッションの中で、同じ hook が**バイト同一**の本文を
 *                                        何度も注入している（実測）。同じ文字列が context に N 回入っている
 *   scope_includes_subagents          : session と subagent の両方に効く登録があり、実際に注入がある。
 *                                        サブエージェントの起動数に比例して増える
 *
 * 出さないもの:
 *   - 登録数・発火回数が多いだけのもの（注入が 0 バイトの hook は何回発火しても症状ではない）
 *   - 「その hook を外すべき」という提案（治療しない）
 *
 * ⚠ 記録に残った出力の長さは、その全部が context に載ったことを意味しない（イベント種別で扱いが違う）。
 * だから confidence を上げず、根拠を「記録に残った注入の長さ」と明記する。
 */
import type { EvidenceRef, Finding, Resource, Snapshot } from '../ir/types.js';
import { bindingsFor, tilde, type DetectorResult, type FindingContext } from './context.js';

/** バイト同一の本文が何回入れば症状として出すか。意図的に単純化: 3 回。上限を変える必要が出たら設定へ */
const REPEAT_THRESHOLD = 3;

export function detectHookAmplification(ctx: FindingContext): DetectorResult {
  const s = ctx.snapshot;
  const home = s.env.home;
  const findings: Finding[] = [];
  const skipped: DetectorResult['skipped'] = [];

  // ── 1. 同じコマンドが複数イベントに登録されている（静的）─────────────────
  const byCommand = new Map<string, Array<{ r: Resource; event: string }>>();
  for (const r of s.resources) {
    if (r.kind !== 'hook_script') continue;
    const raw = (r.declared.raw ?? {}) as Record<string, unknown>;
    const cmd = typeof raw['command'] === 'string' ? raw['command'] : null;
    const event = typeof raw['event'] === 'string' ? raw['event'] : '?';
    if (!cmd) continue;
    (byCommand.get(cmd) ?? byCommand.set(cmd, []).get(cmd)!).push({ r, event });
  }

  for (const [cmd, entries] of byCommand) {
    const events = [...new Set(entries.map((e) => e.event))];
    if (events.length < 2) continue;
    // 発火の実測があれば添える（無くても静的な事実として出せる）。
    // #74: ここで ctx.hookFirings を渡し忘れると、--probe していてもしていなくても常に
    // 「実測 0」と同じ文言になり、probe 無し（unknown）と probe 有り観測 0（observed zero）が
    // 区別できなくなる。
    const measured = measuredFor(entries.map((e) => e.r), ctx.hookFirings);
    const ev: EvidenceRef[] = [];
    for (const e of entries.slice(0, 6)) {
      ev.push({ type: 'resource', resource_id: e.r.resource_id, path: e.r.path });
      for (const b of bindingsFor(s, e.r)) {
        ev.push({ type: 'binding', binding_id: b.binding_id, resource_id: b.resource_id, resource_path: b.resource_path, runtime: b.runtime, mechanism: b.mechanism, rule_id: b.rule_id });
        break;
      }
    }
    findings.push({
      finding_id: 'HOOK_AMPLIFICATION',
      subtype: 'same_registration_multiple_events',
      severity: 'warn',
      confidence: 'high',
      // #73: 実行コマンド文字列そのものは要約に埋め込まない。本文は detail.command にだけ置く
      // （bundle 投影は既に detail.command を shellShape() で潰している。通常の report では detail 経由で見える）
      summary:
        `The same hook command is registered on ${events.length} events (${events.join(', ')}) at ${entries.length} places, so whatever it produces can enter by that many routes (see detail.command for the registered command). ` +
        (!measured.observed
          ? `Hook firing was not observed (run with --probe); whether anything is injected through these routes is unknown.`
          : measured.total_bytes > 0
            ? `Session records show ${measured.firings} firing(s) producing ${measured.total_bytes.toLocaleString()} bytes in total.`
            : `Session records show no injected output for it, so the routes exist but nothing measurable entered the context.`),
      subject: { resource_id: entries[0]!.r.resource_id, path: entries[0]!.r.path, name: entries[0]!.r.name },
      evidence_refs: ev,
      axes: ['activation', 'provenance'],
      protected: false,
      scope: 'next_session',
      detail: {
        command: cmd,
        events,
        registrations: entries.map((e) => ({ path: tilde(e.r.path, home), event: e.event })),
        measured,
        note: 'Registration on several events is not itself a defect. It is reported because the same payload can reach the context by more than one route.',
      },
    });
  }

  // ── 2 & 3. 実測（セッション記録が要る）─────────────────────────────
  const firings = ctx.hookFirings;
  if (!firings || firings.size === 0) {
    skipped.push({
      detector: 'HOOK_AMPLIFICATION',
      reason: 'hook firings not observed (run with --probe). Without session records, only the static case (one command registered on several events) can be checked.',
    });
    return { findings, skipped };
  }

  for (const [sessionId, perHook] of firings) {
    const sess = s.sessions.find((x) => x.session_id === sessionId);
    for (const h of perHook.values()) {
      // 注入が 0 バイトの hook は何回発火しても症状ではない
      if (h.total_bytes === 0) continue;

      // 2. バイト同一の本文が繰り返し入っている
      const repeats = [...h.payload_digests.entries()].filter(([, n]) => n >= REPEAT_THRESHOLD).sort((a, b) => b[1] - a[1]);
      if (repeats.length) {
        const [digest, n] = repeats[0]!;
        const per = Math.round(h.total_bytes / Math.max(1, h.count));
        findings.push({
          finding_id: 'HOOK_AMPLIFICATION',
          subtype: 'identical_payload_repeated',
          severity: 'warn',
          confidence: 'medium',
          summary:
            `In session ${sessionId.slice(0, 8)}, hook "${h.name}" on ${h.event} injected byte-identical text ${n} times (${per.toLocaleString()} bytes each, ${h.total_bytes.toLocaleString()} bytes recorded in total across ${h.count} firing(s)). ` +
            `The same text is therefore present more than once. What the record shows is the output length; whether every byte reached the context depends on the hook event, so this is evidence rather than proof.`,
          subject: { name: h.name, runtime: sess?.runtime ?? 'claude-code', session_id: sessionId },
          evidence_refs: sessionEvidence(s, sessionId, `hook "${h.name}" on ${h.event}: ${n} firings with the same payload digest ${digest}`),
          axes: ['activation', 'temporal'],
          protected: false,
          scope: 'active_runtime',
          detail: { hook: h.name, event: h.event, firings: h.count, total_bytes: h.total_bytes, bytes_per_firing: per, identical_repeats: n, distinct_payloads: h.payload_digests.size, payload_digest: digest, command: h.command },
        });
      }
    }
  }

  // 3. session と subagent の両方に効く登録で、実際に注入があるもの
  for (const r of s.resources) {
    if (r.kind !== 'hook_script') continue;
    const bs = bindingsFor(s, r);
    const applies = new Set(bs.flatMap((b) => b.applies_to));
    if (!(applies.has('session') && applies.has('subagent'))) continue;
    const measured = measuredFor([r], firings);
    if (measured.total_bytes === 0) continue;
    findings.push({
      finding_id: 'HOOK_AMPLIFICATION',
      subtype: 'scope_includes_subagents',
      severity: 'warn',
      confidence: 'medium',
      summary:
        `${tilde(r.path, home)} is bound for both session and subagent scope, and session records show it injecting ${measured.total_bytes.toLocaleString()} bytes across ${measured.firings} firing(s). ` +
        `A hook with subagent scope runs again for every subagent, so the recorded amount grows with how many subagents start.`,
      subject: { resource_id: r.resource_id, path: r.path, name: r.name },
      evidence_refs: [
        { type: 'resource', resource_id: r.resource_id, path: r.path },
        ...bs.slice(0, 2).map((b): EvidenceRef => ({ type: 'binding', binding_id: b.binding_id, resource_id: b.resource_id, resource_path: b.resource_path, runtime: b.runtime, mechanism: b.mechanism, rule_id: b.rule_id })),
      ],
      axes: ['activation'],
      protected: false,
      scope: 'active_runtime',
      detail: { applies_to: [...applies], measured, note: 'Subagent scope is not a defect. It is reported so the cost per subagent is visible.' },
    });
  }

  // 注入 0 バイトの hook は観測として残す（多い = 悪 にしないことを明示する）
  let quiet = 0;
  let quietFirings = 0;
  for (const perHook of firings.values()) {
    for (const h of perHook.values()) {
      if (h.total_bytes === 0) {
        quiet++;
        quietFirings += h.count;
      }
    }
  }
  if (quiet) {
    skipped.push({
      detector: 'HOOK_AMPLIFICATION / no_injection',
      reason: `${quiet} hook(s) fired ${quietFirings} time(s) with no injected output in the records. Firing often is not reported: a hook that produces nothing adds nothing to the context.`,
    });
  }

  return { findings, skipped };
}

export interface HookFiring {
  name: string;
  event: string;
  count: number;
  total_bytes: number;
  command: string | null;
  payload_digests: Map<string, number>;
}

/**
 * この hook_script 群に対応する実測（発火回数・バイト数）を寄せる。
 *
 * `observed: false` = そもそも --probe していない（見ていない。unknown）。
 * `observed: true, total_bytes: 0` = probe した上でこの command の発火が無かった、
 * または在ったが 0 バイトだった（見て、無かった。observed zero）。この 2 つを summary 側で
 * 混同しないために区別して返す（#74）。
 *
 * 突合は **command の完全一致でだけ行う**。hook_script の name は `<Event>[i][j]` という
 * 収集器側の連番で、記録側の hookName（settings の hook 名）とは別物。event 名だけで寄せると
 * 「同じ event に登録された別の hook」の発火量をこの hook の実測であるかのように付けてしまう
 * （別 hook の event 一致だけで実測量を付けない、#74 acceptance criteria）。command が分からない
 * hook（raw.command が無い synthetic 等）は突合しようがないので、常に観測 0 のまま（過大に見せない）。
 */
function measuredFor(resources: Resource[], firings?: FindingContext['hookFirings']): { firings: number; total_bytes: number; sessions: number; observed: boolean } {
  if (!firings) return { firings: 0, total_bytes: 0, sessions: 0, observed: false };
  const commands = new Set(
    resources
      .map((r) => {
        const raw = (r.declared.raw ?? {}) as Record<string, unknown>;
        return typeof raw['command'] === 'string' ? raw['command'] : null;
      })
      .filter((c): c is string => c !== null),
  );
  let f = 0;
  let b = 0;
  const sess = new Set<string>();
  for (const [sid, perHook] of firings) {
    for (const h of perHook.values()) {
      if (h.command === null || !commands.has(h.command)) continue;
      f += h.count;
      b += h.total_bytes;
      sess.add(sid);
    }
  }
  return { firings: f, total_bytes: b, sessions: sess.size, observed: true };
}

function sessionEvidence(s: Snapshot, sessionId: string, note: string): EvidenceRef[] {
  const sess = s.sessions.find((x) => x.session_id === sessionId);
  if (!sess) return [{ type: 'absence', target: `session ${sessionId}`, searched: ['snapshot.sessions'] }];
  return [{ type: 'session', session_id: sess.session_id, runtime: sess.runtime, record_path: sess.record_path, started_at: sess.started_at, live: sess.live, note }];
}
