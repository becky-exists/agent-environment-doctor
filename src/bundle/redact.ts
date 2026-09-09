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
  projects_anonymised: number;
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
      const m = matchProjectSlug(root, slugs);
      if (m.slug) this.projectIds.set(m.slug, id);
      // 実在しない場合も、符号化候補は同じ id へ（他の project の slug と衝突させない）
      for (const c of projectSlugCandidates(root)) if (slugs.includes(c)) this.projectIds.set(c, id);
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
    for (const k of keys) s = s.split(k).join(this.projectIds.get(k)!);

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

    // すでに `$HOME` や `<project-1>` に置き換わった後ろの `/...` を二重に潰さない
    s = s.replace(/(?<![A-Za-z0-9_$>])(?:[A-Za-z]:[\\/]|\/)[A-Za-z0-9._@+-]+(?:[\\/][A-Za-z0-9._@+-]+)+/g, (m0) => {
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
      projects_anonymised: new Set(this.projectIds.values()).size,
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
export function scanForLeaks(bundle: unknown, opts: { home: string; extra?: string[] }): Leak[] {
  const out: Leak[] = [];
  const home = opts.home.replace(/[/\\]+$/, '');
  const user = basename(home);
  const userIsGeneric = user.length < 3 || GENERIC_USERNAMES.has(user.toLowerCase());
  const needles: Array<{ kind: string; value: string; anywhere: boolean }> = [
    { kind: 'home_path', value: home, anywhere: true },
    // username は散文にも出うる語のことがある（home / root など）。**パスや宛先に面している時だけ**数える
    ...(userIsGeneric ? [] : [{ kind: 'username', value: user, anywhere: false }]),
    ...(opts.extra ?? []).map((v) => ({ kind: 'forbidden_string', value: v, anywhere: true })),
  ];
  // #71: username の完全一致では見逃す派生表現（Windows project slug 化で区切り文字/大文字小文字が変わった形）。
  // slug 文字列はパスの区切りに面していない 1 トークンなので、宛先隣接チェックではなく全文で検査する
  const userVariantRe = userIsGeneric ? null : new RegExp(usernameVariantPatternSource(user), 'gi');

  const walk = (v: unknown, where: string): void => {
    if (typeof v === 'string') {
      for (const n of needles) {
        if (!n.value) continue;
        if (n.anywhere ? v.includes(n.value) : identityAdjacent(v, n.value)) out.push({ kind: n.kind, where, sample: clip(v) });
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
