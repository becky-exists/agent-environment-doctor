/**
 * #74 — 観測失敗から不存在を断定しない
 *
 *   unreachable-reference: installed_plugins.json / config.toml が壊れて読めなかった時、
 *   「plugin が無い」（plugin_absent / not_installed / severity error）に化けさせない。
 *   読めて中身が空（正常な事実）は従来どおり欠落として扱う（regression させない）。
 *
 *   hook-amplification: probe が無い（そもそも見ていない）と、probe はあるが実測 0 バイト
 *   （見て、無かった）を summary の文言で混同しない。event 名の一致だけで、別 hook の実測量を
 *   付けない（command が一致した時だけ measured に加える）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { claudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { codexAdapter } from '../src/adapters/codex/index.js';
import { collect } from '../src/snapshot.js';
import { runFindings } from '../src/findings/index.js';
import type { Snapshot } from '../src/ir/types.js';

const readText = async (p: string) => {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

/** `ghost:some-skill` を参照する agent 定義入りの最小 home を組み立てる。installed_plugins.json の中身だけ差し替え可能 */
async function makeHome(root: string, installedPluginsContent: string | null): Promise<void> {
  const cc = join(root, '.claude');
  await mkdir(join(cc, 'agents'), { recursive: true });
  await mkdir(join(cc, 'plugins'), { recursive: true });
  await writeFile(join(cc, 'settings.json'), JSON.stringify({ enabledPlugins: {} }));
  await writeFile(
    join(cc, 'agents', 'andy.md'),
    '---\nname: andy\ndescription: fixture agent\ntools: Read\n---\n\n# andy\n\n- `ghost:some-skill`: review pass\n',
  );
  if (installedPluginsContent !== null) {
    await writeFile(join(cc, 'plugins', 'installed_plugins.json'), installedPluginsContent);
  }
  // codex 側は存在しない（present=false）にして、claude-code 単独の判定を見る
}

async function collectHome(root: string): Promise<Snapshot> {
  const saved = process.env['PATH'];
  process.env['PATH'] = dirname(process.execPath);
  try {
    const { snapshot } = await collect([claudeCodeAdapter, codexAdapter], { home: root, project: null });
    return snapshot;
  } finally {
    if (saved !== undefined) process.env['PATH'] = saved;
  }
}

function ghostFinding(s: Awaited<ReturnType<typeof runFindings>>) {
  return s.findings.filter((f) => f.finding_id === 'UNREACHABLE_REFERENCE' && f.subtype === 'missing_target' && f.detail['plugin_namespace'] === 'ghost');
}

test('#74 RED→GREEN: installed_plugins.json が正常に読めて空（本当に無い）なら、従来どおり plugin_absent を出す（regression させない）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-plugin-ok-'));
  try {
    await makeHome(root, JSON.stringify({ version: 2, plugins: {} }));
    const s = await collectHome(root);
    const res = await runFindings(s, { readText });
    const ghosts = ghostFinding(res);
    assert.equal(ghosts.length, 1, '正常に読めて空の時は従来どおり missing_target を出すべき');
    assert.equal(ghosts[0]!.severity, 'error');
    const detail = ghosts[0]!.detail as Record<string, unknown>;
    assert.equal((detail['plugin_status_by_runtime'] as Record<string, string>)['claude-code'], 'not_installed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('#74 RED→GREEN: installed_plugins.json が壊れている（EJSONPARSE）と not installed / plugin_absent / error を主張しない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-plugin-broken-'));
  try {
    await makeHome(root, '{ this is not valid json');
    const s = await collectHome(root);

    // 収集側は「読めたが壊れている」を failed として記録できている（root cause の裏取り）
    const rec = (s.access ?? []).find((a) => a.what === 'installed plugins');
    assert.ok(rec, 'installed_plugins.json の access 記録が無い');
    assert.equal(rec!.status, 'failed');
    assert.equal(rec!.error_code, 'EJSONPARSE');
    assert.equal(rec!.count, null);

    const res = await runFindings(s, { readText });
    const ghosts = ghostFinding(res);
    assert.equal(ghosts.length, 0, '読めなかったのに plugin_absent の Finding を出している（#74 回帰）');
    assert.ok(
      res.skipped.some((x) => x.detector === 'UNREACHABLE_REFERENCE' && /ghost/.test(x.reason) && /could not be read/.test(x.reason)),
      'skip 理由に「読めなかった」ことが残っていない',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('#74 RED→GREEN（OS 実機、POSIX のみ）: installed_plugins.json が chmod 0o000 で読めない（EACCES/EPERM）と not installed / plugin_absent / error を主張しない', {
  skip: process.platform === 'win32' ? 'NTFS 権限モデルは chmod 0o000 で所有者アクセスを塞げない（#72 R4a と同じ理由）' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-plugin-denied-'));
  try {
    await makeHome(root, JSON.stringify({ version: 2, plugins: {} }));
    await chmod(join(root, '.claude', 'plugins', 'installed_plugins.json'), 0o000);
    const s = await collectHome(root);

    const rec = (s.access ?? []).find((a) => a.what === 'installed plugins');
    assert.ok(rec, 'installed_plugins.json の access 記録が無い');
    assert.equal(rec!.status, 'permission_denied');
    assert.equal(rec!.count, null);

    const res = await runFindings(s, { readText });
    const ghosts = ghostFinding(res);
    assert.equal(ghosts.length, 0, '権限で読めなかったのに plugin_absent の Finding を出している（#74 回帰）');
    assert.ok(res.skipped.some((x) => x.detector === 'UNREACHABLE_REFERENCE' && /could not be read/.test(x.reason)));
  } finally {
    await chmod(join(root, '.claude', 'plugins', 'installed_plugins.json'), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

// ───────────────────── hook amplification: unobserved ≠ observed-zero ─────────────────────

const { detectHookAmplification } = await import('../src/findings/hook-amplification.js');

function mkHookResource(home: string, id: string, event: string, command: string) {
  return {
    resource_id: `res-${id}`,
    kind: 'hook_script' as const,
    path: `${home}/.claude/settings.json#hooks.${event}[${id}].hooks[0]`,
    name: `${event}[${id}][0]`,
    owner: 'user' as const,
    declared: { frontmatterKeys: [], raw: { event, command } },
    content_hash: `sha256:${id}`,
    normalized_hash: `sha256:${id}`,
    mtime: new Date().toISOString(),
  };
}

function baseSnapshot(home: string, resources: unknown[], bindings: unknown[] = []): Snapshot {
  return {
    schema_version: '1',
    tool_version: 'test',
    snapshot_id: 'snap-test',
    env: { os: 'darwin', project: null, home, launchers: [] } as Snapshot['env'],
    runtimes: [{ runtime: 'claude-code', version: null, config_home: `${home}/.claude`, present: true }],
    resources: resources as unknown as Snapshot['resources'],
    bindings: bindings as unknown as Snapshot['bindings'],
    observations: [],
    sessions: [],
    processes: [],
    coverage: { phase: 0, collected: [], not_collected: [] },
    access: [],
  } as unknown as Snapshot;
}

test('#74: hook amplification — 同じ command が複数 event に登録されている静的判定は、probe していない時に「実測 0（観測した上で無い）」と同じ文言にしない', () => {
  const home = '/tmp/agent-doctor-hook-fixture-1';
  const target = [mkHookResource(home, 't0', 'PreToolUse', 'echo target'), mkHookResource(home, 't1', 'PostToolUse', 'echo target')];
  const s = baseSnapshot(home, target);

  // firings を渡さない = そもそも見ていない（unobserved）。渡した上で 0 バイトだった（observed zero）とは違う
  const res = detectHookAmplification({ snapshot: s, protectedGlobs: [] });
  const found = res.findings.find((f) => f.finding_id === 'HOOK_AMPLIFICATION' && f.subtype === 'same_registration_multiple_events');
  assert.ok(found, 'same_registration_multiple_events が出ていない');
  const measured = (found!.detail as Record<string, unknown>)['measured'] as { observed: boolean; total_bytes: number };
  assert.equal(measured.observed, false, 'probe していないのに observed=true になっている');
  assert.doesNotMatch(found!.summary, /no injected output/, 'probe していない（unknown）のに「見て、無かった」と同じ文言になっている');
  assert.match(found!.summary, /not observed|unknown/, 'probe していないことが summary から読み取れない');
});

test('#74: hook amplification — probe した上でこの command の発火が無かった（observed zero）は、従来どおり「実測 0」と言ってよい', () => {
  const home = '/tmp/agent-doctor-hook-fixture-1b';
  const target = [mkHookResource(home, 't0', 'PreToolUse', 'echo target'), mkHookResource(home, 't1', 'PostToolUse', 'echo target')];
  const s = baseSnapshot(home, target);
  // probe はした（firings は存在する）が、この command の発火記録は無い
  const firings = new Map([['sess-1', new Map<string, import('../src/findings/hook-amplification.js').HookFiring>()]]);

  const res = detectHookAmplification({ snapshot: s, protectedGlobs: [], hookFirings: firings });
  const found = res.findings.find((f) => f.finding_id === 'HOOK_AMPLIFICATION' && f.subtype === 'same_registration_multiple_events');
  assert.ok(found, 'same_registration_multiple_events が出ていない');
  const measured = (found!.detail as Record<string, unknown>)['measured'] as { observed: boolean; total_bytes: number };
  assert.equal(measured.observed, true, 'probe した記録があるのに observed=false になっている');
  assert.match(found!.summary, /no injected output/, '観測した上で 0 だった場合の文言が変わっている（regression）');
});

test('#74: hook amplification — event 名の一致だけで、別 hook（別 command）の実測バイトを付けない（scope_includes_subagents）', () => {
  const home = '/tmp/agent-doctor-hook-fixture-2';
  const target = mkHookResource(home, 't0', 'PreToolUse', 'echo target');
  const bindings = [
    {
      binding_id: 'b-1',
      resource_id: target.resource_id,
      resource_path: target.path,
      runtime: 'claude-code',
      runtime_version: null,
      mechanism: 'settings_hooks',
      source_ref: { type: 'discovery', search_path: null },
      discovered: true,
      rule_id: 'claude.hook.settings',
      rule_source: 'docs:hooks.md',
      confidence: 'high',
      load_mode: 'always',
      scope_condition: null,
      applies_to: ['session', 'subagent'],
    },
  ];
  const s = baseSnapshot(home, [target], bindings);

  // 実測記録にあるのは「echo target」ではなく、同じ PreToolUse event を使う「別の hook（echo unrelated）」の大量発火
  const firings = new Map([
    [
      'sess-1',
      new Map([['unrelated|PreToolUse', { name: 'unrelated', event: 'PreToolUse', count: 50, total_bytes: 500000, command: 'echo unrelated', payload_digests: new Map<string, number>() }]]),
    ],
  ]);

  const res = detectHookAmplification({ snapshot: s, protectedGlobs: [], hookFirings: firings });
  const found = res.findings.find((f) => f.finding_id === 'HOOK_AMPLIFICATION' && f.subtype === 'scope_includes_subagents');
  assert.equal(found, undefined, '別 command（echo unrelated）の実測バイトを、この hook（echo target）のものとして誤帰属し、症状を出している（#74 回帰）');
});
