/**
 * 人向けレポート（scan の出力）
 *
 * 必須要素（docs/phase0-implementation-handoff.md §6.1）:
 *   - 冒頭の Report scope 宣言（NEXT SESSION）
 *   - coverage（何を見ていて何を見ていないか）
 *   - Finding は severity 順、なぜそう言えるか（rule_id / searched / 対照例）を添える
 *   - 最後に「no findings for:」= 数が大きいが問題ではないものを Doctor 自身が明示する
 * 言葉の規律: 削除 / 不要 / 無駄 / 最適化 を書かない。事実だけ。
 */
import type { Coverage, Finding, Snapshot } from './ir/types.js';
import type { FindingsResult } from './findings/index.js';
import { formatCoverage } from './coverage.js';

export interface ReportInput {
  snapshot: Snapshot;
  result: FindingsResult;
  home: string;
  showCoverage?: boolean;
}

function tilde(p: string, home: string): string {
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export function scopeBanner(probed = false): string {
  return [
    probed ? 'Report scope: NEXT SESSION (static) + ACTIVE RUNTIME (records already on disk)' : 'Report scope: NEXT SESSION (static analysis)',
    '  Running sessions keep the state they started with.',
    '  Config changes take effect on next launch.',
    probed
      ? '  Active-runtime facts come from session records and `ps`. No session was started, no tokens were spent, nothing was written.'
      : '  To compare against sessions already running: --probe',
  ].join('\n');
}

export function formatReport(inp: ReportInput): string {
  const { snapshot: s, result, home } = inp;
  const L: string[] = [];
  L.push(scopeBanner(s.sessions.length > 0 || s.processes.length > 0));
  L.push('');
  L.push(formatCoverage(s.coverage as Coverage, { compact: !inp.showCoverage }));
  L.push('');
  for (const r of s.runtimes) L.push(`${r.runtime.padEnd(12)} ${r.version ?? '(version unknown)'}   ${tilde(r.config_home, home)}${r.present ? '' : '  [not present]'}`);
  if (s.env.project) L.push(`project      ${s.env.project}`);
  if (s.env.launchers.length) L.push(`launchers    ${s.env.launchers.map((x) => tilde(x, home)).join(', ')}`);
  L.push('');
  const perRt = new Map<string, number>();
  for (const b of s.bindings) perRt.set(b.runtime, (perRt.get(b.runtime) ?? 0) + 1);
  L.push(`resources    ${s.resources.length}   bindings ${[...perRt].map(([k, v]) => `${k} ${v}`).join(' / ')}   observations ${s.observations.length}`);
  if (s.sessions.length || s.processes.length) {
    const live = s.sessions.filter((x) => x.live);
    L.push(`active       ${s.sessions.length} session record(s) read (${live.length} recently active), ${s.processes.length} running process(es) — from records on disk, no session started`);
    const cmp = s.sessions.filter((x) => x.comparable_capabilities);
    const ts = s.sessions.filter((x) => x.comparable_timestamps);
    L.push(`             ${cmp.length} compared by capability, ${ts.length} by timestamp; rest excluded (own session / subagent / non-interactive entrypoint / not recently active)`);
    for (const x of [...ts, ...live.filter((y) => !y.comparable_timestamps)].slice(0, 6)) {
      const caps = Object.entries(x.capabilities).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${(v as string[]).length}`).join(' ');
      L.push(`             ${x.session_id.slice(0, 8)} ${x.runtime} ${x.entrypoint ?? '?'} started=${x.started_at ?? '?'} ${caps || '(no capability record)'}${x.comparable_capabilities ? '' : `  [capability not compared: ${x.not_comparable_reason}]`}`);
    }
  } else {
    L.push('active       not observed (run with --probe to compare against running sessions)');
  }
  const protectedBytes = result.protected.reduce((n, p) => n + p.size_bytes, 0);
  L.push(`protected    ${result.protected.length} resources, ${protectedBytes.toLocaleString()} B — no proposal about their size or existence; findings on them keep their severity`);
  L.push('');

  const bySev = { error: [] as Finding[], warn: [] as Finding[], info: [] as Finding[] };
  for (const f of result.findings) bySev[f.severity].push(f);
  const total = result.findings.length;
  if (total === 0) L.push('No findings.');
  for (const sev of ['error', 'warn', 'info'] as const) {
    const fs = bySev[sev];
    if (!fs.length) continue;
    const byId = new Map<string, Finding[]>();
    for (const f of fs) {
      const k = f.subtype ? `${f.finding_id} / ${f.subtype}` : f.finding_id;
      const arr = byId.get(k) ?? [];
      arr.push(f);
      byId.set(k, arr);
    }
    for (const [k, arr] of byId) {
      L.push(`${sev.toUpperCase().padEnd(6)} ${k.padEnd(44)} ${arr.length}`);
      for (const f of arr) L.push(...formatFinding(f, home));
      L.push('');
    }
  }

  L.push('no findings for:');
  if (result.suppressed.length === 0) L.push('  (nothing suppressed)');
  for (const x of result.suppressed) L.push(`  ${x.detail}`);
  for (const p of result.protected.slice(0, 3)) L.push(`  ${tilde(p.path, home)} (${p.size_bytes.toLocaleString()} B, protected by ${p.glob}) — heavy is not a defect`);
  if (result.protected.length > 3) L.push(`  … and ${result.protected.length - 3} more protected resources`);
  if (result.skipped.length) {
    L.push('');
    L.push('not evaluated (input missing, not a pass):');
    for (const x of result.skipped) L.push(`  ${x.detector}: ${x.reason}`);
  }

  // 見に行って読めなかったもの。**0 件として黙らない**
  const blocked = (s.access ?? []).filter((a) => a.status === 'permission_denied' || a.status === 'failed' || a.status === 'unsupported');
  if (blocked.length) {
    L.push('');
    L.push('could not observe (unknown, NOT zero and NOT absent):');
    for (const a of blocked) L.push(`  ${a.what} @ ${tilde(a.target, home)}: ${a.status}${a.error_code ? ` (${a.error_code})` : ''}${a.reason ? ` — ${a.reason}` : ''}`);
  }
  return L.join('\n');
}

function formatFinding(f: Finding, home: string): string[] {
  const L: string[] = [];
  const subj = f.subject.path ? tilde(f.subject.path, home) : f.subject.name ?? '?';
  L.push(`  ${subj}${f.protected ? '   [protected: no wholesale change proposed]' : ''}   confidence=${f.confidence}`);
  L.push(`    ${f.summary}`);
  for (const e of f.evidence_refs) {
    switch (e.type) {
      case 'binding':
        L.push(`    binding   ${e.runtime} ${e.mechanism} rule=${e.rule_id}`);
        break;
      case 'absence':
        L.push(`    searched  ${e.searched.map((x) => tilde(x, home)).join(', ')}`);
        break;
      case 'contrast':
        L.push(`    compare   ${tilde(e.path, home)} — ${e.note}`);
        break;
      case 'session':
        L.push(`    session   ${e.session_id.slice(0, 8)} ${e.runtime} started=${e.started_at ?? '?'} — ${e.note}`);
        break;
      case 'process':
        L.push(`    process   pid ${e.pid} ${e.runtime} started=${e.started_at ?? '?'} — ${e.note}`);
        break;
      case 'reference':
        L.push(`    ref       ${tilde(e.path, home)}:${e.line}  \`${e.raw}\``);
        break;
      default:
        break; // resource / observation は summary に含まれる
    }
  }
  if (f.subject.resource_id) L.push(`    → agent-doctor explain ${tilde(f.subject.path ?? '', home)}`);
  return L;
}
