#!/usr/bin/env node
/**
 * agent-doctor CLI — Phase 0
 *
 * READ ONLY。snapshot の出力先以外、ファイルを 1 つも書き換えない。
 *
 * サブコマンド:
 *   scan               収集 → Finding 3 本（UNREACHABLE_REFERENCE / CROSS_RUNTIME_DRIFT / SCOPE_MISMATCH）
 *   report --llm       修正役の LLM へ渡すレポート（JSON 既定、--format md）
 *   ui                 localhost で構造を見る顕微鏡（READ ONLY、127.0.0.1 のみ）。--print でサーバ無しの 1 回出力
 *   collect            Resource / Binding / Observation を収集して要約を出す
 *   gate-a             IR が実データで自然に表現できているかを検査（★ Phase 0 の関門）
 *   snapshot --out F   4 種の事実データを保存
 *   diff A [B]         snapshot 間の差分
 *   explain <id|path>  source → binding → observation の連鎖を表示
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { claudeCodeAdapter, TOOL_VERSION } from './adapters/claude-code/index.js';
import { codexAdapter } from './adapters/codex/index.js';
import type { CollectContext, RuntimeAdapter } from './adapters/types.js';
import { collect, saveSnapshot, loadSnapshot, diffSnapshots, attachActiveRuntime } from './snapshot.js';
import { observeActiveRuntime, toSessionInfo, toProcessInfo, activeRuntimeObservations, processObservations, argvTails, capabilityDescriptions, hookFirings, measuredContextItems, mcpServerStatuses, rateLimitEvidence, mapProcessesToSessions, hostProcessUsages } from './probe/index.js';
import { collectHostResources } from './observe/host.js';
import { beginAccessLog, takeAccessLog } from './ir/access.js';
import { loadSeries, buildHistory } from './history/events.js';
import { buildUiData } from './ui/data.js';
import { startUiServer } from './ui/server.js';
import { measureFromRecords } from './observe/context-cost.js';
import { runGateA, formatGateResult } from './gate-a.js';
import { formatCoverage } from './coverage.js';
import { runFindings } from './findings/index.js';
import { formatReport } from './report.js';
import { buildLlmReport, formatLlmReportMarkdown } from './llm-report.js';
import { buildBundle } from './bundle/index.js';
import { readFile } from 'node:fs/promises';
import { writeExclusive, OutputAlreadyExistsError } from './safe-write.js';
import type { Report, Snapshot } from './ir/types.js';

const ALL_ADAPTERS: RuntimeAdapter[] = [claudeCodeAdapter, codexAdapter];

function parseArgs(argv: string[]) {
  const cmd = argv[0] ?? 'help';
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags.set(k!, v);
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags.set(k!, argv[++i]!);
      else flags.set(k!, true);
    } else positional.push(a);
  }
  return { cmd, flags, positional };
}

function ctxFrom(flags: Map<string, string | boolean>): CollectContext {
  const home = String(flags.get('home') ?? process.env['AGENT_DOCTOR_HOME'] ?? homedir());
  const projectFlag = flags.get('project');
  const project = projectFlag === false || projectFlag === undefined ? process.cwd() : projectFlag === true ? null : String(projectFlag);
  const ctx: CollectContext = { home, project: project ? resolve(project) : null };
  const ch = flags.get('config-home');
  if (typeof ch === 'string') ctx.configHome = ch;
  const l = flags.get('launcher');
  if (typeof l === 'string') ctx.launchers = l.split(',').filter(Boolean).map((x) => resolve(x.replace(/^~(?=\/|$)/, home)));
  return ctx;
}

async function saveJson(out: string, value: unknown): Promise<void> {
  // 既存ファイル・既存 symlink は上書きしない（#75）。詳細は safe-write.ts
  await writeExclusive(out, JSON.stringify(value, null, 2));
}

function tilde(p: string, home: string): string {
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Phase 0 から必須のレポート種別宣言。省略すると誤診に見える */
function scopeBanner(probed = false): string {
  return [
    probed ? 'Report scope: NEXT SESSION (static) + ACTIVE RUNTIME (session records on disk)' : 'Report scope: NEXT SESSION (static analysis)',
    '  Running sessions keep the state they started with.',
    '  Config changes take effect on next launch.',
    probed
      ? '  Active-runtime facts come from records already on disk. No session was started, no tokens were spent.'
      : '  To compare against sessions already running: --probe',
    '',
  ].join('\n');
}

/**
 * --probe: すでにディスクにある記録（transcript / rollout / ps）から active runtime を観測して Snapshot に載せる。
 * 起動もしないし token も使わない。ファイルも書かない。
 */
/** 突合用の argv 末尾。Snapshot には載せないので、実行の間だけここに持つ */
let LAST_ARGV_TAILS: Map<number, string> = new Map();
let LAST_CAP_DESCS: Map<string, Map<string, string>> = new Map();
let LAST_HOOK_FIRINGS: Parameters<typeof runFindings>[1] extends { hookFirings?: infer H } ? H : never = undefined as never;
let LAST_MEASURED_COST: ReturnType<typeof measuredContextItems> = [];

async function withProbe(snapshot: Snapshot, ctx: CollectContext, flags: Map<string, string | boolean>): Promise<Snapshot> {
  if (!flags.get('probe')) return snapshot;
  const claudeHome = snapshot.runtimes.find((r) => r.runtime === 'claude-code')?.config_home ?? resolve(ctx.home, '.claude');
  const codexHome = snapshot.runtimes.find((r) => r.runtime === 'codex')?.config_home ?? resolve(ctx.home, '.codex');
  const selfFlag = flags.get('self-session');
  const obs = await observeActiveRuntime({
    home: ctx.home,
    claudeConfigHome: claudeHome,
    codexConfigHome: codexHome,
    project: ctx.project,
    liveWindowMinutes: Number(flags.get('live-window') ?? 30),
    maxSessions: Number(flags.get('max-sessions') ?? 20),
    selfSessionId: typeof selfFlag === 'string' ? selfFlag : null,
    allProjects: flags.get('all-projects') === true,
  });
  const sessions = obs.sessions.map((x) => toSessionInfo(x, obs.self_session_id));
  const processes = obs.processes.map(toProcessInfo);
  LAST_ARGV_TAILS = argvTails(obs.processes);
  LAST_CAP_DESCS = capabilityDescriptions(obs.sessions);
  LAST_HOOK_FIRINGS = hookFirings(obs.sessions) as typeof LAST_HOOK_FIRINGS;
  LAST_MEASURED_COST = measuredContextItems(obs.sessions);
  const observations = [...activeRuntimeObservations(snapshot, sessions, TOOL_VERSION), ...processObservations(snapshot, processes, TOOL_VERSION)];

  // Host / Runtime Signals v0.1 (#69): sessions/processes と同じ --probe の範囲でだけ集める。
  // observeActiveRuntime() がすでに access log を take 済みなので、host 分だけ別に begin/take する
  beginAccessLog();
  const hostBase = await collectHostResources();
  const hostAccess = takeAccessLog();
  const hostSignals = {
    mcpStatus: mcpServerStatuses(obs.sessions),
    rateLimit: rateLimitEvidence(obs.sessions),
    processSessionMap: mapProcessesToSessions(obs.processes, obs.sessions),
    host: { ...hostBase, processes: hostProcessUsages(obs.processes) },
  };
  return attachActiveRuntime(snapshot, sessions, processes, observations, obs.notes, [...obs.access, ...hostAccess], hostSignals);
}

async function cmdCollect(adapters: RuntimeAdapter[], ctx: CollectContext, json: boolean, showCoverage = false): Promise<Snapshot> {
  const { snapshot, perRuntime } = await collect(adapters, ctx);
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return snapshot;
  }
  console.log(scopeBanner(snapshot.sessions.length > 0));
  console.log(formatCoverage(snapshot.coverage, { compact: !showCoverage }));
  console.log('');
  for (const r of snapshot.runtimes) {
    console.log(`${r.runtime.padEnd(12)} ${r.version ?? '(version unknown)'}   ${tilde(r.config_home, ctx.home)}${r.present ? '' : '  [not present]'}`);
  }
  if (snapshot.env.launchers.length) console.log(`launchers    ${snapshot.env.launchers.map((x) => tilde(x, ctx.home)).join(', ')}`);
  console.log('');
  for (const p of perRuntime) {
    console.log(`  ${p.runtime}: resources=${p.resources} bindings=${p.bindings} observations=${p.observations}`);
  }

  // 内訳（Gate A の目視材料）
  const byKind = new Map<string, number>();
  for (const r of snapshot.resources) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  console.log('\n  by kind:');
  for (const [k, v] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(14)} ${v}`);

  const byMode = new Map<string, number>();
  for (const b of snapshot.bindings) byMode.set(b.load_mode, (byMode.get(b.load_mode) ?? 0) + 1);
  console.log('\n  by load_mode:');
  for (const [k, v] of [...byMode].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(18)} ${v}`);

  const byMech = new Map<string, number>();
  for (const b of snapshot.bindings) byMech.set(b.mechanism, (byMech.get(b.mechanism) ?? 0) + 1);
  console.log('\n  by mechanism:');
  for (const [k, v] of [...byMech].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(22)} ${v}`);

  const undisc = snapshot.bindings.filter((b) => !b.discovered);
  if (undisc.length) {
    const byRule = new Map<string, number>();
    for (const b of undisc) byRule.set(b.rule_id, (byRule.get(b.rule_id) ?? 0) + 1);
    console.log('\n  discovered=false (unreachable):');
    for (const [k, v] of byRule) console.log(`    ${k.padEnd(42)} ${v}`);
  }
  return snapshot;
}

async function cmdExplain(adapters: RuntimeAdapter[], ctx: CollectContext, needle: string): Promise<void> {
  const { snapshot } = await collect(adapters, ctx);
  const r =
    snapshot.resources.find((x) => x.resource_id === needle) ??
    snapshot.resources.find((x) => x.path.includes(needle)) ??
    snapshot.resources.find((x) => x.name === needle);
  if (!r) {
    console.error(`not found: ${needle}`);
    process.exitCode = 1;
    return;
  }
  console.log(scopeBanner());
  console.log(`Resource  ${r.name}  [${r.kind}]`);
  console.log(`  path            ${tilde(r.path, ctx.home)}`);
  if (r.real_path) console.log(`  real_path       ${tilde(r.real_path, ctx.home)}  (symlink)`);
  console.log(`  owner           ${r.owner}`);
  console.log(`  resource_id     ${r.resource_id.slice(0, 24)}…`);
  console.log(`  normalized      ${r.normalized_hash.slice(0, 24)}…`);
  console.log(`  size / mtime    ${r.size_bytes} B / ${r.mtime}`);

  console.log('\nBinding');
  for (const b of snapshot.bindings.filter((x) => x.resource_id === r.resource_id && x.resource_path === r.path)) {
    console.log(`  ${b.runtime} @ ${b.runtime_version ?? '?'}   ${b.binding_id}`);
    console.log(`    mechanism     ${b.mechanism}`);
    const src = b.source_ref;
    console.log(
      `    source_ref    ${src.type === 'discovery' ? `discovery ${tilde(src.search_path, ctx.home)}` : src.type === 'resource' ? `resource ${tilde(src.resource_path, ctx.home)}${src.locator ?? ''}` : `external ${tilde(src.ref, ctx.home)}${src.locator ? '#' + src.locator : ''}`}`,
    );
    console.log(`    discovered    ${b.discovered}`);
    console.log(`    rule          ${b.rule_id}`);
    console.log(`    rule_source   ${b.rule_source}`);
    console.log(`    load_mode     ${b.load_mode}   applies_to=${b.applies_to.join(',') || '-'}`);
    console.log(`    confidence    ${b.confidence}`);
    if (b.scope_condition) console.log(`    scope         ${b.scope_condition.join(', ')}`);
  }

  console.log('\nObservation');
  for (const o of snapshot.observations.filter((x) => x.resource_id === r.resource_id && x.resource_path === r.path)) {
    console.log(`  ${o.kind.padEnd(12)} ${String(o.value).slice(0, 40).padEnd(28)} method=${o.method} confidence=${o.confidence} scope=${o.scope}`);
    if (o.source_ref) console.log(`               source: ${tilde(o.source_ref, ctx.home)}`);
  }

  if (r.references.length) {
    console.log('\nRaw references (unresolved primary facts)');
    for (const x of r.references) console.log(`  L${String(x.line).padStart(4)}  [${x.syntax}] ${x.raw}   confidence=${x.confidence}`);
  }
}

async function main(): Promise<void> {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
  const json = flags.get('json') === true || flags.get('json') === 'true';
  const showCoverage = flags.get('coverage') === true;
  const ctx = ctxFrom(flags);
  const want = flags.get('runtime');
  const ADAPTERS =
    typeof want === 'string'
      ? ALL_ADAPTERS.filter((a) => want.split(',').includes(a.id))
      : ALL_ADAPTERS;
  if (ADAPTERS.length === 0) {
    console.error(`no adapter matches --runtime (available: ${ALL_ADAPTERS.map((a) => a.id).join(', ')})`);
    process.exitCode = 2;
    return;
  }


  switch (cmd) {
    case 'scan': {
      const { snapshot: base } = await collect(ADAPTERS, ctx);
      const snapshot = await withProbe(base, ctx, flags);
      // READ ONLY の読み手。本文が要る判定（SCOPE_MISMATCH の条件文 / drift の差分行数）にだけ使う
      const readText = async (p: string) => {
        try {
          return await readFile(p, 'utf8');
        } catch {
          return null;
        }
      };
      const result = await runFindings(snapshot, { readText, argvTails: LAST_ARGV_TAILS, capabilityDescriptions: LAST_CAP_DESCS, hookFirings: LAST_HOOK_FIRINGS });
      if (json) {
        const report: Report = {
          tool_version: TOOL_VERSION,
          generated_at: new Date().toISOString(),
          report_scope: 'next_session',
          snapshot,
          findings: result.findings,
          suppressed: result.suppressed,
          protected: result.protected,
          skipped: result.skipped,
          coverage: snapshot.coverage,
        };
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatReport({ snapshot, result, home: ctx.home, showCoverage }));
      }
      break;
    }

    case 'report': {
      if (!flags.get('llm')) {
        console.error('usage: agent-doctor report --llm [--format json|md] [--finding F-001,F-002] [--no-redact]  (for humans, use scan)');
        process.exitCode = 2;
        return;
      }
      const { snapshot: base2 } = await collect(ADAPTERS, ctx);
      const snapshot = await withProbe(base2, ctx, flags);
      const readText = async (p: string) => {
        try {
          return await readFile(p, 'utf8');
        } catch {
          return null;
        }
      };
      const dl = Number(flags.get('diff-lines'));
      const result = await runFindings(snapshot, { readText, argvTails: LAST_ARGV_TAILS, capabilityDescriptions: LAST_CAP_DESCS, hookFirings: LAST_HOOK_FIRINGS, ...(Number.isFinite(dl) && dl > 0 ? { diffLines: dl } : {}) });
      const only = typeof flags.get('finding') === 'string' ? String(flags.get('finding')).split(',').filter(Boolean) : undefined;
      const llm = await buildLlmReport(snapshot, result, { redactHome: flags.get('no-redact') !== true, readText, ...(only ? { only } : {}) });
      const fmt = String(flags.get('format') ?? 'json');
      console.log(fmt === 'md' ? formatLlmReportMarkdown(llm) : JSON.stringify(llm, null, 2));
      break;
    }

    case 'bundle': {
      // 他人の環境を安全に持ち出す 1 ファイル。**ローカルで redact してから書く。送信はしない**
      const out = String(flags.get('out') ?? `./agent-doctor-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      const levelFlag = String(flags.get('redact') ?? 'strict');
      if (levelFlag !== 'strict' && levelFlag !== 'standard') {
        console.error('--redact must be strict or standard');
        process.exitCode = 2;
        return;
      }
      const symptomFlag = flags.get('symptom');
      const readText = async (p: string) => {
        try {
          return await readFile(p, 'utf8');
        } catch {
          return null;
        }
      };
      const { snapshot: base } = await collect(ADAPTERS, ctx);
      const snapshot = await withProbe(base, ctx, flags);
      const dl = Number(flags.get('diff-lines'));
      const result = await runFindings(snapshot, {
        readText,
        argvTails: LAST_ARGV_TAILS,
        capabilityDescriptions: LAST_CAP_DESCS,
        hookFirings: LAST_HOOK_FIRINGS,
        ...(Number.isFinite(dl) && dl > 0 ? { diffLines: dl } : {}),
      });
      const llm = await buildLlmReport(snapshot, result, { readText });
      const ui = await buildUiData({
        snapshot,
        result,
        history: buildHistory(await loadSeries(String(flags.get('dir') ?? './snapshots'))),
        readText,
        llmFindings: llm.findings,
        clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })),
      });
      const bundle = await buildBundle({
        snapshot,
        result,
        llm,
        clusters: ui.overview.clusters,
        history: buildHistory(await loadSeries(String(flags.get('dir') ?? './snapshots'))),
        symptom: typeof symptomFlag === 'string' ? symptomFlag : null,
        level: levelFlag,
        readText,
      });

      if (!bundle.redaction.self_check.passed) {
        // 自己検査に落ちたものは書かない。**「たぶん入っていない」で出さない**
        console.error(`self-check found ${bundle.redaction.self_check.leaks_found} leak(s) — write aborted:`);
        for (const l of bundle.redaction.self_check.leaks.slice(0, 10)) console.error(`  ${l.kind}  at ${l.where}\n    ${l.sample}`);
        console.error('\nThis is a Doctor bug. File an issue and do not hand over this bundle.');
        process.exitCode = 1;
        return;
      }

      try {
        await saveJson(out, bundle);
      } catch (e) {
        if (e instanceof OutputAlreadyExistsError) {
          console.error(e.message);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      const cluster = bundle.clusters.length;
      const unobs = bundle.observation_status.could_not_observe.length;
      console.log(`saved: ${out}`);
      console.log('');
      console.log(`  ${cluster} area(s) need attention / ${bundle.llm_report.findings.length} finding(s)`);
      console.log(`  observation: ${bundle.observation_status.summary.observed} observed, ${unobs} could not be observed (never reported as 0)`);
      console.log(`  redaction: level=${bundle.redaction.level}, projects=${bundle.redaction.projects_anonymised}, paths=${bundle.redaction.paths_anonymised}, names=${bundle.redaction.names_anonymised}, secrets removed=${bundle.redaction.secrets_removed.reduce((a, b) => a + b.count, 0)}`);
      console.log(`  self check: passed (no home path, no username, no known secret shape left)`);
      console.log('');
      console.log('  READ ONLY. Nothing was written to the examined environment and nothing was sent anywhere.');
      console.log('  No file contents — only hashes, byte counts, line counts, diff sizes, kinds, mechanisms, timestamps.');
      console.log('  Open it yourself before handing it over. It is just JSON.');
      break;
    }

    case 'ui': {
      const port = Number(flags.get('port') ?? 7333);
      const dir = String(flags.get('dir') ?? './snapshots');
      const readText = async (p: string) => {
        try {
          return await readFile(p, 'utf8');
        } catch {
          return null;
        }
      };
      const rescan = async () => {
        const { snapshot: b } = await collect(ADAPTERS, ctx);
        const snapshot = await withProbe(b, ctx, flags);
        const dl = Number(flags.get('diff-lines'));
        const result = await runFindings(snapshot, {
          readText,
          argvTails: LAST_ARGV_TAILS,
          capabilityDescriptions: LAST_CAP_DESCS,
          hookFirings: LAST_HOOK_FIRINGS,
          ...(Number.isFinite(dl) && dl > 0 ? { diffLines: dl } : {}),
        });
        const llm = await buildLlmReport(snapshot, result, { readText });
        const series = await loadSeries(dir);
        const history = buildHistory(series);
        return buildUiData({ snapshot, result, history, readText, llmFindings: llm.findings, clusters: llm.clusters.map((c) => ({ id: c.id, title: c.title, shared_question: c.shared_question, members: c.members })) });
      };
      // --print: サーバを立てずに UI と同じデータを 1 回出す（テストと read-only 回帰のため）
      if (flags.get('print') === true) {
        console.log(JSON.stringify(await rescan(), null, 2));
        break;
      }
      process.stdout.write('scanning…\n');
      const srv = await startUiServer({ port, rescan });
      console.log(`\n  Agent Environment Doctor — ${srv.url}`);
      console.log('  READ ONLY. Bound to 127.0.0.1 only. Nothing is written to the examined environment.');
      console.log(`  history: reading snapshots from ${dir}`);
      console.log('  Ctrl-C to stop.\n');
      // 明示的に閉じるまで動かす
      await new Promise<void>((resolve) => {
        const stop = () => {
          srv.close().then(resolve, resolve);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      break;
    }

    case 'history': {
      const dir = String(flags.get('dir') ?? './snapshots');
      const max = Number(flags.get('max') ?? 0);
      const series = await loadSeries(dir, max > 0 ? { max } : {});
      const h = buildHistory(series);
      if (json) {
        console.log(JSON.stringify(h, null, 2));
        break;
      }
      console.log(`History from ${dir} — ${series.usable.length} comparable snapshot(s), ${series.skipped.length} skipped`);
      for (const n of h.notes) console.log(`  ${n}`);
      if (series.gaps.length) {
        console.log('\n  gaps in observation (nothing that happened here is visible):');
        for (const g of series.gaps) console.log(`    ${g.from} → ${g.to}  (${g.hours} h)`);
      }
      console.log('\n  trend (facts, not a score):');
      console.log(`    ${'at'.padEnd(26)} ${'res'.padStart(5)} ${'bind'.padStart(5)} ${'obs'.padStart(6)} ${'disc'.padStart(5)} ${'drift'.padStart(5)} ${'sess'.padStart(5)}`);
      for (const t of h.trend) {
        console.log(`    ${t.at.padEnd(26)} ${String(t.resources).padStart(5)} ${String(t.bindings).padStart(5)} ${String(t.observations).padStart(6)} ${String(t.discovered).padStart(5)} ${String(t.drifted_skills).padStart(5)} ${(t.sessions === null ? '—' : String(t.sessions)).padStart(5)}`);
      }
      if (h.events.length === 0) {
        console.log('\n  no events derived.');
      } else {
        const byKind = new Map<string, number>();
        for (const e of h.events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
        console.log('\n  events:');
        for (const [k, v] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}`);
        console.log('');
        for (const e of h.events.slice(0, 40)) console.log(`    ${e.observed_at}  ${e.kind.padEnd(26)} ${e.summary}`);
        if (h.events.length > 40) console.log(`    … and ${h.events.length - 40} more`);
      }
      break;
    }

    case 'collect':
      await cmdCollect(ADAPTERS, ctx, json, showCoverage);
      break;

    case 'gate-a': {
      const { snapshot } = await collect(ADAPTERS, ctx);
      const g = runGateA(snapshot);
      if (json) console.log(JSON.stringify(g, null, 2));
      else {
        await cmdCollect(ADAPTERS, ctx, false, showCoverage);
        console.log(formatGateResult(g));
      }
      process.exitCode = g.pass ? 0 : 1;
      break;
    }

    case 'snapshot': {
      const out = String(flags.get('out') ?? `./snapshots/${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      const { snapshot: sbase } = await collect(ADAPTERS, ctx);
      const snapshot = await withProbe(sbase, ctx, flags);
      try {
        await saveSnapshot(snapshot, out);
      } catch (e) {
        if (e instanceof OutputAlreadyExistsError) {
          console.error(e.message);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      console.log(`saved: ${out}  (resources=${snapshot.resources.length} bindings=${snapshot.bindings.length} observations=${snapshot.observations.length})`);
      break;
    }

    case 'diff': {
      const a = positional[0];
      if (!a) {
        console.error('usage: agent-doctor diff <old.json> [<new.json>]');
        process.exitCode = 2;
        return;
      }
      const oldS = await loadSnapshot(a);
      const newS = positional[1] ? await loadSnapshot(positional[1]) : (await collect(ADAPTERS, ctx)).snapshot;
      const d = diffSnapshots(oldS, newS);
      if (json) {
        console.log(JSON.stringify(d, null, 2));
      } else {
        console.log(scopeBanner());
        console.log(`added=${d.added.length} removed=${d.removed.length} changed=${d.changed.length} rebound=${d.rebound.length} bound=${d.bound.length} unbound=${d.unbound.length}`);
        for (const x of d.added.slice(0, 20)) console.log(`  + ${tilde(x.path, ctx.home)}`);
        for (const x of d.removed.slice(0, 20)) console.log(`  - ${tilde(x.path, ctx.home)}`);
        for (const x of d.changed.slice(0, 20)) console.log(`  ~ ${tilde(x.path, ctx.home)}`);
        for (const x of d.rebound.slice(0, 20))
          console.log(`  ! binding changed: ${tilde(x.after.resource_path, ctx.home)} [${x.after.mechanism}] ${x.before.rule_id} → ${x.after.rule_id}`);
        for (const x of d.bound.slice(0, 20)) console.log(`  +b ${x.runtime} ${tilde(x.resource_path, ctx.home)} [${x.mechanism}]`);
        for (const x of d.unbound.slice(0, 20)) console.log(`  -b ${x.runtime} ${tilde(x.resource_path, ctx.home)} [${x.mechanism}]`);
      }
      break;
    }

    case 'explain': {
      const needle = positional[0];
      if (!needle) {
        console.error('usage: agent-doctor explain <resource_id|partial path|name>');
        process.exitCode = 2;
        return;
      }
      await cmdExplain(ADAPTERS, ctx, needle);
      break;
    }

    default:
      console.log(`agent-doctor ${TOOL_VERSION} (READ ONLY)

  scan    [--json]              collect and diagnose (UNREACHABLE_REFERENCE / CROSS_RUNTIME_DRIFT / SCOPE_MISMATCH)
  ui      [--port 7333]         view the structure on localhost (READ ONLY, 127.0.0.1 only). Drill down Overview → detail → Evidence. Can be combined with --probe
                                --print emits the same data once without starting a server
  bundle  --out <file>          build a single-file diagnostic bundle to hand to someone else (redacted locally, never sent anywhere)
                                --symptom "..." to attach a complaint / --redact standard to keep resource names (default strict)
  history [--dir <snapshots>]   derive "what appeared / disappeared / drifted / went stale" from a series of snapshots
  report --llm [--format md]    report for the fixing LLM (Emma / Claude / Codex). --finding F-001 for a single finding, --no-redact to keep HOME raw
                                --diff-lines <n> caps the drift diff excerpt (default 80)
  collect [--json]              collect and summarize Resource / Binding / Observation
  gate-a  [--json]              check whether the IR can naturally express real data
  snapshot --out <file>         save the 4 kinds of factual data
  diff <old.json> [<new.json>]  diff between snapshots (omit new to compare against current state)
  explain <id|path|name>        show the source → binding → observation chain

  common: --home <dir>  --project <dir>  --config-home <dir>  --runtime claude-code,codex
        --probe                         also read records of running sessions (transcript / rollout / ps). Does not launch anything, 0 tokens
        --live-window <min>             consider it "running" if records were updated within this many minutes (default 30)
        --max-sessions <n>              cap on scanned session records (newest first, default 20)
        --self-session <id>             the session Doctor itself is running in (won't report itself as a mismatch)
        --all-projects                  also look at session records outside the cwd's project
        --launcher <script>[,<script>]  name launcher scripts explicitly (collects --append-system-prompt "$(cat …)" as an injection path)
        --coverage                      print full text of what is / isn't collected

Doctor goes observation → evidence → symptom. It does not treat (there is no --fix). It does not treat heavy=bad / unused=unnecessary / invisible=abnormal.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exitCode = 1;
});
