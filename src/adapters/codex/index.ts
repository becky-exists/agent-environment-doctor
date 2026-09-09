/**
 * codex adapter
 *
 * Claude 側と同じ規約: collectResources() は runtime バージョンを知らない。
 * computeBindings() だけがバージョンに依存する。
 */

import { classifyError, recordAccess } from '../../ir/access.js';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';

import { hashes } from '../../ir/normalize.js';
import { withBindingId } from '../../ir/binding.js';
import { isSkillDirForm, toPosixPath } from '../../ir/slug.js';
import type { Binding, Observation, Owner, Resource, ResourceKind, RuntimeInfo, SourceRef } from '../../ir/types.js';
import type { CollectContext, ProbeSpec, RuntimeAdapter, SearchPath } from '../types.js';
import { codexSearchPaths, resolveCodexHome, rulesFor } from './rules.js';
import { extractReferences } from '../claude-code/references.js';
import { TOOL_VERSION } from '../../version.js';

const execFileAsync = promisify(execFile);
const TOOL = 'agent-doctor';

/** config.toml の [[skills.config]] path（明示参照）。collectResources で読み、computeBindings で使う */
const explicitSkillPathsCache = new Map<string, Set<string>>();

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 読めなかったことを 0 件と区別して記録する（claude-code 側と同じ規律） */
/**
 * config.toml を読んで TOML parse する。**読めた/読めなかったを access log に残す**（claude-code 側の
 * readJson と同じ規律）。ここが無いと、config.toml が壊れて plugins/mcp_servers を展開できなかった時と、
 * config.toml に元々 plugins が無かった時が区別できず、UNREACHABLE_REFERENCE が「読めなかった」を
 * 「plugin が無い」に誤読する（#74）。
 */
async function readToml(p: string, what?: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(p, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(raw) as Record<string, unknown>;
    } catch {
      // 読めたが壊れている。**無いのではない**
      if (what) recordAccess({ target: p, collector: 'codex', what, status: 'failed', error_code: 'ETOMLPARSE', reason: 'the file was read but is not valid TOML', runtime: 'codex' });
      return null;
    }
    if (what) recordAccess({ target: p, collector: 'codex', what, status: 'observed', count: 1, runtime: 'codex' });
    return parsed;
  } catch (e) {
    const c = classifyError(e);
    if (what) {
      recordAccess({
        target: p,
        collector: 'codex',
        what,
        status: c.status,
        error_code: c.error_code,
        runtime: 'codex',
        ...(c.status === 'absent' ? {} : { reason: 'the file could not be read; this is not the same as it being absent' }),
      });
    }
    return null;
  }
}

async function listDir(p: string, what?: string): Promise<string[]> {
  try {
    const out = await readdir(p);
    if (what) recordAccess({ target: p, collector: 'codex', what, status: 'observed', count: out.length, runtime: 'codex' });
    return out;
  } catch (e) {
    const c = classifyError(e);
    if (what) {
      recordAccess({
        target: p,
        collector: 'codex',
        what,
        status: c.status,
        error_code: c.error_code,
        runtime: 'codex',
        ...(c.status === 'absent' ? {} : { reason: 'the directory could not be read; this is not the same as it being empty' }),
      });
    }
    return [];
  }
}

async function makeResource(path: string, kind: ResourceKind, owner: Owner, nameOverride?: string): Promise<Resource | null> {
  let text: string;
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    text = await readFile(path, 'utf8');
    st = await stat(path);
  } catch {
    return null;
  }
  const { content_hash, normalized_hash } = hashes(text);

  // frontmatter（md）と TOML（agent_def）で declared の埋め方が違う
  let declared: Resource['declared'] = { frontmatterKeys: [] };
  if (path.endsWith('.toml')) {
    try {
      const t = parseToml(text) as Record<string, unknown>;
      declared = { frontmatterKeys: Object.keys(t), raw: t };
      if (typeof t['name'] === 'string') declared.name = t['name'];
      if (typeof t['description'] === 'string') declared.description = t['description'];
    } catch {
      /* 壊れていても収集は続ける */
    }
  } else {
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (m) {
      // Codex 側の md は frontmatter を持つものが少ない。キー名だけ拾う（YAML 依存を増やさない）
      const keys = (m[1] ?? '').split('\n').map((l) => /^([A-Za-z_][\w-]*):/.exec(l)?.[1]).filter((x): x is string => !!x);
      declared = { frontmatterKeys: keys };
      const d = /^description:\s*(.*)$/m.exec(m[1] ?? '');
      if (d?.[1]) declared.description = d[1].trim();
      const n = /^name:\s*(.*)$/m.exec(m[1] ?? '');
      if (n?.[1]) declared.name = n[1].trim();
    }
  }

  let real_path: string | undefined;
  try {
    const rp = await realpath(path);
    if (rp !== path) real_path = rp;
  } catch {
    /* noop */
  }

  const r: Resource = {
    resource_id: content_hash,
    kind,
    name: nameOverride ?? declared.name ?? basename(path).replace(/\.(md|json|toml|rules)$/, ''),
    path,
    owner,
    content_hash,
    normalized_hash,
    mtime: st.mtime.toISOString(),
    size_bytes: st.size,
    declared,
    references: extractReferences(text),
  };
  if (real_path) r.real_path = real_path;
  return r;
}

function makeSynthetic(
  virtualPath: string,
  kind: ResourceKind,
  owner: Owner,
  name: string,
  payload: unknown,
  mtime: string,
): Resource {
  const text = JSON.stringify(payload, null, 1);
  const { content_hash, normalized_hash } = hashes(text);
  return {
    resource_id: content_hash,
    kind,
    name,
    path: virtualPath,
    owner,
    content_hash,
    normalized_hash,
    mtime,
    size_bytes: Buffer.byteLength(text, 'utf8'),
    declared: { frontmatterKeys: [], raw: payload as Record<string, unknown> },
    references: extractReferences(text),
  };
}

export class CodexAdapter implements RuntimeAdapter {
  readonly id = 'codex' as const;

  async detect(ctx: CollectContext): Promise<RuntimeInfo> {
    const config_home = resolveCodexHome(ctx.home, ctx.configHome);
    const present = await exists(config_home);
    let version: string | null = null;
    try {
      const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 15_000 });
      version = (/(\d+\.\d+\.\d+)/.exec(stdout)?.[1]) ?? null;
    } catch {
      version = null;
    }
    return { runtime: this.id, version, config_home, present };
  }

  searchPaths(ctx: CollectContext): SearchPath[] {
    return codexSearchPaths(ctx.home, ctx.project, ctx.configHome ? resolveCodexHome(ctx.home, ctx.configHome) : undefined);
  }

  discoveryRules(version: string | null) {
    return rulesFor(version);
  }

  protectedDefaults(): string[] {
    return ['**/AGENTS.md', '**/memories/**', '**/memories_*.sqlite'];
  }

  probePlan(): ProbeSpec[] {
    return [
      {
        probe_id: 'codex.exec_self_report',
        method: 'self_report',
        question: 'context に特定の文字列が載っているか（codex exec --ephemeral で 1 問）',
        cost: { tokens: 200, side_effects: false },
      },
    ];
  }

  async collectResources(ctx: CollectContext): Promise<Resource[]> {
    const ch = resolveCodexHome(ctx.home, ctx.configHome);
    const out: Resource[] = [];
    const push = (r: Resource | null) => {
      if (r) out.push(r);
    };

    // instruction（AGENTS.md）
    push(await makeResource(join(ch, 'AGENTS.md'), 'instruction', 'user', 'AGENTS.md(user)'));
    if (ctx.project) push(await makeResource(join(ctx.project, 'AGENTS.md'), 'instruction', 'project', 'AGENTS.md(project)'));

    // skill（~/.agents/skills が主、~/.codex/skills も、Claude 側パスも突合用に）
    for (const sp of this.searchPaths(ctx)) {
      if (sp.kind !== 'skill') continue;
      for (const entry of await listDir(sp.path, `skills (${sp.owner})`)) {
        if (entry.startsWith('.')) continue;
        const full = join(sp.path, entry);
        let isDir = false;
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
        if (isDir) push(await makeResource(join(full, 'SKILL.md'), 'skill', sp.owner, entry));
        else if (entry.endsWith('.md')) push(await makeResource(full, 'skill', sp.owner, entry.replace(/\.md$/, '')));
      }
    }

    // agent_def（.toml）
    for (const entry of await listDir(join(ch, 'agents'), 'agent definitions')) {
      if (!entry.endsWith('.toml')) continue;
      push(await makeResource(join(ch, 'agents', entry), 'agent_def', 'user', entry.replace(/\.toml$/, '')));
    }

    // exec_policy（rules/*.rules）。prefix_rule(...) DSL の実行許可ポリシー。prompt rule ではない。
    // 存在と prefix_rule の行数だけを declared に記録し、DSL の意味は parse しない（coverage）
    for (const entry of await listDir(join(ch, 'rules'), 'exec policy rules')) {
      if (!entry.endsWith('.rules')) continue;
      const r = await makeResource(join(ch, 'rules', entry), 'exec_policy', 'user', entry);
      if (r) {
        const text = await readFile(r.path, 'utf8');
        const n = (text.match(/^\s*prefix_rule\(/gm) ?? []).length;
        r.declared = { frontmatterKeys: ['prefix_rule_count'], raw: { prefix_rule_count: n } };
        out.push(r);
      }
    }

    // settings（config.toml 全体）
    push(await makeResource(join(ch, 'config.toml'), 'settings', 'user', 'config.toml'));

    // hook（hooks.json を 1 hook = 1 Resource に展開）
    const hooksPath = join(ch, 'hooks.json');
    if (await exists(hooksPath)) {
      const mt = (await stat(hooksPath)).mtime.toISOString();
      try {
        const h = JSON.parse(await readFile(hooksPath, 'utf8')) as Record<string, any>;
        for (const [event, groups] of Object.entries((h['hooks'] ?? {}) as Record<string, any[]>)) {
          (groups ?? []).forEach((group, gi) => {
            (group?.hooks ?? []).forEach((hk: any, hi: number) => {
              out.push(
                makeSynthetic(`${hooksPath}#hooks.${event}[${gi}].hooks[${hi}]`, 'hook_script', 'user', `${event}[${gi}][${hi}]`, {
                  event,
                  matcher: group?.matcher ?? null,
                  ...hk,
                }, mt),
              );
            });
          });
        }
      } catch {
        /* 壊れていても続行 */
      }
    }

    // config.toml から mcp_servers / plugins を展開
    const cfgPath = join(ch, 'config.toml');
    if (await exists(cfgPath)) {
      const mt = (await stat(cfgPath)).mtime.toISOString();
      // `what` に資源名（config.toml）をそのまま裸で埋め込まない。bundle 側の identity 置換は
      // パス区切り文字に面した時だけ効くため、地の文に混ぜると素通りする（#74 発見時に実測）
      const cfg = await readToml(cfgPath, 'plugin / mcp_server declarations');
      if (cfg) {
        for (const [name, def] of Object.entries((cfg['mcp_servers'] ?? {}) as Record<string, unknown>)) {
          out.push(makeSynthetic(`${cfgPath}#mcp_servers.${name}`, 'mcp_server', 'user', name, def, mt));
        }
        for (const [id, def] of Object.entries((cfg['plugins'] ?? {}) as Record<string, unknown>)) {
          out.push(makeSynthetic(`${cfgPath}#plugins."${id}"`, 'plugin', 'builtin', id, { id, ...(def as object) }, mt));
        }
        // [[skills.config]] path = "<SKILL.md>": 標準探索場所外でも明示参照された skill は探索対象
        const explicit = new Set<string>();
        const sc = (cfg['skills'] as Record<string, unknown> | undefined)?.['config'];
        for (const e of Array.isArray(sc) ? sc : []) {
          const pth = (e as Record<string, unknown>)?.['path'];
          if (typeof pth === 'string') {
            const abs = pth.replace(/^~(?=\/|$)/, ctx.home);
            explicit.add(abs);
            if (!out.some((r) => r.path === abs)) push(await makeResource(abs, 'skill', 'user', basename(join(abs, '..'))));
          }
        }
        explicitSkillPathsCache.set(ch, explicit);
      }
    }

    return out;
  }

  computeBindings(resources: Resource[], info: RuntimeInfo, ctx: CollectContext): Binding[] {
    const sps = this.searchPaths(ctx);
    const base = { runtime: this.id, runtime_version: info.version };
    const ch = resolveCodexHome(ctx.home, ctx.configHome);
    const cfgPath = join(ch, 'config.toml');
    const cfgRes = resources.find((r) => r.path === cfgPath);
    const hooksPath = join(ch, 'hooks.json');
    const explicit = explicitSkillPathsCache.get(ch) ?? new Set<string>();
    const D = 'docs:codex/';
    const discovery = (sp: SearchPath | undefined, fallback: string): SourceRef => ({ type: 'discovery', search_path: sp?.path ?? fallback });
    const inConfig = (locator: string | null): SourceRef =>
      cfgRes ? { type: 'resource', resource_id: cfgRes.resource_id, resource_path: cfgRes.path, locator } : { type: 'external', ref: cfgPath, locator };

    return resources.map((r): Binding => {
      const sp = sps.find((s) => toPosixPath(r.path).startsWith(toPosixPath(s.path)));
      const common = {
        ...base,
        resource_id: r.resource_id,
        resource_path: r.path,
        search_path: sp?.path ?? null,
        precedence: sp?.precedence ?? null,
      };

      if (r.kind === 'skill') {
        const isDirForm = isSkillDirForm(r.path);
        // [[skills.config]] の明示参照は場所を問わず先に評価する
        if (explicit.has(r.path)) {
          return withBindingId({
            ...common,
            mechanism: 'skill_description',
            source_ref: inConfig('skills.config'),
            discovered: isDirForm,
            rule_id: isDirForm ? 'codex.skill.explicit_config_path' : 'codex.skill.requires_dir_skill_md',
            rule_source: `${D}skills`,
            confidence: 'high',
            load_mode: isDirForm ? 'on_demand' : 'never',
            scope_condition: null,
            applies_to: isDirForm ? ['session'] : [],
          });
        }
        if (sp && !sp.in_search_path) {
          return withBindingId({
            ...common,
            mechanism: 'skill_description',
            source_ref: discovery(sp, r.path),
            discovered: false,
            rule_id: 'codex.skill.not_in_standard_locations',
            rule_source: `${D}skills`,
            confidence: 'high',
            load_mode: 'never',
            scope_condition: null,
            applies_to: [],
          });
        }
        // $CODEX_HOME/skills は undocumented（confidence low、since 0.153.4）
        const undocumentedHome = sp?.path === join(ch, 'skills');
        return withBindingId({
          ...common,
          mechanism: 'skill_description',
          source_ref: discovery(sp, r.path),
          discovered: isDirForm,
          rule_id: !isDirForm ? 'codex.skill.requires_dir_skill_md' : undocumentedHome ? 'codex.skill.codex_home_skills' : 'codex.skill.agents_dir_included',
          rule_source: undocumentedHome ? 'measured:2026-09-07' : `${D}skills`,
          confidence: !isDirForm ? 'high' : undocumentedHome ? 'low' : 'high',
          load_mode: isDirForm ? 'on_demand' : 'never',
          scope_condition: null,
          applies_to: isDirForm ? ['session'] : [],
        });
      }

      if (r.kind === 'instruction') {
        return withBindingId({
          ...common,
          mechanism: 'instruction_concat',
          source_ref: discovery(undefined, r.path.startsWith(ch) ? ch : (ctx.project ?? r.path)),
          discovered: true,
          rule_id: 'codex.instruction.agents_md_always',
          rule_source: `${D}agents-md`,
          confidence: 'high',
          load_mode: 'always',
          scope_condition: null,
          applies_to: ['session'],
        });
      }

      if (r.kind === 'agent_def') {
        return withBindingId({
          ...common,
          mechanism: 'agent_def',
          source_ref: discovery(sp, join(ch, 'agents')),
          discovered: true,
          rule_id: 'codex.agent_def.toml',
          rule_source: `${D}subagents`,
          confidence: 'high',
          load_mode: 'on_demand',
          scope_condition: null,
          applies_to: ['session'],
        });
      }

      if (r.kind === 'exec_policy') {
        // 実行許可ポリシー。prompt には載らない。コマンド一致時に評価されるので load_mode は unknown
        return withBindingId({
          ...common,
          mechanism: 'exec_policy',
          source_ref: discovery(sp, join(ch, 'rules')),
          discovered: true,
          rule_id: 'codex.exec_policy.rules_dir',
          rule_source: `${D}rules`,
          confidence: 'medium',
          load_mode: 'unknown',
          scope_condition: null,
          applies_to: ['session'],
        });
      }

      if (r.kind === 'hook_script') {
        const event = String((r.declared.raw as any)?.['event'] ?? '');
        const [, locator] = r.path.split('#', 2);
        return withBindingId({
          ...common,
          mechanism: 'hook_registration',
          source_ref: { type: 'external', ref: hooksPath, locator: locator ?? null },
          discovered: true, // 「登録されている」の意味。trust 状態は未対応（coverage）
          rule_id: 'codex.hook.hooks_json',
          rule_source: `${D}hooks`,
          confidence: 'medium',
          load_mode: 'always',
          scope_condition: null,
          applies_to: event.startsWith('Subagent') ? ['subagent'] : ['session'],
        });
      }

      if (r.kind === 'plugin') {
        const enabled = (r.declared.raw as any)?.['enabled'];
        const [, locator] = r.path.split('#', 2);
        return withBindingId({
          ...common,
          mechanism: 'plugin_manifest',
          source_ref: inConfig(locator ?? null),
          discovered: enabled === true,
          rule_id: 'codex.plugin.enabled_flag',
          rule_source: 'measured:2026-09-07',
          confidence: 'medium', // undocumented（since 0.153.4）
          load_mode: enabled === true ? 'always' : 'never',
          scope_condition: null,
          applies_to: enabled === true ? ['session'] : [],
        });
      }

      if (r.kind === 'mcp_server') {
        const [, locator] = r.path.split('#', 2);
        return withBindingId({
          ...common,
          mechanism: 'mcp_config',
          source_ref: inConfig(locator ?? null),
          discovered: true,
          rule_id: 'codex.mcp.config_toml',
          rule_source: `${D}config-reference`,
          confidence: 'medium',
          load_mode: 'deferred',
          scope_condition: null,
          applies_to: ['session'],
        });
      }

      // settings（config.toml 等）。context には載らない
      return withBindingId({
        ...common,
        mechanism: 'settings_file',
        source_ref: discovery(sp, r.path),
        discovered: true,
        rule_id: 'codex.settings.config_toml',
        rule_source: `${D}config-reference`,
        confidence: 'high',
        load_mode: 'never',
        scope_condition: null,
        applies_to: ['session'],
      });
    });
  }

  async collectObservations(resources: Resource[], _ctx: CollectContext): Promise<Observation[]> {
    const now = new Date().toISOString();
    const meta = { runtime: this.id, tool: TOOL, tool_version: TOOL_VERSION, scope: 'next_session' as const };
    const out: Observation[] = [];
    for (const r of resources) {
      out.push({
        ...meta,
        resource_id: r.resource_id,
        resource_path: r.path,
        runtime: null, // ファイルサイズは filesystem の事実。runtime に依存しない
        kind: 'size',
        value: r.size_bytes,
        unit: 'bytes',
        measured_at: now,
        method: 'filesystem',
        confidence: 'high',
        source_ref: r.path,
      });
      out.push({
        ...meta,
        resource_id: r.resource_id,
        resource_path: r.path,
        runtime: null, // mtime も同様
        kind: 'mtime',
        value: r.mtime,
        unit: null,
        measured_at: now,
        method: 'filesystem',
        confidence: 'high',
        source_ref: r.path,
      });
    }
    // ponytail: Codex の usage 記録は thread_history/logs の sqlite にあるが、
    // Phase 0 では invocation を作らない。上限=filesystem 由来のみ、必要になったら sqlite を読む
    return out;
  }
}

export const codexAdapter = new CodexAdapter();
