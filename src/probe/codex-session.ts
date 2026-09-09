/**
 * Codex の session rollout から起動中セッションの状態を読む
 *
 * Claude 側と対称。**記録を読むだけ**で、token を使わず副作用が無い。
 *
 * 実測（2026-09-07、codex-cli 0.153.4）: `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl`
 *   1 行目 {"type":"session_meta","payload":{session_id, timestamp, cwd, cli_version, originator,
 *                                            base_instructions:{text}, context_window, git, …}}
 * Claude と違い **起動時に載った命令本文（base_instructions.text）が記録されている**。
 * ⚠ 本文は保持しない。長さと sha256 だけ取り、現在のファイルと突合する時もハッシュで比べる。
 * 逆に skill / agent の一覧は記録が無い（Claude 側は取れる）。互いに補完関係。
 */
import { classifyError, recordAccess } from '../ir/access.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import type { SessionObservation } from './transcript.js';

export async function scanCodexSession(path: string, liveWindowMs: number): Promise<SessionObservation | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }

  const obs: SessionObservation = {
    session_id: '',
    runtime: 'codex',
    record_path: path,
    started_at: null,
    last_activity_at: st.mtime.toISOString(),
    live: Date.now() - st.mtimeMs <= liveWindowMs,
    runtime_version: null,
    cwd: null,
    git_branch: null,
    entrypoint: null,
    // Codex 側は skill / agent の一覧が記録されない = 観測できていない（null のまま）
    capabilities: { skills: null, agents: null, deferred_tools: null, mcp_instructions: null, failed_mcp_servers: null },
    capabilities_from_startup: false,
    non_initial_listings: 0,
    capability_descriptions: new Map(),
    instruction_text_available: false,
    instruction_digest: null,
    is_sidechain: false,
    mcp_instruction_bytes: new Map(),
    hook_firings: new Map(),
    // #69: codex の rollout は session_meta（先頭行）しか読まない設計のまま。
    // MCP 接続状況・API エラーはここでは観測しない（会話本文に踏み込まずに読める構造フィールドが今のところ見当たらない）
    mcp_events: [],
    api_errors: [],
  };

  // session_meta は先頭。turn_context 以降は読まない（会話本文を触らない）
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"session_meta"')) {
        if (obs.session_id) break; // meta を取り終えたら以降は読まない
        continue;
      }
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        break;
      }
      const p = (rec['payload'] ?? {}) as Record<string, unknown>;
      obs.session_id = typeof p['session_id'] === 'string' ? p['session_id'] : typeof p['id'] === 'string' ? p['id'] : '';
      obs.started_at = typeof p['timestamp'] === 'string' ? p['timestamp'] : typeof rec['timestamp'] === 'string' ? rec['timestamp'] : null;
      obs.cwd = typeof p['cwd'] === 'string' ? p['cwd'] : null;
      obs.runtime_version = typeof p['cli_version'] === 'string' ? p['cli_version'] : null;
      obs.entrypoint = typeof p['originator'] === 'string' ? p['originator'] : null;
      const git = p['git'] as Record<string, unknown> | undefined;
      if (git && typeof git['branch'] === 'string') obs.git_branch = git['branch'];
      const bi = p['base_instructions'] as Record<string, unknown> | undefined;
      const text = bi && typeof bi['text'] === 'string' ? bi['text'] : null;
      if (text !== null) {
        obs.instruction_text_available = true;
        // 本文は捨てる。長さと hash だけ残す
        obs.instruction_digest = { bytes: Buffer.byteLength(text, 'utf8'), sha256: 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex') };
      }
      break;
    }
  } finally {
    rl.close();
  }
  return obs.session_id ? obs : null;
}

export async function scanCodexSessions(codexHome: string, opts: { liveWindowMs: number; max: number }): Promise<SessionObservation[]> {
  const root = join(codexHome, 'sessions');
  const files: Array<{ path: string; mtimeMs: number }> = [];
  // sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl。深さ 3 まで（総当たりしない）
  for (const y of await safeReaddir(root, 'codex session rollout directories')) {
    for (const m of await safeReaddir(join(root, y))) {
      for (const d of await safeReaddir(join(root, y, m))) {
        for (const f of await safeReaddir(join(root, y, m, d))) {
          if (!f.endsWith('.jsonl')) continue;
          const p = join(root, y, m, d, f);
          try {
            files.push({ path: p, mtimeMs: (await stat(p)).mtimeMs });
          } catch {
            /* noop */
          }
        }
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: SessionObservation[] = [];
  for (const f of files.slice(0, opts.max)) {
    const o = await scanCodexSession(f.path, opts.liveWindowMs);
    if (o) out.push(o);
  }
  return out;
}

async function safeReaddir(p: string, what?: string): Promise<string[]> {
  try {
    const out = await readdir(p);
    if (what) recordAccess({ target: p, collector: 'probe', what, status: 'observed', count: out.length, runtime: 'codex' });
    return out;
  } catch (e) {
    if (what) {
      const c = classifyError(e);
      recordAccess({
        target: p,
        collector: 'probe',
        what,
        status: c.status,
        error_code: c.error_code,
        runtime: 'codex',
        ...(c.status === 'absent' ? {} : { reason: 'rollout records could not be listed; no codex session is reported, and that is not evidence that none exist' }),
      });
    }
    return [];
  }
}
