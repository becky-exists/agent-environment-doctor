/**
 * fixture 4 本 — IR がすでに満たしているべき事実（ir_preconditions）を実データで検証する
 *
 * Finding は未実装。ここで見るのは「Finding 側が読むであろう IR の事実が正しく出ているか」。
 * Finding が入ったら、末尾の `findings` ブロックに expected.findings / no_findings の照合を足す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FIXTURES, FIXTURE_NAMES, collectFixture, expand, fixtureHome, loadExpectation } from './helpers.js';
import type { Snapshot } from '../src/ir/types.js';

const FINDING_IDS = new Set([
  'UNREACHABLE_REFERENCE', 'CROSS_RUNTIME_DRIFT', 'SCOPE_MISMATCH',
  'SESSION_STALENESS', 'HOOK_AMPLIFICATION', 'TOMBSTONE_ENTRY', 'FIXED_COST_WITHOUT_USAGE',
  'CONTEXT_TAX', 'DUPLICATE_RESOURCE', 'SHARED_RESOURCE_COUPLING', 'RUNTIME_FORMAT_DIVERGENCE',
  'PROTECTED_HEAVY', 'BASELINE_REGRESSION',
]);

/** `~/x/y#frag` の実体ファイル（`#` より前）が fixture に在るか */
async function fileBehind(p: string, home: string): Promise<boolean> {
  const real = expand(p, home).split('#')[0]!;
  try {
    await access(real);
    return true;
  } catch {
    return false;
  }
}

function findResource(s: Snapshot, path: string) {
  return s.resources.find((r) => r.path === path);
}

for (const name of FIXTURE_NAMES) {
  test(`fixture ${name}: expected.json の形`, async () => {
    const exp = await loadExpectation(name);
    assert.equal(exp.schema, 'agent-doctor-fixture-expectation/1');
    assert.equal(exp.fixture, name);
    assert.ok(Array.isArray(exp.findings));
    assert.ok(Array.isArray(exp.no_findings));
    assert.ok(Array.isArray(exp.ir_preconditions) && exp.ir_preconditions.length > 0, 'ir_preconditions が空');
    for (const f of exp.findings) {
      assert.ok(FINDING_IDS.has(String(f['finding_id'])), `未知の finding_id: ${String(f['finding_id'])}`);
      assert.ok(typeof f['why'] === 'string' && f['why'], 'findings[].why が無い');
      assert.ok(Array.isArray(f['evidence_must_include']) && (f['evidence_must_include'] as unknown[]).length > 0, 'evidence_must_include が空（根拠なき期待値）');
    }
    for (const n of exp.no_findings) assert.ok(typeof n.why === 'string' && n.why.length > 10, 'no_findings[].why が無い（何の原則を守る対照か書く）');
    // 参照しているパスは fixture 内に実在する（期待値が幽霊を指していない）
    const home = fixtureHome(name, exp);
    const paths = [...exp.findings, ...exp.no_findings, ...exp.ir_preconditions]
      .map((x) => x['path'])
      .filter((p): p is string => typeof p === 'string');
    for (const p of paths) assert.ok(await fileBehind(p, home), `expected.json が指すパスが fixture に無い: ${p}`);
    // notes.md がある
    await access(join(FIXTURES, name, 'notes.md'));
  });

  test(`fixture ${name}: 実環境を読まない`, async () => {
    const exp = await loadExpectation(name);
    const s = await collectFixture(name, exp);
    const home = fixtureHome(name, exp);
    assert.ok(s.resources.length > 0, '収集 0 件');
    for (const r of s.resources) assert.ok(r.path.startsWith(home), `fixture 外を読んだ: ${r.path}`);
    for (const rt of s.runtimes) assert.ok(rt.config_home.startsWith(home), `config_home が fixture 外: ${rt.config_home}`);
    assert.equal(s.env.home, home);
  });

  test(`fixture ${name}: ir_preconditions`, async () => {
    const exp = await loadExpectation(name);
    const s = await collectFixture(name, exp);
    const home = fixtureHome(name, exp);

    for (const pre of exp.ir_preconditions) {
      const label = JSON.stringify(pre);

      if (typeof pre['count_kind'] === 'string') {
        const n = s.resources.filter((r) => r.kind === pre['count_kind']).length;
        assert.ok(n >= Number(pre['min'] ?? 0), `${label}: actual ${n}`);
        continue;
      }

      if (typeof pre['same_name'] === 'string') {
        const rs = s.resources.filter((r) => r.kind === 'skill' && r.name === pre['same_name']);
        assert.ok(rs.length >= 2, `${label}: 同名が ${rs.length} 件しか無い`);
        const normEq = new Set(rs.map((r) => r.normalized_hash)).size === 1;
        assert.equal(normEq, pre['normalized_hash_equal'], `${label}: normalized_hash_equal`);
        if ('content_hash_equal' in pre) {
          const contentEq = new Set(rs.map((r) => r.content_hash)).size === 1;
          assert.equal(contentEq, pre['content_hash_equal'], `${label}: content_hash_equal`);
        }
        continue;
      }

      const path = expand(String(pre['path']), home);
      const r = findResource(s, path);
      assert.ok(r, `${label}: Resource が無い ${path}`);

      if (typeof pre['kind'] === 'string') assert.equal(r.kind, pre['kind'], `${label}: kind`);
      if (typeof pre['min_size_bytes'] === 'number') assert.ok(r.size_bytes >= pre['min_size_bytes'], `${label}: size ${r.size_bytes}`);

      if (pre['reference'] && typeof pre['reference'] === 'object') {
        const want = pre['reference'] as { raw: string; syntax: string; line: number };
        const hit = r.references.find((x) => x.raw === want.raw && x.syntax === want.syntax && x.line === want.line);
        assert.ok(hit, `${label}: reference が無い。実際: ${JSON.stringify(r.references)}`);
      }

      if (pre['line_matches'] && typeof pre['line_matches'] === 'object') {
        const { line, pattern } = pre['line_matches'] as { line: number; pattern: string };
        const text = await readFile(path, 'utf8');
        const l = text.split(/\r\n?|\n/)[line - 1] ?? '';
        assert.ok(l.includes(pattern), `${label}: L${line} に "${pattern}" が無い: ${l}`);
      }

      if (typeof pre['runtime'] === 'string') {
        const all = s.bindings.filter((x) => x.runtime === pre['runtime'] && x.resource_path === path);
        if (typeof pre['bindings_count'] === 'number') {
          assert.equal(all.length, pre['bindings_count'], `${label}: Binding 本数。実際: ${all.map((x) => x.mechanism).join(',')}`);
          continue;
        }
        const b = typeof pre['mechanism'] === 'string' ? all.find((x) => x.mechanism === pre['mechanism']) : all[0];
        assert.ok(b, `${label}: Binding が無い（ある mechanism: ${all.map((x) => x.mechanism).join(',')}）`);
        assert.ok(b.binding_id && b.mechanism && b.source_ref, `${label}: binding_id / mechanism / source_ref が空`);
        if (pre['source_ref'] && typeof pre['source_ref'] === 'object') {
          const want = pre['source_ref'] as { type: string; resource_path?: string; locator?: string | null };
          assert.equal(b.source_ref.type, want.type, `${label}: source_ref.type`);
          if (b.source_ref.type === 'resource' && want.resource_path)
            assert.equal(b.source_ref.resource_path, expand(want.resource_path, home), `${label}: source_ref.resource_path`);
          if (b.source_ref.type === 'resource' && 'locator' in want) assert.equal(b.source_ref.locator, want.locator, `${label}: source_ref.locator`);
        }
        if ('discovered' in pre) assert.equal(b.discovered, pre['discovered'], `${label}: discovered`);
        if ('rule_id' in pre) assert.equal(b.rule_id, pre['rule_id'], `${label}: rule_id`);
        if ('load_mode' in pre) assert.equal(b.load_mode, pre['load_mode'], `${label}: load_mode`);
        if ('scope_condition' in pre) assert.deepEqual(b.scope_condition, pre['scope_condition'], `${label}: scope_condition`);
        assert.ok(b.rule_id, `${label}: rule_id が空`);
      }

      if (pre['observation'] && typeof pre['observation'] === 'object') {
        const want = pre['observation'] as { kind: string; value: unknown };
        const o = s.observations.find((x) => x.resource_path === path && x.kind === want.kind);
        assert.ok(o, `${label}: Observation が無い`);
        assert.equal(o.value, want.value, `${label}: value`);
        assert.ok(o.method && o.scope, `${label}: method / scope が空`);
      }
    }
  });
}

test('guard-false-bloat: 期待値は findings: []（製品思想の回帰）', async () => {
  const exp = await loadExpectation('guard-false-bloat');
  assert.deepEqual(exp.findings, []);
  assert.ok(exp.guard, 'guard の宣言文が無い');
  // 「見えない = 異常にしない」の両向きが対照として入っている
  const s = await collectFixture('guard-false-bloat', exp);
  const home = fixtureHome('guard-false-bloat', exp);
  const codexOnlyFromClaude = s.bindings.find((b) => b.runtime === 'claude-code' && b.resource_path === expand('~/.agents/skills/codex-only/SKILL.md', home));
  const claudeOnlyFromCodex = s.bindings.find((b) => b.runtime === 'codex' && b.resource_path === expand('~/.claude/skills/claude-only/SKILL.md', home));
  assert.ok(codexOnlyFromClaude && !codexOnlyFromClaude.discovered && /not_in_search_path$/.test(codexOnlyFromClaude.rule_id));
  assert.ok(claudeOnlyFromCodex && !claudeOnlyFromCodex.discovered && /not_in_standard_locations$/.test(claudeOnlyFromCodex.rule_id));
  // TODO(Finding 実装後): runFindings(s) が [] を返すことをここで assert する。
  // これが落ちたビルドは他が全部通っていても不合格。
});

test('二重注入: 同じファイルが rule_autoload と append_system_prompt の 2 本の Binding を持ち、binding_id が別（Codex レビュー 2-A）', async () => {
  const exp = await loadExpectation('scope-mismatch');
  const s = await collectFixture('scope-mismatch', exp);
  const home = fixtureHome('scope-mismatch', exp);
  const bs = s.bindings.filter((b) => b.runtime === 'claude-code' && b.resource_path === expand('~/.claude/rules/channels-only.md', home));
  assert.deepEqual(bs.map((b) => b.mechanism).sort(), ['append_system_prompt', 'rule_autoload']);
  assert.notEqual(bs[0]!.binding_id, bs[1]!.binding_id);
  // 旧キー (runtime, resource_id, resource_path) では同一に見える = ここが潰れていた
  assert.equal(new Set(bs.map((b) => `${b.runtime}|${b.resource_id}|${b.resource_path}`)).size, 1);
  // 起動スクリプトの参照は raw のまま残る（解決は分析側）
  const launcher = s.resources.find((r) => r.kind === 'launcher')!;
  assert.ok(launcher.references.some((x) => x.syntax === 'path_ref' && x.raw === '~/.claude/rules/channels-only.md'));
});

test('discovered=false の判定基準: 領域（in_search_path=false）と形状（requires_dir_skill_md）を Binding で区別できる', async () => {
  const exp = await loadExpectation('unreachable-reference');
  const s = await collectFixture('unreachable-reference', exp);
  const home = fixtureHome('unreachable-reference', exp);
  const flat = s.bindings.filter((b) => b.resource_path === expand('~/.claude/skills/flat-orphan.md', home));
  assert.equal(flat.length, 2, '両 runtime の Binding がある');
  const claude = flat.find((b) => b.runtime === 'claude-code')!;
  const codex = flat.find((b) => b.runtime === 'codex')!;
  // 形状で落ちている（= Finding 候補）
  assert.equal(claude.rule_id, 'claude.skill.requires_dir_skill_md');
  assert.ok(claude.search_path && claude.search_path.startsWith(home), 'claude 側は探索対象パスの中に在る');
  // 領域で落ちている（= Observation）。「標準探索場所外」であって「常に対象外」ではない（skills.config で明示参照できる）
  assert.equal(codex.rule_id, 'codex.skill.not_in_standard_locations');
  // 同じ discovered=false でも rule_id が違う。ここが崩れると 72 件の偽 Finding が出る
  assert.notEqual(claude.rule_id, codex.rule_id);
});
