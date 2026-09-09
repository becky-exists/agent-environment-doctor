/**
 * テスト共通ヘルパ
 *
 * - fixture の読み込みと `~` の展開
 * - in-process collect（外部 CLI を呼ばないよう PATH を絞る）
 * - 患者環境の指紋（hash / mtime / エントリ一覧）を取る walk
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, readlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { codexAdapter } from '../src/adapters/codex/index.js';
import { collect, attachActiveRuntime } from '../src/snapshot.js';
import { observeActiveRuntime, toSessionInfo, toProcessInfo, activeRuntimeObservations, processObservations, argvTails, capabilityDescriptions } from '../src/probe/index.js';
import type { Snapshot } from '../src/ir/types.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'fixtures');
export const FIXTURE_NAMES = ['unreachable-reference', 'cross-runtime-drift', 'scope-mismatch', 'guard-false-bloat', 'session-staleness', 'windows-projects', 'bundle-privacy'] as const;

/** collectFixture が probe を走らせた時の側チャネル（argv 末尾 / capability 説明）。runFindings に渡す */
export let lastProbe: { argvTails: Map<number, string>; capabilityDescriptions: Map<string, Map<string, string>> } = {
  argvTails: new Map(),
  capabilityDescriptions: new Map(),
};

export interface Expectation {
  schema: string;
  fixture: string;
  home: string;
  project: string | null;
  runtimes: string[];
  findings: Array<Record<string, unknown>>;
  no_findings: Array<Record<string, unknown> & { why: string }>;
  ir_preconditions: Array<Record<string, unknown>>;
  /** fixture ディレクトリ相対。CollectContext.launchers に渡す */
  launchers?: string[];
  /** active runtime も観測する fixture。live_window は 10 年等に設定してチェックアウト時刻に依存させない */
  probe?: { live_window_minutes: number; self_session?: string; note?: string };
  guard?: string;
}

export function fixtureLaunchers(name: string, exp?: Expectation): string[] {
  return (exp?.launchers ?? []).map((l) => join(FIXTURES, name, l));
}

export async function loadExpectation(name: string): Promise<Expectation> {
  return JSON.parse(await readFile(join(FIXTURES, name, 'expected.json'), 'utf8')) as Expectation;
}

export function fixtureHome(name: string, exp?: Expectation): string {
  return join(FIXTURES, name, exp?.home ?? 'env/home');
}

/** expected.json の `~` を fixture の home に展開する */
/**
 * home の見た目（区切り文字）から、Windows 形式かどうかを機械的に判定する。
 * 実行環境（process.platform）に頼らず文字列そのもので判定することで、Windows 実機が無くても
 * 「home に Windows 形式の文字列を渡した時、実機 Windows と同じ結合規則で解決されるか」を
 * このテストスイート内（Mac 上）で検証できるようにする（#72）。
 */
function joinerFor(home: string): typeof join {
  // 実機 Windows 上ではこの ambient `join`（node:path の既定 export）自体が win32.join と同一物になる
  // ため、else 節で `join` を返すと「home が POSIX 形式の時は POSIX 規則で組む」という意図に反して
  // Windows 実機では win32 規則で組まれてしまう（#72 R4b）。else は明示的に posix.join にする。
  return /^[A-Za-z]:[\\/]/.test(home) || home.includes('\\') ? win32.join : posix.join;
}

/**
 * `~/x/y` の実体パスを home 基準で解決する。
 *
 * fixture の expected.json は常に `/` 区切りで書かれているが、home 側の区切り文字は実行環境で変わる
 * （Windows なら `\`）。旧実装（`home + p.slice(1)`）は単純な文字列連結だったため、Windows 上では
 * `C:\Users\...\home/.claude/skills/x.md` のような区切り文字混在パスができ、production 側
 * （`node:path` の `join()` で一貫して生成される Resource.path）との厳密比較が常に不一致になっていた（#72）。
 * ここでは `/` 区切りのセグメントに分解してから home の規則で組み直すことで、混在を作らない。
 */
export function expand(p: string, home: string): string {
  if (!p.startsWith('~')) return p;
  const segs = p.slice(1).split('/').filter(Boolean);
  return joinerFor(home)(home, ...segs);
}

/** 実環境の変数と外部 CLI から切り離した状態で collect する */
export async function collectFixture(name: string, exp?: Expectation): Promise<Snapshot> {
  const home = fixtureHome(name, exp);
  const saved = { CODEX_HOME: process.env['CODEX_HOME'], CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'], PATH: process.env['PATH'] };
  delete process.env['CODEX_HOME'];
  delete process.env['CLAUDE_CONFIG_DIR'];
  // claude / codex の --version を呼ばせない（version は null になる。fixture では version を問わない）
  process.env['PATH'] = dirname(process.execPath);
  try {
    const project = exp?.project ? join(FIXTURES, name, exp.project) : null;
    const { snapshot } = await collect([claudeCodeAdapter, codexAdapter], { home, project, launchers: fixtureLaunchers(name, exp) });
    if (!exp?.probe) return snapshot;
    // active runtime も観測する（ディスクの記録を読むだけ。起動しない）
    const obs = await observeActiveRuntime({
      home,
      claudeConfigHome: join(home, '.claude'),
      codexConfigHome: join(home, '.codex'),
      project,
      liveWindowMinutes: exp.probe.live_window_minutes,
      maxSessions: 50,
      selfSessionId: exp.probe.self_session ?? null,
      allProjects: true,
    });
    const sessions = obs.sessions.map((x) => toSessionInfo(x, obs.self_session_id));
    const processes = obs.processes.map(toProcessInfo);
    lastProbe = { argvTails: argvTails(obs.processes), capabilityDescriptions: capabilityDescriptions(obs.sessions) };
    return attachActiveRuntime(snapshot, sessions, processes, [...activeRuntimeObservations(snapshot, sessions, 'test'), ...processObservations(snapshot, processes, 'test')], obs.notes, obs.access);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ───────────────────────── 患者の指紋 ─────────────────────────

export interface Fingerprint {
  /** root からの相対パス → 記述子 */
  entries: Map<string, string>;
}

/**
 * 相対パスのキーを `/` 区切りに統一する。
 * `relative()` は実行環境の区切り文字（Windows なら `\`）を返すため、キーをそのまま使うと
 * `readonly.test.ts` 側の `/` 前提のフィルタ・正規表現が Windows で一致しなくなる（#72）。
 * Mac 上では `\` が現れないので置換は無害。
 */
export function toPosixKey(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * ディレクトリ配下すべての「変わったら分かる」情報を取る。
 *   file    : sha256 + size + mtimeMs + mode
 *   dir     : 子エントリ名（ソート済み）+ mtimeMs（子の追加・削除で変わる）
 *   symlink : リンク先（辿らない）
 * atime は読むだけで動くので見ない。ctime は chmod で動くので見ない。
 */
export async function fingerprint(root: string): Promise<Fingerprint> {
  const entries = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const names = (await readdir(dir)).sort();
    const st = await lstat(dir);
    entries.set(toPosixKey(relative(root, dir)) || '.', `dir entries=[${names.join(',')}] mtime=${st.mtimeMs}`);
    for (const n of names) {
      const full = join(dir, n);
      const s = await lstat(full);
      if (s.isSymbolicLink()) entries.set(toPosixKey(relative(root, full)), `symlink -> ${await readlink(full)}`);
      else if (s.isDirectory()) await walk(full);
      else {
        const h = createHash('sha256').update(await readFile(full)).digest('hex');
        entries.set(toPosixKey(relative(root, full)), `file sha256=${h} size=${s.size} mtime=${s.mtimeMs} mode=${(s.mode & 0o777).toString(8)}`);
      }
    }
  }
  await walk(root);
  return { entries };
}

/** 2 つの指紋の差。空なら無変化 */
export function diffFingerprints(before: Fingerprint, after: Fingerprint): string[] {
  const out: string[] = [];
  for (const [k, v] of before.entries) {
    const w = after.entries.get(k);
    if (w === undefined) out.push(`removed: ${k}`);
    else if (w !== v) out.push(`changed: ${k}\n    before ${v}\n    after  ${w}`);
  }
  for (const k of after.entries.keys()) if (!before.entries.has(k)) out.push(`added: ${k}`);
  return out;
}
