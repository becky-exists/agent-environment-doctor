/**
 * 起動中プロセスの argv と開始時刻を読む（`ps`、read only）
 *
 * なぜ要るか: 起動スクリプトの `--append-system-prompt "$(cat <path>)"` は **argv に展開済みの本文が載る**。
 * つまり「そのセッションが実際に何を注入されて起動したか」がプロセスから読める。
 * 実測（2026-09-07）: 同じ becky-start.sh 由来の 2 プロセスで、片方の argv に旧パスの本文、
 * もう片方に新パスの本文が入っていた（8/21 起動のものと 9/7 起動のもの）。ファイルを移動しても
 * 起動中プロセスの argv は変わらない。これが SESSION_STALENESS の一次事実になる。
 *
 * ⚠ argv には秘密が混ざりうる（token を渡す起動スクリプトなど）。**本文は保持せず長さと hash だけ**を持ち、
 * 突合もハッシュで行う。パスとフラグ名は保持する（証拠として必要）。
 */
import { recordAccess } from '../ir/access.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RuntimeProcess {
  pid: number;
  ppid: number;
  /** ISO8601。ps の lstart をパースしたもの。パースできなければ null */
  started_at: string | null;
  runtime: 'claude-code' | 'codex';
  /** argv 全体は持たない。フラグ名だけ */
  flags: string[];
  /**
   * --append-system-prompt に渡された本文の指紋（本文は保持しない）。
   * ⚠ ps の 1 行から quote を復元することはできないので、この値は **フラグ以降の末尾全部**。
   * 実測（2026-09-07）: 注入本文の中に `--channels` という文字列が入っていたため、
   * 「次のフラグまで」で切ると本文が途中で切れて偽の不一致になった。だから切らない。
   * 突合は「ファイル本文が argv 末尾の前方一致か（またはその逆）」で行う（prefixMatches）。
   */
  appended_system_prompt: { bytes: number; sha256: string; tail_is_open_ended: true } | null;
  /** argv に見えた設定ファイルのパス（--append-system-prompt "$(cat X)" の X は argv には残らないので、これは別フラグ由来） */
  config_paths: string[];
  /** argv の総バイト数（診断の目安） */
  argv_bytes: number;
  /**
   * 突合用に一時的に持つ、--append-system-prompt 以降の正規化済み末尾。
   * **Snapshot には載せない**（秘密が混ざりうる）。ProcessInfo へ変換する時に落とす。
   */
  appended_tail?: string | null;
  /** #69 Host Signals v0.1: 同じ ps 呼び出しに乗せた %CPU / RSS(KB)。取れなければ null（0 にしない） */
  cpu_percent: number | null;
  rss_bytes: number | null;
}

/** `ps` の lstart 形式（ロケール依存）を極力パースする。できなければ null */
function parseLstart(s: string): string | null {
  const t = s.trim();
  // 英語ロケール: "Mon Sep  7 16:23:34 2026"
  const en = Date.parse(t);
  if (!Number.isNaN(en)) return new Date(en).toISOString();
  // 日本語ロケール実測: "月  9/ 7 16:23:34 2026"
  const ja = /^\S+\s+(\d{1,2})\/\s*(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(t);
  if (ja) {
    const [, mo, d, h, mi, sec, y] = ja;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  return null;
}

/**
 * 起動中の claude / codex プロセスを列挙する。
 * 意図的に単純化: `ps -axo pid=,ppid=,lstart=,command=` を 1 回。上限 = 出力 4 MB、
 * 必要になったら /proc 相当（macOS は libproc）へ差し替える。
 */
export async function listRuntimeProcesses(): Promise<RuntimeProcess[]> {
  let stdout: string;
  try {
    // #69: 同じ呼び出しに pcpu / rss を乗せる（2 回 ps を叩かない）。darwin/linux とも BSD 由来のこの記法で通る
    ({ stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,lstart=,command='], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (e) {
    // ps が無い / 失敗しても診断は続ける。ただし **0 プロセスとして黙らない**
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null;
    const windowsLike = process.platform === 'win32';
    recordAccess({
      target: 'ps -axo pid=,ppid=,lstart=,command=',
      collector: 'probe',
      what: 'running runtime processes',
      status: windowsLike ? 'unsupported' : 'failed',
      error_code: code,
      reason: windowsLike
        ? 'this platform has no BSD-style `ps`; running processes were not observed at all'
        : '`ps` could not be run, so no process was observed. This is not evidence that no runtime is running.',
    });
    return [];
  }

  const out: RuntimeProcess[] = [];
  let matched = 0;
  for (const line of stdout.split('\n')) {
    // pid ppid pcpu rss <lstart（可変長）> command
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+\s+\S+\s*\S*\s+\S+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pidS, ppidS, pcpuS, rssS, lstart, command] = m;
    const cmd = command ?? '';

    // 実行ファイルが claude / codex のものだけ。grep や自分自身の shell は拾わない
    const exe = /^(?:\S*\/)?(claude|codex)(?:\s|$)/.exec(cmd) ?? /^\S*\/(claude|codex)\s/.exec(cmd);
    const isClaude = /(^|\/)claude(\s|$)/.test(cmd.split(/\s+/)[0] ?? '');
    const isCodex = /(^|\/)codex(\s|$)/.test(cmd.split(/\s+/)[0] ?? '');
    if (!isClaude && !isCodex) continue;
    void exe;

    const flags = [...cmd.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/g)].map((x) => x[1]!);
    // --append-system-prompt 以降の末尾全部。フラグでは切らない（本文にフラグ文字列が入りうる）
    let appended: RuntimeProcess['appended_system_prompt'] = null;
    let appendedTail: string | null = null;
    const ai = cmd.indexOf('--append-system-prompt');
    if (ai >= 0) {
      const rest = cmd.slice(ai + '--append-system-prompt'.length).replace(/^[=\s]+/, '');
      const norm = normalizeArgvText(rest);
      if (norm) {
        appended = { bytes: Buffer.byteLength(norm, 'utf8'), sha256: 'sha256:' + createHash('sha256').update(norm, 'utf8').digest('hex'), tail_is_open_ended: true };
        appendedTail = norm;
      }
    }
    const config_paths = [...cmd.matchAll(/(?:^|[\s="'])((?:~|\/)[\w./@+-]*\.(?:md|json|toml))/g)].map((x) => x[1]!);

    out.push({
      pid: Number(pidS),
      ppid: Number(ppidS),
      started_at: parseLstart(lstart ?? ''),
      runtime: isCodex ? 'codex' : 'claude-code',
      flags: [...new Set(flags)],
      appended_system_prompt: appended,
      appended_tail: appendedTail,
      config_paths: [...new Set(config_paths)],
      argv_bytes: Buffer.byteLength(cmd, 'utf8'),
      cpu_percent: pcpuS !== undefined && pcpuS !== '' ? Number(pcpuS) : null,
      rss_bytes: rssS !== undefined && rssS !== '' ? Number(rssS) * 1024 : null,
    });
  }
  return out;
}

/** ps 出力の 1 行に潰された本文を復元する（改行の \012 / \n エスケープ） */
export function normalizeArgvText(s: string): string {
  return s.replace(/\\012/g, '\n').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim();
}

/** ファイル本文の指紋。argv の指紋と同じ規則（trim + 改行統一）で作る */
export function promptDigest(text: string): { bytes: number; sha256: string } {
  const norm = text.replace(/\r\n?/g, '\n').trim();
  return { bytes: Buffer.byteLength(norm, 'utf8'), sha256: 'sha256:' + createHash('sha256').update(norm, 'utf8').digest('hex') };
}

/**
 * argv 末尾とファイル本文が「同じものを指しているか」の判定。
 * argv 末尾は開いている（後続フラグが混ざりうる）ので、前方一致のどちらかが成立すれば一致とみなす。
 * ps が長い argv を打ち切る環境もあるため、逆向きの前方一致も許す。
 */
export function prefixMatches(argvTail: string, fileText: string): { match: boolean; how: string } {
  const a = normalizeArgvText(argvTail);
  const f = fileText.replace(/\r\n?/g, '\n').trim();
  if (a === f) return { match: true, how: 'argv tail equals the file content' };
  if (a.startsWith(f)) return { match: true, how: 'the file content is a prefix of the argv tail (the rest of the tail is other argv)' };
  if (f.startsWith(a)) return { match: true, how: 'the argv tail is a prefix of the file content (ps truncated the argv)' };
  // 先頭が一致していれば「同じファイル由来だが内容が変わった」寄り。全く違えば別物
  const head = Math.min(120, a.length, f.length);
  return { match: false, how: a.slice(0, head) === f.slice(0, head) ? 'same opening text but the content diverges further in' : 'the opening text differs' };
}
