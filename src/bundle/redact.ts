/**
 * Redaction — 他人の環境を持ち出せる形にする
 *
 * bundle は **生成した本人の機械の上で redact されてから完成する。** 送信は一切しない。
 *
 * 出さないもの:
 *   API key / token / credential / env の値 / transcript 本文 / Memory 本文 /
 *   CLAUDE.md・AGENTS.md 等の本文 / private repo のソース / username / home path / 顧客名・案件名
 *
 * 比較に要る情報は本文ではなく hash・行数・byte 数・diff 量・kind・mechanism・timestamp で持つ。
 * 本文そのものを落とすのは `bundle/index.ts` の構造側（`declared.raw` や `diff_excerpt.lines` を入れない）。
 * ここでやるのは **文字列に混ざって出てくるもの**の置換。
 *
 * 匿名化は **同一 bundle 内で参照整合性を保つ**（同じ実体は同じ id）。
 * bundle をまたいで同じ id になる必要はない（永続識別子にしない）。
 */
import { basename } from 'node:path';

import { matchProjectSlug, projectSlugCandidates } from '../ir/slug.js';

export type RedactionLevel = 'standard' | 'strict';

/** 本文でなく「文字列の中に混ざって出てくる秘密」。見つけたら値を捨てて種別だけ残す */
export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'anthropic_api_key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai_api_key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'slack_token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi },
  { name: 'private_key_block', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'assigned_secret', re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}=*["']?/gi },
  { name: 'url_credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi },
];

/** ここから下は誰の機械にもある公共の場所。username を消したあとは匿名化しない */
const PUBLIC_ROOTS = new Set(['usr', 'bin', 'sbin', 'opt', 'etc', 'var', 'tmp', 'private', 'Applications', 'Library', 'System', 'nix', 'dev', 'proc']);

/**
 * username の「区切り文字・大文字小文字が変わった派生表現」を検知する正規表現ソースを作る（#71）。
 *
 * Windows の project slug 符号化（`projectSlugCandidates`）は `.` `/` `\` `:` を `-` に畳み、
 * 大文字小文字の規則も一次情報で確定していない（src/ir/slug.ts 参照）。つまり同じ username が
 * `tanaka.y` の他に `tanaka-y` / `Tanaka-Y` のような形でも bundle の文字列（reason 等の自由文）に
 * 現れうる。username そのものの完全一致（`split().join()`）ではこの派生形を捕まえられない。
 *
 * ここでは username の英数字はそのまま、非英数字は「どんな区切り文字にも化けうる」とみなして
 * `[.\-_ ]` に緩め、大文字小文字を無視する。username と綴りが同じ単語が散文に出た時の誤爆を
 * 抑えるため、呼び出し側は既存の長さ・GENERIC_USERNAMES ガードと組み合わせて使うこと。
 */
function usernameVariantPatternSource(user: string): string {
  return user
    .split('')
    .map((ch) => (/[A-Za-z0-9]/.test(ch) ? escapeRe(ch) : '[.\\-_ ]'))
    .join('');
}

/**
 * home を畳んだ表記（`~/x` `$HOME/x`、Windows の `\` 区切りも）を作る（#91）。
 *
 * bundle に入る文字列は、レポート生成側で先に `~/...` へ畳まれていることがある。
 * project 根を**絶対パスの形だけ**で置換していると、畳まれた表記は素通りし、
 * そのあとの `~ → $HOME` だけが走って `$HOME/<実名>/...` が残る。
 * 置換の順序に依存しないよう、Redactor 側で畳まれた形も同じ鍵として持つ。
 *
 * home の外の project（`--project` が別ドライブ等）には何も足さない。
 */
export function foldedHomeForms(root: string, home: string): string[] {
  if (!home || !root.startsWith(home)) return [];
  const rel = root.slice(home.length);
  if (!/^[/\\]/.test(rel)) return []; // home そのもの、または `homeXXX` のような別ディレクトリ
  const out = new Set<string>();
  for (const r of separatorVariants(rel)) {
    out.add(`~${r}`);
    out.add(`$HOME${r}`);
  }
  return [...out];
}

/**
 * 同じパスの区切り文字違い（Windows 実機で必要、#91）。
 *
 * Doctor は Windows で `\` と `/` を意図的に行き来する（`toPosixPath` / `toPosixKey` は
 * まさにそのために在る）。置換の鍵を**採取した時の形だけ**で持つと、正規化された側が素通りする。
 * 鍵は安いので両方持つ。
 */
export function separatorVariants(p: string): string[] {
  return [...new Set([p, p.replace(/\//g, '\\'), p.replace(/\\/g, '/')])];
}

export interface RedactorOptions {
  home: string;
  /** 現在の project の絶対パス */
  project?: string | null;
  /** 追加で匿名化したい project 根（他 project の memory slug 等はここに来なくてよい） */
  extraProjects?: string[];
  /** `~/.claude/projects/` に実在した slug（列挙結果）。project 根と同じ id へ寄せる */
  projectSlugs?: string[];
  level?: RedactionLevel;
}

export interface RedactionSummary {
  level: RedactionLevel;
  home_replaced: boolean;
  username_replaced: boolean;
  /** **実際に置換が起きた** project の数。id を振っただけのものは数えない（#91） */
  projects_anonymised: number;
  /** id を振った project の数。`projects_anonymised` との差は「名前が一度も出てこなかった」の意味 */
  project_ids_assigned: number;
  paths_anonymised: number;
  names_anonymised: number;
  secrets_removed: Array<{ kind: string; count: number }>;
  rules: string[];
}

export class Redactor {
  readonly level: RedactionLevel;
  private readonly home: string;
  private readonly user: string;
  /** username の区切り文字/大文字小文字違いの派生表現を検知する正規表現（#71）。一般的すぎる名前では null のまま */
  private readonly userVariantRe: RegExp | null;
  /** 実体 → `<project-N>`。project 根と slug の両方を同じ id に寄せる */
  private readonly projectIds = new Map<string, string>();
  /** 実際に置換が起きた project id（#91: 「id を振った数」を「消した数」として報告しないため） */
  private readonly projectsReplaced = new Set<string>();
  private readonly pathIds = new Map<string, string>();
  private readonly nameIds = new Map<string, string>();
  private readonly identities = new Map<string, string>();
  private identityRe: RegExp | null = null;
  private readonly secretHits = new Map<string, number>();
  private nextProject = 1;
  private nextPath = 1;
  private readonly nextName = new Map<string, number>();

  constructor(opts: RedactorOptions) {
    this.home = opts.home.replace(/[/\\]+$/, '');
    this.user = basename(this.home);
    this.level = opts.level ?? 'strict';
    // #71: username そのものの完全一致だけでなく、区切り文字/大文字小文字が変わった派生表現も拾う
    this.userVariantRe =
      this.user.length >= 3 && !GENERIC_USERNAMES.has(this.user.toLowerCase()) ? new RegExp(usernameVariantPatternSource(this.user), 'gi') : null;

    const slugs = opts.projectSlugs ?? [];
    // 現在の project とその slug は同じ id にする（bundle 内の参照整合性）
    const roots = [opts.project, ...(opts.extraProjects ?? [])].filter((x): x is string => typeof x === 'string' && x.length > 0);
    for (const root of roots) {
      const id = this.assignProject(root);
      // #91: 採取時と正規化後で区切り文字が違うことがある（Windows）
      for (const v of separatorVariants(root)) this.projectIds.set(v, id);
      const m = matchProjectSlug(root, slugs);
      if (m.slug) this.projectIds.set(m.slug, id);
      // 符号化候補は、`~/.claude/projects` に**実在しなくても**同じ id へ（#91）。
      // 候補は root を符号化したものなので、他の project の slug と衝突しない。
      // 実在するものだけ登録していた頃は、memory ディレクトリを持たない project の名前が
      // 「絞り込めなかった（tried: -Users-<user>-<実名>）」という説明文に残っていた。
      for (const c of projectSlugCandidates(root)) this.projectIds.set(c, id);
      // #91: home が畳まれた表記も同じ id へ
      for (const k of foldedHomeForms(root, this.home)) this.projectIds.set(k, id);
    }
    // 残りの slug（他プロジェクト）にもそれぞれ id を振る
    for (const s of slugs) if (!this.projectIds.has(s)) this.assignProject(s);
  }

  private assignProject(key: string): string {
    const hit = this.projectIds.get(key);
    if (hit) return hit;
    const id = `<project-${this.nextProject++}>`;
    this.projectIds.set(key, id);
    return id;
  }

  /**
   * strict のとき、資源の識別セグメント（skill のディレクトリ名など）をパスの中でも置き換えるために登録する。
   * 登録しないと `structure` の名前だけ匿名化されて、パスの中に生の名前が残る。
   */
  registerIdentity(kind: string, segment: string): string {
    const pseudo = this.name(kind, segment);
    if (this.level === 'strict' && isIdentityLike(segment)) {
      this.identities.set(segment, pseudo);
      this.identityRe = null;
    }
    return pseudo;
  }

  /**
   * 登録した識別セグメントを置き換える。**パスや引用に面している時だけ。**
   * 散文に同じ単語が出てきても潰さない（`memory` という名の skill があっても文章の "memory" は残す）。
   */
  private identityPass(s: string): string {
    if (this.level !== 'strict' || this.identities.size === 0) return s;
    if (!this.identityRe) {
      const alt = [...this.identities.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escapeRe)
        .join('|');
      // 直前が / \ ` " ' か、直後が / \ の時だけ置き換える
      const BEFORE = '(?<=[/\\\\`"\'.#=:])';
      const AFTER = '(?=[/\\\\])';
      this.identityRe = new RegExp(BEFORE + '(?:' + alt + ')|(?:' + alt + ')' + AFTER, 'g');
    }
    // 名前そのものが値として入っているフィールド（subject.name 等）は完全一致で置き換える
    const exact = this.identities.get(s.trim());
    if (exact) return exact;
    return s.replace(this.identityRe, (m0) => this.identities.get(m0) ?? m0);
  }

  /** 資源名の匿名化（strict のみ）。kind ごとに連番 */
  name(kind: string, value: string): string {
    if (this.level !== 'strict') return this.text(value);
    const key = `${kind}|${value}`;
    const hit = this.nameIds.get(key);
    if (hit) return hit;
    const n = (this.nextName.get(kind) ?? 0) + 1;
    this.nextName.set(kind, n);
    const id = `<${kind}-${n}>`;
    this.nameIds.set(key, id);
    return id;
  }

  /** パスと、パスを含む文字列。`text()` の別名（意図を読みやすくするため） */
  path(value: string): string {
    return this.text(value);
  }

  /**
   * 文字列 1 本を安全にする。順序が意味を持つ:
   *   1. secret を消す（他の置換で形が崩れる前に）
   *   2. project の slug と根を `<project-N>` へ、登録済みの資源名を `<kind-N>` へ（strict）
   *   3. home を `$HOME` へ
   *   4. username を `<user>` へ（home の外に出てくる分）
   *   5. 残った絶対パスのうち、公共の場所でないものを `<path-N>` へ
   */
  text(value: string): string {
    if (!value) return value;
    let s = value;

    for (const { name, re } of SECRET_PATTERNS) {
      s = s.replace(re, () => {
        this.secretHits.set(name, (this.secretHits.get(name) ?? 0) + 1);
        return `<redacted:${name}>`;
      });
    }

    // 長いものから置換する（短い slug が長い slug の一部を食わないように）
    const keys = [...this.projectIds.keys()].sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (!s.includes(k)) continue;
      const id = this.projectIds.get(k)!;
      s = s.split(k).join(id);
      this.projectsReplaced.add(id); // #91: 消した数だけを summary に出す
    }

    s = this.identityPass(s);

    if (this.home) s = s.split(this.home).join('$HOME');
    // report 側ですでに `~/...` に畳まれている表記も $HOME に寄せる（下の総当たりで食われないように）
    s = s.replace(/(?<![A-Za-z0-9_])~(?=[/\\])/g, '$HOME');
    if (this.user && this.user.length >= 3) s = s.split(this.user).join('<user>');
    // #71: username の完全一致では拾えない派生表現（Windows project slug 化で `.` が `-` に変わる等）
    if (this.userVariantRe) {
      this.userVariantRe.lastIndex = 0;
      s = s.replace(this.userVariantRe, '<user>');
    }

    // 最後の網。すでに `$HOME` や `<project-1>` に置き換わった後ろの `/...` は二重に潰さない。
    //
    // 区間に `<user>` `<agent_def-1>` のような**置換済みの札**が混ざっていても、ひと続きのパスとして
    // 飲み込む（#91）。Windows 実機で、home の綴りが実体と食い違って（短縮名 `RUNNER~1` と長い名前）
    // home 置換も project 置換も外れ、そのあと username の語だけが置き換わってパスが分断され、
    // この網が途中で止まって残りが素の名前のまま残っていた。網が最後である以上、途中で切れてはいけない。
    const SEG = '(?:[A-Za-z0-9._@+-]+|<[A-Za-z0-9._-]+>)';
    s = s.replace(new RegExp(`(?<![A-Za-z0-9_$>])(?:[A-Za-z]:[\\\\/]|/)${SEG}(?:[\\\\/]${SEG})+`, 'g'), (m0) => {
      if (m0.startsWith('$HOME')) return m0;
      const first = m0.replace(/^[A-Za-z]:[\\/]/, '').replace(/^\//, '').split(/[\\/]/)[0] ?? '';
      if (PUBLIC_ROOTS.has(first)) return m0;
      const hit = this.pathIds.get(m0);
      if (hit) return hit;
      const id = `<path-${this.nextPath++}>`;
      this.pathIds.set(m0, id);
      return id;
    });

    return s;
  }

  /**
   * 出来上がりをもう一度同じ規則で掃いて、置き換え残しが無いかを見る（自己検査用）。
   * 散文の同じ単語は境界条件で拾わないので、ここで変化があれば **本当の置き換え残し**。
   */
  sweep(serialised: string): string[] {
    if (this.level !== 'strict' || this.identities.size === 0) return [];
    const after = this.identityPass(serialised);
    if (after === serialised) return [];
    const out: string[] = [];
    for (const [name] of this.identities) {
      const re = new RegExp('.{0,40}(?<=[/' + '\\\\' + '`"\'.#=:])' + escapeRe(name) + '.{0,40}', 'g');
      const m = serialised.match(re);
      if (m) out.push(...m.slice(0, 2));
      if (out.length >= 10) break;
    }
    return out;
  }

  /** JSON を深く歩いて全部の文字列に `text()` をかける。キー名も安全にする */
  deep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[this.text(k)] = this.walk(val);
      return out;
    }
    return v;
  }

  summary(): RedactionSummary {
    return {
      level: this.level,
      home_replaced: true,
      username_replaced: true,
      projects_anonymised: this.projectsReplaced.size,
      project_ids_assigned: new Set(this.projectIds.values()).size,
      paths_anonymised: this.pathIds.size,
      names_anonymised: this.nameIds.size,
      secrets_removed: [...this.secretHits].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      rules: [
        'File and message bodies are never included: no transcript text, no memory text, no CLAUDE.md / AGENTS.md text, no source. Only hashes, byte sizes, line counts and diff counts.',
        'The home directory is replaced with $HOME and the username with <user>.',
        'Project roots and the project slugs under .claude/projects are replaced with <project-N>. The same real project is the same id inside this bundle; ids are not stable across bundles.',
        'Absolute paths outside the home directory and outside public system roots are replaced with <path-N>.',
        'Declared configuration values (mcp server definitions, hook commands as declared, frontmatter values) are not copied into the bundle; only the key names are.',
        this.level === 'strict'
          ? 'Resource names are replaced with <kind-N>, because skill / agent / project names are where customer and product names live.'
          : 'Resource names are kept as they are (level=standard). Use --redact strict when the names themselves must not leave the machine.',
        'Known secret shapes (api keys, tokens, private key blocks, credentials in URLs) are replaced with <redacted:kind> wherever they appear in any string.',
      ],
    };
  }
}

export interface Leak {
  kind: string;
  where: string;
  sample: string;
}

/**
 * 出来上がった bundle をもう一度走査して、漏れがないか自分で確かめる。
 * 「たぶん入っていない」で済ませないための最後の関門。**bundle は必ずこれを通してから書く。**
 */
export function scanForLeaks(bundle: unknown, opts: { home: string; extra?: string[]; projects?: string[] }): Leak[] {
  const out: Leak[] = [];
  const home = opts.home.replace(/[/\\]+$/, '');
  const user = basename(home);
  const userIsGeneric = user.length < 3 || GENERIC_USERNAMES.has(user.toLowerCase());
  const needles: Array<{ kind: string; value: string; mode: NeedleMode }> = [
    { kind: 'home_path', value: home, mode: 'anywhere' },
    // username は散文にも出うる語のことがある（home / root など）。**パスや宛先に面している時だけ**数える
    ...(userIsGeneric ? [] : [{ kind: 'username', value: user, mode: 'adjacent' as NeedleMode }]),
    ...projectNeedles(opts.projects ?? []),
    ...(opts.extra ?? []).map((v) => ({ kind: 'forbidden_string', value: v, mode: 'anywhere' as NeedleMode })),
  ];
  // #71: username の完全一致では見逃す派生表現（Windows project slug 化で区切り文字/大文字小文字が変わった形）。
  // slug 文字列はパスの区切りに面していない 1 トークンなので、宛先隣接チェックではなく全文で検査する
  const userVariantRe = userIsGeneric ? null : new RegExp(usernameVariantPatternSource(user), 'gi');

  const walk = (v: unknown, where: string): void => {
    if (typeof v === 'string') {
      for (const n of needles) {
        if (!n.value) continue;
        if (matchNeedle(v, n.value, n.mode)) out.push({ kind: n.kind, where, sample: clip(v) });
      }
      if (userVariantRe) {
        userVariantRe.lastIndex = 0;
        if (userVariantRe.test(v)) out.push({ kind: 'username_variant', where, sample: clip(v) });
        userVariantRe.lastIndex = 0;
      }
      for (const { name, re } of SECRET_PATTERNS) {
        re.lastIndex = 0;
        const hit = re.test(v);
        re.lastIndex = 0; // g フラグは状態を持つ。**必ず戻す**（次の文字列で取りこぼす）
        if (hit) out.push({ kind: `secret:${name}`, where, sample: clip(v) });
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, `${where}.${k}`);
    }
  };
  walk(bundle, '$');
  return out;
}

type NeedleMode = 'anywhere' | 'adjacent' | 'token';

/**
 * project 根と slug を自己検査の針にする（#91）。
 *
 * `rules[]` は「project 根と slug は `<project-N>` に置き換える」と約束しているのに、
 * 自己検査はそれを一度も確かめていなかった。だから **漏れていても self check は通った**。
 *
 * 針は `token` 一致で数える。パス区切りに面している形（`$HOME/<実名>/…`）だけでなく、
 * slug に符号化された形（`-Users-<user>-<実名>`）も同じ 1 語として拾うため
 * （実測で後者が残っていた。前者だけを見ていると、また「passed なのに漏れている」になる）。
 *
 * **針にしないもの**: 構造の名前（`src` `docs` 等）と、Doctor 自身が散文で使う語。
 * これらは置換はされるが、ここで数えると誤検知が出て、自己検査そのものが信用されなくなる。
 * 「見ていないものは見ていないと言う」— 数えない対象があること自体は隠さない。
 */
function projectNeedles(projects: string[]): Array<{ kind: string; value: string; mode: NeedleMode }> {
  const out: Array<{ kind: string; value: string; mode: NeedleMode }> = [];
  const seen = new Set<string>();
  for (const p of projects) {
    if (!p) continue;
    const hasSep = /[/\\]/.test(p);
    // node:path の basename は動いている OS の規則で切る。POSIX 上では Windows パスの `\` を
    // 区切りとみなさず、丸ごと 1 語として返す（#72 / #81 と同じ型の罠）。
    // bundle は「Windows で採取したものを Mac で読む」ことが在りうるので、両方の区切りで切る。
    const value = hasSep ? (p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '') : p;
    const lower = value.toLowerCase();
    if (!isIdentityLike(value) || GENERIC_USERNAMES.has(lower) || DOCTOR_VOCABULARY.has(lower)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ kind: hasSep ? 'project_root' : 'project_slug', value, mode: 'token' });
  }
  return out;
}

/**
 * Doctor 自身が散文で使う語。project 名がこれと同じ時は**自己検査の針にしない**。
 * 置換は行われる。ここで数えると自分の説明文に当たり続けて、self check が狼少年になる。
 */
const DOCTOR_VOCABULARY = new Set([
  'agent', 'agents', 'skill', 'skills', 'session', 'sessions', 'runtime', 'runtimes', 'plugin', 'plugins',
  'hook', 'hooks', 'rule', 'rules', 'bundle', 'report', 'finding', 'findings', 'evidence', 'resource', 'resources',
  'binding', 'bindings', 'observation', 'observations', 'claude', 'codex', 'doctor', 'snapshot', 'history',
]);

/**
 * パスや識別子の「構造」を示す記号。project 名がこれに面していたら、それは**散文ではなく在り処**。
 * 空白に挟まれただけの出現（Doctor 自身の説明文に同じ単語が出ただけ）とはここで分ける。
 */
const STRUCTURE_MARKS = new Set(['/', '\\', '-', '@', ':', '=', '"', "'", '`']);

function matchNeedle(haystack: string, needle: string, mode: NeedleMode): boolean {
  if (mode === 'anywhere') return haystack.includes(needle);
  if (mode === 'adjacent') return identityAdjacent(haystack, needle);
  // token: 文字列そのもの、または「構造記号に面していて、反対側が単語の途中でない」出現。
  //
  // 実機で分かったこと（Windows CI）: 前後が英数字でないだけを条件にすると、project 名が
  // ありふれた語（fixture の `work`）の時に Doctor 自身の定型文（"not a work order"）へ誤爆する。
  // 自己検査が clean な bundle で叫ぶのは、漏れを見逃すのとは別の意味で信用を失う。
  if (haystack.trim() === needle) return true;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    const before = i > 0 ? haystack[i - 1]! : '';
    const after = i + needle.length < haystack.length ? haystack[i + needle.length]! : '';
    const beforeAlnum = /[A-Za-z0-9]/.test(before);
    const afterAlnum = /[A-Za-z0-9]/.test(after);
    if (!beforeAlnum && !afterAlnum && (STRUCTURE_MARKS.has(before) || STRUCTURE_MARKS.has(after))) return true;
    i = haystack.indexOf(needle, i + 1);
  }
  return false;
}

/**
 * 匿名化して意味があるのは「その人が付けた名前」だけ。
 * `.claude` `.codex` `skills` のような**構造の名前**を匿名化すると、パスが読めなくなって診断の役に立たない。
 */
const STRUCTURAL_NAMES = new Set([
  'skills', 'agents', 'rules', 'hooks', 'commands', 'projects', 'memory', 'plugins', 'output-styles', 'sessions', 'bin', 'src', 'docs', 'config', 'settings',
  'SKILL', 'AGENTS', 'CLAUDE', 'MEMORY', 'README', 'user', 'project', 'shared', 'builtin', 'main', 'index',
]);

function isIdentityLike(segment: string): boolean {
  if (!segment || segment.length < 3) return false;
  if (segment.startsWith('.')) return false; // ドットで始まるものは設定ディレクトリ側の構造
  if (STRUCTURAL_NAMES.has(segment)) return false;
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** どの機械にもある一般名。これを username として全文検索すると散文に当たり続ける */
const GENERIC_USERNAMES = new Set(['home', 'root', 'user', 'users', 'admin', 'runner', 'ubuntu', 'test', 'tmp']);

/** パスや宛先に面している時だけ「その人の名前」とみなす（散文の同じ語は数えない） */
function identityAdjacent(haystack: string, needle: string): boolean {
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    const before = i > 0 ? haystack[i - 1]! : '';
    const after = i + needle.length < haystack.length ? haystack[i + needle.length]! : '';
    const marks = new Set(['/', '\\', '@', ':', '=', '"', "'", '`']);
    if (marks.has(before) || marks.has(after)) return true;
    i = haystack.indexOf(needle, i + 1);
  }
  return false;
}

function clip(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
