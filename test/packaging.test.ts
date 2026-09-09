/**
 * Packaging regression（#72）
 *
 * 発見の経緯: モノレポ root の `.gitignore` にある `.claude/` `.agents/`（実環境の設定ディレクトリを
 * 誤コミットしないための全体 ignore）が、Agent Environment Doctor の fixture 内にある
 * **意図的に作ったテスト用の `.claude` / `.agents`** まで巻き込んで無視していた。
 *
 * このマシン上でテストが通り続けていたのは、working tree に実ファイルが（git 未追跡のまま）
 * 残っていたから。`git archive` / `git clone` で持ち出すと最初から欠落し、
 * Windows 実機 Dogfood（89 pass / 54 fail）の失敗の相当数はこれが真因だった。
 *
 * fixture は root `.gitignore` の否定パターンで tracked file に戻したが（#72）、
 * **「working tree に未追跡 fixture が残っているから通る」を二度と許さない**ために、
 * git 管理下のファイルだけから作った fresh checkout の上で実際に test suite が通ることを
 * ここで固定する。node_modules はネットワークを使わず既存のものを共有する（symlink）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { ROOT } from './helpers.js';

// fixture の完全性に直結するテスト群。読み取り専用の患者コピーまで含めて、
// working tree の未追跡ファイルに頼らず fresh checkout だけで通ることを確認する
const CRITICAL_SUITES = ['test/fixtures.test.ts', 'test/windows.test.ts', 'test/readonly.test.ts', 'test/bundle.test.ts'];

// このテスト自体は「開発者の git ワーキングツリーから git archive した時に欠落が無いか」を守るためのもの。
// 配布用 zip（それ自体が git archive の結果、.git を持たないスタンドアロンコピー）の中で実行すると
// 対象が無く意味を成さないので、その場合は fail ではなく skip する（#72）
let monorepoRoot: string | null = null;
try {
  monorepoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  monorepoRoot = null;
}

test(
  'packaging: git 管理下のファイルだけで作った fresh checkout でも fixture 依存テストが通る（working tree の未追跡 fixture に依存していないことの regression, #72）',
  { skip: monorepoRoot === null ? 'not inside a git working tree (this checks fixture tracking against git history; a distributed zip has no .git to compare against)' : false },
  async () => {
    const root = monorepoRoot!;
    const relPath = relative(root, ROOT).split('\\').join('/'); // git archive の pathspec は "/" 区切り
    // standalone root（このリポジトリ自体が git toplevel）では relPath が空文字列になる。
    // `git archive -- ""` は "empty string is not a valid pathspec" で拒否されるため、
    // その場合は archive 全体を対象にする "." を渡す（#79）
    const archiveTarget = relPath === '' ? '.' : relPath;

    const tmpRoot = await mkdtemp(join(tmpdir(), 'agent-doctor-fresh-'));
    try {
      // HEAD の agent-environment-doctor サブツリーだけを tar 化 → 展開。
      // ワーキングツリーの未追跡ファイルは一切含まれない（= fixture が本当に tracked かの実地証明）
      const tar = execFileSync('git', ['archive', '--format=tar', 'HEAD', '--', archiveTarget], {
        cwd: root,
        maxBuffer: 100 * 1024 * 1024,
      });
      execFileSync('tar', ['-x', '-C', tmpRoot], { input: tar, maxBuffer: 100 * 1024 * 1024 });
      const freshDoctor = join(tmpRoot, relPath);

      // node_modules は再ダウンロードしない（ネットワーク不要・高速）。HEAD 時点の package.json と
      // 現在の node_modules は同じリポジトリ上のものなので依存関係は一致する前提
      await symlink(join(ROOT, 'node_modules'), join(freshDoctor, 'node_modules'), 'dir');

      const tsx = join(freshDoctor, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const r = spawnSync(process.execPath, [tsx, '--test', ...CRITICAL_SUITES], {
        cwd: freshDoctor,
        encoding: 'utf8',
        timeout: 180_000,
      });

      assert.equal(
        r.status,
        0,
        `fresh checkout（git 管理下のファイルだけ）で test が失敗した。fixture が git 未追跡のまま残っている可能性がある:\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  },
);
