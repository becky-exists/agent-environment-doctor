/**
 * project path ↔ Claude Code の `projects/<slug>` — **列挙が正、符号化は絞り込みだけ**
 *
 * 設計（#64 / #65）:
 *   1. `~/.claude/projects/` の **ディレクトリ列挙を正とする。** スキャンは常に列挙から始める
 *   2. cwd → slug の符号化は「今のプロジェクトだけに絞る」時にしか使わない
 *   3. **符号化は非可逆。** slug から元のパスを復元しない（元パスに `-` があると壊れる。
 *      `-Volumes-SSD2TB-wo-projects-KUROKO` を戻すと `wo/projects` になり、正解の `wo-projects` に戻らない）
 *
 * OS 差について、確かなことと確かでないこと:
 *
 *   - **Mac / Linux は実測済み。** このマシンの 42 slug で確認した。非英数を `-` に置き換え、
 *     **大文字はそのまま残る**（`-Volumes-SSD2TB-wo-projects-KUROKO`）
 *   - **Windows は実測していない。** 一次情報は `claude-config-inspector` の commit b48baf6 だけで、
 *     そこでも **実装とコミットメッセージが食い違っている**:
 *       コード: `cwd.replace(/[/\\:.]/g, '-').toLowerCase()` → `c--users-foo-bar-gsd`（全体が小文字）
 *       メッセージ / コメント: `C:\Users\foo.bar\gsd → c--Users-foo-bar-gsd`（`Users` の U が大文字のまま）
 *     どちらが実際の Claude Code の挙動かは、Windows 機で `~/.claude/projects` を列挙するまで決まらない。
 *
 * だから **1 本の slug に賭けない。** 候補を複数出し、列挙した実ディレクトリと突き合わせる。
 * Windows では大小文字を無視して突合する（ファイルシステムがそもそも case-insensitive）。
 * 突合できなかった時は「該当なし」ではなく **突合失敗** として記録する（unobserved ≠ absent）。
 */

import { win32, posix } from 'node:path';

/** drive letter + 区切り = Windows の絶対パス */
export function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p);
}

/** Mac / Linux 規則（実測）: 非英数を `-` に。大文字は残す */
export function posixSlug(project: string): string {
  return project.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * project の絶対パス → slug 候補（重複なし、確からしい順）。
 * **1 本に決めないのが仕様。** 呼び出し側は列挙結果と突合すること。
 */
export function projectSlugCandidates(project: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  if (isWindowsAbsolutePath(project)) {
    // 一次情報のコード: `/ \ : .` を `-` にして全体を小文字化
    const sepFolded = project.replace(/[/\\:.]/g, '-');
    add(sepFolded.toLowerCase());
    // 一次情報のコメント / コミットメッセージ: drive letter だけ小文字
    add(sepFolded.charAt(0).toLowerCase() + sepFolded.slice(1));
    // 空白や日本語など、上の 2 つが触らない文字も `-` になる場合（Mac 規則の合成）
    add(posixSlug(project).toLowerCase());
    add(posixSlug(project));
  } else {
    add(posixSlug(project));
  }
  return out;
}

export type SlugMatch =
  /** 列挙した実ディレクトリと一致した */
  | { slug: string; how: 'exact' | 'case_insensitive'; candidates: string[] }
  /** 列挙はできたが、どの候補とも一致しなかった。**0 件ではなく突合失敗** */
  | { slug: null; how: 'no_match'; candidates: string[] }
  /** そもそも絞り込む対象が無い（project 未指定） */
  | { slug: null; how: 'not_applicable'; candidates: string[] };

/**
 * 列挙された slug の中から、この project のものを選ぶ。
 * Windows では大小文字を無視する（FS が case-insensitive で、符号化の case 規則も確定していないため）。
 */
export function matchProjectSlug(project: string | null, entries: readonly string[]): SlugMatch {
  if (!project) return { slug: null, how: 'not_applicable', candidates: [] };
  const candidates = projectSlugCandidates(project);
  for (const c of candidates) {
    if (entries.includes(c)) return { slug: c, how: 'exact', candidates };
  }
  if (isWindowsAbsolutePath(project)) {
    const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
    for (const c of candidates) {
      const hit = lower.get(c.toLowerCase());
      if (hit) return { slug: hit, how: 'case_insensitive', candidates };
    }
  }
  return { slug: null, how: 'no_match', candidates };
}

/**
 * `<config_home>/projects/<slug>/memory/...` から slug を取り出す。**区切り非依存。**
 * Windows の `\` でも同じ意味になる（`/` 固定だと 1 件もマッチせず、cost が静かに 0 になっていた）。
 */
export function memorySlugOf(path: string): string | null {
  const m = /[/\\]projects[/\\]([^/\\]+)[/\\]memory[/\\]/.exec(path);
  return m ? m[1]! : null;
}

/**
 * SKILL.md を持つ「dir 形式」の skill かどうか。**区切り非依存**（#72 続き）。
 *
 * claude-code / codex 両アダプタとも、実機 Windows で join() が `\` を使って作った r.path に対し
 * `/SKILL\.md$` 固定の正規表現で判定していたため、常に不一致 → dir 形式の skill が「平置き .md」
 * （requires_dir_skill_md）に誤判定され discovered:false になっていた。memorySlugOf と同じ
 * `[/\\]` パターンに揃える。
 */
export function isSkillDirForm(path: string): boolean {
  return /[/\\]SKILL\.md$/.test(path);
}

/**
 * 区切り文字を `/` に統一する。**比較専用**（表示や slug 化には使わない。test/helpers.ts の
 * toPosixKey と同じ意図の production 版）。
 *
 * search_path の前方一致判定（`r.path.startsWith(sp.path)`）で使う。sp.path は
 * claudeSearchPaths/codexSearchPaths がテンプレートリテラルで組んでいて実機 Windows でも
 * `/` 区切りのまま残るケースがあり得る一方、r.path は join() で OS 依存生成されるため、
 * 万一どちらかに区切り文字の混在が残っても前方一致が壊れないよう、比較の直前で正規化する。
 */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * `path.join()` の結合規則を、実行環境（ambient OS）ではなく `base` の見た目（区切り文字）で選ぶ。
 *
 * Doctor は「収集したホストとは別の環境の bundle / snapshot を分析する」ことが前提の道具なので、
 * `home` / `config_home` は必ずしもホスト OS の形式と一致しない（Windows の bundle を Mac 上で読む、等）。
 * node:path の ambient `join()`（既定 export）は実行環境で posix.join / win32.join のどちらかに固定
 * されてしまうため、POSIX 形式の base を Windows 実機で結合すると `\` 区切りになり、逆に Windows 形式の
 * base を Mac 上で結合すると区切りが混在する。base 自身が Windows 形式（drive letter か `\` を含む）かどうか
 * だけで結合規則を選べば、実行環境に関係なく base の形式が保たれる（test/helpers.ts の joinerFor と同じ判定）。
 */
export function joinPreservingStyle(base: string, ...segments: string[]): string {
  const j = /^[A-Za-z]:[\\/]/.test(base) || base.includes('\\') ? win32.join : posix.join;
  return j(base, ...segments);
}
