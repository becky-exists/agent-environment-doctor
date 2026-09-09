/**
 * RuntimeAdapter — runtime ごとの収集規約
 *
 * 規約: collectResources() と computeBindings() を必ず分ける。
 *   Resource 収集は runtime バージョンを知らずに動く。
 *   Binding 計算だけがバージョンに依存する。
 *   → Claude Code の仕様変更時、再計算する範囲が Binding に閉じる。
 */

import type { Binding, Observation, Resource, RuntimeId, RuntimeInfo, Confidence, LoadMode, AppliesTo, Mechanism, SourceRef } from '../ir/types.js';

/** discovery 規則。runtime バージョンで変わるので since/until を持つ */
export interface DiscoveryRule {
  rule_id: string;
  /** 規則の出典。docs:<file>#<anchor> か measured:<date> */
  rule_source: string;
  description: string;
  confidence: Confidence;
  /** この規則が有効な runtime バージョン範囲。null = 全版 */
  since?: string | null;
  until?: string | null;
}

/** 探索パスと優先順位 */
export interface SearchPath {
  path: string;
  owner: Resource['owner'];
  kind: Resource['kind'];
  /** 小さいほど強い */
  precedence: number;
  /** このパスがこの runtime の探索対象か。false なら収集はするが discovered=false */
  in_search_path: boolean;
  /** 発見に必要なファイル形状 */
  shape: 'dir_with_skill_md' | 'flat_md' | 'flat_toml' | 'json' | 'md' | 'any' | 'rules_dsl';
}

/** Phase 1 以降の probe 計画。Phase 0 は計画を返すだけで実行しない */
export interface ProbeSpec {
  probe_id: string;
  method: 'debug_log' | 'plugin_eval' | 'self_report';
  /** 何を確定させたいか */
  question: string;
  /** 実行コスト（token 概算 / 副作用の有無） */
  cost: { tokens: number | null; side_effects: boolean };
}

export interface CollectContext {
  /** HOME。fixture 実行時は差し替わる */
  home: string;
  /** 対象プロジェクト（cwd 相当）。null なら user scope のみ */
  project: string | null;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME 相当の上書き */
  configHome?: string;
  /**
   * 明示された起動スクリプト（絶対パス）。Phase 0 はここで渡された分だけ収集し、
   * shell 設定・launchd の全域探索はしない（Codex レビュー 2-D、2026-09-07）。
   */
  launchers?: string[];
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;

  /** この環境が存在するか + バージョン */
  detect(ctx: CollectContext): Promise<RuntimeInfo>;

  searchPaths(ctx: CollectContext): SearchPath[];

  /** discovery 規則。バージョン差を表現するため version を受ける */
  discoveryRules(version: string | null): DiscoveryRule[];

  /** 事実のみ。runtime 非依存の形で返す */
  collectResources(ctx: CollectContext): Promise<Resource[]>;

  /** discovery 規則を適用。rule_id を必ず埋める */
  computeBindings(resources: Resource[], info: RuntimeInfo, ctx: CollectContext): Binding[];

  /** 既に存在する記録から Observation を作る。測定はしない */
  collectObservations(resources: Resource[], ctx: CollectContext): Promise<Observation[]>;

  /** Phase 1 以降。計画を返すだけ */
  probePlan(): ProbeSpec[];

  /** 既定で protected にする glob（安全側） */
  protectedDefaults(): string[];
}

/** Binding を組む時の共通ヘルパ用 */
export interface BindingDecision {
  mechanism: Mechanism;
  source_ref: SourceRef;
  discovered: boolean;
  rule_id: string;
  rule_source: string;
  confidence: Confidence;
  load_mode: LoadMode;
  applies_to: AppliesTo[];
  scope_condition: string[] | null;
}
