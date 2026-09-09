/**
 * UNREACHABLE_REFERENCE — 到達できない、の裏表
 *
 *   undiscovered_declaration : 宣言はあるが、どの runtime からも発見されない。
 *                              ただし「探索対象の場所に、発見されない形式で置いてある」時だけ。
 *                              他 runtime の領域に在るだけ（TERRITORY_RULE）や意図的な無効化は Observation。
 *   missing_target           : 参照（`ns:name`）の先が、どの runtime にも到達可能な形で存在しない。
 *                              「なぜ無いと言えるか」= 探した場所を全部 searched[] に列挙する。
 */
import type { AccessRecord, Binding, EvidenceRef, Finding, Resource, RuntimeInfo, Snapshot } from '../ir/types.js';
import { DISABLE_RULE, SHAPE_RULE, bindingsFor, tilde, type DetectorResult, type FindingContext, type Skipped } from './context.js';
import { joinPreservingStyle as join } from '../ir/slug.js';

/**
 * plugin の在否を主張する根拠にしている探索先。runtime ごとに違う（#74）。
 * ここが `failed` / `permission_denied` 等（= 読めなかった）だと、「plugin が無い」と「読めなかった」が
 * 見分けられなくなる。`observed`（読めて、中身から判断できた）と `absent`（ファイル自体が無い、正常な事実）
 * だけが「無いと言ってよい」根拠になる。
 */
function pluginSourceTargets(rt: RuntimeInfo): string[] {
  return rt.runtime === 'claude-code'
    ? [join(rt.config_home, 'plugins', 'installed_plugins.json'), join(rt.config_home, 'settings.json')]
    : [join(rt.config_home, 'config.toml')];
}

/** その runtime の plugin 探索先で、読めなかった access 記録だけを返す。空 = 「無い」と言ってよい */
function pluginSourceUnreadable(s: Snapshot, rt: RuntimeInfo): AccessRecord[] {
  const targets = pluginSourceTargets(rt);
  return (s.access ?? []).filter((a) => targets.includes(a.target) && a.status !== 'observed' && a.status !== 'absent');
}

export function detectUnreachableReference(ctx: FindingContext): DetectorResult {
  const s = ctx.snapshot;
  const home = s.env.home;
  const findings: Finding[] = [];
  const skipped: Skipped[] = [];

  // ── undiscovered_declaration ──────────────────────────────────────────
  for (const r of s.resources) {
    if (r.kind !== 'skill') continue;
    const bs = bindingsFor(s, r);
    if (bs.length === 0 || bs.some((b) => b.discovered)) continue;
    const shape = bs.find((b) => SHAPE_RULE.test(b.rule_id));
    if (!shape) continue; // 全部が領域 or 無効化の理由 → 仕様どおりの不可視。Finding にしない
    if (bs.some((b) => DISABLE_RULE.test(b.rule_id))) continue;

    // 対照: 同じ探索パスで、同じ runtime に発見されている skill
    const contrast = s.resources.find(
      (x) =>
        x.kind === 'skill' &&
        x.path !== r.path &&
        shape.search_path !== null &&
        x.path.startsWith(shape.search_path) &&
        bindingsFor(s, x).some((b) => b.discovered && b.runtime === shape.runtime),
    );

    const evidence: EvidenceRef[] = [{ type: 'resource', resource_id: r.resource_id, path: r.path }];
    for (const b of bs) evidence.push(bindingRef(b));
    if (contrast) evidence.push({ type: 'contrast', resource_id: contrast.resource_id, path: contrast.path, note: `same search path, <dir>/SKILL.md form, discovered=true on ${shape.runtime}` });

    findings.push({
      finding_id: 'UNREACHABLE_REFERENCE',
      subtype: 'undiscovered_declaration',
      severity: 'error',
      confidence: shape.confidence === 'high' ? 'high' : 'medium',
      summary:
        `${tilde(r.path, home)} is a skill declaration placed directly under ${tilde(shape.search_path ?? '', home)}/. ` +
        `${shape.runtime} reads only <dir>/SKILL.md there (${shape.rule_id}), and no other runtime discovers this path either.`,
      subject: { resource_id: r.resource_id, path: r.path, name: r.name, runtime: shape.runtime },
      evidence_refs: evidence,
      axes: ['presence'],
      protected: false,
      scope: 'next_session',
      detail: { rule_id: shape.rule_id, rule_source: shape.rule_source, search_path: shape.search_path, other_runtimes: bs.filter((b) => b !== shape).map((b) => `${b.runtime}:${b.rule_id}`) },
    });
  }

  // ── missing_target ────────────────────────────────────────────────────
  // 到達可能な名前。skill と agent_def（plugin のものは "<plugin>:<name>" の名で収集されている。`ns:name` は両方を指しうる）
  const reachable = new Set<string>();
  for (const r of s.resources) if ((r.kind === 'skill' || r.kind === 'agent_def') && bindingsFor(s, r).some((b) => b.discovered)) reachable.add(r.name);

  // plugin の名前空間: "<ns>@<marketplace>" の ns。enabled かどうかは Binding.discovered
  const pluginState = new Map<string, { enabled: boolean; bindings: Binding[]; resource: Resource }[]>();
  for (const r of s.resources) {
    if (r.kind !== 'plugin') continue;
    const ns = r.name.split('@')[0]!.toLowerCase();
    const bs = bindingsFor(s, r);
    const arr = pluginState.get(ns) ?? [];
    arr.push({ enabled: bs.some((b) => b.discovered), bindings: bs, resource: r });
    pluginState.set(ns, arr);
  }
  // plugin 由来の skill が 1 本でも収集されていれば、その ns は「実体あり」
  for (const r of s.resources) if (r.owner.startsWith('plugin:')) {
    const ns = r.owner.slice('plugin:'.length).split('@')[0]!.toLowerCase();
    if (!pluginState.has(ns)) pluginState.set(ns, []);
  }

  const searched = searchedPlaces(ctx);

  // runtime ごとに「plugin 一覧が読めたか」。読めなかった runtime があると、その runtime に
  // 実体が在る可能性を否定できない（#74: unobserved ≠ absent）
  const unreadableByRuntime = new Map<string, AccessRecord[]>();
  for (const rt of s.runtimes) {
    if (!rt.present) continue;
    const bad = pluginSourceUnreadable(s, rt);
    if (bad.length) unreadableByRuntime.set(rt.runtime, bad);
  }

  // 同じ raw を参照している箇所を全部まとめて 1 Finding にする（cross-runtime の複製が見える）
  const byRaw = new Map<string, Array<{ r: Resource; line: number }>>();
  for (const r of s.resources) {
    if (r.kind === 'launcher') continue;
    for (const ref of r.references) {
      if (ref.syntax !== 'skill_ref') continue;
      if (reachable.has(ref.raw)) continue;
      const arr = byRaw.get(ref.raw) ?? [];
      arr.push({ r, line: ref.line });
      byRaw.set(ref.raw, arr);
    }
  }

  for (const [raw, referrers] of byRaw) {
    const ns = raw.split(':')[0]!.toLowerCase();
    const plugins = pluginState.get(ns);

    // ns がどの runtime にも実体が無い、と言い切れるのは、判定に使う plugin 一覧が全部読めた時だけ。
    // 読めなかった runtime がある場合、そこに `ns` が在る可能性を否定できない → 主張せず skip
    if (!plugins && unreadableByRuntime.size > 0) {
      const reasons = [...unreadableByRuntime.entries()]
        .map(([rtId, bad]) => `${rtId}: ${bad.map((a) => `${a.target} (${a.status}${a.error_code ? `/${a.error_code}` : ''})`).join(', ')}`)
        .join('; ');
      skipped.push({
        detector: 'UNREACHABLE_REFERENCE',
        reason: `\`${raw}\` (namespace \`${ns}\`) — plugin source could not be read for ${reasons}, so absence cannot be claimed (a failed read is not the same as an observed empty list).`,
      });
      continue;
    }

    const status: 'plugin_absent' | 'plugin_disabled' | 'plugin_present_skill_missing' =
      !plugins ? 'plugin_absent' : plugins.some((p) => p.enabled) ? 'plugin_present_skill_missing' : 'plugin_disabled';

    // 参照元の順序: claude-code 側（agent_def / skill）を主対象に
    const sorted = [...referrers].sort((a, b) => kindRank(a.r) - kindRank(b.r) || a.r.path.localeCompare(b.r.path));
    const primary = sorted[0]!;
    const primaryRuntime = bindingsFor(s, primary.r).find((b) => b.discovered)?.runtime;

    const evidence: EvidenceRef[] = [];
    for (const x of sorted) evidence.push({ type: 'reference', resource_id: x.r.resource_id, path: x.r.path, raw, line: x.line });
    evidence.push({ type: 'absence', target: raw, searched });
    for (const p of plugins ?? []) for (const b of p.bindings) evidence.push(bindingRef(b));
    // 対照: 同じ参照元にある、解決できる skill_ref
    const ok = primary.r.references.find((x) => x.syntax === 'skill_ref' && reachable.has(x.raw));
    if (ok) {
      const target = s.resources.find((x) => (x.kind === 'skill' || x.kind === 'agent_def') && x.name === ok.raw && bindingsFor(s, x).some((b) => b.discovered));
      if (target) evidence.push({ type: 'contrast', resource_id: target.resource_id, path: target.path, note: `\`${ok.raw}\` on line ${ok.line} of the same file resolves to this skill (discovered=true)` });
    }

    const where = sorted.map((x) => `${tilde(x.r.path, home)}:${x.line}`);
    // runtime ごとの plugin 状態（ドッグフード指摘: Codex の disabled を根拠に Claude 側も同じに見えていた）
    const byRuntime: Record<string, 'not_installed' | 'disabled' | 'enabled' | 'unknown'> = {};
    for (const rt of s.runtimes) {
      if (!rt.present) continue;
      // この runtime の plugin 一覧が読めていなければ「無い」と言わない（#74）
      if (unreadableByRuntime.has(rt.runtime)) {
        byRuntime[rt.runtime] = 'unknown';
        continue;
      }
      const ps = (plugins ?? []).filter((p) => p.bindings.some((b) => b.runtime === rt.runtime));
      byRuntime[rt.runtime] = ps.length === 0 ? 'not_installed' : ps.some((p) => p.enabled) ? 'enabled' : 'disabled';
    }
    const perRuntimeText = Object.entries(byRuntime)
      .map(([k, v]) => {
        if (v === 'unknown') {
          const bad = unreadableByRuntime.get(k) ?? [];
          return `${k}: unknown (${bad.map((a) => `${a.target} could not be read: ${a.status}${a.error_code ? `/${a.error_code}` : ''}`).join(', ')}; presence/absence not established)`;
        }
        if (v === 'disabled') {
          // enabled=false が明示されているのか、既定値なのかを添える（受け手が「意図的な無効化か」を読むため）
          const explicit = (plugins ?? []).some((p) => p.bindings.some((b) => b.runtime === k) && (p.resource.declared.raw as Record<string, unknown> | undefined)?.['enabled'] === false);
          return `${k}: disabled (${explicit ? 'enabled=false set explicitly' : 'not enabled'}, ${k === 'codex' ? '$CODEX_HOME/config.toml layer only; <project>/.codex not read' : 'user layer only'})`;
        }
        if (v === 'not_installed') return `${k}: not installed (${k === 'claude-code' ? 'installed_plugins.json + settings.json#enabledPlugins at user layer; project-layer enabledPlugins not read' : 'config.toml#plugins'})`;
        return `${k}: enabled`;
      })
      .join('; ');
    const statusText =
      status === 'plugin_absent'
        ? `No plugin or skill named \`${ns}\` is installed, enabled, or collected for any runtime (${perRuntimeText})`
        : status === 'plugin_disabled'
          ? `Plugin \`${ns}\` appears in configuration and is not enabled in any runtime (${perRuntimeText})`
          : `Plugin \`${ns}\` is enabled (${perRuntimeText}) but no collected skill or agent is named \`${raw}\``;

    // 確信度の等級:
    //   ns が plugin として実在（有効・無効を問わず）→ 参照先が本当に無い。error / high
    //   ns 不明でも agent 定義の中 → agent 定義は skill を列挙する場所。error / high（fixture の ghost:some-skill）
    //   ns 不明で skill 本文・instruction の中 → `type:name` のようなラベルの可能性が残る。warn / medium で正直に出す
    const nsKnown = plugins !== undefined;
    const strong = nsKnown || primary.r.kind === 'agent_def';
    findings.push({
      finding_id: 'UNREACHABLE_REFERENCE',
      subtype: 'missing_target',
      severity: strong ? 'error' : 'warn',
      confidence: strong ? 'high' : 'medium',
      summary:
        `${where[0]} references \`${raw}\`${where.length > 1 ? ` (also at ${where.slice(1).join(', ')})` : ''}. ` +
        `${statusText}. Searched ${searched.length} places.` +
        (strong ? '' : ` The namespace \`${ns}\` is not a known plugin; this may be a label rather than a skill reference.`),
      subject: { resource_id: primary.r.resource_id, path: primary.r.path, name: primary.r.name, ...(primaryRuntime ? { runtime: primaryRuntime } : {}) },
      evidence_refs: evidence,
      axes: ['presence', 'provenance'],
      protected: false,
      scope: 'next_session',
      detail: {
        reference: raw,
        status: nsKnown ? status : 'namespace_unknown',
        referrers: where,
        plugin_namespace: ns,
        plugin_status_by_runtime: byRuntime,
        // 参照元の性質。agent 定義 / skill 本文 / instruction の中の文字列はモデルが読む散文であり、runtime が起動時に解決するフィールドではない
        referrer_context: `${primary.r.kind} body text (prose read by the model; not a field the runtime resolves at startup). Runtime effect of an unresolved name is not observed statically.`,
      },
    });
  }

  return { findings, skipped };
}

function bindingRef(b: Binding): EvidenceRef {
  return { type: 'binding', binding_id: b.binding_id, resource_id: b.resource_id, resource_path: b.resource_path, runtime: b.runtime, mechanism: b.mechanism, rule_id: b.rule_id };
}

function kindRank(r: Resource): number {
  return r.kind === 'agent_def' ? 0 : r.kind === 'skill' ? 1 : r.kind === 'instruction' ? 2 : 3;
}

/** 「探したが無かった」の探索先。runtime が present なものだけ列挙する。テストで直接検証するため export */
export function searchedPlaces(ctx: FindingContext): string[] {
  const s = ctx.snapshot;
  const out: string[] = [];
  for (const rt of s.runtimes) {
    if (!rt.present) continue;
    if (rt.runtime === 'claude-code') {
      out.push(`${join(rt.config_home, 'settings.json')}#enabledPlugins`);
      out.push(`${join(rt.config_home, 'plugins', 'installed_plugins.json')}#plugins`);
      out.push(join(rt.config_home, 'skills', '<dir>', 'SKILL.md'));
      if (s.env.project) out.push(join(s.env.project, '.claude', 'skills', '<dir>', 'SKILL.md'));
      out.push(`<installPath>/skills/<dir>/SKILL.md (plugins listed in installed_plugins.json)`);
    } else {
      out.push(`${join(rt.config_home, 'config.toml')}#plugins`);
      out.push(`${join(rt.config_home, 'config.toml')}#skills.config[].path`);
      out.push(join(s.env.home, '.agents', 'skills', '<dir>', 'SKILL.md'));
      out.push(join(rt.config_home, 'skills', '<dir>', 'SKILL.md'));
    }
  }
  return out;
}
