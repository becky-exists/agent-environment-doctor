/**
 * Cross-platform correctness と「取れなかった」の表現
 *
 * 守るのは 2 つ:
 *   1. **Windows で memory が静かに 0 件にならない**（#64 の実バグ）
 *   2. **0 件と「読めなかった」を混同しない**（unobserved ≠ absent の延長）
 *
 * Windows 機は無いので、Windows 形式の projects ツリーを fixture にして Mac 上で回す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';

import { claudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { codexAdapter } from '../src/adapters/codex/index.js';
import { collect, SCHEMA_VERSION } from '../src/snapshot.js';
import { computeContextCost } from '../src/observe/context-cost.js';
import { isSkillDirForm, isWindowsAbsolutePath, matchProjectSlug, memorySlugOf, posixSlug, projectSlugCandidates, toPosixPath } from '../src/ir/slug.js';
import { classifyError, makeAccessRecord } from '../src/ir/access.js';
import { globToRegExp, isProtected } from '../src/findings/context.js';
import { searchedPlaces } from '../src/findings/unreachable-reference.js';
import { extractLauncherInjections, resolveHomeRelative } from '../src/ir/binding.js';
import type { FindingContext } from '../src/findings/context.js';
import type { Snapshot } from '../src/ir/types.js';
import { FIXTURES, expand, toPosixKey } from './helpers.js';

const HOME = join(FIXTURES, 'windows-projects', 'env', 'home');
const readText = async (p: string) => {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
};

/** 実環境の変数を持ち込まずに fixture を収集する */
async function collectWin(project: string | null) {
  const saved = { CODEX_HOME: process.env['CODEX_HOME'], CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'], PATH: process.env['PATH'] };
  delete process.env['CODEX_HOME'];
  delete process.env['CLAUDE_CONFIG_DIR'];
  process.env['PATH'] = dirname(process.execPath);
  try {
    return (await collect([claudeCodeAdapter, codexAdapter], { home: HOME, project })).snapshot;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ───────────────────── slug の規則 ─────────────────────

test('slug: Mac / Linux は実測どおり — 非英数を - に、大文字は残す', () => {
  assert.equal(posixSlug('/Volumes/SSD2TB/wo-projects/KUROKO'), '-Volumes-SSD2TB-wo-projects-KUROKO');
  assert.deepEqual(projectSlugCandidates('/Volumes/SSD2TB/foo'), ['-Volumes-SSD2TB-foo']);
});

test('slug: Windows は 1 本に決めず、候補を出す（一次情報が実装とコメントで食い違うため）', () => {
  assert.ok(isWindowsAbsolutePath('C:\\Users\\foo.bar\\gsd'));
  assert.ok(isWindowsAbsolutePath('D:/data/x'));
  assert.ok(!isWindowsAbsolutePath('/Volumes/SSD2TB/foo'));

  const c = projectSlugCandidates('C:\\Users\\foo.bar\\gsd');
  // 一次情報のコード: 全体 lowercase
  assert.ok(c.includes('c--users-foo-bar-gsd'), `lowercase 候補が無い: ${c.join(', ')}`);
  // 一次情報のコメント / コミットメッセージ: drive letter だけ lowercase
  assert.ok(c.includes('c--Users-foo-bar-gsd'), `drive-letter-only 候補が無い: ${c.join(', ')}`);
  assert.ok(c.length >= 2, '候補が 1 本に潰れている（賭けてしまっている）');
});

test('slug: 列挙結果と突合する。突合できなければ no_match（0 件ではない）', () => {
  const entries = ['c--users-foo-bar-gsd', 'c--Users-Foo-Bar-Mixed', '-Volumes-SSD2TB-posix-project'];

  const a = matchProjectSlug('C:\\Users\\foo.bar\\gsd', entries);
  assert.equal(a.slug, 'c--users-foo-bar-gsd');

  const b = matchProjectSlug('C:\\Users\\Foo.Bar\\Mixed', entries);
  assert.equal(b.slug, 'c--Users-Foo-Bar-Mixed');

  const c = matchProjectSlug('/Volumes/SSD2TB/posix/project', entries);
  assert.equal(c.slug, '-Volumes-SSD2TB-posix-project');

  const d = matchProjectSlug('C:\\Users\\nobody\\missing', entries);
  assert.equal(d.slug, null);
  assert.equal(d.how, 'no_match');
  assert.ok(d.candidates.length > 0, '何を試したかを残す');

  const e = matchProjectSlug(null, entries);
  assert.equal(e.how, 'not_applicable');
});

test('slug: Windows は大小文字を無視して突合する（FS が case-insensitive で、case 規則も未確定）', () => {
  // どの候補とも exact で一致しない case の並び。case を無視して初めて拾える
  const m = matchProjectSlug('C:\\Users\\foo.bar\\gsd', ['C--Users-foo-bar-GSD']);
  assert.equal(m.slug, 'C--Users-foo-bar-GSD');
  assert.equal(m.how, 'case_insensitive');
  // Mac / Linux では case を落とさない（実測で大文字が残るため）
  assert.equal(matchProjectSlug('/Volumes/SSD2TB/KUROKO', ['-volumes-ssd2tb-kuroko']).slug, null);
});

test('memorySlugOf: 区切りが \\ でも / でも同じ意味になる（/ 固定だと cost が静かに 0 になっていた）', () => {
  assert.equal(memorySlugOf('/Users/x/.claude/projects/-Volumes-a/memory/MEMORY.md'), '-Volumes-a');
  assert.equal(memorySlugOf('C:\\Users\\x\\.claude\\projects\\c--users-x\\memory\\MEMORY.md'), 'c--users-x');
  assert.equal(memorySlugOf('C:/Users/x/.claude/projects/c--users-x/memory/MEMORY.md'), 'c--users-x');
  assert.equal(memorySlugOf('/Users/x/.claude/skills/foo/SKILL.md'), null);
});

test('slug: 符号化は非可逆。復元関数を持たない', async () => {
  const src = await readFile(join(FIXTURES, '..', 'src', 'ir', 'slug.ts'), 'utf8');
  assert.ok(!/export function (decode|unslug|slugToPath)/.test(src), 'slug から元パスを復元する関数を作らない');
});

// ───────────────────── Windows fixture の実収集 ─────────────────────

test('Windows fixture: 列挙が正 — 符号化規則が違う memory を全部見つける', async () => {
  const s = await collectWin(null);
  const memories = s.resources.filter((r) => r.kind === 'memory').map((r) => memorySlugOf(r.path));
  assert.ok(memories.includes('c--users-foo-bar-gsd'), 'Windows(全体 lowercase) の memory を落とした');
  assert.ok(memories.includes('c--Users-Foo-Bar-Mixed'), 'Windows(drive letter のみ lowercase) の memory を落とした');
  assert.ok(memories.includes('-Volumes-SSD2TB-posix-project'), 'Mac 形式の memory を落とした');
  assert.equal(memories.length, 3);
});

test('Windows fixture: project を Windows パスで指定しても memory が 0 にならない', async () => {
  const s = await collectWin('C:\\Users\\foo.bar\\gsd');
  const cost = await computeContextCost(s, () => false, readText);
  const memoryItems = cost.items.filter((i) => memorySlugOf(i.path) !== null);
  assert.ok(memoryItems.length > 0, 'memory が 1 件も計上されていない（#64 の静かな 0 件）');
  // 絞り込みが効いている = 自分の slug だけ
  assert.deepEqual([...new Set(memoryItems.map((i) => memorySlugOf(i.path)))], ['c--users-foo-bar-gsd']);
});

test('Windows fixture: 絞り込みに失敗したら 0 件にせず、失敗として記録する', async () => {
  const s = await collectWin('C:\\Users\\nobody\\not-a-real-project');
  const cost = await computeContextCost(s, () => false, readText);
  const memoryItems = cost.items.filter((i) => memorySlugOf(i.path) !== null);
  assert.ok(memoryItems.length > 0, '突合できなかった時に memory を全部落としている（これが一番まずい失敗）');
  assert.ok(
    cost.not_measured.some((x) => /could not be matched/.test(x)),
    `突合失敗が not_measured に出ていない: ${JSON.stringify(cost.not_measured)}`,
  );
});

test('Windows fixture: 存在しない project パスの読み取りは absent、成功は observed', async () => {
  const s = await collectWin('C:\\Users\\foo.bar\\gsd');
  const acc = s.access ?? [];
  assert.ok(acc.length > 0, 'access が記録されていない');
  const mem = acc.find((a) => a.what === 'project memory directories');
  assert.ok(mem, 'memory ディレクトリの読み取り記録が無い');
  assert.equal(mem!.status, 'observed');
  assert.equal(mem!.count, 4, '4 つの project ディレクトリを列挙している');
  // project 側（Windows パスなので Mac には無い）は absent であって failed ではない
  const projectSide = acc.filter((a) => a.status === 'absent');
  assert.ok(projectSide.length > 0);
  for (const a of projectSide) assert.equal(a.count, null, 'observed 以外で数を書いている');
});

// ───────────────────── 「取れなかった」の表現 ─────────────────────

test('access: status が observed 以外の時は count を必ず null にする（0 と書けない）', () => {
  for (const status of ['absent', 'permission_denied', 'failed', 'unsupported', 'not_applicable', 'unobserved'] as const) {
    const r = makeAccessRecord({ target: 't', collector: 'c', what: 'w', status, count: 0 });
    assert.equal(r.count, null, `${status} で count=0 が残っている`);
  }
  assert.equal(makeAccessRecord({ target: 't', collector: 'c', what: 'w', status: 'observed', count: 0 }).count, 0);
});

test('access: errno を推測で absent にしない', () => {
  assert.equal(classifyError({ code: 'ENOENT' }).status, 'absent');
  assert.equal(classifyError({ code: 'EACCES' }).status, 'permission_denied');
  assert.equal(classifyError({ code: 'EPERM' }).status, 'permission_denied');
  assert.equal(classifyError({ code: 'EIO' }).status, 'failed');
  assert.equal(classifyError({ code: 'ELOOP' }).status, 'failed');
  assert.equal(classifyError(new Error('no code')).status, 'failed');
  // 知らない errno を absent に倒さない
  assert.equal(classifyError({ code: 'ENOTSUPPORTEDWHATEVER' }).status, 'failed');
});

// ───────────────────── R4a（#72 続き）: chmod permission test ─────────────────────
//
// メンテナーの Windows v7 実機ドッグフードで発見。Windows の NTFS 権限モデルは POSIX の mode bit
// （chmod 0o000）と一致しないため、chmod でディレクトリを「読めない」状態には基本的にできない
// （所有者アクセスは大抵素通りする）。production 側（classifyError の EACCES/EPERM 判定）は
// 既に正しい。壊れていたのは「実 OS の権限で不可読ディレクトリを作る」というテストの再現方法
// そのもの。OS 権限に頼らず、readdir の失敗を直接注入して同じ契約（collector → access log）
// を検証する形に置き換える。

test('access（OS 非依存）: listDir の readdir 失敗が握りつぶされず access log の permission_denied まで運ばれる', async () => {
  const { beginAccessLog, peekAccessLog } = await import('../src/ir/access.js');
  const { listDir } = await import('../src/adapters/claude-code/index.js');
  beginAccessLog();
  const denyEacces = async (): Promise<string[]> => {
    throw Object.assign(new Error('permission denied (synthetic)'), { code: 'EACCES' });
  };
  const out = await listDir('/does/not/matter/skills', 'skills (synthetic)', denyEacces);
  assert.deepEqual(out, [], '読めなかった時は空配列を返す（0 件表示そのものは維持）');
  const denied = peekAccessLog().filter((a) => a.status === 'permission_denied');
  assert.ok(denied.length > 0, '権限で読めなかったことが記録されていない（skill 0 件に見えてしまう）');
  assert.equal(denied[0]!.count, null);
  assert.equal(denied[0]!.error_code, 'EACCES');
  assert.match(String(denied[0]!.reason), /not the same as it being empty/);
});

test('access（OS 実機、POSIX のみ）: chmod 0o000 で実際に不可読にしたディレクトリが permission_denied になる', { skip: process.platform === 'win32' ? 'Windows の NTFS 権限モデルは chmod 0o000 では所有者アクセスを塞げない（#72 R4a）。OS 非依存版で契約を検証する' : false }, async () => {
  const { chmod, mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'agent-doctor-perm-'));
  try {
    const cc = join(root, '.claude');
    await mkdir(join(cc, 'skills'), { recursive: true });
    await mkdir(join(cc, 'skills', 'hidden-by-permission'), { recursive: true });
    await writeFile(join(cc, 'skills', 'hidden-by-permission', 'SKILL.md'), '---\nname: x\ndescription: x\n---\n');
    await writeFile(join(cc, 'settings.json'), '{}');
    await chmod(join(cc, 'skills'), 0o000);

    const s = await (async () => {
      const saved = process.env['PATH'];
      process.env['PATH'] = dirname(process.execPath);
      try {
        return (await collect([claudeCodeAdapter], { home: root, project: null })).snapshot;
      } finally {
        if (saved !== undefined) process.env['PATH'] = saved;
      }
    })();

    const denied = (s.access ?? []).filter((a) => a.status === 'permission_denied');
    assert.ok(denied.length > 0, '権限で読めなかったことが記録されていない（skill 0 件に見えてしまう）');
    assert.equal(denied[0]!.count, null);
    assert.match(String(denied[0]!.reason), /not the same as it being empty/);
  } finally {
    await chmod(join(root, '.claude', 'skills'), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

// ───────────────────── #72: test harness の path 区切り文字混在（最小再現） ─────────────────────
//
// Windows 実機 Dogfood（89 pass / 54 fail）で発見。production 側（src/）は node:path の join() を
// 一貫して使っておりバグは無い。壊れていたのは test/helpers.ts の `expand()` と `fingerprint()` という
// **test harness 側**。ここでは Windows 実機が無くても node:path の win32 名前空間で結合規則そのものを
// 検証し、「Windows 上で実際に何が起きていたか」を Mac 上で再現・固定する。

test('#72 最小再現: 旧 expand() 実装は Windows 形式 home で区切り文字が混在したパスを作る（regression 証拠）', () => {
  const home = 'C:\\Users\\foo.bar\\home';
  // 修正前の実装そのもの（home + p.slice(1)）。fixture 側の "/" と home 側の "\" が混ざる
  const oldExpand = (p: string, h: string) => (p.startsWith('~') ? h + p.slice(1) : p);
  const broken = oldExpand('~/.claude/skills/x.md', home);
  assert.equal(broken, 'C:\\Users\\foo.bar\\home/.claude/skills/x.md');
  assert.ok(broken.includes('/') && broken.includes('\\'), 'この再現テスト自体が旧実装の壊れ方を再現できていない');
});

test('#72: expand() は Windows 形式 home を渡しても win32 の結合規則で統一される（Windows 実機を Mac 上で検証）', () => {
  const home = 'C:\\Users\\foo.bar\\home';
  const result = expand('~/.claude/skills/x.md', home);
  assert.equal(result, 'C:\\Users\\foo.bar\\home\\.claude\\skills\\x.md');
  assert.ok(!result.includes('/'), `区切り文字が混在している: ${result}`);
});

test('#72: expand() は Mac/Linux 形式 home では従来どおり posix の結合規則のまま（既存挙動の後方互換）', () => {
  const home = '/Users/foo.bar/home';
  const result = expand('~/.claude/skills/x.md', home);
  assert.equal(result, '/Users/foo.bar/home/.claude/skills/x.md');
});

test('#72: toPosixKey は Windows 形式の相対パスキーを "/" に統一する（read-only harness の allow-list 判定に使う）', () => {
  assert.equal(toPosixKey('patient\\home\\.claude\\rules\\x.md'), 'patient/home/.claude/rules/x.md');
  assert.equal(toPosixKey('cwd\\snapshots\\2026.json'), 'cwd/snapshots/2026.json');
  // Mac 上の相対パス（すでに "/" 区切り）は無変化
  assert.equal(toPosixKey('patient/home/.claude/rules/x.md'), 'patient/home/.claude/rules/x.md');
});

// ───────────────────── #72 続き: skill discovery の共有 root cause（claude-code / codex 共通） ─────────────────────
//
// メンテナーの Windows v6 実機ドッグフード（149 tests / 115 pass / 32 fail / 2 skip）で発見。
// isDirForm 判定（`/SKILL\.md$/` 固定）と search_path の前方一致判定（sp.path がテンプレートリテラルで
// `/` 固定生成）の 2 箇所が、claude-code / codex 両アダプタに同一パターンで重複していた。
// r.path は join() で OS 依存生成される（Windows 実機なら `\` 区切り）ため、`/` 固定の判定は
// 実機 Windows で常に不一致になり、dir 形式の skill が discovered:false に誤判定されていた。

test('isSkillDirForm: 区切りが \\ でも dir 形式と判定する（旧 /SKILL\\.md$ 固定正規表現は Windows で常に不一致だった）', () => {
  const winPath = 'C:\\Users\\test\\.claude\\skills\\finish\\SKILL.md';
  const posixPath = '/Users/test/.claude/skills/finish/SKILL.md';
  // 旧実装そのもの（claude-code/codex 両 index.ts の isDirForm 判定）
  const oldRegex = /\/SKILL\.md$/;
  assert.equal(oldRegex.test(winPath), false, 'この再現テスト自体が旧実装の壊れ方を再現できていない');
  // 新実装は区切り非依存
  assert.equal(isSkillDirForm(winPath), true);
  assert.equal(isSkillDirForm(posixPath), true);
  // 平置き .md（dir 形式でない）は引き続き false のまま
  assert.equal(isSkillDirForm('C:\\Users\\test\\.claude\\skills\\flat.md'), false);
  assert.equal(isSkillDirForm('/Users/test/.claude/skills/flat.md'), false);
});

test('toPosixPath: search_path の前方一致判定は区切り文字混在でも成立する（sp.path 側に "/" が残っても r.path 側の "\\" と一致する）', () => {
  // r.path 相当（join() が実機 Windows で作る形）
  const rPath = 'C:\\Users\\test\\.claude\\skills\\finish\\SKILL.md';
  // sp.path 相当（旧テンプレートリテラル実装が作っていた形。ホームは "\\" だが自前で足した区切りは "/"）
  const spPath = 'C:\\Users\\test\\.claude/skills';
  assert.equal(rPath.startsWith(spPath), false, 'この再現テスト自体が旧実装の壊れ方を再現できていない');
  assert.equal(toPosixPath(rPath).startsWith(toPosixPath(spPath)), true);
});

// ───────────────────── R3（#72 続き）: protected MEMORY.md matcher ─────────────────────
//
// メンテナーの Windows v7 実機ドッグフードで発見。isProtected() が glob（`**/MEMORY.md` のように
// `/` 固定）を、join() で作られた native path（Windows 実機なら `\` 区切り）にそのまま test()
// していたため、実機 Windows では常に不一致になり protected:false 誤判定になっていた
// （guard-false-bloat の protected assertion / llm-report の protected list / context-cost の
// protected_total、共有 root）。

test('isProtected: Windows native path（"\\" 区切り）でも "**/MEMORY.md" にマッチする（旧実装は常に false だった）', () => {
  const winPath = 'C:\\Users\\test\\.claude\\projects\\y\\memory\\MEMORY.md';
  const posixPath = '/Users/test/.claude/projects/y/memory/MEMORY.md';
  // 旧実装そのもの（区切り正規化なしの globToRegExp().test()）
  assert.equal(globToRegExp('**/MEMORY.md').test(winPath), false, 'この再現テスト自体が旧実装の壊れ方を再現できていない');
  // 新実装は区切り非依存
  assert.equal(isProtected(winPath, ['**/MEMORY.md']), true);
  assert.equal(isProtected(posixPath, ['**/MEMORY.md']), true);
  // memory/** の glob でも同様
  assert.equal(isProtected('C:\\Users\\test\\.claude\\memory\\soul\\axis-1.md', ['**/memory/**']), true);
  // 対象外パスは引き続き false のまま
  assert.equal(isProtected('C:\\Users\\test\\.claude\\rules\\flat.md', ['**/MEMORY.md', '**/memory/**']), false);
});

// ───────────────────── R1（#72 続き）: evidence/search path separator 混在 ─────────────────────
//
// メンテナーの Windows v7 実機ドッグフードで発見。searchedPlaces() が `${rt.config_home}/settings.json`
// のようにハードコードの "/" で config_home（join() で作られる native path）と連結していたため、
// 実機 Windows では区切り文字混在パスになっていた（unreachable-reference の missing_target 評価
// で「探した場所」に出す文字列）。
//
// join() を実行環境の process.platform で解決するため、Mac 上ではこの入れ替えの効果（\ 統一）
// 自体は再現できない（ambient join は Mac では posix のまま）。ここでは (1) join() 化で実際に
// Mac 上でも観測できる副作用（末尾区切りの二重化が normalize される）と、(2) win32.join を明示
// 使用した際にアルゴリズムとして区切りが統一されること、の 2 点を確認する。実機 Windows での
// 最終確認は npm test の実行結果による（このセッションでは実行できない）。

function windowsSnapshot(configHome: string, home: string): Snapshot {
  return {
    snapshot_id: 'r1-test',
    schema_version: SCHEMA_VERSION,
    tool_version: 'test',
    runtimes: [{ runtime: 'claude-code', version: '2.1.263', config_home: configHome, present: true }],
    env: { os: 'test', project: null, home, launchers: [] },
    coverage: { phase: 'test', collected: [], not_collected: [] },
    resources: [],
    bindings: [],
    observations: [],
    sessions: [],
    processes: [],
    probe_notes: [],
  };
}

test('searchedPlaces: config_home の末尾区切り文字が二重にならない（テンプレートリテラル連結の名残りを join() が normalize する）', () => {
  const ctx = { snapshot: windowsSnapshot('/h/.claude/', '/h'), protectedGlobs: [] } as unknown as FindingContext;
  const places = searchedPlaces(ctx);
  assert.ok(places.some((p) => p === '/h/.claude/settings.json#enabledPlugins'));
  assert.ok(places.every((p) => !p.includes('//')), `二重区切りが残っている: ${JSON.stringify(places)}`);
});

test('searchedPlaces（アルゴリズム検証）: win32.join を明示使用すれば region 混在は起きない（旧実装のテンプレートリテラル連結は "/" 固定で混在した）', () => {
  const configHome = 'C:\\Users\\test\\.claude';
  // 旧実装そのもの（テンプレートリテラル連結）
  const oldStyle = `${configHome}/settings.json#enabledPlugins`;
  assert.match(oldStyle, /\\.*\//, 'この再現テスト自体が旧実装の壊れ方を再現できていない（\\ と / の混在が無い）');
  // 新実装相当（win32.join を明示することで実機 Windows の ambient join と同じ挙動を Mac 上で確認）
  const newStyle = `${win32.join(configHome, 'settings.json')}#enabledPlugins`;
  assert.equal(newStyle, 'C:\\Users\\test\\.claude\\settings.json#enabledPlugins');
  assert.equal(/\//.test(newStyle.replace(/#.*$/, '')), false, 'パス部分に "/" が残っている');
});

// R1 の詰め残し（Codex アドバーサリアルレビューで発見）: `${join(rt.config_home, 'skills')}/<dir>/SKILL.md`
// のように、join() で正規化した部分の**後ろ**にハードコードの "/" で `<dir>/SKILL.md` を連結していた箇所が
// 4 箇所残っていた。join() 部分は実機 Windows で "\" になるが、後付けの "/<dir>/SKILL.md" はそのままなので
// 依然として区切り文字混在になる。修正は `<dir>` と `SKILL.md` も join() のセグメントとして渡す形に統一。

test('searchedPlaces（アルゴリズム検証）: <dir>/SKILL.md 行も join() のセグメントに含めれば区切り混在は起きない（旧実装は "/<dir>/SKILL.md" をテンプレートリテラル固定で後付け連結していた）', () => {
  const configHome = 'C:\\Users\\test\\.claude';
  // 旧実装そのもの（`${join(configHome, 'skills')}/<dir>/SKILL.md`）
  const oldStyle = `${win32.join(configHome, 'skills')}/<dir>/SKILL.md`;
  assert.match(oldStyle, /\\.*\//, 'この再現テスト自体が旧実装の壊れ方を再現できていない（\\ と / の混在が無い）');
  // 新実装（<dir> と SKILL.md も join() の引数として渡す。node:path の join() は文字列セグメントの
  // 中身を解釈しないため "<dir>" というリテラルをそのまま 1 セグメントとして渡せる）
  const newStyle = win32.join(configHome, 'skills', '<dir>', 'SKILL.md');
  assert.equal(newStyle, 'C:\\Users\\test\\.claude\\skills\\<dir>\\SKILL.md');
  assert.equal(/\//.test(newStyle), false, 'パスに "/" が残っている');
});

test('searchedPlaces: <dir>/SKILL.md を含む探索先が実際に join() 経由で生成される（区切り混在の後付け連結が production コードから消えていることの直接確認）', () => {
  // ここで渡す config_home / home は POSIX 形式の合成入力。searchedPlaces() は base の見た目で
  // 結合規則を選ぶ（joinPreservingStyle、#72 F2-F4）ため、期待値も ambient join ではなく posix.join
  // で組む。ambient join だと実機 Windows では win32.join になり、POSIX 形式 base の結果と一致しなくなる。
  const claudeCtx = { snapshot: windowsSnapshot('/h/.claude', '/h'), protectedGlobs: [] } as unknown as FindingContext;
  assert.ok(searchedPlaces(claudeCtx).includes(posix.join('/h/.claude', 'skills', '<dir>', 'SKILL.md')));

  const codexSnapshot: Snapshot = { ...windowsSnapshot('/h/.codex', '/h'), runtimes: [{ runtime: 'codex', version: '1.0', config_home: '/h/.codex', present: true }] };
  const codexCtx = { snapshot: codexSnapshot, protectedGlobs: [] } as unknown as FindingContext;
  const codexPlaces = searchedPlaces(codexCtx);
  assert.ok(codexPlaces.includes(posix.join('/h', '.agents', 'skills', '<dir>', 'SKILL.md')));
  assert.ok(codexPlaces.includes(posix.join('/h/.codex', 'skills', '<dir>', 'SKILL.md')));
});

// ───────────────────── R2（#72 続き）: append_system_prompt の Windows launcher parsing ─────────────────────
//
// メンテナーの Windows v7 実機ドッグフードで発見。extractLauncherInjections() が `~/rules/foo.md` の
// `~` だけを home に置換し、残りの "/" 区切りセグメントをそのまま文字列連結していたため、実機
// Windows では home("\" 区切り) + 残り("/" 区切り) の混在パスになっていた。collectResources() の
// 重複判定（`out.some((r) => r.path === inj.target)`）が native path 生成の Resource と一致せず、
// 混在パスのまま別 Resource を作ってしまい、computeBindings() の `byPath.get(inj.target)` がその
// 別 Resource を掴む → append_system_prompt の Binding は resource_path が食い違ったまま作られ、
// bindingsFor()（resource_id と resource_path の両方一致が条件）で本来の rule 側 Resource から見て
// 「無い」ことになっていた（scope-mismatch fixture で rule_autoload だけになる現象）。

test('resolveHomeRelative: POSIX home では従来どおり "/" 区切りで解決する（既存挙動の後方互換）', () => {
  assert.equal(resolveHomeRelative('~/.claude/rules/foo.md', '/Users/test'), '/Users/test/.claude/rules/foo.md');
  assert.equal(resolveHomeRelative('$HOME/.claude/rules/foo.md', '/Users/test'), '/Users/test/.claude/rules/foo.md');
  assert.equal(resolveHomeRelative('${HOME}/.claude/rules/foo.md', '/Users/test'), '/Users/test/.claude/rules/foo.md');
  assert.equal(resolveHomeRelative('~', '/Users/test'), '/Users/test');
  // home 参照でないもの（絶対パス）はそのまま
  assert.equal(resolveHomeRelative('/etc/foo.md', '/Users/test'), '/etc/foo.md');
});

test('extractLauncherInjections（アルゴリズム検証）: win32.join を明示使用すれば home("\\" 区切り) + 残り("/" 区切り) の混在は起きない（旧実装の文字列置換は混在した）', () => {
  const home = 'C:\\Users\\test';
  const raw = '~/.claude/rules/foo.md';
  // 旧実装そのもの（先頭の ~ だけ置換する文字列置換）
  const oldStyle = raw.replace(/^~(?=\/|$)/, home);
  assert.equal(oldStyle, 'C:\\Users\\test/.claude/rules/foo.md', 'この再現テスト自体が旧実装の壊れ方を再現できていない');
  assert.match(oldStyle, /\\.*\//, '旧実装が \\ と / の混在パスを作ることを再現できていない');
  // 新実装のアルゴリズム相当（win32.join を明示することで実機 Windows の ambient join と同じ挙動を Mac 上で確認）
  const segs = raw.slice(1).split('/').filter(Boolean);
  const newStyle = win32.join(home, ...segs);
  assert.equal(newStyle, 'C:\\Users\\test\\.claude\\rules\\foo.md');
  assert.equal(/\//.test(newStyle), false, 'パスに "/" が残っている');
});

test('extractLauncherInjections: launcher スクリプトの --append-system-prompt "$(cat ~/x)" を1行から拾う（既存挙動の後方互換）', () => {
  const script = '#!/bin/sh\nclaude --append-system-prompt "$(cat ~/.claude/rules/foo.md)"\n';
  const injections = extractLauncherInjections(script, '/Users/test');
  assert.equal(injections.length, 1);
  assert.equal(injections[0]!.line, 2);
  assert.equal(injections[0]!.raw_target, '~/.claude/rules/foo.md');
  assert.equal(injections[0]!.target, '/Users/test/.claude/rules/foo.md');
});
