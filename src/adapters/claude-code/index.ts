/**
 * claude-code adapter
 *
 * 規約: collectResources() は runtime バージョンを知らない。
 *       computeBindings() だけがバージョンに依存する。
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import yaml from 'js-yaml';

import { hashes } from '../../ir/normalize.js';
import { classifyError, recordAccess } from '../../ir/access.js';
import { extractLauncherInjections, withBindingId } from '../../ir/binding.js';
import { isSkillDirForm, toPosixPath } from '../../ir/slug.js';
import type {
  Binding,
  DeclaredMeta,
  Observation,
  Resource,
  ResourceKind,
  Owner,
  RuntimeInfo,
  SourceRef,
} from '../../ir/types.js';
import type { CollectContext, ProbeSpec, RuntimeAdapter, SearchPath } from '../types.js';
import { claudeSearchPaths, rulesFor } from './rules.js';
import { extractReferences } from './references.js';
import { TOOL_VERSION } from '../../version.js';

const execFileAsync = promisify(execFile);
const TOOL = 'agent-doctor';

/** collectResources（非同期）で解析した launcher の注入を computeBindings（同期）へ渡す。キー = launcher の絶対パス */
const launcherInjectionsCache = new Map<string, ReturnType<typeof extractLauncherInjections>>();

// ───────────────────────── 小さなユーティリティ ─────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * ディレクトリを読む。**読めなかったことを 0 件と区別して記録する。**
 * 存在しない（ENOENT）は正常な事実、権限不足や I/O エラーは「読めなかった」。
 * `what` を渡した時だけ記録する（記録に意味がある入口だけに絞る）。
 *
 * `readdirFn` はテスト用の差し替え口（既定は本物の readdir）。実 OS の権限（chmod）で
 * permission_denied を再現しようとすると、Windows の NTFS 権限モデルが POSIX の mode bit と
 * 一致せず信頼できない（#72 R4a）。この口を使えば OS に依存せず EACCES/EPERM を注入して
 * 「collector が readdir の失敗を握りつぶさず access log まで運ぶ」契約を検証できる。
 */
export async function listDir(p: string, what?: string, readdirFn: (p: string) => Promise<string[]> = readdir): Promise<string[]> {
  try {
    const out = await readdirFn(p);
    if (what) recordAccess({ target: p, collector: 'claude-code', what, status: 'observed', count: out.length, runtime: 'claude-code' });
    return out;
  } catch (e) {
    const c = classifyError(e);
    if (what) {
      recordAccess({
        target: p,
        collector: 'claude-code',
        what,
        status: c.status,
        error_code: c.error_code,
        runtime: 'claude-code',
        ...(c.status === 'absent' ? {} : { reason: 'the directory could not be read; this is not the same as it being empty' }),
      });
    }
    return []; // 存在しないパスは正常。エラーにしない
  }
}

async function readJson<T = unknown>(p: string, what?: string): Promise<T | null> {
  try {
    const raw = await readFile(p, 'utf8');
    let parsed: T;
    try {
      parsed = JSON.parse(raw) as T;
    } catch {
      // 読めたが壊れている。**無いのではない**
      if (what) recordAccess({ target: p, collector: 'claude-code', what, status: 'failed', error_code: 'EJSONPARSE', reason: 'the file was read but is not valid JSON', runtime: 'claude-code' });
      return null;
    }
    if (what) recordAccess({ target: p, collector: 'claude-code', what, status: 'observed', count: 1, runtime: 'claude-code' });
    return parsed;
  } catch (e) {
    const c = classifyError(e);
    if (what) {
      recordAccess({
        target: p,
        collector: 'claude-code',
        what,
        status: c.status,
        error_code: c.error_code,
        runtime: 'claude-code',
        ...(c.status === 'absent' ? {} : { reason: 'the file could not be read; this is not the same as it being absent' }),
      });
    }
    return null;
  }
}

/** frontmatter を分離。無ければ meta は空 */
function parseFrontmatter(text: string): { meta: DeclaredMeta; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: { frontmatterKeys: [] }, body: text };
  let raw: Record<string, unknown> = {};
  try {
    // JSON_SCHEMA に絞る: frontmatter に必要なのは string/number/bool/null/配列/マップだけ。
    // plugin 由来の他人が書いた SKILL.md も読むので、独自タグや timestamp を解釈させない。
    const parsed = yaml.load(m[1] ?? '', { schema: yaml.JSON_SCHEMA });
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // YAML が壊れていても収集は続ける（壊れている事実は frontmatterKeys が空になることで表れる）
  }
  const meta: DeclaredMeta = {
    frontmatterKeys: Object.keys(raw),
    raw,
  };
  if (typeof raw['name'] === 'string') meta.name = raw['name'];
  if (typeof raw['description'] === 'string') meta.description = raw['description'];
  return { meta, body: text.slice(m[0].length) };
}

/** ファイル 1 本を Resource にする */
async function makeResource(
  path: string,
  kind: ResourceKind,
  owner: Owner,
  nameOverride?: string,
): Promise<Resource | null> {
  let text: string;
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    text = await readFile(path, 'utf8');
    st = await stat(path);
  } catch {
    return null;
  }
  const { meta } = parseFrontmatter(text);
  const { content_hash, normalized_hash } = hashes(text);

  let real_path: string | undefined;
  try {
    const rp = await realpath(path);
    if (rp !== path) real_path = rp;
  } catch {
    /* symlink 解決できなくても続行 */
  }

  const r: Resource = {
    resource_id: content_hash,
    kind,
    name: nameOverride ?? meta.name ?? basename(path).replace(/\.(md|json|toml)$/, ''),
    path,
    owner,
    content_hash,
    normalized_hash,
    mtime: st.mtime.toISOString(),
    size_bytes: st.size,
    declared: meta,
    references: extractReferences(text),
  };
  if (real_path) r.real_path = real_path;
  return r;
}

/** 合成 Resource（settings の一部など、ファイル全体でないもの）*/
function makeSyntheticResource(
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

// ───────────────────────────── adapter ─────────────────────────────

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code' as const;

  async detect(ctx: CollectContext): Promise<RuntimeInfo> {
    const config_home = ctx.configHome ?? join(ctx.home, '.claude');
    const present = await exists(config_home);
    let version: string | null = null;
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 15_000 });
      version = (/(\d+\.\d+\.\d+)/.exec(stdout)?.[1]) ?? null;
    } catch {
      version = null; // CLI が無い環境（fixture 等）でも収集は続ける
    }
    return { runtime: this.id, version, config_home, present };
  }

  searchPaths(ctx: CollectContext): SearchPath[] {
    return claudeSearchPaths(ctx.home, ctx.project, ctx.configHome);
  }

  discoveryRules(version: string | null) {
    return rulesFor(version);
  }

  protectedDefaults(): string[] {
    return ['**/memory/**', '**/MEMORY.md', '**/soul/**', '**/CLAUDE.md', '**/AGENTS.md'];
  }

  probePlan(): ProbeSpec[] {
    // Phase 0 は計画を返すだけ。実行しない
    return [
      {
        probe_id: 'claude.debug_log',
        method: 'debug_log',
        question: '起動時に実際にロードされた instruction / skill description は何か',
        cost: { tokens: 0, side_effects: false },
      },
      {
        probe_id: 'claude.self_report',
        method: 'self_report',
        question: 'context に特定の文字列が載っているか（YES/NO）',
        cost: { tokens: 200, side_effects: false },
      },
    ];
  }

  // ── L1: 事実の収集 ────────────────────────────────────────────

  async collectResources(ctx: CollectContext): Promise<Resource[]> {
    const cc = ctx.configHome ?? join(ctx.home, '.claude');
    const out: Resource[] = [];
    const push = (r: Resource | null) => {
      if (r) out.push(r);
    };

    // instruction
    push(await makeResource(join(cc, 'CLAUDE.md'), 'instruction', 'user', 'CLAUDE.md(user)'));
    if (ctx.project) {
      push(await makeResource(join(ctx.project, 'CLAUDE.md'), 'instruction', 'project', 'CLAUDE.md(project)'));
    }

    // skill: <dir>/SKILL.md（発見される形）と 平置き .md（発見されない形）の両方を収集
    for (const sp of this.searchPaths(ctx)) {
      if (sp.kind !== 'skill') continue;
      for (const entry of await listDir(sp.path, `skills (${sp.owner})`)) {
        if (entry.startsWith('.')) continue; // .backup 等は隠しなので収集対象外
        const full = join(sp.path, entry);
        let isDir = false;
        try {
          isDir = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          push(await makeResource(join(full, 'SKILL.md'), 'skill', sp.owner, entry));
        } else if (entry.endsWith('.md')) {
          // 平置き = UNREACHABLE_REFERENCE の一次事実
          push(await makeResource(full, 'skill', sp.owner, entry.replace(/\.md$/, '')));
        }
      }
    }

    // plugin 由来 skill / hook / MCP
    //
    // installed_plugins.json が指す installPath のみを走査する。
    // plugin cache には旧バージョンが積み上がる（BECKY 環境では claude-mem が 9 版）が、
    // 実際にロードされるのは installed_plugins.json の版だけ。
    // ponytail: 旧版キャッシュそのものの検出は TOMBSTONE_ENTRY（Phase 2）の担当。
    // 上限=installed_plugins.json に載っている版のみ、必要になったら旧版も Resource 化する。
    const installedForSkills = await readJson<Record<string, any>>(join(cc, 'plugins', 'installed_plugins.json'));
    for (const [pluginId, entries] of Object.entries((installedForSkills?.['plugins'] ?? {}) as Record<string, any>)) {
      const [plugName = pluginId, mkt = 'unknown'] = pluginId.split('@');
      for (const entry of (Array.isArray(entries) ? entries : [entries]) as any[]) {
        const root: string | undefined = entry?.installPath;
        if (!root) continue;
        const owner: Owner = `plugin:${pluginId}`;
        const skillsDir = join(root, 'skills');
        for (const sname of await listDir(skillsDir)) {
          push(await makeResource(join(skillsDir, sname, 'SKILL.md'), 'skill', owner, `${plugName}:${sname}`));
        }
        for (const hp of [join(root, 'hooks', 'hooks.json'), join(root, 'hooks.json')]) {
          push(await makeResource(hp, 'hook_script', owner, `${plugName}:hooks`));
        }
        // plugin の agent 定義。`<plugin>:<agent>` の名で参照される（実測: codex:codex-rescue）。
        // これを集めないと plugin agent への参照が missing_target の偽陽性になる（後回し項目の前倒し、2026-09-07）
        for (const aname of await listDir(join(root, 'agents'))) {
          if (!aname.endsWith('.md')) continue;
          push(await makeResource(join(root, 'agents', aname), 'agent_def', owner, `${plugName}:${aname.replace(/\.md$/, '')}`));
        }
        push(await makeResource(join(root, '.mcp.json'), 'mcp_server', owner, `${plugName}:mcp`));
        // plugin.json の hooks フィールドが別ファイルを指す場合（ponytail が該当）
        const manifest = await readJson<Record<string, any>>(join(root, '.claude-plugin', 'plugin.json'));
        const hookRef = manifest?.['hooks'];
        if (typeof hookRef === 'string') {
          push(await makeResource(resolve(root, hookRef), 'hook_script', owner, `${plugName}:hooks(manifest)`));
        }
        void mkt;
      }
    }

    // agent_def / rule / output_style
    for (const sp of this.searchPaths(ctx)) {
      if (!['agent_def', 'rule', 'output_style', 'command'].includes(sp.kind)) continue;
      for (const entry of await listDir(sp.path, `${sp.kind} (${sp.owner})`)) {
        if (!entry.endsWith('.md')) continue;
        push(await makeResource(join(sp.path, entry), sp.kind, sp.owner, entry.replace(/\.md$/, '')));
      }
    }

    // settings（precedence 順に別 Resource として持つ）
    for (const [p, owner] of [
      [join(cc, 'managed-settings.json'), 'builtin'],
      [join(cc, 'settings.json'), 'user'],
      [join(cc, 'settings.local.json'), 'user'],
      ...(ctx.project
        ? ([
            [join(ctx.project, '.claude', 'settings.json'), 'project'],
            [join(ctx.project, '.claude', 'settings.local.json'), 'project'],
          ] as const)
        : []),
    ] as Array<[string, Owner]>) {
      push(await makeResource(p, 'settings', owner, basename(p)));
    }

    // hook: settings.json#hooks を 1 hook = 1 Resource に展開（provenance に配列位置を含める）
    const settings = await readJson<Record<string, any>>(join(cc, 'settings.json'), 'settings.json');
    const settingsMtime = (await exists(join(cc, 'settings.json')))
      ? (await stat(join(cc, 'settings.json'))).mtime.toISOString()
      : new Date().toISOString();
    if (settings?.['hooks']) {
      for (const [event, groups] of Object.entries(settings['hooks'] as Record<string, any[]>)) {
        (groups ?? []).forEach((group, gi) => {
          (group?.hooks ?? []).forEach((h: any, hi: number) => {
            out.push(
              makeSyntheticResource(
                `${join(cc, 'settings.json')}#hooks.${event}[${gi}].hooks[${hi}]`,
                'hook_script',
                'user',
                `${event}[${gi}][${hi}]`,
                { event, matcher: group?.matcher ?? null, ...h },
                settingsMtime,
              ),
            );
          });
        });
      }
    }

    // MCP server: ~/.claude.json の必要キーだけ拾う（巨大なので全体を保持しない）
    const claudeJsonPath = join(ctx.home, '.claude.json');
    const cj = await readJson<Record<string, any>>(claudeJsonPath, '.claude.json (mcp servers / skill usage)');
    if (cj) {
      const cjMtime = (await stat(claudeJsonPath)).mtime.toISOString();
      for (const [name, def] of Object.entries((cj['mcpServers'] ?? {}) as Record<string, unknown>)) {
        out.push(makeSyntheticResource(`${claudeJsonPath}#mcpServers.${name}`, 'mcp_server', 'user', name, def, cjMtime));
      }
      if (ctx.project) {
        const proj = (cj['projects'] ?? {})[ctx.project];
        for (const [name, def] of Object.entries((proj?.mcpServers ?? {}) as Record<string, unknown>)) {
          out.push(
            makeSyntheticResource(`${claudeJsonPath}#projects[${ctx.project}].mcpServers.${name}`, 'mcp_server', 'project', name, def, cjMtime),
          );
        }
      }
    }

    // plugin エントリ（有効・無効の宣言と、実体の在処）
    const installed = await readJson<Record<string, any>>(join(cc, 'plugins', 'installed_plugins.json'), 'installed plugins');
    if (installed?.['plugins']) {
      const mt = (await stat(join(cc, 'plugins', 'installed_plugins.json'))).mtime.toISOString();
      for (const [id, entries] of Object.entries(installed['plugins'] as Record<string, unknown>)) {
        const enabled = settings?.['enabledPlugins']?.[id];
        out.push(
          makeSyntheticResource(
            `${join(cc, 'plugins', 'installed_plugins.json')}#plugins["${id}"]`,
            'plugin',
            'builtin',
            id,
            { id, installed: entries, enabled: enabled ?? null },
            mt,
          ),
        );
      }
    }

    // memory（protected 対象。存在の記録だけ取り、本文は hash 以外持たない）
    const projectsDir = join(cc, 'projects');
    for (const slug of await listDir(projectsDir, 'project memory directories')) {
      const memIndex = join(projectsDir, slug, 'memory', 'MEMORY.md');
      push(await makeResource(memIndex, 'memory', 'user', `MEMORY.md(${slug})`));
    }

    // launcher（--launcher で明示された起動スクリプトだけ。全域探索はしない）
    // --append-system-prompt "$(cat <path>)" の対象が未収集なら instruction として収集する
    // （rules/ から移動した後のファイルなど、探索パス外にあっても注入はされるため）
    for (const lp of ctx.launchers ?? []) {
      const launcher = await makeResource(lp, 'launcher', 'user', basename(lp));
      if (!launcher) continue;
      out.push(launcher);
      const text = await readFile(lp, 'utf8');
      const injections = extractLauncherInjections(text, ctx.home);
      launcherInjectionsCache.set(lp, injections);
      for (const inj of injections) {
        if (out.some((r) => r.path === inj.target)) continue;
        push(await makeResource(inj.target, 'instruction', 'user', `${basename(inj.target)}(injected)`));
      }
    }

    return out;
  }

  // ── L2: discovery 規則の適用 ──────────────────────────────────

  computeBindings(resources: Resource[], info: RuntimeInfo, ctx: CollectContext): Binding[] {
    const sps = this.searchPaths(ctx);
    const base = { runtime: this.id, runtime_version: info.version };
    const cc = ctx.configHome ?? join(ctx.home, '.claude');
    const settingsPath = join(cc, 'settings.json');
    const settingsRes = resources.find((r) => r.path === settingsPath);
    const byPath = new Map(resources.map((r) => [r.path, r]));

    const discovery = (sp: SearchPath | undefined, fallback: string): SourceRef => ({ type: 'discovery', search_path: sp?.path ?? fallback });

    const out: Binding[] = resources.flatMap((r): Binding[] => {
      const sp = sps.find((s) => toPosixPath(r.path).startsWith(toPosixPath(s.path)));
      const common = {
        ...base,
        resource_id: r.resource_id,
        // 同一内容が複数パスに在る場合、Binding はパスごとに別物
        resource_path: r.path,
        search_path: sp?.path ?? null,
        precedence: sp?.precedence ?? null,
      };

      // skill
      if (r.kind === 'skill') {
        // 探索対象外のパス（~/.agents/skills 等）
        if (sp && !sp.in_search_path) {
          return [withBindingId({
            ...common,
            mechanism: 'skill_description',
            source_ref: discovery(sp, r.path),
            discovered: false,
            rule_id: 'claude.skill.not_in_search_path',
            rule_source: 'docs:skills.md#discovery-locations',
            confidence: 'high',
            load_mode: 'never',
            scope_condition: null,
            applies_to: [],
          })];
        }
        // 平置き .md は発見されない
        const isDirForm = isSkillDirForm(r.path);
        if (!isDirForm) {
          return [withBindingId({
            ...common,
            mechanism: 'skill_description',
            source_ref: discovery(sp, r.path),
            discovered: false,
            rule_id: 'claude.skill.requires_dir_skill_md',
            rule_source: 'docs:skills.md#discovery-locations',
            confidence: 'high',
            load_mode: 'never',
            scope_condition: null,
            applies_to: [],
          })];
        }
        const disabled = r.declared.raw?.['disable-model-invocation'] === true;
        return [withBindingId({
          ...common,
          mechanism: 'skill_description',
          source_ref: discovery(sp, r.owner.startsWith('plugin:') ? 'plugin' : r.path),
          discovered: true,
          rule_id: disabled ? 'claude.skill.disable_model_invocation' : 'claude.skill.description_always_loaded',
          rule_source: 'docs:skills.md',
          confidence: 'high',
          load_mode: 'on_demand',
          scope_condition: null,
          applies_to: ['session'],
        })];
      }

      // rule: paths: 有無で load_mode が変わる（SCOPE_MISMATCH の入力）
      if (r.kind === 'rule') {
        const paths = r.declared.raw?.['paths'];
        const hasPaths = Array.isArray(paths) && paths.length > 0;
        return [withBindingId({
          ...common,
          mechanism: 'rule_autoload',
          source_ref: discovery(sp, r.path),
          discovered: true,
          rule_id: 'claude.rule.paths_optional',
          rule_source: 'docs:memory.md#path-specific-rules',
          confidence: 'high',
          load_mode: hasPaths ? 'path_conditional' : 'always',
          scope_condition: hasPaths ? (paths as string[]) : null,
          applies_to: ['session'],
        })];
      }

      if (r.kind === 'instruction') {
        // launcher が注入するために収集した instruction（探索パス外）は、それ自身の自動ロード経路を持たない。
        // 自動ロードの Binding は作らず、後段の launcher 由来（append_system_prompt）Binding だけになる
        if (/\(injected\)$/.test(r.name)) return [];
        return [withBindingId({
          ...common,
          mechanism: 'instruction_concat',
          source_ref: discovery(sp, r.path),
          discovered: true,
          rule_id: 'claude.instruction.always_loaded',
          rule_source: 'docs:memory.md#how-claude-md-files-load',
          confidence: 'high',
          load_mode: 'always',
          scope_condition: null,
          // SubagentStart は親の CLAUDE.md を継承しない
          applies_to: ['session'],
        })];
      }

      if (r.kind === 'command') {
        return [withBindingId({
          ...common,
          mechanism: 'skill_description',
          source_ref: discovery(sp, r.path),
          discovered: true,
          rule_id: 'claude.command.commands_dir',
          rule_source: 'measured:2026-09-07',
          confidence: 'medium',
          load_mode: 'on_demand',
          scope_condition: null,
          applies_to: ['session'],
        })];
      }

      if (r.kind === 'output_style') {
        const selected = false; // settings.json#outputStyle との突合は未対応（coverage）
        return [withBindingId({
          ...common,
          mechanism: 'output_style',
          source_ref: discovery(sp, r.path),
          discovered: true,
          rule_id: 'claude.output_style.only_selected',
          rule_source: 'measured:2026-09-07',
          confidence: 'medium',
          load_mode: selected ? 'always' : 'on_demand',
          scope_condition: null,
          applies_to: ['session'],
        })];
      }

      if (r.kind === 'mcp_server') {
        // 合成 Resource（~/.claude.json#mcpServers.x）。~/.claude.json 自体は Resource 化しないので external
        const [file, locator] = r.path.split('#', 2);
        return [withBindingId({
          ...common,
          mechanism: 'mcp_config',
          source_ref: { type: 'external', ref: file!, locator: locator ?? null },
          discovered: true,
          rule_id: 'claude.mcp.tool_schema_deferred',
          rule_source: 'measured:2026-09-07',
          // 遅延ロードの実態は probe でしか確定しない
          confidence: 'probe_required',
          load_mode: 'deferred',
          scope_condition: null,
          applies_to: ['session'],
        })];
      }

      if (r.kind === 'hook_script') {
        const event = String((r.declared.raw as any)?.['event'] ?? '');
        const applies: Binding['applies_to'] = event.startsWith('Subagent') ? ['subagent'] : ['session'];
        const [file, locator] = r.path.split('#', 2);
        const src: SourceRef =
          settingsRes && file === settingsPath
            ? { type: 'resource', resource_id: settingsRes.resource_id, resource_path: settingsRes.path, locator: locator ?? null }
            : { type: 'external', ref: file!, locator: locator ?? null };
        return [withBindingId({
          ...common,
          mechanism: 'hook_registration',
          source_ref: src,
          discovered: true,
          rule_id: 'claude.hook.registered_in_settings',
          rule_source: 'docs:hooks-guide.md',
          confidence: 'high',
          load_mode: 'always',
          scope_condition: null,
          applies_to: applies,
        })];
      }

      if (r.kind === 'plugin') {
        const enabled = (r.declared.raw as any)?.['enabled'];
        const [file, locator] = r.path.split('#', 2);
        return [withBindingId({
          ...common,
          mechanism: 'plugin_manifest',
          source_ref: { type: 'external', ref: file!, locator: locator ?? null },
          discovered: enabled === true,
          rule_id: 'claude.plugin.disabled_not_loaded',
          rule_source: 'docs:plugins.md',
          confidence: 'high',
          load_mode: enabled === true ? 'always' : 'never',
          scope_condition: null,
          applies_to: enabled === true ? ['session'] : [],
        })];
      }

      if (r.kind === 'launcher') {
        // 起動スクリプト本体は context に載らない。注入先の Binding は下で別に作る
        return [withBindingId({
          ...common,
          mechanism: 'launcher',
          source_ref: { type: 'external', ref: r.path, locator: null },
          discovered: true,
          rule_id: 'claude.launcher.explicit_only',
          rule_source: 'measured:2026-09-07',
          confidence: 'medium',
          load_mode: 'never',
          scope_condition: null,
          applies_to: [],
        })];
      }

      if (r.kind === 'memory') {
        return [withBindingId({
          ...common,
          mechanism: 'memory_autoload',
          source_ref: discovery(sp, join(cc, 'projects')),
          discovered: true,
          rule_id: 'claude.instruction.always_loaded',
          rule_source: 'docs:memory.md#how-claude-md-files-load',
          confidence: 'high',
          load_mode: 'always',
          scope_condition: null,
          applies_to: ['session'],
        })];
      }

      if (r.kind === 'settings') {
        return [withBindingId({
          ...common,
          mechanism: 'settings_file',
          source_ref: discovery(sp, r.path),
          discovered: true,
          rule_id: 'claude.settings.precedence',
          rule_source: 'docs:settings.md',
          confidence: 'high',
          load_mode: 'never', // 設定は読まれるが context には載らない
          scope_condition: null,
          applies_to: ['session'],
        })];
      }

      // agent_def
      return [withBindingId({
        ...common,
        mechanism: 'agent_def',
        source_ref: discovery(sp, r.owner.startsWith('plugin:') ? 'plugin' : r.path),
        discovered: true,
        rule_id: 'claude.agent_def.agents_dir',
        rule_source: 'docs:sub-agents.md',
        confidence: 'high',
        load_mode: 'on_demand',
        scope_condition: null,
        applies_to: ['session'],
      })];
    });

    // launcher 由来の 2 本目の経路: --append-system-prompt "$(cat <path>)"
    // 同じファイルが rules/ の自動ロードでも入っていれば、ここで別 mechanism の Binding が並ぶ
    for (const launcher of resources.filter((r) => r.kind === 'launcher')) {
      const injections = launcherInjectionsCache.get(launcher.path) ?? [];
      for (const inj of injections) {
        const target = byPath.get(inj.target);
        if (!target) continue; // 対象ファイルが無い。参照は launcher の references に残っている（missing_target の入力）
        out.push(
          withBindingId({
            ...base,
            resource_id: target.resource_id,
            resource_path: target.path,
            search_path: null,
            precedence: null,
            mechanism: 'append_system_prompt',
            source_ref: { type: 'resource', resource_id: launcher.resource_id, resource_path: launcher.path, locator: `:${inj.line}` },
            discovered: true,
            rule_id: 'claude.launcher.append_system_prompt',
            rule_source: 'measured:2026-09-07',
            // その launcher が実際に使われたかは静的に証明できない
            confidence: 'medium',
            load_mode: 'always',
            scope_condition: null,
            applies_to: ['session'],
          }),
        );
      }
    }
    return out;
  }

  // ── Observation: 既存の記録から作る。測定はしない ─────────────

  async collectObservations(resources: Resource[], ctx: CollectContext): Promise<Observation[]> {
    const now = new Date().toISOString();
    const out: Observation[] = [];
    const meta = { runtime: this.id, tool: TOOL, tool_version: TOOL_VERSION, scope: 'next_session' as const };

    // filesystem 由来（size / mtime）
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

    // usage 由来（invocation）。~/.claude.json の必要キーだけ
    const claudeJsonPath = join(ctx.home, '.claude.json');
    const cj = await readJson<Record<string, any>>(claudeJsonPath);
    const usage: Record<string, any> = cj?.['skillUsage'] ?? {};
    const sps = this.searchPaths(ctx);
    for (const r of resources) {
      if (r.kind !== 'skill') continue;
      // skillUsage は Claude Code が発見している skill の記録。探索対象外（~/.agents/skills 等）の複製には付けない
      // （付けると codex 側の copy に claude の回数が写り、drift の判断材料を汚す。ドッグフード 2026-09-07）
      const sp = sps.find((x) => toPosixPath(r.path).startsWith(toPosixPath(x.path)));
      if (sp && !sp.in_search_path) continue;
      // skillUsage のキーは skill 名（plugin skill は "<plugin>:<skill>"）
      const rec = usage[r.name];
      out.push({
        ...meta,
        resource_id: r.resource_id,
        resource_path: r.path,
        kind: 'invocation',
        value: rec?.usageCount ?? 0,
        unit: 'count',
        measured_at: now,
        method: 'usage_record',
        confidence: rec ? 'high' : 'medium', // 記録が無い = 0 回とは限らない（名前不一致の可能性）
        source_ref: `${claudeJsonPath}#skillUsage.${r.name}`,
      });
    }

    return out;
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
export { TOOL, TOOL_VERSION };
export const _internal = { parseFrontmatter, makeResource, resolvePath: resolve };
