/**
 * Agent Environment Doctor — IR (4 種の事実データ)
 *
 * 設計正本: docs/design-review-v0.1.md §4.2 / docs/phase0-implementation-handoff.md §2
 *
 * 原則:
 *   - 保存するのは地味で壊れにくい事実。Graph は分析時に生成する
 *   - Resource / Binding / Observation は寿命が違うので混ぜない
 *       Resource    : 内容が変わるまで持続（同一性 = content hash、パスではない）
 *       Binding     : runtime バージョンに依存（規則が変われば再計算）
 *       Observation : 時系列で追記、不変
 *   - raw reference は解決前の文字列を一次事実として保持する。解決は分析時
 *   - Finding は必ず evidence_refs を持ち、一次事実まで辿れる
 */

// ─────────────────────────── 共通 ───────────────────────────

import type { AccessRecord, AccessStatus } from './access.js';
export type { AccessRecord, AccessStatus } from './access.js';

/** 対応 runtime。Phase 0 は claude-code のみ実装、codex は Gate A 通過後 */

export type RuntimeId = 'claude-code' | 'codex';

export type ResourceKind =
  | 'skill'
  | 'hook_script'
  | 'instruction'
  | 'agent_def'
  | 'rule'
  | 'mcp_server'
  | 'plugin'
  | 'memory'
  | 'output_style'
  | 'settings'
  /** スラッシュコマンド（~/.claude/commands/*.md）。セッションの skill 一覧に同じ名前空間で現れる */
  | 'command'
  /** 実行許可ポリシー（Codex の rules/*.rules）。prompt に載る rule とは別物 */
  | 'exec_policy'
  /** 起動スクリプト。明示された分だけ収集（Phase 0）。本文は context に載らない */
  | 'launcher';

/** 誰の持ち物か。plugin 由来は plugin:<id> の形 */
export type Owner = 'user' | 'project' | 'shared' | 'builtin' | `plugin:${string}`;

/**
 * 確信度。規則で確定できるものと heuristic を混ぜないために必須。
 * probe_required = 静的には決まらない（Phase 1 の probe 待ち）
 */
export type Confidence = 'high' | 'medium' | 'low' | 'probe_required';

// ────────────────────────── Resource ──────────────────────────

/**
 * 参照の生文字列。**解決しない。**
 * 「andy.md の 28 行目に `vercel:react-best-practices` という文字列がある」は壊れにくい事実。
 * 「それが解決できない」は分析結果なので Finding 側で出す。
 */
export interface RawReference {
  /** 抽出した文字列そのまま。正規化しない */
  raw: string;
  line: number;
  /** どのパターンで拾ったか。誤検出を許容し、確信度で表現する */
  syntax: 'skill_ref' | 'path_ref' | 'plugin_ref';
  confidence: Confidence;
}

/** 宣言から読めた内容（frontmatter 等）。runtime の解釈は入れない */
export interface DeclaredMeta {
  name?: string;
  description?: string;
  frontmatterKeys: string[];
  /** frontmatter の生の値。runtime 固有フィールドもそのまま持つ */
  raw?: Record<string, unknown>;
}

/** 「何が在るか」。runtime を知らない */
export interface Resource {
  /** sha256:<content_hash>。パスではなく内容が同一性（移動しても同じ Resource） */
  resource_id: string;
  kind: ResourceKind;
  name: string;
  /** 絶対パス。~ は展開済み */
  path: string;
  /** symlink の場合の実体パス。symlink でなければ undefined */
  real_path?: string;
  owner: Owner;
  content_hash: string;
  /** 正規化後の hash。drift 判定はこちらで比較（改行差の偽陽性を防ぐ） */
  normalized_hash: string;
  mtime: string;
  size_bytes: number;
  declared: DeclaredMeta;
  references: RawReference[];
}

// ────────────────────────── Binding ──────────────────────────

/**
 * いつ効くか。
 *   always           : 起動時に必ず載る
 *   path_conditional : 条件付き（paths glob 等）
 *   on_demand        : 呼ばれた時だけ本文が載る（skill の body 等）
 *   deferred         : 名前だけ載り、スキーマ本文は要求時（MCP tool 等）
 *   never            : 発見されないので載らない
 */
export type LoadMode = 'always' | 'path_conditional' | 'on_demand' | 'deferred' | 'never' | 'unknown';

/**
 * どう結合するか（注入の機構）。同じファイルが同じ runtime に別の機構で 2 回入るのは別の結合。
 *   rule_autoload         : rules/*.md の自動ロード
 *   instruction_concat    : CLAUDE.md / AGENTS.md の連結
 *   memory_autoload       : auto memory（MEMORY.md）
 *   append_system_prompt  : 起動スクリプト等の --append-system-prompt "$(cat …)"
 *   skill_description     : skill の description が起動時に載り、本文は要求時
 *   agent_def             : agent 定義（呼ばれた時に本文）
 *   hook_registration     : settings / hooks.json への登録
 *   mcp_config            : MCP server 設定
 *   output_style          : output-styles
 *   plugin_manifest       : plugin の有効・無効宣言
 *   settings_file         : 設定ファイルそのもの（context には載らない）
 *   exec_policy           : 実行許可ポリシー（コマンド一致時に評価。prompt には載らない）
 *   launcher              : 起動スクリプトそのもの（context には載らない）
 */
export type Mechanism =
  | 'rule_autoload'
  | 'instruction_concat'
  | 'memory_autoload'
  | 'append_system_prompt'
  | 'skill_description'
  | 'agent_def'
  | 'hook_registration'
  | 'mcp_config'
  | 'output_style'
  | 'plugin_manifest'
  | 'settings_file'
  | 'exec_policy'
  | 'launcher';

/**
 * 結合を作った主体（型付き provenance）。文字列 1 本にしない。
 *   discovery : runtime 自身の探索（search_path の走査）
 *   resource  : 収集済み Resource の中の宣言（locator = その中の位置。#hooks.PreToolUse[1].hooks[0] / :42 等）
 *   external  : まだ Resource 化していない外部要因（パス + locator）
 */
export type SourceRef =
  | { type: 'discovery'; search_path: string }
  | { type: 'resource'; resource_id: string; resource_path: string; locator: string | null }
  | { type: 'external'; ref: string; locator: string | null };

/** 誰に効くか。SubagentStart の継承有無を表現する */
export type AppliesTo = 'session' | 'subagent';

/**
 * 「この runtime からどう見えるか」。runtime バージョンごとに再計算される。
 *
 * ⚠ 一意キーは (runtime, resource_path, mechanism, source_ref の位置) = binding_id。
 *   - resource_path が要る: 同じファイルが同じ runtime に別の機構で 2 回入る
 *     （実測: rules/ の自動ロード + 起動スクリプトの --append-system-prompt。2026-09-07 Codex レビュー）
 *   - mechanism まででも足りない: 同じ hook script が別の event / 設定位置から登録される → source_ref
 *   - content hash は**入れない**: 容器ファイルの内容が変わるだけで結合が別物になり、history が
 *     「消えて増えた」と誤る（2026-09-07 実測で 46+46 件の偽イベント）。内容は resource_changed で追う
 */
export interface Binding {
  /**
   * sha256(runtime | resource_path | mechanism | source_ref の位置)。一意キーの導出値。
   * **content hash は入れない**。内容が変わっても結合の同一性は保たれる（内容の変化は Resource 側で追う）。
   */
  binding_id: string;
  resource_id: string;
  /** この Binding が対象にしている実体のパス。同一内容が複数パスに在る場合の区別に必須 */
  resource_path: string;
  runtime: RuntimeId;
  runtime_version: string | null;
  /** どう結合するか。discovered=false でも「本来この機構で結合されるはずだった」機構を入れる */
  mechanism: Mechanism;
  /** 結合を作った主体。必須 */
  source_ref: SourceRef;
  /** discovery 規則を通ったか */
  discovered: boolean;
  /** どの規則で判定したか。規則が変わった時に過去の判定を検証できるよう必須 */
  rule_id: string;
  /** 規則の出典（docs:skills.md#... / measured:2026-09-07 等） */
  rule_source: string;
  confidence: Confidence;
  load_mode: LoadMode;
  /** paths glob 等。null = 無条件 */
  scope_condition: string[] | null;
  applies_to: AppliesTo[];
  search_path: string | null;
  /** 同名衝突時の優先度。小さいほど強い */
  precedence: number | null;
}

// ──────────────────────── Observation ────────────────────────

/** Phase 0 で作るのはこの 3 種だけ。token 換算は作らない（chars/4 禁止） */
export type ObservationKind = 'invocation' | 'size' | 'mtime' | 'token_cost' | 'context_present';

/**
 * 測定方法 = 証拠の等級。**必須**。
 * 同じ量でも method が違えば別の Observation として並存する。
 */
export type ObservationMethod =
  | 'filesystem'
  | 'usage_record'
  /** セッション記録（Claude transcript / Codex rollout）の構造レコードを読んだもの。本文は保持しない */
  | 'transcript_scan'
  /** 起動中プロセスの argv（`ps`）。起動スクリプトが実際に注入した本文の指紋 */
  | 'process_argv'
  | 'tiktoken'
  | 'official_skill_doctor'
  | 'probe_debug_log'
  | 'probe_self_report';

/**
 * どの状態を観測したか。**必須**。
 *   next_session   : 次回起動時の effective state（静的解析）
 *   active_runtime : 今動いているセッションの実測（セッション記録 / argv。Phase 1）
 * この区別を落とすと「直したのにまだ残っている」の誤診になる。
 */
export type ObservationScope = 'next_session' | 'active_runtime';

/**
 * 「実際にどうだったか」。追記のみ、上書きしない。
 * 一意キーは (resource_id, resource_path, runtime, kind, method, scope, session_id)。
 * runtime=null なら runtime を除く。session_id は active_runtime の観測を session ごとに並存させるために必須
 * （同じ skill が session A には在り B には無い、を両方持てる）。
 */
export interface Observation {
  resource_id: string;
  /** 測定対象の実体パス。Binding と同じ理由で必須 */
  resource_path: string;
  /**
   * どの runtime の文脈での観測か。
   * null = runtime 非依存（ファイルサイズや mtime は filesystem の事実で、runtime の観測ではない）。
   * 両 adapter が同じパスを収集しても、runtime 非依存の観測は 1 件に集約される。
   */
  runtime: RuntimeId | null;
  kind: ObservationKind;
  value: number | string | boolean | null;
  unit: string | null;
  measured_at: string;
  /** 証拠の等級。必須 */
  method: ObservationMethod;
  confidence: Confidence;
  scope: ObservationScope;
  /**
   * どのセッションの観測か。null = セッションに属さない（静的解析 / filesystem の事実）。
   * scope='active_runtime' の Observation は必ず session_id か process_ref を持つ。
   */
  session_id?: string | null;
  /** プロセス由来の観測の帰属（`pid:<n>@<started_at>`）。argv 観測で使う */
  process_ref?: string | null;
  /** 測定に使った道具とその版。再現性のために持つ */
  tool: string;
  tool_version: string;
  /** 測定元のファイル・キー（例: ~/.claude.json#skillUsage.finish） */
  source_ref?: string;
}

// ────────────────────────── Snapshot ──────────────────────────

export interface RuntimeInfo {
  runtime: RuntimeId;
  version: string | null;
  /** 設定の home（CLAUDE_CONFIG_DIR / CODEX_HOME を尊重） */
  config_home: string;
  present: boolean;
}

export interface SnapshotEnv {
  os: string;
  project: string | null;
  /** 収集時の HOME。fixture 実行時は差し替わる */
  home: string;
  /** 明示された起動スクリプト。Phase 0 は明示分だけ収集する（全域探索はしない） */
  launchers: string[];
}

/** 何を収集していて何を収集していないか。レポートと README に同じ内容を出す（診断できるふりをしない） */
export interface Coverage {
  phase: string;
  collected: string[];
  not_collected: string[];
}

/**
 * 起動中（または記録の残っている）セッション 1 本。**Resource ではない**（ファイルではない）。
 * runtimes と同じ「環境がどういう状態か」の層に置く。capability の有無は Observation 側に session_id 付きで入る。
 */
export interface SessionInfo {
  session_id: string;
  runtime: RuntimeId;
  /** 記録ファイルのパス。証拠として path だけ持つ（本文は保持しない） */
  record_path: string;
  started_at: string | null;
  last_activity_at: string;
  /** 記録が最近更新されている = live。**heuristic**（プロセスとの紐付けはできていない） */
  live: boolean;
  runtime_version: string | null;
  cwd: string | null;
  git_branch: string | null;
  entrypoint: string | null;
  /** Doctor 自身が動いているセッションか。true なら食い違いは正常 */
  is_self: boolean;
  /** サブエージェント（sidechain）由来か */
  is_sidechain: boolean;
  /** 観測できた capability の種別（skills / agents / deferred_tools / mcp_instructions）。
   *  ここに無い種別は「記録が無い」= 観測できていない。「無かった」ではない */
  observed_capability_kinds: string[];
  /**
   * セッションが起動時に与えられた capability の名前の集合。null = その種別の記録が無い（観測できていない）。
   * ここは Observation にできない: 名前が今の設定のどの Resource にも対応しないこと自体が症状（= 消したのに残っている）で、
   * Observation は resource_id を要求するため表現できない。だからセッションの生の記録としてここに置く。
   */
  capabilities: {
    skills: string[] | null;
    agents: string[] | null;
    deferred_tools: string[] | null;
    mcp_instructions: string[] | null;
    failed_mcp_servers: string[] | null;
  };
  /** capability 集合が startup（isInitial）の記録から取れたか。false なら capabilities を信用しない */
  capabilities_from_startup: boolean;
  /** 起動後に現れた絞り込み一覧の回数（集合の変更ではない。§probe/transcript.ts 参照） */
  non_initial_listings: number;
  /**
   * capability 集合を設定と比較してよいか。false ならその理由。
   * 実測: entrypoint=sdk-py 等のセッションは --setting-sources= や --disallowedTools で capability を
   * 絞って起動されるため、設定との差は仕様であって症状ではない。Codex は capability 記録が無いので常に false。
   */
  comparable_capabilities: boolean;
  /**
   * 開始時刻と資源の mtime を比較してよいか。capability 記録が無い runtime でも成立する。
   * 対話セッションで、まだ動いていて、自分自身でなければ true。
   */
  comparable_timestamps: boolean;
  /** 比較しなかった理由（両方 false の時に使う。片方だけなら該当する側の理由） */
  not_comparable_reason: string | null;
  /** 起動時に載った命令本文の指紋（Codex のみ。Claude の transcript には本文が無い） */
  instruction_digest: { bytes: number; sha256: string } | null;
}

/** 起動中プロセス 1 つ。argv の本文は保持せず指紋だけ */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  started_at: string | null;
  runtime: RuntimeId;
  flags: string[];
  /** argv 末尾は開いている（後続フラグが混ざりうる）ので、指紋の一致だけで断定しない */
  appended_system_prompt: { bytes: number; sha256: string; tail_is_open_ended: true } | null;
  config_paths: string[];
  argv_bytes: number;
}

// ────────────────────── Host / Runtime Signals v0.1 ──────────────────────
// #69 (Third-party Diagnostic Dogfood) で「重い/遅い/セッションが変」に対して
// Agent 設定以外の原因候補も切り分けたいという要求から追加。
// 全て --probe の時だけ埋まる（active_runtime と同じ扱い）。数値だけから Finding は作らない。
// 「取れなかった」は AccessStatus で表現し、0 にしない。

/** MCP server 1 本の接続状況。claude-code の transcript delta から観測できる分だけ（v0.1） */
export interface McpServerStatus {
  mcp_server: string;
  /** connected/failed が両方観測されていれば intermittent */
  status: 'connected' | 'failed' | 'intermittent';
  observed_at: string;
  /** v0.1 では常に null。この観測方法では「独立した接続試行の回数」までは分からない */
  connection_attempts: number | null;
  /** failedMcpServers に載った回数。再送・キャッシュされた同一失敗の再掲を含みうる（下記 note） */
  failures: number;
  /** 直近の失敗時に記録されていたエラー文（runtime 自身が出す定型文。最大 200 文字、redaction は通す） */
  last_error_kind: string | null;
  /** v0.1 では常に null。接続待ち時間はこの観測方法に記録が無い */
  latency_ms: number | null;
  latency_method: string | null;
  session_ids: string[];
  runtime: RuntimeId;
  method: 'transcript_scan';
  note: string;
}

/** provider から返ってきた API エラー（429 等）を transcript から観測したもの。新規リクエストは投げない */
export interface RateLimitEvidence {
  provider: 'anthropic';
  /** rate_limit=429 / overloaded / other_api_error（400 のプロンプト長超過等）/ network_or_unknown */
  kind: 'rate_limit' | 'overloaded' | 'other_api_error' | 'network_or_unknown';
  status_code: number | null;
  count: number;
  first_observed_at: string;
  last_observed_at: string;
  session_ids: string[];
  runtime: RuntimeId;
  method: 'transcript_scan';
  /** v0.1 では常に null。retry-after はこの観測方法に記録が無い */
  retry_after_ms: null;
}

/** pid ↔ session_id の対応。高確度で結べる時だけ mapped、それ以外は unmapped/ambiguous のまま残す */
export interface ProcessSessionMapping {
  pid: number;
  runtime: RuntimeId;
  session_id: string | null;
  started_at: string | null;
  /** argv の指紋（--append-system-prompt の hash、無ければ flags+bytes から作った簡易指紋） */
  argv_fingerprint: string | null;
  /** mapped の時だけ、対応した session の cwd */
  cwd: string | null;
  status: 'mapped' | 'unmapped' | 'ambiguous';
  confidence: Confidence | null;
  /** ambiguous の時、候補になった session_id 全部 */
  candidate_session_ids: string[];
  evidence: string;
}

export interface ProcessSessionMap {
  observed_at: string;
  entries: ProcessSessionMapping[];
  /** live（heuristic）なのに対応する process が 1 つも見つからなかった session_id。
   *  「記録は残ってるがprocessは居ない」と「本当にまだ動いている」を分けるための核 */
  live_sessions_without_process: string[];
  note: string;
}

/** システム全体の 1 項目分。取れなければ 0 でなく status で言う */
export interface HostMetric {
  status: AccessStatus;
  method: string | null;
  reason: string | null;
}
export interface HostLoad extends HostMetric {
  load1: number | null;
  load5: number | null;
  load15: number | null;
}
export interface HostMemory extends HostMetric {
  total_bytes: number | null;
  used_bytes: number | null;
  available_bytes: number | null;
}
export interface HostSwap extends HostMetric {
  total_bytes: number | null;
  used_bytes: number | null;
}
/** agent runtime 1 プロセスぶんの実測。取れなければ status で言う（0 にしない） */
export interface HostProcessUsage {
  pid: number;
  runtime: RuntimeId;
  cpu_percent: number | null;
  rss_bytes: number | null;
  status: AccessStatus;
  method: string | null;
}
export interface HostResources {
  observed_at: string;
  /** process.platform の生値（darwin / linux / win32 …）。cross-platform = 同じ値を取ることではない */
  platform: string;
  load: HostLoad;
  memory: HostMemory;
  swap: HostSwap;
  processes: HostProcessUsage[];
}

/** その時点の環境。diff は同一 schema_version 間でのみ行う */
export interface Snapshot {
  snapshot_id: string;
  /**
   * 違う版どうしは「比較不能」として落とす。黙って壊れた差分を出さない。
   *   2 = Binding に mechanism / source_ref / binding_id（2026-09-07）
   *   3 = sessions / processes（active_runtime の観測）、Observation に session_id / process_ref（2026-09-07）
   *   4 = binding_id の導出から content hash を外した。位置だけが結合の同一性（2026-09-07）
   */
  schema_version: 4;
  tool_version: string;
  runtimes: RuntimeInfo[];
  env: SnapshotEnv;
  coverage: Coverage;
  resources: Resource[];
  bindings: Binding[];
  observations: Observation[];
  /** active_runtime を観測した時だけ埋まる。空配列 = 観測していない（--probe 無し） */
  sessions: SessionInfo[];
  processes: ProcessInfo[];
  /** active_runtime の観測方法とその限界。レポートにそのまま出す */
  probe_notes: string[];
  /**
   * 見に行った結果そのもの（読めた / 無かった / 権限が無い / 失敗した / 対象外）。
   * **「取れなかった」を 0 件として出さないための記録。** 省略可（この版より前の snapshot には無い）。
   * 無い場合は「記録していない」であって「失敗が無かった」ではない。
   */
  access?: AccessRecord[];
  /**
   * Host / Runtime Signals v0.1（#70）。sessions/processes と同じく --probe の時だけ埋まる。省略可。
   * schema_version は上げていない: 既存の同一性規則（binding_id 等）に影響しない追加専用のフィールドだから。
   */
  mcp_status?: McpServerStatus[];
  rate_limit_events?: RateLimitEvidence[];
  process_session_map?: ProcessSessionMap;
  host?: HostResources;
}

// ─────────────────────────── Finding ───────────────────────────

/**
 * 証拠への参照。**なぜこの診断になったかを一次事実まで辿れるようにする。**
 * absence が要るのは、missing_target のように「無いこと」が根拠になる診断があるため。
 */
export type EvidenceRef =
  | { type: 'resource'; resource_id: string; path: string; line?: number }
  | { type: 'binding'; binding_id: string; resource_id: string; resource_path: string; runtime: RuntimeId; mechanism: Mechanism; rule_id: string }
  /** Observation は (resource_id, resource_path, runtime, kind, method, scope, measured_at) で一意に指す */
  | {
      type: 'observation';
      resource_id: string;
      resource_path: string;
      runtime: RuntimeId | null;
      kind: ObservationKind;
      method: ObservationMethod;
      scope: ObservationScope;
      measured_at: string;
    }
  | { type: 'reference'; resource_id: string; path: string; raw: string; line: number }
  /** 「探したが無かった」。searched に探索先を全部列挙する */
  | { type: 'absence'; target: string; searched: string[] }
  /** 対照例（これは正常、という比較対象） */
  | { type: 'contrast'; resource_id: string; path: string; note: string }
  /** 起動中セッションの状態（session 記録由来） */
  | { type: 'session'; session_id: string; runtime: RuntimeId; record_path: string; started_at: string | null; live: boolean; note: string }
  /** 起動中プロセスの argv 由来 */
  | { type: 'process'; pid: number; runtime: RuntimeId; started_at: string | null; note: string };

export type Severity = 'error' | 'warn' | 'info';

/** Phase 0 で実装するのは最初の 3 つだけ */
export type FindingId =
  | 'UNREACHABLE_REFERENCE'
  | 'CROSS_RUNTIME_DRIFT'
  | 'SCOPE_MISMATCH'
  // Phase 1
  | 'SESSION_STALENESS'
  | 'HOOK_AMPLIFICATION'
  // Phase 2
  | 'TOMBSTONE_ENTRY'
  | 'FIXED_COST_WITHOUT_USAGE'
  | 'CONTEXT_TAX'
  | 'DUPLICATE_RESOURCE'
  | 'SHARED_RESOURCE_COUPLING'
  | 'RUNTIME_FORMAT_DIVERGENCE'
  | 'PROTECTED_HEAVY'
  | 'BASELINE_REGRESSION';

export interface Finding {
  finding_id: FindingId;
  subtype?: string;
  severity: Severity;
  confidence: Confidence;
  /** 事実の記述のみ。「削除」「不要」「無駄」を書かない */
  summary: string;
  /** 主対象 */
  subject: { resource_id?: string; path?: string; name?: string; runtime?: RuntimeId; session_id?: string };
  /** 必須。空配列は許さない（根拠なき診断を出さない） */
  evidence_refs: EvidenceRef[];
  /** どの観測軸から導出されたか */
  axes: Array<'presence' | 'activation' | 'provenance' | 'temporal'>;
  /** protected に当たっているか。true なら severity を info に落とす */
  protected: boolean;
  /** 観測対象。レポート冒頭の宣言と一致させる */
  scope: ObservationScope;
  /** 種別ごとの構造化された補足（drift の両側、条件文の行、参照の状態など）。LLM 向け report の材料 */
  detail?: Record<string, unknown>;
}

// ─────────────────────── Report ───────────────────────

/** レポート。scope の宣言を必ず持つ（Phase 0 から必須） */
export interface Report {
  tool_version: string;
  generated_at: string;
  /** 何を観測したレポートか。next_session = 静的、active_runtime = probe */
  report_scope: ObservationScope;
  snapshot: Snapshot;
  findings: Finding[];
  /** 「数が大きいが Finding にしなかったもの」。Doctor が Optimizer でないことを毎回示す */
  suppressed: Array<{ reason: string; detail: string; count?: number }>;
  /** protected glob に当たった資源（提案しない） */
  protected: Array<{ path: string; size_bytes: number; glob: string }>;
  /** 判定に必要な入力が無くて評価しなかったもの（できるふりをしない） */
  skipped: Array<{ detector: string; reason: string }>;
  /** 何を見ていて何を見ていないか */
  coverage: Coverage;
}
