/**
 * Claude Code の transcript から「起動中セッションが実際に持っている capability」を読む
 *
 * これは probe（起動して聞く）ではない。**すでにディスクにある記録を読むだけ**なので
 * token を使わず、副作用が無く、新規セッションではなく実際に動いているセッションを観測できる。
 *
 * ⚠ プライバシー: transcript は会話本文そのもの。**構造レコードのフィールドだけを取り、本文は一切保持しない。**
 *   - 取る: attachment の type と names / addedTypes / addedNames / skillCount、timestamp、version、cwd、gitBranch
 *   - 取らない: user / assistant のメッセージ、skill_listing.content（説明文全文）、hook の出力、ファイル差分
 *   行単位で streaming し、必要な種別以外は捨てる（2〜3 MB のファイルを丸ごとメモリに載せない）。
 *
 * 実測（2026-09-07、Claude Code 2.1.263）:
 *   {"type":"attachment","attachment":{"type":"skill_listing","names":[…],"skillCount":92,"isInitial":true},"timestamp":…}
 *   {"type":"attachment","attachment":{"type":"agent_listing_delta","addedTypes":[…],"removedTypes":[],"isInitial":true}}
 *   {"type":"attachment","attachment":{"type":"deferred_tools_delta","addedNames":[…],"removedNames":[],"failedMcpServers":[{"name":…}]}}
 *   {"type":"attachment","attachment":{"type":"mcp_instructions_delta","addedNames":[…]}}
 * instruction（CLAUDE.md / rules / memory）の本文は transcript に載らない。→ 内容比較はできず、
 * 「開始時刻より後に変わったか」だけが分かる（confidence をそこで落とす）。
 */
import { classifyError, recordAccess } from '../ir/access.js';
import { matchProjectSlug } from '../ir/slug.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';

/** 起動中（または過去の）セッション 1 本の観測 */
export interface SessionObservation {
  session_id: string;
  runtime: 'claude-code' | 'codex';
  /** 記録ファイル。証拠として path だけ持つ（中身は持たない） */
  record_path: string;
  started_at: string | null;
  last_activity_at: string;
  /** last_activity_at が閾値内なら live。**heuristic**（プロセスとの紐付けはできていない） */
  live: boolean;
  runtime_version: string | null;
  cwd: string | null;
  git_branch: string | null;
  entrypoint: string | null;
  /** 起動時に載った capability の集合。null = その種別の記録が無い（観測できていない） */
  capabilities: {
    skills: string[] | null;
    agents: string[] | null;
    deferred_tools: string[] | null;
    mcp_instructions: string[] | null;
    failed_mcp_servers: string[] | null;
  };
  /**
   * capability 集合が startup（isInitial=true）の記録から取れたか。
   * false = isInitial の記録が無い（走査した範囲に載っていない）。その場合 capabilities は信用しない。
   */
  capabilities_from_startup: boolean;
  /**
   * 起動後に現れた skill_listing の回数。**これは「集合が変わった」ではない。**
   * 実測（2026-09-07）: skill 呼び出し後に `isInitial:false, skillCount:1, names:['craft-code']` のような
   * 絞られた一覧が載る。意味が確定していないので startup set を置き換えない（置き換えると 91 件の偽陽性が出た）。
   */
  non_initial_listings: number;
  /**
   * capability 名 → その一覧に書かれていた説明文の先頭。**Snapshot には載せない**（突合にだけ使う）。
   * 名前だけの突合は誤診になる。実測（2026-09-07）: セッションの "agmsg" は ~/.claude/commands/agmsg.md
   * のスラッシュコマンドだったが、~/.agents/skills/agmsg/SKILL.md という別物が同名で存在し、
   * 名前照合だけで「消えた skill を持ち続けている」と誤って報告した。説明文で同一性を裏取りする。
   */
  capability_descriptions: Map<string, string>;
  /** 命令本文の観測。claude-code は取れない（transcript に載らない） */
  instruction_text_available: boolean;
  /** codex のみ: 起動時に載った命令本文の長さと hash（本文は保持しない） */
  instruction_digest: { bytes: number; sha256: string } | null;
  /** サブエージェント（sidechain）由来のセッションか */
  is_sidechain: boolean;
  /**
   * 実際に注入された MCP instructions の長さ（server 名ごと）。本文は保持しない。
   * これは「起動時に確実に載った」量の実測（method: transcript_scan）。
   */
  mcp_instruction_bytes: Map<string, number>;
  /**
   * hook の発火実測。key = `${hookName}|${hookEvent}`。
   * ⚠ 記録に残った出力の長さであって、その全部が context に載ったとは限らない（イベント種別で違う）。
   * 断定しないために payload_digests を持ち、**同一の本文が何回入ったか**まで見る。
   */
  hook_firings: Map<string, { name: string; event: string; count: number; total_bytes: number; command: string | null; payload_digests: Map<string, number> }>;
  /**
   * #69 Host/Runtime Signals v0.1: MCP server の接続 delta の生の出現。集約は probe/index.ts 側でやる。
   * ok=false の時の error は runtime 自身が出す定型文（最大 200 文字）。ユーザー本文ではない。
   */
  mcp_events: Array<{ server: string; ok: boolean; error: string | null; at: string }>;
  /**
   * #69: API エラー（isApiErrorMessage）の生の出現。message.content は一切読まない。
   * status_code / error（短い type 文字列）だけを構造として持つ。
   */
  api_errors: Array<{ status_code: number | null; error_type: string | null; at: string }>;
}

const WANT = new Set([
  'skill_listing',
  'agent_listing_delta',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  // #56 / #57: 実際に注入されたテキストの長さと hook の発火。**本文は保持せず長さと指紋だけ**
  'hook_success',
  'hook_additional_context',
  'hook_system_message',
  'async_hook_response',
]);
/** 説明文は先頭だけ持つ。同一性の裏取りに要るのは冒頭で足りる */
const DESC_PREFIX = 80;

/** transcript 1 本を streaming で走査。構造レコードのフィールドだけを取る */
export async function scanClaudeTranscript(path: string, liveWindowMs: number): Promise<SessionObservation | null> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }

  const obs: SessionObservation = {
    session_id: basename(path).replace(/\.jsonl$/, ''),
    runtime: 'claude-code',
    record_path: path,
    started_at: null,
    last_activity_at: st.mtime.toISOString(),
    live: Date.now() - st.mtimeMs <= liveWindowMs,
    runtime_version: null,
    cwd: null,
    git_branch: null,
    entrypoint: null,
    capabilities: { skills: null, agents: null, deferred_tools: null, mcp_instructions: null, failed_mcp_servers: null },
    capabilities_from_startup: false,
    non_initial_listings: 0,
    capability_descriptions: new Map(),
    instruction_text_available: false,
    instruction_digest: null,
    is_sidechain: false,
    mcp_instruction_bytes: new Map(),
    hook_firings: new Map(),
    mcp_events: [],
    api_errors: [],
  };

  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lastTs: string | null = null;
  try {
    for await (const line of rl) {
      // 安いふるい。必要な種別を含まない行は JSON.parse すらしない
      if (line.length < 20) continue;
      const isAttachment = line.includes('"type":"attachment"');
      const hasTs = line.includes('"timestamp"');
      if (!isAttachment && !hasTs) continue;

      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 書き込み途中の行など。落とさず飛ばす
      }

      const ts = typeof rec['timestamp'] === 'string' ? rec['timestamp'] : null;
      if (ts) {
        if (!obs.started_at) obs.started_at = ts;
        lastTs = ts;
      }
      if (obs.runtime_version === null && typeof rec['version'] === 'string') obs.runtime_version = rec['version'];
      if (obs.cwd === null && typeof rec['cwd'] === 'string') obs.cwd = rec['cwd'];
      if (obs.git_branch === null && typeof rec['gitBranch'] === 'string') obs.git_branch = rec['gitBranch'];
      if (obs.entrypoint === null && typeof rec['entrypoint'] === 'string') obs.entrypoint = rec['entrypoint'];
      if (rec['isSidechain'] === true) obs.is_sidechain = true;

      // #69: API エラー（429 等）。message.content は読まない。status_code と短い type 文字列だけ
      if (rec['isApiErrorMessage'] === true) {
        const status = typeof rec['apiErrorStatus'] === 'number' ? rec['apiErrorStatus'] : null;
        const errType = typeof rec['error'] === 'string' ? rec['error'] : null;
        obs.api_errors.push({ status_code: status, error_type: errType, at: ts ?? obs.last_activity_at });
      }

      const att = rec['attachment'] as Record<string, unknown> | undefined;
      const kind = att && typeof att['type'] === 'string' ? att['type'] : null;
      if (!kind || !WANT.has(kind)) continue;

      const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

      if (kind === 'skill_listing') {
        // names だけ。content（説明文全文）は読まない。
        // isInitial=true のものだけを startup set として採る。以降の一覧は意味が確定していないので数えるだけ
        if (att!['isInitial'] === true) {
          obs.capabilities.skills = strs(att!['names']);
          obs.capabilities_from_startup = true;
          // 説明文の先頭だけを name → prefix で持つ（同一性の裏取り用。会話本文ではなく設定のテキスト）
          const content = typeof att!['content'] === 'string' ? att!['content'] : '';
          for (const line of content.split('\n')) {
            const m = /^-\s+([^:]+):\s*(.*)$/.exec(line);
            if (m) obs.capability_descriptions.set(m[1]!.trim(), (m[2] ?? '').slice(0, DESC_PREFIX));
          }
        } else {
          obs.non_initial_listings++;
        }
      } else if (kind === 'agent_listing_delta') {
        const base = obs.capabilities.agents ?? [];
        const added = strs(att!['addedTypes']);
        const removed = new Set(strs(att!['removedTypes']));
        obs.capabilities.agents = [...new Set([...base, ...added])].filter((x) => !removed.has(x));
        for (const line of strs(att!['addedLines'])) {
          const m = /^-\s+([^:]+):\s*(.*)$/.exec(line);
          if (m) obs.capability_descriptions.set(m[1]!.trim(), (m[2] ?? '').slice(0, DESC_PREFIX));
        }
      } else if (kind === 'deferred_tools_delta') {
        const base = obs.capabilities.deferred_tools ?? [];
        const added = strs(att!['addedNames']);
        const removed = new Set(strs(att!['removedNames']));
        obs.capabilities.deferred_tools = [...new Set([...base, ...added])].filter((x) => !removed.has(x));
        const failedRaw = Array.isArray(att!['failedMcpServers']) ? (att!['failedMcpServers'] as Array<Record<string, unknown>>) : [];
        const failed = failedRaw.map((x) => (typeof x?.['name'] === 'string' ? x['name'] : '')).filter(Boolean);
        if (failed.length) obs.capabilities.failed_mcp_servers = [...new Set([...(obs.capabilities.failed_mcp_servers ?? []), ...failed])];
        // #69: MCP 接続失敗の生イベント。error は runtime 自身の定型文（最大 200 文字）
        for (const f of failedRaw) {
          const name = typeof f['name'] === 'string' ? f['name'] : null;
          if (!name) continue;
          const err = typeof f['error'] === 'string' ? f['error'].slice(0, 200) : null;
          obs.mcp_events.push({ server: name, ok: false, error: err, at: ts ?? obs.last_activity_at });
        }
      } else if (kind === 'mcp_instructions_delta') {
        const base = obs.capabilities.mcp_instructions ?? [];
        const added = strs(att!['addedNames']);
        const removed = new Set(strs(att!['removedNames']));
        obs.capabilities.mcp_instructions = [...new Set([...base, ...added])].filter((x) => !removed.has(x));
        // #69: instructions が実際に載った = この server は接続できている
        for (const name of added) obs.mcp_events.push({ server: name, ok: true, error: null, at: ts ?? obs.last_activity_at });
        // 実際に載ったブロックの長さ。name と block は同じ順で並ぶ（実測）
        const blocks = strs(att!['addedBlocks']);
        added.forEach((name, i) => {
          const b = blocks[i];
          if (typeof b === 'string') obs.mcp_instruction_bytes.set(name, (obs.mcp_instruction_bytes.get(name) ?? 0) + Buffer.byteLength(b, 'utf8'));
        });
      } else if (kind === 'hook_success' || kind === 'hook_additional_context' || kind === 'hook_system_message' || kind === 'async_hook_response') {
        // 注入された本文の長さと指紋だけ。本文は保持しない
        const name = typeof att!['hookName'] === 'string' ? att!['hookName'] : '(unnamed)';
        const event = typeof att!['hookEvent'] === 'string' ? att!['hookEvent'] : kind;
        const cmd = typeof att!['command'] === 'string' ? att!['command'] : null;
        let payload = '';
        for (const key of ['content', 'stdout', 'additionalContext', 'message']) {
          const v = att![key];
          if (typeof v === 'string') payload += v;
          else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') payload += x;
        }
        const k = `${name}|${event}`;
        const e =
          obs.hook_firings.get(k) ??
          obs.hook_firings.set(k, { name, event, count: 0, total_bytes: 0, command: cmd, payload_digests: new Map() }).get(k)!;
        e.count++;
        e.total_bytes += Buffer.byteLength(payload, 'utf8');
        if (cmd && !e.command) e.command = cmd;
        if (payload) {
          const d = 'sha256:' + createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24);
          e.payload_digests.set(d, (e.payload_digests.get(d) ?? 0) + 1);
        }
      }
    }
  } finally {
    rl.close();
  }
  if (lastTs && lastTs > obs.last_activity_at) obs.last_activity_at = lastTs;
  return obs;
}

/**
 * `<config_home>/projects/<slug>/*.jsonl` を新しい順に走査。max 本まで。
 *
 * **列挙が正。** project で絞る時も、cwd から作った slug 文字列で直接ディレクトリを開くのではなく、
 * 列挙した実ディレクトリと候補を突き合わせる（OS で符号化規則が違い、Windows 規則は確定していない）。
 * 突合できなかった時は **0 件として黙らず**、突合失敗として記録して全件走査に落とす。
 */
export async function scanClaudeSessions(
  configHome: string,
  opts: { liveWindowMs: number; max: number; projectFilter?: string | null },
): Promise<SessionObservation[]> {
  const projects = join(configHome, 'projects');
  let entries: string[];
  try {
    entries = await readdir(projects);
    recordAccess({ target: projects, collector: 'probe', what: 'claude session project directories', status: 'observed', count: entries.length, runtime: 'claude-code' });
  } catch (e) {
    const c = classifyError(e);
    recordAccess({
      target: projects,
      collector: 'probe',
      what: 'claude session project directories',
      status: c.status,
      error_code: c.error_code,
      runtime: 'claude-code',
      ...(c.status === 'absent' ? {} : { reason: 'session records could not be listed; no session is reported, and that is not evidence that none exist' }),
    });
    entries = [];
  }

  let filterSlug: string | null = null;
  if (opts.projectFilter) {
    const m = matchProjectSlug(opts.projectFilter, entries);
    filterSlug = m.slug;
    recordAccess({
      target: 'project_slug_match',
      collector: 'probe',
      what: 'current project slug',
      status: m.slug ? 'observed' : entries.length === 0 ? 'unobserved' : 'failed',
      count: m.slug ? 1 : null,
      runtime: 'claude-code',
      reason: m.slug
        ? `matched "${m.slug}" (${m.how})`
        : `none of the candidate encodings matched an existing directory (tried: ${m.candidates.join(', ')}). Sessions are not filtered by project, so the set below is wider than this project — it is not "no sessions".`,
    });
  }

  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const slug of entries) {
    if (filterSlug && slug !== filterSlug) continue;
    const dir = join(projects, slug);
    for (const f of await safeReaddir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try {
        files.push({ path: p, mtimeMs: (await stat(p)).mtimeMs });
      } catch {
        /* 消えたファイルは飛ばす */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: SessionObservation[] = [];
  for (const f of files.slice(0, opts.max)) {
    const o = await scanClaudeTranscript(f.path, opts.liveWindowMs);
    if (o) out.push(o);
  }
  return out;
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

// slug の符号化は src/ir/slug.ts に 1 本化した（Mac/Windows 差と「列挙が正」の規律はそちらに書いてある）
export { matchProjectSlug, projectSlugCandidates } from '../ir/slug.js';
