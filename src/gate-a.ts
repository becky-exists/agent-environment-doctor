/**
 * Gate A — IR が実データで自然に表現できているかの検査
 *
 * ゆうの指示: Claude Adapter → IR 生成までで一度止めて、
 *   Resource / Binding / Observation / Snapshot / raw reference / evidence
 * が自然に表現できているかを実データで確認する。
 * 不自然なら Codex Adapter を足して誤魔化さず、IR を先に直す。
 *
 * ここは診断（Finding）を出す場所ではない。**IR の健全性だけを見る。**
 */

import { normalizeContent, sha256 } from './ir/normalize.js';
import type { Snapshot, Resource, Binding, EvidenceRef } from './ir/types.js';

export interface GateCheck {
  id: string;
  question: string;
  pass: boolean;
  detail: string;
  /** 落ちた時に何を直すべきか */
  fix?: string;
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
  /** 目視用のサンプル */
  samples: {
    resource: Resource | null;
    binding: Binding | null;
    /** raw reference を持つ Resource の例 */
    withReferences: Array<{ path: string; refs: number; sample: string }>;
    /** 同名で内容が違う資源（CROSS_RUNTIME_DRIFT の土台） */
    driftCandidates: Array<{ name: string; paths: string[] }>;
    /** evidence chain が組めるかの実演 */
    evidenceChain: EvidenceRef[];
  };
}

export function runGateA(s: Snapshot): GateResult {
  const checks: GateCheck[] = [];
  const add = (c: GateCheck) => checks.push(c);

  // ── 1. Resource: 同一性が content hash で機能しているか
  const dupIds = new Map<string, string[]>();
  for (const r of s.resources) {
    const arr = dupIds.get(r.resource_id) ?? [];
    arr.push(r.path);
    dupIds.set(r.resource_id, arr);
  }
  const sameContentDifferentPath = [...dupIds.entries()].filter(([, ps]) => ps.length > 1);
  add({
    id: 'resource.identity_is_content',
    question: 'resource_id は内容 hash として機能しているか（同内容が別パスにあれば同一 id になる）',
    pass: s.resources.length > 0,
    detail:
      `resources=${s.resources.length}, 同内容で複数パスに存在=${sameContentDifferentPath.length} 件` +
      (sameContentDifferentPath.length
        ? `（例: ${sameContentDifferentPath[0]![1].slice(0, 2).join(' / ')}）`
        : ''),
    fix: s.resources.length === 0 ? '収集が 0 件。searchPaths か HOME の解決を確認' : undefined,
  });

  // ── 2. Resource: normalized_hash が drift 判定の土台として機能しているか
  //
  // 注: 実環境のファイルは概ね LF・末尾整形済みなので normalized == content になるのが正常。
  // 「差が出ること」ではなく「drift 判定に使える状態か」を問う。
  //   (a) 全件 normalized_hash が埋まっている
  //   (b) 同名の資源で normalized_hash の一致/不一致が分かれる（= 真の drift を切り分けられる）
  //   (c) 正規化が CRLF 差を吸収する（合成ケースで実証。ここだけ合成を使う）
  const missingNorm = s.resources.filter((r) => !r.normalized_hash).length;
  const byName = new Map<string, Resource[]>();
  for (const r of s.resources) {
    if (r.kind !== 'skill') continue;
    const arr = byName.get(r.name) ?? [];
    arr.push(r);
    byName.set(r.name, arr);
  }
  const sameName = [...byName.entries()].filter(([, rs]) => rs.length > 1);
  const identical = sameName.filter(([, rs]) => new Set(rs.map((r) => r.normalized_hash)).size === 1).length;
  const drifted = sameName.filter(([, rs]) => new Set(rs.map((r) => r.normalized_hash)).size > 1).length;
  const crlfAbsorbed = sha256(normalizeContent('a\r\nb\r\n')) === sha256(normalizeContent('a\nb\n'));
  add({
    id: 'resource.normalized_hash_usable_for_drift',
    question: 'normalized_hash が drift 判定の土台として機能しているか（同名資源の一致/不一致を切り分けられるか）',
    pass: missingNorm === 0 && sameName.length > 0 && drifted > 0 && identical > 0 && crlfAbsorbed,
    detail:
      `normalized_hash 欠落=${missingNorm} / 同名 skill=${sameName.length} 組（内容一致=${identical}, 差分あり=${drifted}） / ` +
      `CRLF 吸収=${crlfAbsorbed ? 'ok' : 'NG'}`,
    fix:
      missingNorm > 0
        ? 'normalized_hash が空。makeResource を確認'
        : !crlfAbsorbed
          ? '正規化が CRLF を吸収していない。normalize.ts を確認'
          : sameName.length === 0
            ? '同名資源が 1 組も無い。cross-runtime 収集ができていない可能性'
            : drifted === 0 || identical === 0
              ? '同名資源が全て一致 or 全て不一致。drift の切り分けを実データで確認できない'
              : undefined,
  });

  // ── 1.5 Resource が runtime 非依存として重複排除されているか
  //
  // 実測で見つけた欠陥: 複数 adapter が同じパスを収集する（~/.agents/skills は
  // claude 側では「探索対象外」、codex 側では「探索対象」として両方が読む）ため、
  // 重複排除しないと同じ実体が Resource 配列に 2 回入る。
  const rKeys = new Map<string, number>();
  for (const r of s.resources) {
    const k = `${r.resource_id}|${r.path}`;
    rKeys.set(k, (rKeys.get(k) ?? 0) + 1);
  }
  const rDup = [...rKeys.values()].filter((n) => n > 1).length;
  add({
    id: 'resource.runtime_independent',
    question: 'Resource は runtime 非依存として重複排除されているか（同じ実体が 2 回入っていないか）',
    pass: rDup === 0,
    detail: rDup === 0 ? `${s.resources.length} 件すべて一意 (resource_id, path)` : `重複 ${rDup} 件`,
    fix: rDup > 0 ? 'collect() で (resource_id, path) をキーに重複排除する。Resource に runtime を持たせない' : undefined,
  });

  // ── 2.5 Binding / Observation の一意キーが衝突しないか
  //
  // 実測で見つけた欠陥: 内容が完全一致する資源が複数パスに在ると resource_id が同じになるため、
  // (resource_id, runtime) だけでは Binding を識別できず、snapshot diff が偽の差分を出した。
  // 一意キーに resource_path を含める必要がある。
  //   一意キーは binding_id = (runtime, resource_id, resource_path, mechanism, source_ref)。
  //   path 抜き / mechanism 抜きで何件つぶれるかも出す（なぜそのキーが要るかの実データ）
  const bKeys = new Map<string, number>();
  for (const b of s.bindings) bKeys.set(b.binding_id, (bKeys.get(b.binding_id) ?? 0) + 1);
  const bCollide = [...bKeys.values()].filter((n) => n > 1).length;
  const bKeysWithoutPath = new Set(s.bindings.map((b) => `${b.resource_id}|${b.runtime}`)).size;
  const bKeysWithoutMech = new Set(s.bindings.map((b) => `${b.resource_id}|${b.runtime}|${b.resource_path}`)).size;
  const oKeys = new Map<string, number>();
  for (const o of s.observations) {
    const k = `${o.resource_id}|${o.resource_path}|${o.runtime ?? '-'}|${o.kind}|${o.method}`;
    oKeys.set(k, (oKeys.get(k) ?? 0) + 1);
  }
  const oCollide = [...oKeys.values()].filter((n) => n > 1).length;
  add({
    id: 'binding.key_uniqueness',
    question: 'Binding / Observation の一意キーが衝突しないか（同一内容が複数パスに在っても識別できるか）',
    pass: bCollide === 0 && oCollide === 0,
    detail:
      `Binding 衝突=${bCollide}（binding_id ${bKeys.size} キー / mechanism 抜き ${bKeysWithoutMech} / path 抜き ${bKeysWithoutPath}` +
      `${bKeys.size !== bKeysWithoutMech ? ` ← mechanism が無いと ${bKeys.size - bKeysWithoutMech} 件つぶれる` : ''}` +
      `${bKeysWithoutMech !== bKeysWithoutPath ? `, path が無いと更に ${bKeysWithoutMech - bKeysWithoutPath} 件` : ''}）, ` +
      `Observation 衝突=${oCollide}`,
    fix: bCollide + oCollide > 0 ? 'binding_id が衝突している（同じ結合を 2 回作っている）。Observation は kind/method の粒度を見直す' : undefined,
  });

  // ── 3. Binding: 全 Resource（occurrence = resource_id + path）に Binding が付いているか
  //   Codex レビュー 1-a: resource_id だけで見ると、同一内容の別パスに Binding が無くても見逃す
  const boundOcc = new Set(s.bindings.map((b) => `${b.resource_id}|${b.resource_path}`));
  const unbound = s.resources.filter((r) => !boundOcc.has(`${r.resource_id}|${r.path}`));
  add({
    id: 'binding.covers_all_resources',
    question: '全 Resource occurrence（resource_id + path）に Binding が付いているか',
    pass: unbound.length === 0,
    detail: unbound.length ? `Binding 無し ${unbound.length} 件（例: ${unbound[0]!.path}）` : `全 ${s.resources.length} 件に Binding あり`,
    fix: unbound.length ? 'computeBindings の分岐漏れ。kind を網羅しているか確認' : undefined,
  });

  // ── 4. Binding: rule_id が必ず埋まっているか（規則の追跡可能性）
  const noRule = s.bindings.filter((b) => !b.rule_id);
  add({
    id: 'binding.rule_id_present',
    question: 'Binding は必ず rule_id を持つか（規則が変わった時に過去の判定を検証できるか）',
    pass: noRule.length === 0,
    detail: noRule.length ? `rule_id 欠落 ${noRule.length} 件` : `全 ${s.bindings.length} 件に rule_id あり`,
    fix: noRule.length ? 'rule_id を必須にする。規則を書けないなら confidence: probe_required で明示' : undefined,
  });

  // ── 5. Binding: discovered=false が実在するか（到達不能を表現できているか）
  const undiscovered = s.bindings.filter((b) => !b.discovered);
  const byRule = new Map<string, number>();
  for (const b of undiscovered) byRule.set(b.rule_id, (byRule.get(b.rule_id) ?? 0) + 1);
  add({
    id: 'binding.expresses_unreachable',
    question: '「存在するが発見されない」を Binding で表現できているか',
    pass: undiscovered.length > 0,
    detail: undiscovered.length
      ? `discovered=false ${undiscovered.length} 件: ` + [...byRule].map(([k, v]) => `${k}=${v}`).join(', ')
      : 'discovered=false が 0 件（実環境には到達不能な資源があるはずなので、規則の適用漏れの可能性）',
    fix: undiscovered.length === 0 ? '平置き skill / 探索対象外パスを収集しているか確認' : undefined,
  });

  // ── 6. Binding: load_mode が複数種類出ているか（Activation 軸が機能しているか）
  const modes = new Map<string, number>();
  for (const b of s.bindings) modes.set(b.load_mode, (modes.get(b.load_mode) ?? 0) + 1);
  add({
    id: 'binding.load_mode_variety',
    question: 'load_mode が実データで複数種類に分かれるか（Activation / Scope 軸が機能しているか）',
    pass: modes.size >= 3,
    detail: [...modes].map(([k, v]) => `${k}=${v}`).join(', '),
    fix: modes.size < 3 ? 'always / path_conditional / on_demand / deferred / never の判定分岐を確認' : undefined,
  });

  // ── 7. Observation: method と scope が必ず埋まっているか
  const badObs = s.observations.filter((o) => !o.method || !o.scope || !o.tool_version);
  add({
    id: 'observation.method_scope_required',
    question: 'Observation は method / scope / tool_version を必ず持つか（証拠の等級が残るか）',
    pass: badObs.length === 0 && s.observations.length > 0,
    detail: `observations=${s.observations.length}, 欠落=${badObs.length}`,
    fix: badObs.length ? 'method / scope / tool_version を必須にする' : undefined,
  });

  // ── 8. Observation: 同一 resource に method 違いが並存できる構造か
  const obsKinds = new Map<string, Set<string>>();
  for (const o of s.observations) {
    const k = `${o.resource_id}|${o.kind}`;
    const set = obsKinds.get(k) ?? new Set();
    set.add(o.method);
    obsKinds.set(k, set);
  }
  const methodsUsed = new Set(s.observations.map((o) => o.method));
  add({
    id: 'observation.multi_method_capable',
    question: '同じ量を別 method で観測した時に並存できるか（chars/4 と tiktoken を別物として持てるか）',
    pass: methodsUsed.size >= 2,
    detail: `使用中の method: ${[...methodsUsed].join(', ')}`,
    fix: methodsUsed.size < 2 ? 'Observation を (resource, kind, method) で一意にし、上書きしない設計か確認' : undefined,
  });

  // ── 9. raw reference: 解決前の文字列が一次事実として残っているか
  const withRefs = s.resources.filter((r) => r.references.length > 0);
  const totalRefs = withRefs.reduce((n, r) => n + r.references.length, 0);
  const refSyntaxes = new Set(withRefs.flatMap((r) => r.references.map((x) => x.syntax)));
  add({
    id: 'reference.raw_preserved',
    question: 'raw reference が解決前の文字列 + 行番号として残っているか',
    pass: totalRefs > 0 && refSyntaxes.size >= 2,
    detail: `参照を持つ resource=${withRefs.length}, 総参照=${totalRefs}, syntax 種別=${[...refSyntaxes].join(',')}`,
    fix: totalRefs === 0 ? 'extractReferences が動いていない。抽出パターンを確認' : undefined,
  });

  // ── 10. Snapshot: 自己完結しているか（後から Graph を生成できるか）
  const resourceIds = new Set(s.resources.map((r) => r.resource_id));
  const danglingBindings = s.bindings.filter((b) => !resourceIds.has(b.resource_id)).length;
  const danglingObs = s.observations.filter((o) => !resourceIds.has(o.resource_id)).length;
  add({
    id: 'snapshot.self_contained',
    question: 'Snapshot 単体で Graph を再生成できるか（Binding/Observation の参照先が全て内包されているか）',
    pass: danglingBindings === 0 && danglingObs === 0,
    detail: `孤立 Binding=${danglingBindings}, 孤立 Observation=${danglingObs}`,
    fix: danglingBindings + danglingObs > 0 ? 'Snapshot に resource を全部入れる。id の生成規則を統一' : undefined,
  });

  // ── 11. evidence: 一次事実まで辿れる chain が組めるか（実演）
  //   Codex レビュー 1-a: Binding / Observation は path 込みで選ぶ（別パスの証拠を指さない）
  const target = s.resources.find((r) => r.references.length > 0 && r.kind === 'agent_def')
    ?? s.resources.find((r) => r.references.length > 0)
    ?? null;
  const targetBinding = target ? s.bindings.find((b) => b.resource_id === target.resource_id && b.resource_path === target.path) ?? null : null;
  const targetObs = target ? s.observations.find((o) => o.resource_id === target.resource_id && o.resource_path === target.path) ?? null : null;
  const chain: EvidenceRef[] = [];
  if (target) {
    chain.push({ type: 'resource', resource_id: target.resource_id, path: target.path });
    const ref = target.references[0]!;
    chain.push({ type: 'reference', resource_id: target.resource_id, path: target.path, raw: ref.raw, line: ref.line });
    if (targetBinding)
      chain.push({
        type: 'binding',
        binding_id: targetBinding.binding_id,
        resource_id: target.resource_id,
        resource_path: targetBinding.resource_path,
        runtime: targetBinding.runtime,
        mechanism: targetBinding.mechanism,
        rule_id: targetBinding.rule_id,
      });
    if (targetObs)
      chain.push({
        type: 'observation',
        resource_id: target.resource_id,
        resource_path: targetObs.resource_path,
        runtime: targetObs.runtime,
        kind: targetObs.kind,
        method: targetObs.method,
        scope: targetObs.scope,
        measured_at: targetObs.measured_at,
      });
    chain.push({ type: 'absence', target: ref.raw, searched: ['(demo) enabledPlugins', 'installed_plugins.json', 'plugins/cache'] });
  }
  add({
    id: 'evidence.chain_constructible',
    question: 'Finding から一次事実まで辿る evidence chain が組めるか（absence も表現できるか）',
    pass: chain.length >= 4,
    detail: chain.length ? `chain 長=${chain.length}, 種別=${[...new Set(chain.map((c) => c.type))].join(',')}` : 'chain を組めなかった',
    fix: chain.length < 4 ? 'reference を持つ resource が無い、または Binding/Observation が紐付いていない' : undefined,
  });

  // ── 12. protected: 保護対象が識別できているか
  const protectedish = s.resources.filter((r) => r.kind === 'memory' || /MEMORY\.md|\/soul\//.test(r.path));
  add({
    id: 'protected.identifiable',
    question: 'protected 対象（memory / identity）を Resource から識別できるか',
    pass: protectedish.length > 0,
    detail: protectedish.length ? `${protectedish.length} 件（例: ${protectedish[0]!.path}）` : 'memory kind が 0 件',
    fix: protectedish.length === 0 ? 'memory の収集パスを確認（~/.claude/projects/<slug>/memory/）' : undefined,
  });

  // ── 13. Binding: mechanism / source_ref / binding_id が全件に在り、binding_id が一意か
  const noMech = s.bindings.filter((b) => !b.mechanism || !b.source_ref || !b.binding_id).length;
  const idSet = new Set(s.bindings.map((b) => b.binding_id));
  const mechs = new Set(s.bindings.map((b) => b.mechanism));
  add({
    id: 'binding.mechanism_and_provenance',
    question: 'Binding は mechanism（どう結合するか）と source_ref（誰が結合を作ったか）を必ず持ち、binding_id が一意か',
    pass: noMech === 0 && idSet.size === s.bindings.length && s.bindings.length > 0,
    detail: `欠落=${noMech}, binding_id 一意=${idSet.size}/${s.bindings.length}, mechanism 種別=${[...mechs].sort().join(',')}`,
    fix: noMech ? 'withBindingId を通していない Binding がある' : idSet.size !== s.bindings.length ? '同じ (runtime, resource, path, mechanism, source_ref) の Binding が 2 回作られている' : undefined,
  });

  // ── 14. Binding: 同じファイルが同じ runtime に複数の機構で入るケースを表現できるか（二重注入）
  //   launcher が明示されていなければ n/a（Phase 0 は全域探索しない）。できるふりをしない
  const byOcc = new Map<string, Set<string>>();
  for (const b of s.bindings) {
    if (!b.discovered) continue;
    const k = `${b.runtime}|${b.resource_path}`;
    const set = byOcc.get(k) ?? new Set<string>();
    set.add(b.mechanism);
    byOcc.set(k, set);
  }
  const multi = [...byOcc.entries()].filter(([, m]) => m.size > 1);
  const appendBindings = s.bindings.filter((b) => b.mechanism === 'append_system_prompt');
  const launchersGiven = s.env.launchers.length > 0;
  add({
    id: 'binding.multi_mechanism_expressible',
    question: '同じファイルが同じ runtime に別の機構で 2 回入る結合を、別 Binding として表現できるか（launcher 明示時）',
    pass: launchersGiven ? appendBindings.length > 0 : true,
    detail: launchersGiven
      ? `launcher=${s.env.launchers.length}, append_system_prompt Binding=${appendBindings.length}, 複数機構で入る occurrence=${multi.length}` +
        (multi.length ? `（例: ${multi[0]![0]} → ${[...multi[0]![1]].join('+')}）` : '（この環境では二重注入なし）')
      : 'n/a — --launcher 未指定。Phase 0 は起動スクリプトを明示分しか読まない（coverage 参照）',
    fix: launchersGiven && appendBindings.length === 0 ? 'launcher の --append-system-prompt "$(cat …)" を抽出できていない、または対象ファイルが Resource 化されていない' : undefined,
  });

  // ── 15. exec_policy は prompt rule と混ざっていないか（Codex .rules を always にしない）
  const execPol = s.bindings.filter((b) => b.mechanism === 'exec_policy');
  const badExec = execPol.filter((b) => b.load_mode === 'always' || b.load_mode === 'path_conditional');
  const ruleKindOnRules = s.resources.filter((r) => r.kind === 'rule' && /\.rules$/.test(r.path)).length;
  add({
    id: 'binding.exec_policy_separated',
    question: 'Codex の rules/*.rules は exec_policy として分離され、prompt の load_mode（always 等）を持っていないか',
    pass: badExec.length === 0 && ruleKindOnRules === 0,
    detail: `exec_policy Binding=${execPol.length}, 誤って always/path_conditional=${badExec.length}, kind=rule のまま残る .rules=${ruleKindOnRules}`,
    fix: badExec.length || ruleKindOnRules ? '.rules は kind=exec_policy / load_mode=unknown にする（SCOPE_MISMATCH の偽陽性源）' : undefined,
  });

  return {
    pass: checks.every((c) => c.pass),
    checks,
    samples: {
      resource: s.resources[0] ?? null,
      binding: s.bindings[0] ?? null,
      withReferences: withRefs.slice(0, 5).map((r) => ({
        path: r.path.replace(process.env['HOME'] ?? '~', '~'),
        refs: r.references.length,
        sample: r.references[0]!.raw,
      })),
      evidenceChain: chain,
      driftCandidates: sameName
        .filter(([, rs]) => new Set(rs.map((r) => r.normalized_hash)).size > 1)
        .slice(0, 6)
        .map(([name, rs]) => ({ name, paths: rs.map((r) => r.path.replace(process.env['HOME'] ?? '~', '~')) })),
    },
  };
}

export function formatGateResult(g: GateResult): string {
  const L: string[] = [];
  L.push('');
  L.push('════════ Gate A — IR が実データで自然に表現できているか ════════');
  L.push('');
  for (const c of g.checks) {
    L.push(`${c.pass ? '✅' : '❌'} ${c.id}`);
    L.push(`   Q: ${c.question}`);
    L.push(`   → ${c.detail}`);
    if (!c.pass && c.fix) L.push(`   FIX: ${c.fix}`);
  }
  L.push('');
  L.push('── raw reference を持つ Resource（サンプル）');
  for (const w of g.samples.withReferences) L.push(`   ${w.path}  refs=${w.refs}  例: ${w.sample}`);
  L.push('');
  L.push('── 同名で内容が違う資源（CROSS_RUNTIME_DRIFT の土台）');
  for (const d of g.samples.driftCandidates) L.push(`   ${d.name}: ${d.paths.join('  vs  ')}`);
  L.push('');
  L.push('── evidence chain の実演');
  for (const e of g.samples.evidenceChain) {
    const d = e.type === 'absence' ? `searched ${e.searched.length} places for "${e.target}"` : JSON.stringify(e).slice(0, 180);
    L.push(`   [${e.type}] ${d}`);
  }
  L.push('');
  L.push(g.pass ? '════════ Gate A: PASS ════════' : '════════ Gate A: FAIL — IR を直す（Codex Adapter を足して誤魔化さない）════════');
  return L.join('\n');
}
