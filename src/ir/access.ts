/**
 * 観測の成否 — **「取れなかった」を 0 件として出さない**
 *
 * Doctor がずっと守っている `unobserved ≠ absent` の延長。第三者の環境を診るときに一番まずいのは、
 * Windows で memory が読めなかった時に `Memory: 0` と表示することで、これは「無い」と読めてしまう。
 *
 * だからここでは **見に行った結果そのものを記録する**:
 *
 *   observed          読めた（`count` が入る。**status が observed の時だけ数を持つ**）
 *   absent            読めて、無かった（ENOENT。存在しないという事実）
 *   permission_denied 権限が無くて読めなかった（EACCES / EPERM）。**不存在ではない**
 *   failed            その他の入出力エラー。**不存在ではない**
 *   unsupported       この platform / runtime にその概念が無い
 *   not_applicable    前提が満たされていない（project 未指定、--probe 無し等）
 *   unobserved        そもそも見に行っていない
 *
 * `count` は observed 以外では必ず null。型と `record()` の両方で守る（0 を書けないようにする）。
 *
 * Doctor は取得失敗を Finding へ自動昇格しない。まず coverage / observation status として正直に出す。
 */

export type AccessStatus = 'observed' | 'absent' | 'permission_denied' | 'failed' | 'unsupported' | 'not_applicable' | 'unobserved';

export interface AccessRecord {
  /** 見に行った先。パス、または論理名（`ps`, `project_slug_match` 等） */
  target: string;
  /** どの収集器が見に行ったか */
  collector: string;
  /** 何を取ろうとしていたか（memory / skills / sessions / rules …） */
  what: string;
  status: AccessStatus;
  /** **observed の時だけ数が入る。** それ以外は null（0 と書かない） */
  count: number | null;
  /** errno 等の機械的な理由。推測しない */
  error_code: string | null;
  /** 人が読む一行。なぜ 0 件に見えるのかを言う */
  reason?: string;
  runtime?: string | null;
}

/** status が observed 以外なら count を null に落とす。ここが「0 と書けない」ことの担保 */
export function makeAccessRecord(r: Omit<AccessRecord, 'count' | 'error_code'> & { count?: number | null; error_code?: string | null }): AccessRecord {
  const rec: AccessRecord = {
    target: r.target,
    collector: r.collector,
    what: r.what,
    status: r.status,
    count: r.status === 'observed' ? (r.count ?? 0) : null,
    error_code: r.error_code ?? null,
  };
  if (r.reason !== undefined) rec.reason = r.reason;
  if (r.runtime !== undefined) rec.runtime = r.runtime;
  return rec;
}

/** Node の errno → status。分からないものを勝手に absent にしない */
export function classifyError(e: unknown): { status: AccessStatus; error_code: string | null } {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null;
  switch (code) {
    case 'ENOENT':
      return { status: 'absent', error_code: code };
    case 'EACCES':
    case 'EPERM':
      return { status: 'permission_denied', error_code: code };
    case null:
      return { status: 'failed', error_code: null };
    default:
      // ENOTDIR / ELOOP / EIO / EMFILE / EISDIR … 読めなかったのであって、無いのではない
      return { status: 'failed', error_code: code };
  }
}

/**
 * 収集 1 回ぶんの記録置き場。
 * adapter は module 関数の集まりなので、既存の cache 類と同じくモジュール変数で持つ。
 * `beginAccessLog()` で始め、`takeAccessLog()` で取り出す（取り出すと空になる）。
 */
let LOG: AccessRecord[] = [];

export function beginAccessLog(): void {
  LOG = [];
}

export function recordAccess(r: Parameters<typeof makeAccessRecord>[0]): void {
  LOG.push(makeAccessRecord(r));
}

export function takeAccessLog(): AccessRecord[] {
  const out = LOG;
  LOG = [];
  return out;
}

export function peekAccessLog(): readonly AccessRecord[] {
  return LOG;
}

/** 「読めなかった」だけを取り出す。0 件表示の隣に必ず出すためのもの */
export function failedAccess(records: readonly AccessRecord[]): AccessRecord[] {
  return records.filter((r) => r.status === 'permission_denied' || r.status === 'failed');
}

/** 人が読む 1 行にまとめる。数が出ない理由を数の代わりに置く */
export function formatAccess(r: AccessRecord): string {
  const n = r.status === 'observed' ? `${r.count}` : r.status;
  return `${r.what} @ ${r.target}: ${n}${r.error_code ? ` (${r.error_code})` : ''}${r.reason ? ` — ${r.reason}` : ''}`;
}
