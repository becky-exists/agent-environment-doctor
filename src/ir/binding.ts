/**
 * Binding の一意キー導出と、起動スクリプトの注入経路の抽出
 *
 * binding_id = sha256(runtime | resource_path | mechanism | source_ref の位置)
 *
 * **content hash を identity に入れない。** 入れていた版では、容器ファイル（settings.json / config.toml）の
 * 内容が変わるだけで、中身の変わっていない結合まで別 id になり、history が「46 件消えて 46 件増えた」と
 * 誤って言った（2026-09-07 実測）。結合の同一性は「どの場所の、どの機構による結合か」であって、
 * その時そこに何の内容が在ったかではない。内容は Resource 側（resource_changed）で追う。
 *
 * 一意性は resource_path が担保する（同一内容が別パスに在っても path で分かれる）。
 * source_ref は**位置**だけを直列化する（source の content hash は使わない）。
 */
import { createHash } from 'node:crypto';
import type { Binding, Mechanism, RuntimeId, SourceRef } from './types.js';
import { joinPreservingStyle } from './slug.js';

export function serializeSourceRef(s: SourceRef): string {
  switch (s.type) {
    case 'discovery':
      return `discovery:${s.search_path}`;
    case 'resource':
      // resource_id（content hash）は入れない。位置だけが identity
      return `resource:${s.resource_path}#${s.locator ?? ''}`;
    case 'external':
      return `external:${s.ref}#${s.locator ?? ''}`;
  }
}

export function bindingId(runtime: RuntimeId, resource_path: string, mechanism: Mechanism, source_ref: SourceRef): string {
  const h = createHash('sha256');
  h.update([runtime, resource_path, mechanism, serializeSourceRef(source_ref)].join(' '), 'utf8');
  return 'binding:' + h.digest('hex').slice(0, 32);
}

/** binding_id を埋めた Binding を返す。adapter は binding_id を手で書かない */
export function withBindingId(b: Omit<Binding, 'binding_id'>): Binding {
  return { binding_id: bindingId(b.runtime, b.resource_path, b.mechanism, b.source_ref), ...b };
}

export interface LauncherInjection {
  /** 起動スクリプト内の行番号 */
  line: number;
  /** cat の引数に書かれた生の文字列（~ 展開前） */
  raw_target: string;
  /** ~ / $HOME を展開した絶対パス */
  target: string;
  /** どのフラグに渡されたか。Phase 0 は --append-system-prompt のみ */
  flag: 'append-system-prompt';
}

/**
 * 起動スクリプトから `--append-system-prompt "$(cat <path>)"` の形だけを拾う。
 * 意図的に単純化: 対応は cat 1 ファイル、フラグはこれ 1 つ。上限 = この 1 形状。
 * 変数展開・複数 cat・heredoc が必要になったら shell の字句解析へ差し替える。
 */
export function extractLauncherInjections(text: string, home: string): LauncherInjection[] {
  const out: LauncherInjection[] = [];
  const re = /--append-system-prompt(?:=|\s+)"?\$\(\s*cat\s+([^)\s"]+)\s*\)"?/g;
  text.split(/\r\n?|\n/).forEach((line, idx) => {
    for (const m of line.matchAll(re)) {
      const raw = m[1]!;
      const target = resolveHomeRelative(raw, home);
      out.push({ line: idx + 1, raw_target: raw, target, flag: 'append-system-prompt' });
    }
  });
  return out;
}

/**
 * `~/x/y` / `$HOME/x/y` / `${HOME}/x/y` の home 参照だけを解決する。launcher スクリプトの記法は
 * 常に shell の "/" 区切りだが、home 側は収集した環境の path（実機 Windows なら "\" 区切り、Windows の
 * bundle / snapshot を別 OS 上で分析する場合は "/" 区切りのまま渡ってくることもある）。
 * 旧実装（先頭の `~` 等を文字列置換するだけ）は残りのセグメントを "/" のまま home にくっつけるため、
 * home が "\" 区切りの時は home("\" 区切り) + 残り("/" 区切り) の混在パスになり、join() で作られる他の
 * Resource.path と一致しなくなっていた（#72 R2、append_system_prompt の Binding が欠落して見えた）。
 * "/" 区切りのセグメントに一度分解してから home の見た目（区切り文字）に合わせた規則で組み直すことで、
 * 混在を作らない。ambient OS ではなく home の見た目で規則を選ぶのは、Doctor がホストと別環境の
 * home 文字列を扱う前提のため（joinPreservingStyle、#72 F2-F4）。
 */
export function resolveHomeRelative(raw: string, home: string): string {
  const m = /^(?:~|\$HOME|\$\{HOME\})(?:\/(.*))?$/.exec(raw);
  if (!m) return raw; // home 参照でない（絶対パス等）はそのまま
  const segs = (m[1] ?? '').split('/').filter(Boolean);
  return segs.length ? joinPreservingStyle(home, ...segs) : home;
}
