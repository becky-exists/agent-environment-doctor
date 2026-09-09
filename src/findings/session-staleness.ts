/**
 * SESSION_STALENESS — 設定した状態と、今動いているセッションの状態の食い違い
 *
 * 「直したのに直っていない」の正体。Doctor の信用を一度で失う種類の食い違いなので、
 * **断定できる範囲を狭く取り、確信度で正直に段を付ける。**
 *
 * subtype:
 *   capability_present_but_unconfigured : セッションは持っているが、今の設定では発見されない
 *                                         （移動・削除・無効化した後、そのセッションにだけ残っている）
 *   resource_changed_after_start        : セッション開始より後に、常時ロードされる資源の内容が変わった
 *                                         （そのセッションは古い本文を持ったまま。本文の記録が無いので mtime 比較）
 *   injection_digest_divergence         : 起動中プロセスが注入している本文と、今のファイルの本文が違う
 *                                         （起動スクリプトの --append-system-prompt。argv が一次事実）
 *   instruction_digest_divergence       : セッション開始時に載った命令本文と、今のファイルの本文が違う（Codex）
 *
 * 出さないもの:
 *   - **Doctor 自身のセッション**の食い違い（自分の context と診断結果が食い違うのは正常）
 *   - sidechain（サブエージェント）と非対話 entrypoint（sdk-*）のセッション。capability を絞って起動されるため
 *   - **「設定にはあるがセッションに無い」方向**（configured_but_absent）。起動フラグによる制限・
 *     起動後の追加・plugin の後付けなど無害な説明が多すぎる。実測で 545 件の偽陽性を出したので
 *     Finding にせず suppressed の観測として数だけ出す（「見えない = 異常」にしない）
 *   - **説明文が一致しない同名**。実測（2026-09-07）: セッションの skill "agmsg" は
 *     ~/.claude/commands/agmsg.md（スラッシュコマンド）だったが、~/.agents/skills/agmsg/SKILL.md という
 *     別物が同名で存在し、名前照合だけで「消えた skill を持ち続けている」と誤って報告した。
 *     名前が一致しても**説明文の先頭が一致しなければ別物**として扱う
 *   - **セッションが持つ名前が、収集した資源のどこにも無い場合**。実測 27 件のうち 26 件は
 *     CLI 同梱の skill / agent（dataviz・code-review・Explore・general-purpose 等）で、ファイルとして
 *     収集できない（coverage 外）。「人が消した」と「runtime に同梱」を区別できないので断定しない。
 *     報告するのは **同名のファイルが在るのに発見されていない** 場合だけ（= 移動・形式ミス・無効化の跡）
 *   - 「そのセッションを再起動すべき」という提案（治療しない）
 */
import type { EvidenceRef, Finding, Resource, SessionInfo, Snapshot } from '../ir/types.js';
import { bindingsFor, tilde, type DetectorResult, type FindingContext } from './context.js';
import { prefixMatches, promptDigest } from '../probe/process.js';

/** 起動中セッションで「持っている capability」の意味を持つ mechanism */
const CAPABILITY_MECHANISMS = new Set(['skill_description', 'agent_def', 'mcp_config']);

export async function detectSessionStaleness(ctx: FindingContext): Promise<DetectorResult> {
  const s = ctx.snapshot;
  const home = s.env.home;
  const findings: Finding[] = [];
  const skipped: DetectorResult['skipped'] = [];
  /** 「設定にはあるがセッションに無い」の件数。Finding にせず観測として出す */
  const absentCounts: Array<{ session_id: string; kind: string; count: number; configured: number }> = [];
  /** セッションは持っているが収集対象のどこにも無い名前（CLI 同梱の可能性）。同じく観測として出す */
  const notCollectedCounts: Array<{ session_id: string; kind: string; names: string[] }> = [];
  /**
   * 同名だが説明文が違う = 別物。誤診を避けて外したもの。
   * #73: 説明文そのもの（本文）は保持しない。一致したかどうかの事実だけで十分に skipped の理由が書ける
   */
  const nameCollisions: Array<{ session_id: string; kind: string; name: string; file_path: string }> = [];
  /** 説明文が観測できず裏取りできなかったもの */
  const unverified: Array<{ session_id: string; kind: string; name: string; file_path: string }> = [];

  if (s.sessions.length === 0 && s.processes.length === 0) {
    skipped.push({
      detector: 'SESSION_STALENESS',
      reason: 'active runtime not observed (run with --probe). Without it, this report describes only the next session; a running session may still hold an older state.',
    });
    return { findings, skipped };
  }

  // ── 対象セッション: capability 比較と時刻比較で別の集合（判定は probe/index.ts）──────
  const capCandidates = s.sessions.filter((x) => x.comparable_capabilities);
  const tsCandidates = s.sessions.filter((x) => x.comparable_timestamps);
  // 除外理由は 1 件ずつ並べず、理由ごとにまとめる（40 行の同文が出ていた）
  const byReason = new Map<string, string[]>();
  for (const x of s.sessions) {
    if (x.comparable_capabilities) continue;
    const r = x.not_comparable_reason ?? 'unknown';
    (byReason.get(r) ?? byReason.set(r, []).get(r)!).push(x.session_id.slice(0, 8));
  }
  for (const [r, ids] of byReason) {
    skipped.push({
      detector: 'SESSION_STALENESS / capability comparison',
      reason: `${ids.length} session(s) not compared by capability — ${r}. (${ids.slice(0, 6).join(', ')}${ids.length > 6 ? `, +${ids.length - 6} more` : ''})`,
    });
  }

  // ── 1. capability の集合差 ────────────────────────────────────────
  for (const sess of capCandidates) {
    // その runtime で「今の設定なら発見される」名前の集合
    const configured = new Map<string, Resource>();
    for (const r of s.resources) {
      const b = bindingsFor(s, r).find((x) => x.runtime === sess.runtime && x.discovered && CAPABILITY_MECHANISMS.has(x.mechanism));
      if (b) configured.set(kindKey(r.kind, r.name), r);
    }

    for (const [kind, observedNames] of observedSets(sess)) {
      const observed = new Set(observedNames);
      const configuredOfKind = new Map([...configured].filter(([k]) => k.startsWith(kind + ':')).map(([k, v]) => [k.slice(kind.length + 1), v]));

      // present but unconfigured
      const notCollected: string[] = [];
      for (const name of observed) {
        if (configuredOfKind.has(name)) continue;
        // 同名のファイルが在るのに発見されていない場合だけ報告する。
        // 収集したどこにも無い名前は CLI 同梱の可能性があり、「消した」と区別できない
        const undiscovered = s.resources.find((r) => r.name === name && bindingsFor(s, r).some((b) => b.runtime === sess.runtime && !b.discovered));
        if (!undiscovered) {
          notCollected.push(name);
          continue;
        }
        // 名前が一致しても別物のことがある。説明文の先頭で裏取りする
        const sessDesc = ctx.capabilityDescriptions?.get(sess.session_id)?.get(name) ?? null;
        const fileDesc = undiscovered.declared.description ?? null;
        if (sessDesc !== null && fileDesc !== null) {
          const a = sessDesc.trim();
          const b = fileDesc.trim().slice(0, a.length);
          if (a !== b && !a.startsWith(fileDesc.trim().slice(0, 40))) {
            // #73: 説明文の中身は持ち出さない。裏取りに失敗した事実（一致しなかった）だけを残す
            nameCollisions.push({ session_id: sess.session_id, kind, name, file_path: tilde(undiscovered.path, home) });
            continue;
          }
        } else if (sessDesc === null) {
          // 裏取りできない（説明が観測できていない）。断定しない
          unverified.push({ session_id: sess.session_id, kind, name, file_path: tilde(undiscovered.path, home) });
          continue;
        }
        const ev: EvidenceRef[] = [
          { type: 'session', session_id: sess.session_id, runtime: sess.runtime, record_path: sess.record_path, started_at: sess.started_at, live: sess.live, note: `${kind} "${name}" is in the session's startup ${kind} set` },
          { type: 'resource', resource_id: undiscovered.resource_id, path: undiscovered.path },
        ];
        for (const b of bindingsFor(s, undiscovered).filter((x) => x.runtime === sess.runtime)) {
          ev.push({ type: 'binding', binding_id: b.binding_id, resource_id: b.resource_id, resource_path: b.resource_path, runtime: b.runtime, mechanism: b.mechanism, rule_id: b.rule_id });
        }
        // 対照: 同じ探索パスで発見されている資源
        const contrast = s.resources.find((r) => r.name !== name && bindingsFor(s, r).some((b) => b.runtime === sess.runtime && b.discovered && b.mechanism === bindingsFor(s, undiscovered)[0]?.mechanism));
        if (contrast) ev.push({ type: 'contrast', resource_id: contrast.resource_id, path: contrast.path, note: `same mechanism, discovered=true — the session has this one and the configuration still provides it` });
        findings.push({
          finding_id: 'SESSION_STALENESS',
          subtype: 'capability_present_but_unconfigured',
          severity: 'warn',
          confidence: 'high',
          summary:
            `Session ${sess.session_id} (${sess.runtime}, started ${sess.started_at ?? 'unknown'}, last active ${sess.last_activity_at}) has ${kind} "${name}" in the set it was given at startup, ` +
            `while ${tilde(undiscovered.path, home)} exists now and is not discovered by ${sess.runtime} (${bindingsFor(s, undiscovered).find((b) => b.runtime === sess.runtime)?.rule_id ?? '?'}). ` +
            `The description recorded for the session matches the one declared in that file, so they are the same capability. ` +
            'A configuration change reaches a session only when it starts, so that session still has it.',
          subject: { name, runtime: sess.runtime, session_id: sess.session_id, resource_id: undiscovered.resource_id, path: undiscovered.path },
          evidence_refs: ev,
          axes: ['temporal', 'presence'],
          protected: false,
          scope: 'active_runtime',
          detail: {
            capability_kind: kind,
            capability_name: name,
            session: sessionDigest(sess, home),
            configured_state: 'present but not discovered',
            not_discovered_rule: bindingsFor(s, undiscovered).find((b) => b.runtime === sess.runtime)?.rule_id ?? null,
          },
        });
      }

      // 「設定にはあるがセッションに無い」方向は Finding にしない（無害な説明が多すぎる）。
      // 数だけ数えて suppressed に出す
      let absent = 0;
      for (const name of configuredOfKind.keys()) if (!observed.has(name)) absent++;
      if (absent) absentCounts.push({ session_id: sess.session_id, kind, count: absent, configured: configuredOfKind.size });
      if (notCollected.length) notCollectedCounts.push({ session_id: sess.session_id, kind, names: notCollected });
    }
  }

  // ── 3. 常時ロードされる資源が、セッション開始より後に変わった ─────────────
  //   セッション 1 本 = 1 Finding に畳む。資源ごとに出すと同じ事実が何十件にもなる
  //   （実測: MEMORY.md の symlink 29 本で 1 つの実体が 29 件に膨れた → resource_id で重複排除）
  for (const sess of tsCandidates) {
    if (!sess.started_at) continue;
    // 粒度は「実体ファイル」。settings.json#hooks.X[i] のような合成資源は 1 ファイルの mtime を共有するので、
    // 別々に数えると 1 つの変更が 8 件に見える（実測）。`#` より前で畳み、内訳は entries に残す
    const changed = new Map<string, { paths: string[]; entries: number; mtime: string; mechanism: string; kind: string; rule_id: string; binding_id: string; resource_id: string }>();
    for (const r of s.resources) {
      const b = bindingsFor(s, r).find((x) => x.runtime === sess.runtime && x.discovered && x.load_mode === 'always');
      if (!b) continue;
      if (!(r.mtime > sess.started_at)) continue;
      const file = r.path.split('#')[0]!;
      const key = `${file}|${b.mechanism}`;
      const e = changed.get(key);
      if (e) {
        e.entries++;
        if (!e.paths.includes(tilde(r.path, home)) && e.paths.length < 3) e.paths.push(tilde(r.path, home));
        continue;
      }
      changed.set(key, { paths: [tilde(file, home)], entries: 1, mtime: r.mtime, mechanism: b.mechanism, kind: r.kind, rule_id: b.rule_id, binding_id: b.binding_id, resource_id: r.resource_id });
    }
    if (changed.size === 0) continue;

    const items = [...changed.values()].sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    const ev: EvidenceRef[] = [
      { type: 'session', session_id: sess.session_id, runtime: sess.runtime, record_path: sess.record_path, started_at: sess.started_at, live: sess.live, note: `started before ${items.length} always-loaded file(s) were last modified` },
    ];
    // 同じ mechanism の binding を何本も並べない（実測で hook_registration が 8 本並んだ）
    const seenMech = new Set<string>();
    for (const it of items.slice(0, 8)) {
      ev.push({ type: 'resource', resource_id: it.resource_id, path: it.paths[0]! });
      if (seenMech.has(it.mechanism)) continue;
      seenMech.add(it.mechanism);
      const b = s.bindings.find((x) => x.binding_id === it.binding_id);
      if (b) ev.push({ type: 'binding', binding_id: b.binding_id, resource_id: b.resource_id, resource_path: b.resource_path, runtime: b.runtime, mechanism: b.mechanism, rule_id: b.rule_id });
    }
    const anyProtected = items.some((it) => it.kind === 'memory' || /MEMORY\.md|\/soul\/|CLAUDE\.md|AGENTS\.md/.test(it.paths[0]!));
    findings.push({
      finding_id: 'SESSION_STALENESS',
      subtype: 'resource_changed_after_start',
      severity: 'warn',
      // 本文の記録が無いので「古い本文を持っている」とまでは言えない。mtime の事実まで
      confidence: 'medium',
      summary:
        `Session ${sess.session_id} (${sess.runtime}) started ${sess.started_at} and is still active (${sess.last_activity_at}). ` +
        `${items.length} file(s) that load into every session (load_mode=always) have been modified since then (${mechBreakdown(items)}), most recently ${items[0]!.paths[0]} at ${items[0]!.mtime}. ` +
        `That session holds the content as of its start. The session record does not store instruction text for this runtime, so what it holds was not read; only timestamps were compared.`,
      subject: { runtime: sess.runtime, session_id: sess.session_id, name: sess.session_id },
      evidence_refs: ev,
      axes: ['temporal', 'activation'],
      protected: anyProtected,
      scope: 'active_runtime',
      detail: {
        session: sessionDigest(sess, home),
        session_started_at: sess.started_at,
        changed_count: items.length,
        changed: items.map((it) => ({ file: it.paths[0], kind: it.kind, mechanism: it.mechanism, mtime: it.mtime, rule_id: it.rule_id, entries_from_this_file: it.entries })),
        content_comparison: 'not possible (session records do not store instruction text for this runtime)',
      },
    });
  }

  // ── 4. プロセスが注入している本文と、今のファイルの本文が違う ─────────────
  if (ctx.readText) {
    const { extractLauncherInjections } = await import('../ir/binding.js');
    for (const launcher of s.resources.filter((r) => r.kind === 'launcher')) {
      const text = await ctx.readText(launcher.path);
      if (text === null) continue;
      const injections = extractLauncherInjections(text, home);
      for (const inj of injections) {
        const cur = await ctx.readText(inj.target);
        const curDigest = cur === null ? null : promptDigest(cur);
        for (const proc of s.processes) {
          if (!proc.appended_system_prompt) continue;
          const tail = ctx.argvTails?.get(proc.pid) ?? null;
          if (cur !== null && tail !== null) {
            const m = prefixMatches(tail, cur);
            // 一致 = そのプロセスは今のファイル本文で動いている
            if (m.match) continue;
            // 先頭も違う = そもそも別のファイルの注入。この injection の話ではない
            if (m.how === 'the opening text differs') continue;
          } else if (curDigest && proc.appended_system_prompt.sha256 === curDigest.sha256) {
            continue;
          } else if (tail === null) {
            // argv 末尾が取れていない（Snapshot 経由の分析など）。断定できないので出さない
            skipped.push({ detector: 'SESSION_STALENESS / injection_digest_divergence', reason: `pid ${proc.pid}: argv text not available in this run, so it was not compared against ${tilde(inj.target, home)}` });
            continue;
          }
          // 一致しないプロセスが、この注入の対象と関係あるかを示せる材料があるか
          findings.push({
            finding_id: 'SESSION_STALENESS',
            subtype: 'injection_digest_divergence',
            severity: 'warn',
            // argv の本文は ps の整形（改行の潰れ）を受けるので、指紋不一致だけで断定しない
            confidence: 'medium',
            summary:
              `Process ${proc.pid} (${proc.runtime}, started ${proc.started_at ?? 'unknown'}) was launched with --append-system-prompt carrying ${proc.appended_system_prompt.bytes} bytes, ` +
              `while ${tilde(launcher.path, home)}:${inj.line} now injects ${tilde(inj.target, home)}` +
              (curDigest ? ` whose current content is ${curDigest.bytes} bytes` : ' which is not readable now') +
              `. The text begins the same way and then diverges, so that process is running with content from before the file was last changed. ` +
              `argv cannot be tokenized reliably from \`ps\`, so this compares the file content against the whole tail after the flag; a divergence found this way is evidence, not proof.`,
            subject: { resource_id: launcher.resource_id, path: launcher.path, name: launcher.name, runtime: proc.runtime },
            evidence_refs: [
              { type: 'process', pid: proc.pid, runtime: proc.runtime, started_at: proc.started_at, note: `argv carries --append-system-prompt with ${proc.appended_system_prompt.bytes} bytes (digest ${proc.appended_system_prompt.sha256.slice(0, 19)})` },
              { type: 'resource', resource_id: launcher.resource_id, path: launcher.path, line: inj.line },
              ...(curDigest
                ? ([{ type: 'contrast', resource_id: launcher.resource_id, path: inj.target, note: `current content is ${curDigest.bytes} bytes (digest ${curDigest.sha256.slice(0, 19)})` }] as EvidenceRef[])
                : ([{ type: 'absence', target: inj.target, searched: [inj.target] }] as EvidenceRef[])),
            ],
            axes: ['temporal', 'provenance'],
            protected: false,
            scope: 'active_runtime',
            detail: {
              pid: proc.pid,
              process_started_at: proc.started_at,
              injected_bytes: proc.appended_system_prompt.bytes,
              injected_digest: proc.appended_system_prompt.sha256,
              current_target: inj.target,
              current_digest: curDigest?.sha256 ?? null,
              current_bytes: curDigest?.bytes ?? null,
              launcher_line: inj.line,
              note: 'Process-to-session attribution is not established; the pid is the evidence, not the session.',
            },
          });
        }
      }
    }
  }

  // ── 5. Codex: 起動時の命令本文と今のファイルが違う ────────────────────
  if (ctx.readText) {
    for (const sess of tsCandidates) {
      if (!sess.instruction_digest) continue;
      // Codex の base_instructions は AGENTS.md の連結 + 組み込み命令なので、単独ファイルとの一致は期待できない。
      // 「同じか違うか」を言えるのは、同じ session が前に記録した digest との比較（Phase 1 の history 待ち）。
      // ここでは事実だけ残し、Finding にはしない。
      skipped.push({
        detector: 'SESSION_STALENESS / instruction_digest_divergence',
        reason: `session ${sess.session_id} recorded a startup instruction digest (${sess.instruction_digest.bytes} B), but there is no baseline to compare it against: codex composes base_instructions from built-in text plus AGENTS.md, so it never equals a single file. Comparing across snapshots needs the history layer.`,
      });
    }
  }

  // 同名だが別物だったもの / 裏取りできなかったものを残す（黙って落とさない）
  for (const c of nameCollisions) {
    skipped.push({
      detector: 'SESSION_STALENESS / name_collision',
      reason:
        `session ${c.session_id.slice(0, 8)}: ${c.kind} "${c.name}" also exists as ${c.file_path}, but the description recorded for the session does not match the one declared in that file, ` +
        `so they are treated as different capabilities and no staleness is claimed.`,
    });
  }
  for (const u of unverified) {
    skipped.push({
      detector: 'SESSION_STALENESS / unverified_name',
      reason: `session ${u.session_id.slice(0, 8)}: ${u.kind} "${u.name}" matches ${u.file_path} by name, but no description was recorded for it in the session, so identity could not be corroborated and nothing is claimed.`,
    });
  }
  // セッションが持つが収集対象に無い名前（CLI 同梱の可能性）は観測として残す
  for (const n of notCollectedCounts) {
    skipped.push({
      detector: 'SESSION_STALENESS / present_but_not_collected',
      reason:
        `session ${n.session_id.slice(0, 8)}: ${n.names.length} ${n.kind}(s) in its startup set are not in the collected configuration (${n.names.slice(0, 6).join(', ')}${n.names.length > 6 ? `, +${n.names.length - 6} more` : ''}). ` +
        `Not reported: capabilities bundled with the runtime are not collected as files, so "removed from the configuration" and "shipped with the runtime" cannot be told apart from these facts.`,
    });
  }
  // 「設定にはあるがセッションに無い」は観測として残す
  for (const a of absentCounts) {
    skipped.push({
      detector: 'SESSION_STALENESS / configured_but_absent',
      reason: `session ${a.session_id.slice(0, 8)}: ${a.count} of ${a.configured} configured ${a.kind}(s) are not in its startup set. Not reported as a finding: a session can be launched with restricted capability flags, and a capability can be added after a session starts. Observation only.`,
    });
  }

  return { findings, skipped };
}

/** mechanism ごとの内訳。hook の変更と命令本文の変更は意味が違うので分けて見せる */
function mechBreakdown(items: Array<{ mechanism: string; entries: number }>): string {
  const m = new Map<string, { files: number; entries: number }>();
  for (const it of items) {
    const e = m.get(it.mechanism) ?? { files: 0, entries: 0 };
    e.files++;
    e.entries += it.entries;
    m.set(it.mechanism, e);
  }
  return [...m]
    .sort((a, b) => b[1].files - a[1].files)
    .map(([k, v]) => (v.entries > v.files ? `${k} ${v.files} file (${v.entries} entries)` : `${k} ${v.files}`))
    .join(', ');
}

function kindKey(kind: string, name: string): string {
  const k = kind === 'skill' ? 'skill' : kind === 'agent_def' ? 'agent' : kind === 'mcp_server' ? 'mcp' : kind;
  return `${k}:${name}`;
}

/** セッションから観測できた capability 集合を (kind, names) で返す。null の種別は出さない */
function observedSets(sess: SessionInfo & { capabilities?: unknown }): Array<[string, string[]]> {
  const caps = (sess as unknown as { capabilities?: Record<string, string[] | null> }).capabilities;
  if (!caps) return [];
  const out: Array<[string, string[]]> = [];
  if (caps['skills']) out.push(['skill', caps['skills']]);
  if (caps['agents']) out.push(['agent', caps['agents']]);
  return out;
}

function searchPathsOf(s: Snapshot, runtime: string, kind: string): string[] {
  const set = new Set<string>();
  for (const b of s.bindings) {
    if (b.runtime !== runtime || !b.search_path) continue;
    if (kind === 'skill' && b.mechanism !== 'skill_description') continue;
    if (kind === 'agent' && b.mechanism !== 'agent_def') continue;
    set.add(b.search_path);
  }
  return [...set];
}

function sessionDigest(sess: SessionInfo, home: string): Record<string, unknown> {
  return {
    session_id: sess.session_id,
    runtime: sess.runtime,
    record_path: tilde(sess.record_path, home),
    started_at: sess.started_at,
    last_activity_at: sess.last_activity_at,
    live: sess.live,
    live_is_heuristic: true,
    runtime_version: sess.runtime_version,
    observed_capability_kinds: sess.observed_capability_kinds,
  };
}

function mtimeObs(s: Snapshot, r: Resource): EvidenceRef | null {
  const o = s.observations.find((x) => x.resource_id === r.resource_id && x.resource_path === r.path && x.kind === 'mtime');
  if (!o) return null;
  return { type: 'observation', resource_id: o.resource_id, resource_path: o.resource_path, runtime: o.runtime, kind: o.kind, method: o.method, scope: o.scope, measured_at: o.measured_at };
}
