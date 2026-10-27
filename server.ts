/**
 * bb-plugin-radar — backend entry.
 *
 * A live view of the PR/issue queues that need you. Each "lane"
 * is a saved query over one or more hosts: a Delta repo (`dt api search/issues`, the
 * primary host for repos that left GitHub, e.g. shop/world), GitHub (`gh api graphql`
 * search) and, only when turned on as read-only history, a Gitstream repo
 * (`gs api repos/<repo>/pulls`; Gitstream no longer accepts PR writes). The server polls every lane on an interval, keeps
 * only the latest result in memory, and pushes a realtime signal so the panel
 * re-reads it. Persisted state is small configuration in plugin kv (lanes, focus,
 * seen keys, review links) plus the plugin database for anything that can grow:
 * the label index, hidden items, mention tracking and the last results.
 *
 * "Track something" sends a natural-language description to an OpenAI-compatible
 * endpoint (set in settings), which drafts a lane; the panel previews its live results before you
 * add it.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MentionTracker, mentionStoreSchema, createMentionStore, type MentionStore } from "./mentions";

import { aiBackend, aiDetail, aiOverrideSchema, complete, fallbackBaseUrl, type AiFallback, type AiOverride } from "./ai";
import {
  applyFilter,
  findSection,
  threadsToSection,
  DEFAULT_LANES,
  missingDefaults,
  draftPrompt,
  fromGithubNode,
  GITHUB_SEARCH_GRAPHQL,
  githubSearchQuery,
  withWindow,
  DEFAULT_MAX_AGE_DAYS,
  maxAgeDays,
  deltaArgs,
  deltaQuery,
  fromDelta,
  SOURCE_LABEL,
  type Source,
  fromGitstream,
  gitstreamArgs,
  laneSchema,
  lanesSchema,
  MAX_LANES,
  parseDraft,
  slugify,
  type Item,
  type Lane,
  classifyToolError,
  principalFallbackEmail,
  laneQueryKey,
  markNew,
  remoteRepo,
  reviewPrompt,
  reviewTitle,
  CATEGORIES,
  itemInView,
  laneInView,
  requestedCategory,
  type View,
} from "./lanes";
import { enabledSources } from "./lanes";
import { hosts, hostsSchema, readHosts, setHosts } from "./hosts";
import {
  addHidden,
  entryFor,
  hiddenEntrySchema,
  hiddenSet,
  HIDDEN_STALE_DAYS,
  KEY_PATTERN,
  normKey,
  parseHidden,
  parseItemRef,
  reconcileHidden,
  removeHidden,
  resolveItemKey,
  withoutHidden,
  type HiddenEntry,
} from "./hidden";
import { actionFor, DEFAULT_SKILL_SETTINGS, hostSkillFor, selectedSkills, withSkillMention } from "./review-skills";
import {
  applyScopeOp,
  catalogKeys,
  describeScope,
  effectiveScope,
  EMPTY_SCOPE,
  FOCUS_OFF,
  focusPrompt,
  focusStateSchema,
  heuristicFocus,
  isActive,
  parseFocusReply,
  type FocusState,
  itemAreas,
  resolveScope,
  scopeCatalog,
  scopeFilterSchema,
  scopePredicate,
  type ScopeEntry,
  type ScopeFilter,
  type ScopeOp,
} from "./scope";
import {
  classifyRebaseFailure,
  githubCompareArgs,
  githubPrArgs,
  githubRebaseArgs,
  deltaMeArgs,
  deltaPrArgs,
  deltaPrincipal,
  captureFailure,
  gitDeleteRefArgs,
  gitFetchArgs,
  gitListRadarRefsArgs,
  staleRadarRefs,
  gitIsAncestorArgs,
  gitMergesArgs,
  gitOriginArgs,
  gitPushArgs,
  gitPushUrlsArgs,
  gitReplayArgs,
  gitRevParseArgs,
  originMatches,
  pushUrlsMatch,
  radarRefs,
  replayedHead,
  parseRebaseTarget,
  REBASE_SOURCES,
  REPO_PATTERN,
  verifyGithubPr,
  verifyDeltaPr,
  type RebaseResult,
  type RebaseTarget,
} from "./rebase";
import {
  compareTs,
  extractSummary,
  MAX_SUMMARY,
  MAX_THREADS_PER_ISSUE,
  mcpTool,
  parseSearchResults,
  parseSummaryReply,
  parseThreadJson,
  renderComment,
  searchArguments,
  SlackAuthError,
  SlackRateLimited,
  SUMMARY_SYSTEM,
  summaryPrompt,
  unwrapText,
  type SlackSource,
} from "./slack-context";

const run = promisify(execFile);

const CHANGED = "radar-changed";
const TOOL_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const LANE_CONCURRENCY = 3;
const CLI_ROW_LIMIT = 80;
/** markSeen keeps up to this many lane-limits of seen keys that are not in the current result. */
const SEEN_CARRY_FACTOR = 4;
/** Lane and focus descriptions: the same cap as the RPCs and the stored schemas. */
const MAX_DESCRIPTION = 600;
const DESCRIPTION_TOO_LONG = `Keep the description under ${MAX_DESCRIPTION} characters.`;

/** The bb server may start with a GUI-app PATH; add the usual dev toolchain dirs. */
const EXTRA_PATH = [
  `${homedir()}/.local/state/tec/toolchain/base_profile/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/dev/bin",
];
const toolEnv = {
  ...process.env,
  PATH: [process.env.PATH ?? "", ...EXTRA_PATH].filter(Boolean).join(":"),
  GH_PROMPT_DISABLED: "1",
  NO_COLOR: "1",
};

class UserError extends Error {}
/** A tool run cancelled by plugin shutdown; callers handle it like any UserError, logging skips it. */
class ToolAborted extends UserError {
  constructor(label: string) {
    super(`${label}: cancelled`);
  }
}

// ---------------------------------------------------------------------------
// RPC contract (types shared with app.tsx)
// ---------------------------------------------------------------------------

const itemSchema = z.object({
  key: z.string(),
  source: z.enum(["gitstream", "delta", "github"]),
  kind: z.enum(["pr", "issue"]),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  draft: z.boolean(),
  state: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  isNew: z.boolean(),
  canAcknowledge: z.boolean().optional(),
});

const laneResultSchema = z.object({
  laneId: z.string(),
  items: z.array(itemSchema),
  /** Rows the provider returned before client-side filters. */
  fetched: z.number(),
  error: z.string(),
  fetchedAt: z.string(),
  loading: z.boolean(),
});

const resultsCacheSchema = z.object({
  fetchedAt: z.string(),
  lanes: z.record(z.string(), z.object({ queryKey: z.string(), result: laneResultSchema })),
});

const snapshotSchema = z.object({
  lanes: z.array(z.any()),
  results: z.record(z.string(), laneResultSchema),
  fetchedAt: z.string(),
  refreshing: z.boolean(),
  githubLogin: z.string(),
  /** Your Delta principal (email); "" until known. */
  deltaLogin: z.string(),
  /** Whether Rebase is offered on Delta (a rebase checkout is configured). */
  deltaRebase: z.boolean(),
  /** Item key → bb thread started from Radar for it. */
  reviews: z.record(z.string(), z.object({ threadId: z.string(), at: z.string() })),
  ai: z.object({ available: z.boolean(), model: z.string(), detail: z.string() }),
  /** Focus filter in effect (empty while Focus is off), applied to every lane, view and the rail badge. */
  scope: scopeFilterSchema,
  /** Focus mode: the described focus, kept while off so it can be resumed. */
  focus: focusStateSchema,
  /** Host skills Radar threads invoke, so rows can name them before a thread starts. */
  /** The "Max age" setting in days (0 = no limit), for the lane editor's hint. */
  maxAgeDays: z.number(),
  /** Configured Delta / Gitstream-history hosts and area repo; the panel mirrors them. */
  hosts: hostsSchema,
  skills: z.object({ reviewSkill: z.string(), gitstreamReviewSkill: z.string(), triageSkill: z.string() }),
  /** Items hidden one by one (radar_hidden_items lists them); already removed from `results`. */
  hiddenCount: z.number(),
  /** Slack context: drafts waiting for your approval, by item key. */
  slack: z.object({
    enabled: z.boolean(),
    error: z.string(),
    sweptAt: z.string(),
    drafts: z.record(z.string(), z.object({ at: z.string(), threads: z.number() })),
  }),
});

export type RadarItem = z.infer<typeof itemSchema>;
export type ReviewContext = { title: string; prompt: string; defaultProjectId: string | null };
export type LaneResult = z.infer<typeof laneResultSchema>;
export type RadarSnapshot = Omit<z.infer<typeof snapshotSchema>, "lanes"> & { lanes: Lane[] };
export type { FocusState, HiddenEntry, Lane, RebaseResult, ScopeEntry, ScopeFilter };
export type SlackDraftView = {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The AI's proposed summary; you can edit it before posting. */
  summary: string;
  /** The summary in the comment on the issue now ("" if Radar has not posted one). */
  current: string;
  sources: SlackSource[];
  at: string;
};

export const rpcContract = defineRpcContract({
  radar_snapshot: { input: z.null(), output: z.any() },
  radar_ai_get: { input: z.null(), output: aiOverrideSchema },
  radar_ai_set: { input: aiOverrideSchema, output: aiOverrideSchema },
  radar_refresh: { input: z.object({ laneId: z.string().optional() }).nullable(), output: z.any() },
  radar_lane_upsert: { input: z.object({ lane: z.any() }), output: z.any() },
  radar_lane_delete: { input: z.object({ laneId: z.string() }), output: z.any() },
  radar_lanes_reorder: { input: z.object({ ids: z.array(z.string()) }), output: z.any() },
  radar_lanes_reset: { input: z.null(), output: z.any() },
  radar_acknowledge: { input: z.object({ key: z.string().min(1).max(300) }), output: z.any() },
  /** Hides one item (by key) from every lane, view, count and the badge, until unhidden. */
  radar_hide_item: { input: z.object({ key: z.string().max(260).regex(KEY_PATTERN) }), output: z.any() },
  /** Unhides one item, or every hidden item with `all: true`. */
  radar_unhide_item: {
    input: z.union([
      z.object({ key: z.string().max(260).regex(KEY_PATTERN) }).strict(),
      z.object({ all: z.literal(true) }).strict(),
    ]),
    output: z.any(),
  },
  /** Hidden items, newest first, for the restore list. */
  radar_hidden_items: { input: z.null(), output: z.array(hiddenEntrySchema) },
  radar_mark_seen: {
    /** `view` limits it to what that view shows; `kind` is the pre-category form (pr = prs, issue = issues). */
    input: z.object({ laneId: z.string().optional(), view: z.enum(CATEGORIES).optional(), kind: z.enum(["pr", "issue"]).optional() }),
    output: z.any(),
  },
  /** Seeds bb's new-thread composer for reviewing one item. */
  radar_review_context: { input: z.object({ key: z.string() }), output: z.any() },
  /** Spawns the review thread from the composer's resolved request. */
  radar_review_start: {
    input: z.object({ key: z.string(), request: z.record(z.string(), z.unknown()) }),
    output: z.object({ threadId: z.string() }),
  },
  /** Edits the focus filter: focus (replace), add-focus, hide, show, clear. */
  radar_scope: {
    input: z.object({ op: z.enum(["focus", "add-focus", "hide", "show", "clear"]), keys: z.array(z.string().max(200)).max(60) }),
    output: z.any(),
  },
  /** Turns a plain-English focus ("no billing stuff") into the filter and turns Focus on. */
  radar_focus_describe: { input: z.object({ description: z.string().trim().min(2).max(600) }), output: z.any() },
  /** Turns Focus off (board back to normal) or resumes the last focus. */
  radar_focus_set: { input: z.object({ enabled: z.boolean() }), output: z.any() },
  radar_draft: {
    input: z.object({ description: z.string().min(3).max(600) }),
    output: z.any(),
  },
  /** Server-side rebase of one of your open PRs; authorship and state are re-checked on the host. */
  /** The pending Slack-context draft for one GitHub issue. */
  radar_slack_draft: { input: z.object({ key: z.string().min(1).max(300) }), output: z.any() },
  /** Posts (or edits Radar's existing) Slack-context comment with your approved summary. */
  radar_slack_publish: {
    input: z.object({ key: z.string().min(1).max(300), summary: z.string().trim().min(1).max(MAX_SUMMARY) }),
    output: z.object({ url: z.string() }),
  },
  /** Drops the draft and marks the threads read, so only newer Slack messages draft again. */
  radar_slack_dismiss: { input: z.object({ key: z.string().min(1).max(300) }), output: z.any() },
  /** Checks one issue against Slack now instead of waiting for its turn. */
  radar_slack_check: { input: z.object({ key: z.string().min(1).max(300) }), output: z.any() },
  radar_rebase: {
    input: z.object({
      source: z.enum(["github", "gitstream", "delta"]),
      repo: z.string().max(200).regex(REPO_PATTERN),
      number: z.number().int().positive().max(1e9),
    }),
    output: z.object({ status: z.enum(["rebased", "up-to-date"]), message: z.string(), headSha: z.string() }),
  },
});

export type DraftResult = { lane: Lane; preview: LaneResult };

// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    refreshSeconds: {
      type: "number",
      label: "Refresh & retention · Refresh interval in seconds (min 30)",
      default: 90,
      experimental_schema: z.number().finite().min(30),
    },
    maxAgeDays: {
      type: "number",
      label: "Refresh & retention · Maximum age in days (0 = no limit)",
      description: "Hide items not updated within this many days in every lane.",
      default: DEFAULT_MAX_AGE_DAYS,
      experimental_schema: z.number().finite().int().min(0).max(3650),
    },
    ghPath: { type: "string", label: "Sources · GitHub CLI executable", default: "gh" },
    deltaHost: { type: "string", label: "Sources · Delta host name (e.g. delta.example.com)", default: "" },
    deltaRepo: { type: "string", label: "Sources · Delta repo, owner/name (empty = off)", default: "" },
    deltaLabel: { type: "string", label: "Sources · Name shown for Delta", default: "Delta" },
    dtPath: { type: "string", label: "Sources · Delta CLI executable", default: "dt" },
    deltaCheckout: {
      type: "string",
      label: "Sources · Delta checkout for Rebase (absolute path; origin must be Delta; empty = no Rebase on Delta)",
      description: "Radar fetches into private refs/radar/* refs and uses git replay, so the checkout's worktree, branches and origin/* are untouched. Only the rebased PR branch is force-pushed, with a lease.",
      default: "",
    },
    gitstreamHistory: {
      type: "boolean",
      label: "Sources · Show Gitstream PRs as read-only history",
      description: "Off by default; Gitstream no longer accepts PR writes. When on, lanes that include Gitstream also list old Gitstream PRs; Radar never writes to Gitstream.",
      default: false,
    },
    gitstreamRepo: { type: "string", label: "Sources · Gitstream history repo, owner/name", default: "" },
    gitstreamWebUrl: { type: "string", label: "Sources · Gitstream history web URL (https origin)", default: "" },
    gitstreamLabel: { type: "string", label: "Sources · Name shown for Gitstream history (\"history\" is appended)", default: "Gitstream" },
    gsPath: { type: "string", label: "Sources · Gitstream CLI executable (history only)", default: "gs" },
    areaRepo: {
      type: "string",
      label: "AI & focus · Area monorepo, owner/name (empty = none)",
      description: "Its //path labels become Focus areas.",
      default: "",
    },
    aiBaseUrl: {
      type: "string",
      label: "AI & focus · Fallback endpoint, OpenAI-compatible https URL (empty = none)",
      description: "Used only when this BB host has no configured-provider completion (experimental_ai). Receives the key below; /v1/chat/completions is appended.",
      default: "",
    },
    aiKeyEnv: {
      type: "string",
      label: "AI & focus · Fallback key environment variable",
      default: "",
    },
    aiModel: {
      type: "string",
      label: "AI & focus · Fallback model",
      default: "",
    },
    draftNotes: {
      type: "string",
      label: "AI & focus · Lane drafting notes (optional)",
      description: "Describe your repos, teams and labels in plain words.",
      default: "",
    },
    reviewSection: {
      type: "string",
      label: "Review workflows · Thread section (created if missing; empty = none)",
      default: "Reviews",
    },
    reviewSkill: {
      type: "string",
      label: "Review workflows · GitHub / Delta review skill (empty = none)",
      default: DEFAULT_SKILL_SETTINGS.reviewSkill,
    },
    gitstreamReviewSkill: {
      type: "string",
      label: "Review workflows · Gitstream history review skill (empty = none)",
      default: DEFAULT_SKILL_SETTINGS.gitstreamReviewSkill,
    },
    triageSkill: {
      type: "string",
      label: "Review workflows · Issue triage skill (empty = none)",
      default: DEFAULT_SKILL_SETTINGS.triageSkill,
    },
    slackMcpUrl: {
      type: "string",
      label: "Slack context · Slack MCP endpoint, https URL (empty = off)",
      description:
        "Radar searches public Slack channels for messages that link your GitHub issues, follows their threads and drafts a short \"Slack context\" comment. Nothing is posted until you approve it; Radar then edits its one comment in place.",
      default: "",
    },
    slackTokenCommand: {
      type: "string",
      label: "Slack context · Command that prints the endpoint's bearer token",
      description: "Run on the bb host without a shell; the last line it prints is the token. Re-run when the token expires.",
      default: "",
    },
    slackSweepMinutes: {
      type: "number",
      label: "Slack context · Minutes between Slack sweeps (min 10)",
      description: "Each sweep checks a few issues, least recently checked first, to stay inside Slack's rate limits.",
      default: 30,
      experimental_schema: z.number().finite().min(10).max(1440),
    },
  });
  type Config = {
    refreshSeconds: number;
    maxAgeDays: number;
    gitstreamHistory: boolean;
    deltaCheckout: string;
    gitstreamRepo: string;
    gitstreamWebUrl: string;
    gitstreamLabel: string;
    deltaHost: string;
    deltaRepo: string;
    deltaLabel: string;
    areaRepo: string;
    draftNotes: string;
    aiBaseUrl: string;
    aiKeyEnv: string;
    aiModel: string;
    gsPath: string;
    ghPath: string;
    dtPath: string;
    reviewSection: string;
    reviewSkill: string;
    gitstreamReviewSkill: string;
    triageSkill: string;
    slackMcpUrl: string;
    slackTokenCommand: string;
    slackSweepMinutes: number;
  };
  const readConfig = (values: Config): Config => ({
    refreshSeconds: Number.isFinite(values.refreshSeconds) ? Math.max(30, values.refreshSeconds) : 90,
    maxAgeDays: values.maxAgeDays === undefined ? DEFAULT_MAX_AGE_DAYS : maxAgeDays(values.maxAgeDays),
    gitstreamHistory: values.gitstreamHistory === true,
    deltaCheckout: checkoutPath(values.deltaCheckout ?? ""),
    gitstreamRepo: values.gitstreamRepo ?? "",
    gitstreamWebUrl: values.gitstreamWebUrl ?? "",
    gitstreamLabel: values.gitstreamLabel ?? "",
    deltaHost: values.deltaHost ?? "",
    deltaRepo: values.deltaRepo ?? "",
    deltaLabel: values.deltaLabel ?? "",
    areaRepo: values.areaRepo ?? "",
    draftNotes: (values.draftNotes ?? "").trim(),
    aiBaseUrl: fallbackBaseUrl(values.aiBaseUrl ?? ""),
    aiKeyEnv: (values.aiKeyEnv ?? "").trim(),
    aiModel: (values.aiModel ?? "").trim(),
    gsPath: values.gsPath.trim() || "gs",
    ghPath: values.ghPath.trim() || "gh",
    dtPath: (values.dtPath ?? "").trim() || "dt",
    reviewSection: (values.reviewSection ?? "Reviews").trim(),
    reviewSkill: (values.reviewSkill ?? DEFAULT_SKILL_SETTINGS.reviewSkill).trim(),
    gitstreamReviewSkill: (values.gitstreamReviewSkill ?? DEFAULT_SKILL_SETTINGS.gitstreamReviewSkill).trim(),
    triageSkill: (values.triageSkill ?? DEFAULT_SKILL_SETTINGS.triageSkill).trim(),
    // Same https-only rule as the AI fallback: the token is sent there.
    slackMcpUrl: fallbackBaseUrl(values.slackMcpUrl ?? ""),
    slackTokenCommand: (values.slackTokenCommand ?? "").trim(),
    slackSweepMinutes: Number.isFinite(values.slackSweepMinutes) ? Math.min(1440, Math.max(10, values.slackSweepMinutes)) : 30,
  });
  const savedAi = aiOverrideSchema.safeParse(await bb.storage.kv.get<unknown>("aiOverride"));
  let aiOverride: AiOverride = savedAi.success ? savedAi.data : null;
  /** An absolute path, `~/` expanded; anything else turns Delta rebase off. */
  function checkoutPath(value: string): string {
    const trimmed = value.trim().replace(/^~(?=\/|$)/, homedir());
    if (trimmed === "") return "";
    if (trimmed.startsWith("/") && !trimmed.includes("\0")) return trimmed;
    bb.log.warn(`deltaCheckout "${trimmed.slice(0, 80)}" is not an absolute path; Rebase on Delta is off`);
    return "";
  }
  /** Applies the host settings; malformed values switch that host off and are logged. */
  function applyHosts(values: Config): void {
    const { hosts: next, problems } = readHosts(values);
    for (const problem of problems) bb.log.warn(`${problem}; that host is off`);
    setHosts(next);
  }
  let config = readConfig(await settings.get());
  applyHosts(config);

  // Radar threads get radar-review / radar-triage on top of the radar CLI skill. Selecting
  // any skill filters this plugin's roots to the selection, so `radar` is always included.
  bb.agents.configure((context) => ({ tools: [], skills: selectedSkills(context.pluginMetadata) }));

  // Anything that can grow past kv's 256KB value cap lives in the plugin database: the label
  // index (~5k names, ~300KB), per-item hides, the mention tracker and the results cache.
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE label_index (name TEXT PRIMARY KEY) WITHOUT ROWID",
    "CREATE TABLE label_index_meta (id INTEGER PRIMARY KEY CHECK (id = 1), indexed_at TEXT NOT NULL)",
    // Per-item hides: id = lowercased item key, entry = the validated HiddenEntry as JSON.
    "CREATE TABLE hidden_items (id TEXT PRIMARY KEY, entry TEXT NOT NULL) WITHOUT ROWID",
    // Mention tracker: one row per account, one per tracked item (entry = the item's state as JSON).
    "CREATE TABLE mention_accounts (account TEXT PRIMARY KEY, scope TEXT NOT NULL, login TEXT NOT NULL, error TEXT) WITHOUT ROWID",
    "CREATE TABLE mention_items (account TEXT NOT NULL, key TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (account, key)) WITHOUT ROWID",
    // Mention candidates: key = item key, candidate = { key, repo, number, kind, updatedAt } as JSON.
    "CREATE TABLE mention_candidates (key TEXT PRIMARY KEY, candidate TEXT NOT NULL) WITHOUT ROWID",
    // Last refresh's lane results (result = LaneResult as JSON), so a restart shows what Radar knew.
    "CREATE TABLE results_cache (lane_id TEXT PRIMARY KEY, query_key TEXT NOT NULL, result TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE results_meta (id INTEGER PRIMARY KEY CHECK (id = 1), fetched_at TEXT NOT NULL)",
    // Slack context: threads that link an issue (latest_ts = newest human message seen, synced_ts =
    // newest one already summarised or dismissed), when each issue was last searched, and drafts.
    "CREATE TABLE slack_threads (issue_key TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, channel_name TEXT NOT NULL, permalink TEXT NOT NULL, latest_ts TEXT NOT NULL, synced_ts TEXT NOT NULL, PRIMARY KEY (issue_key, channel_id, thread_ts)) WITHOUT ROWID",
    "CREATE TABLE slack_issues (issue_key TEXT PRIMARY KEY, checked_at TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE slack_drafts (issue_key TEXT PRIMARY KEY, draft TEXT NOT NULL) WITHOUT ROWID",
  ]);
  const parseRow = (value: unknown): unknown => {
    try {
      return typeof value === "string" ? (JSON.parse(value) as unknown) : null;
    } catch {
      return null;
    }
  };

  // ---- persisted configuration -------------------------------------------

  async function loadLanes(): Promise<Lane[]> {
    const stored = await bb.storage.kv.get<unknown>("lanes");
    if (stored === undefined || stored === null) return DEFAULT_LANES.map((lane) => ({ ...lane }));
    const parsed = lanesSchema.safeParse(stored);
    if (parsed.success) return parsed.data;
    bb.log.warn("stored lanes were invalid; falling back to defaults");
    return DEFAULT_LANES.map((lane) => ({ ...lane }));
  }
  async function saveLanes(next: Lane[]) {
    const parsed = lanesSchema.safeParse(next);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new UserError(`Invalid lanes (${issue?.path.join(".")}: ${issue?.message})`);
    }
    lanes = parsed.data;
    await bb.storage.kv.set("lanes", lanes);
  }

  type SeenMap = Record<string, string[]>;
  let seen: SeenMap = (await bb.storage.kv.get<SeenMap>("seen")) ?? {};
  const persistSeen = () => bb.storage.kv.set("seen", seen);
  const saveMentionRows = db.transaction((store: MentionStore) => {
    db.prepare("DELETE FROM mention_items").run();
    db.prepare("DELETE FROM mention_accounts").run();
    const account = db.prepare("INSERT INTO mention_accounts (account, scope, login, error) VALUES (?, ?, ?, ?)");
    const item = db.prepare("INSERT INTO mention_items (account, key, entry) VALUES (?, ?, ?)");
    for (const [id, value] of Object.entries(store.accounts)) {
      account.run(id, value.scope, value.login, value.error);
      for (const [key, entry] of Object.entries(value.items)) item.run(id, key, JSON.stringify(entry));
    }
  });
  /** The tracker store from SQLite; an unreadable store starts over (mentions are re-scanned). */
  function loadMentionStore(): MentionStore {
    const accounts = db.prepare("SELECT account, scope, login, error FROM mention_accounts").all() as { account: string; scope: string; login: string; error: string | null }[];
    const items = db.prepare("SELECT account, key, entry FROM mention_items").all() as { account: string; key: string; entry: unknown }[];
    const store: MentionStore = createMentionStore();
    for (const row of accounts) store.accounts[row.account] = { scope: row.scope, login: row.login, error: row.error, items: {} };
    for (const row of items) {
      const account = store.accounts[row.account];
      if (account !== undefined) (account.items as Record<string, unknown>)[row.key] = parseRow(row.entry);
    }
    const parsed = mentionStoreSchema.safeParse(store);
    if (parsed.success) return parsed.data;
    bb.log.warn("stored mention state was invalid; starting over");
    saveMentionRows(createMentionStore());
    return createMentionStore();
  }
  // One-time move from kv (where it could outgrow the 256KB value cap) into SQLite.
  const kvMentions = await bb.storage.kv.get<unknown>("mentions");
  if (kvMentions !== undefined) {
    const parsed = mentionStoreSchema.safeParse(kvMentions);
    const empty = (db.prepare("SELECT COUNT(*) AS n FROM mention_accounts").get() as { n: number }).n === 0;
    if (parsed.success && empty) saveMentionRows(parsed.data);
    await bb.storage.kv.delete("mentions");
  }
  const mentions = new MentionTracker(loadMentionStore(), async (path, method = "GET") => {
    const output = await tool(config.ghPath, ["api", "--method", method, path], "GitHub notifications");
    return output.trim() ? parseJson(output, "GitHub notifications") : null;
  }, "github.com", async () => { saveMentionRows(mentions.state); });
  const persistMentions = async () => { saveMentionRows(mentions.state); };
  // Candidates last scanned: updatedAt is the item's when it was last scanned successfully ("" = due).
  const candidateSchema = z.object({ key: z.string(), repo: z.string(), number: z.number(), kind: z.enum(["pr", "issue"]), updatedAt: z.string().default("") });
  type Candidate = z.infer<typeof candidateSchema>;
  const saveCandidateRows = db.transaction((candidates: Record<string, Candidate>) => {
    db.prepare("DELETE FROM mention_candidates").run();
    const insert = db.prepare("INSERT INTO mention_candidates (key, candidate) VALUES (?, ?)");
    for (const candidate of Object.values(candidates)) insert.run(candidate.key, JSON.stringify(candidate));
  });
  function loadCandidates(): Record<string, Candidate> {
    const rows = db.prepare("SELECT key, candidate FROM mention_candidates").all() as { key: string; candidate: unknown }[];
    const out: Record<string, Candidate> = {};
    for (const row of rows) {
      const parsed = candidateSchema.safeParse(parseRow(row.candidate));
      if (parsed.success && parsed.data.key === row.key) out[row.key] = parsed.data;
    }
    return out;
  }
  const kvCandidates = await bb.storage.kv.get<unknown>("mentionCandidates");
  if (kvCandidates !== undefined) {
    const parsed = z.record(z.string(), candidateSchema).safeParse(kvCandidates);
    const empty = (db.prepare("SELECT COUNT(*) AS n FROM mention_candidates").get() as { n: number }).n === 0;
    if (parsed.success && empty) saveCandidateRows(parsed.data);
    await bb.storage.kv.delete("mentionCandidates");
  }
  let trackedMentions: Record<string, Candidate> = loadCandidates();
  const persistTracked = async () => { saveCandidateRows(trackedMentions); };
  const isMentionLane = (lane: Lane) => lane.sources.includes("github") && /(?:^|\s)mentions:@me(?:\s|$)/i.test(lane.query ?? "");
  let mentionSync: Promise<void> = Promise.resolve();
  /**
   * Candidates are exactly the GitHub items in the current Mentions-lane results: anything
   * else is pruned from the tracked list and the tracker. Only items whose updatedAt moved
   * since their last successful scan are re-scanned; every current item stays visible.
   */
  function syncMentions(): Promise<void> {
    mentionSync = mentionSync.catch(() => {}).then(async () => {
      if (!githubLogin) return;
      const mentionLanes = lanes.filter(isMentionLane);
      const current = new Map<string, RadarItem>();
      for (const lane of mentionLanes) {
        for (const item of results[lane.id]?.items ?? []) if (item.source === "github") current.set(item.key, item);
      }
      const prunedTracker = mentions.prune(new Set(current.keys()));
      const next: typeof trackedMentions = {};
      for (const [key, item] of current) {
        next[key] = { key, repo: item.repo, number: item.number, kind: item.kind, updatedAt: trackedMentions[key]?.updatedAt ?? "" };
      }
      const due = [...current.values()].filter((item) => next[item.key]!.updatedAt !== item.updatedAt);
      const trackedChanged = JSON.stringify(Object.keys(next).sort()) !== JSON.stringify(Object.keys(trackedMentions).sort());
      trackedMentions = next;
      if (current.size === 0) {
        // No Mentions lane (or nothing in it): nothing to scan, just drop what was tracked.
        if (trackedChanged) await persistTracked();
        if (prunedTracker) await persistMentions();
        if (trackedChanged || prunedTracker) publish();
        return;
      }
      const generations = new Map([...current.keys()].map(key => [key, mentions.metadata(key).generation]));
      const { scannedKeys } = await mentions.reconcile([...current.values()], githubLogin, due);
      for (const key of scannedKeys) {
        const item = current.get(key);
        if (item !== undefined && trackedMentions[key] !== undefined) trackedMentions[key]!.updatedAt = item.updatedAt;
      }
      await persistTracked();
      for (const lane of mentionLanes) {
        for (const item of results[lane.id]?.items ?? []) {
          if (item.source === "github" && (generations.get(item.key) ?? 0) > 0 && mentions.metadata(item.key).generation > (generations.get(item.key) ?? 0)) {
            seen[lane.id] = (seen[lane.id] ?? []).filter(key => key !== item.key);
            item.isNew = true;
          }
        }
      }
      await persistSeen();
      await persistMentions();
      publish();
    });
    return mentionSync;
  }

  let lanes = await loadLanes();

  const storedFocus = focusStateSchema.safeParse(await bb.storage.kv.get<unknown>("focus"));
  let focusState: FocusState = storedFocus.success ? storedFocus.data : { ...FOCUS_OFF };
  let scope: ScopeFilter = effectiveScope(focusState);
  let visible = scopePredicate(scope);

  type Reviews = Record<string, { threadId: string; at: string }>;
  let reviews: Reviews = (await bb.storage.kv.get<Reviews>("reviews")) ?? {};
  /** Repo → project last chosen in the review composer; beats remote-URL matching. */
  let reviewProjects: Record<string, string> =
    (await bb.storage.kv.get<Record<string, string>>("reviewProjects")) ?? {};

  // ---- live state ---------------------------------------------------------

  const results: Record<string, LaneResult> = {};
  let fetchedAt = "";
  // Last refresh's results, so a restart or reload shows what we knew instead of blank lanes.
  type CachedLane = { laneId: string; queryKey: string; result: LaneResult };
  const saveResultsRows = db.transaction((at: string, rows: CachedLane[]) => {
    db.prepare("DELETE FROM results_cache").run();
    const insert = db.prepare("INSERT INTO results_cache (lane_id, query_key, result) VALUES (?, ?, ?)");
    for (const row of rows) insert.run(row.laneId, row.queryKey, JSON.stringify(row.result));
    db.prepare("INSERT INTO results_meta (id, fetched_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at").run(at);
  });
  // One-time move from kv, where it outgrew the 256KB value cap at about 650 items.
  const kvResults = await bb.storage.kv.get<unknown>("resultsCache");
  if (kvResults !== undefined) {
    const parsed = resultsCacheSchema.safeParse(kvResults);
    const empty = db.prepare("SELECT 1 FROM results_meta WHERE id = 1").get() === undefined;
    if (parsed.success && empty) {
      saveResultsRows(parsed.data.fetchedAt, Object.entries(parsed.data.lanes).map(([laneId, cached]) => ({ laneId, ...cached })));
    }
    await bb.storage.kv.delete("resultsCache");
  }
  {
    const meta = db.prepare("SELECT fetched_at FROM results_meta WHERE id = 1").get() as { fetched_at: string } | undefined;
    const rows = db.prepare("SELECT lane_id, query_key, result FROM results_cache").all() as { lane_id: string; query_key: string; result: unknown }[];
    const cached = new Map(rows.map((row) => [row.lane_id, row]));
    for (const lane of lanes) {
      const row = cached.get(lane.id);
      if (row === undefined || row.query_key !== laneQueryKey(lane)) continue;
      const result = laneResultSchema.safeParse(parseRow(row.result));
      if (result.success) results[lane.id] = { ...result.data, loading: false };
    }
    if (meta !== undefined) fetchedAt = meta.fetched_at;
  }
  const persistResults = async () =>
    saveResultsRows(
      fetchedAt,
      lanes.flatMap((lane) => {
        const result = results[lane.id];
        return result === undefined || result.fetchedAt === "" ? [] : [{ laneId: lane.id, queryKey: laneQueryKey(lane), result: { ...result, loading: false } }];
      }),
    );
  let refreshing = false;
  let githubLogin = "";
  /** The user's Gitstream principal (email) as `gs` resolved it. The REST API does not resolve @me. */
  let gitstreamMe = "";
  /** The user's Delta principal (email) from `/api/v1/me`. */
  let deltaMe = "";
  /** Label names (Delta, else Gitstream history), for steering the LLM to exact spellings. Rebuilt weekly from Delta, daily from Gitstream. */
  type LabelIndex = { at: string; names: string[] };
  const putHiddenRows = db.transaction((entries: HiddenEntry[]) => {
    const upsert = db.prepare("INSERT INTO hidden_items (id, entry) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET entry = excluded.entry");
    for (const entry of entries) upsert.run(normKey(entry.key), JSON.stringify(entry));
  });
  const deleteHiddenRows = db.transaction((entries: HiddenEntry[]) => {
    const remove = db.prepare("DELETE FROM hidden_items WHERE id = ?");
    for (const entry of entries) remove.run(normKey(entry.key));
  });
  const replaceHiddenRows = db.transaction((entries: HiddenEntry[]) => {
    db.prepare("DELETE FROM hidden_items").run();
    putHiddenRows(entries);
  });
  /** Bad or duplicate rows are dropped (and the table rewritten) rather than failing the load. */
  function loadHidden(): HiddenEntry[] {
    const rows = db.prepare("SELECT entry FROM hidden_items").all() as { entry: unknown }[];
    const values = rows.map((row) => {
      try {
        return typeof row.entry === "string" ? (JSON.parse(row.entry) as unknown) : null;
      } catch {
        return null;
      }
    });
    const { entries, dropped } = parseHidden(values);
    if (dropped > 0) {
      bb.log.warn(`dropped ${dropped} invalid or excess hidden item row(s)`);
      replaceHiddenRows(entries);
    }
    return entries;
  }
  let hiddenItems: HiddenEntry[] = loadHidden();
  let hiddenKeys = hiddenSet(hiddenItems);
  const isHidden = (item: { key: string }) => hiddenKeys.has(normKey(item.key));
  function setHidden(next: HiddenEntry[]) {
    hiddenItems = next;
    hiddenKeys = hiddenSet(next);
  }
  function loadLabelIndex(): LabelIndex | null {
    const meta = db.prepare("SELECT indexed_at FROM label_index_meta WHERE id = 1").get() as { indexed_at: string } | undefined;
    if (meta === undefined) return null;
    const rows = db.prepare("SELECT name FROM label_index ORDER BY name").all() as { name: string }[];
    return { at: meta.indexed_at, names: rows.map((row) => row.name) };
  }
  const saveLabelIndex = db.transaction((index: LabelIndex) => {
    db.prepare("DELETE FROM label_index").run();
    const insert = db.prepare("INSERT OR IGNORE INTO label_index (name) VALUES (?)");
    for (const name of index.names) insert.run(name);
    db.prepare(
      "INSERT INTO label_index_meta (id, indexed_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET indexed_at = excluded.indexed_at",
    ).run(index.at);
  });
  let labelIndex: LabelIndex | null = loadLabelIndex();
  await bb.storage.kv.delete("labelIndex");
  let labelIndexing: Promise<void> | null = null;
  let disposed = false;
  let wakeSleep: (() => void) | undefined;
  let inFlight: Promise<void> | null = null;
  const controller = new AbortController();

  function aiFallback(): AiFallback {
    return { baseUrl: config.aiBaseUrl, keyEnv: config.aiKeyEnv, model: config.aiModel };
  }

  function aiState() {
    const backend = aiBackend(bb, aiFallback());
    return {
      available: backend !== null,
      model: backend === "fallback" ? config.aiModel : (aiOverride?.model ?? "BB default"),
      detail: aiDetail(bb, aiFallback()),
    };
  }

  /**
   * The board: lane results minus acknowledged mentions and items hidden one by one. The panel,
   * the badge and every CLI read (status, list, scopes, item and rebase lookups) use this view;
   * unhiding and hidden-item pruning work on the full `results`.
   */
  function boardResults(): Record<string, LaneResult> {
    return withoutHidden(Object.fromEntries(Object.entries(results).map(([id, result]) => {
      const lane = lanes.find(l => l.id === id);
      if (!lane || !isMentionLane(lane)) return [id, result];
      return [id, { ...result,
        error: [result.error, mentions.error ? `Mention sync: ${mentions.error}` : ""].filter(Boolean).join(" · "),
        items: result.items.filter(item => item.source !== "github" || mentions.metadata(item.key).generation === 0 || mentions.metadata(item.key).canAck)
          .map(item => ({ ...item, canAcknowledge: item.source === "github" && mentions.metadata(item.key).canAck })),
      }];
    })), hiddenKeys);
  }

  function snapshot(): RadarSnapshot {
    return {
      lanes,
      results: boardResults(),
      fetchedAt,
      refreshing,
      githubLogin,
      deltaLogin: deltaMe,
      deltaRebase: hosts().delta !== null && config.deltaCheckout !== "",
      reviews,
      ai: aiState(),
      scope,
      focus: focusState,
      maxAgeDays: config.maxAgeDays,
      hosts: hosts(),
      skills: { reviewSkill: config.reviewSkill, gitstreamReviewSkill: config.gitstreamReviewSkill, triageSkill: config.triageSkill },
      hiddenCount: hiddenItems.length,
      slack: slackState(),
    };
  }

  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  function publish() {
    // Coalesce bursts (one per lane) into one signal.
    if (publishTimer !== undefined) return;
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      if (!disposed) bb.realtime.publish(CHANGED, { fetchedAt });
    }, 50);
  }

  /**
   * Runs a host CLI. A non-zero exit comes back as `error` with whatever it printed on stdout
   * (gh exits 1 on a GraphQL partial error but still prints the readable data); a missing
   * binary, a timeout or a shutdown still throw.
   */
  async function toolOutput(bin: string, args: string[], label: string): Promise<{ stdout: string; error: UserError | null }> {
    try {
      const { stdout } = await run(bin, args, {
        cwd: homedir(),
        env: toolEnv,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: TOOL_TIMEOUT_MS,
        signal: controller.signal,
        killSignal: "SIGKILL",
      });
      return { stdout, error: null };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown } | null;
      // Shutdown aborts in-flight tools; that is a cancellation, not a tool failure.
      if (failure?.code === "ABORT_ERR" || controller.signal.aborted) throw new ToolAborted(label);
      const stderr = typeof failure?.stderr === "string" ? failure.stderr : "";
      const stdout = typeof failure?.stdout === "string" ? failure.stdout : "";
      if (failure?.code === "ENOENT") throw new UserError(`${label}: "${bin}" is not on PATH. Set the path in Radar settings.`);
      if (failure?.killed === true || failure?.code === "ETIMEDOUT") throw new UserError(`${label} timed out.`);
      const kind = classifyToolError(stderr);
      if (kind === "rate-limit") return { stdout, error: new UserError(`${label}: rate limit hit; it will retry next cycle.`) };
      if (kind === "auth") return { stdout, error: new UserError(`${label}: not authenticated (${stderr.trim().split("\n")[0]?.slice(0, 160)}).`) };
      const first =
        stderr.trim().split("\n").find((line) => line.trim() !== "") ??
        `command failed${typeof failure?.code === "number" ? ` (exit ${failure.code})` : ""}`;
      // The label already names the host; drop the CLI's own "gh: " / "dt: " prefix.
      return { stdout, error: new UserError(`${label}: ${first.replace(/^(?:gh|dt|gs):\s*/i, "").slice(0, 200)}`) };
    }
  }

  async function tool(bin: string, args: string[], label: string): Promise<string> {
    const { stdout, error } = await toolOutput(bin, args, label);
    if (error !== null) throw error;
    return stdout;
  }

  function parseJson(stdout: string, label: string): unknown {
    // gs prints a human summary on stderr, JSON on stdout.
    try {
      return JSON.parse(stdout);
    } catch {
      throw new UserError(`${label} returned invalid JSON.`);
    }
  }

  async function resolveDeltaMe(): Promise<string> {
    if (deltaMe !== "") return deltaMe;
    const delta = hosts().delta;
    if (delta === null) throw new UserError("Delta is not configured.");
    const me = deltaPrincipal(parseJson(await tool(config.dtPath, deltaMeArgs(delta.host, delta.repo), `${SOURCE_LABEL.delta} identity`), `${SOURCE_LABEL.delta} identity`));
    if (me === "") throw new UserError(`Could not resolve your ${SOURCE_LABEL.delta} identity. Run dt auth login --host ${delta.host}.`);
    deltaMe = me;
    publish();
    return deltaMe;
  }

  async function resolveGitstreamMe(): Promise<string> {
    if (gitstreamMe !== "") return gitstreamMe;
    // `gs pr list` prints its resolved scope ("author=<email> (default)") on stderr.
    try {
      const { stderr } = await run(config.gsPath, ["pr", "list", "--limit", "1", "--json"], {
        cwd: homedir(), env: toolEnv, timeout: TOOL_TIMEOUT_MS, signal: controller.signal, maxBuffer: MAX_OUTPUT_BYTES,
      });
      gitstreamMe = stderr.match(/author=([^\s(),]+@[^\s(),]+)/)?.[1] ?? "";
    } catch {
      gitstreamMe = "";
    }
    if (gitstreamMe !== "") return gitstreamMe;
    // Fallback for this cycle only, so a transient gs failure is retried next time
    // instead of pinning a guessed identity until restart.
    const fallback = principalFallbackEmail(
      await tool("git", ["config", "--global", "user.email"], "git config").catch(() => ""),
    );
    if (fallback === "") throw new UserError("Could not resolve your Gitstream identity. Run gs auth login.");
    return fallback;
  }

  /** Where label names for drafting come from: Delta, else Gitstream history ("" = none). */
  function labelRepo(): string {
    const { delta, gitstream } = hosts();
    return delta !== null ? `delta:${delta.host}/${delta.repo}` : gitstream !== null ? `gitstream:${gitstream.repo}` : "";
  }

  function buildLabelIndex(): Promise<void> {
    if (labelIndexing !== null) return labelIndexing;
    labelIndexing = (async () => {
      const names: string[] = [];
      // Delta is the live host (and asked to be read gently): ~60 sequential pages, at most
      // weekly (see the poll service). Gitstream history is only a fallback when Delta is off.
      const { delta, gitstream } = hosts();
      const pages = delta !== null ? 100 : 200;
      let complete = false;
      for (let page = 1; page <= pages && !disposed; page++) {
        const data =
          delta !== null
            ? parseJson(await tool(config.dtPath, ["--host", delta.host, "-R", delta.repo, "api", `repos/${delta.repo}/labels?per_page=100&page=${page}`], "dt labels"), "dt labels")
            : gitstream !== null
              ? parseJson(await tool(config.gsPath, ["api", "-X", "GET", `repos/${gitstream.repo}/labels`, "-f", "per_page=100", "-f", `page=${page}`], "gs labels"), "gs labels")
              : null;
        if (!Array.isArray(data)) break;
        for (const label of data) {
          const name = (label as { name?: unknown } | null)?.name;
          if (typeof name === "string") names.push(name);
        }
        if (data.length < 100) {
          complete = true;
          break;
        }
      }
      // A capped read keeps names indexed before, so the index never shrinks to the first pages.
      if (!complete && labelIndex !== null) names.push(...labelIndex.names);
      if (names.length > 0) {
        labelIndex = { at: new Date().toISOString(), names: [...new Set(names)] };
        saveLabelIndex(labelIndex);
        bb.log.info(`indexed ${labelIndex.names.length} labels from ${labelRepo()}${complete ? "" : ` (first ${pages} pages, merged with the previous index)`}`);
      }
    })()
      .catch((error) => {
        if (!(error instanceof ToolAborted) && !disposed) bb.log.warn(`label index failed: ${String(error)}`);
      })
      .finally(() => {
        labelIndexing = null;
      });
    return labelIndexing;
  }

  const STOP = new Set(["the", "and", "for", "with", "that", "from", "prs", "pr", "pull", "requests", "issues", "issue",
    "open", "mine", "my", "me", "not", "any", "all", "anyone", "everyone", "world", "review", "reviews", "track", "show",
    "this", "week", "today", "team", "touching", "touch", "about", "drafts", "draft", "updated", "into", "have", "been"]);

  function candidateLabels(description: string): string[] {
    const names = labelIndex?.names ?? [];
    const tokens = [...new Set(description.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])].filter((t) => !STOP.has(t));
    if (tokens.length === 0 || names.length === 0) return [];
    const scored = names
      .map((name) => {
        const lower = name.toLowerCase();
        const hits = tokens.filter((token) => lower.includes(token)).length;
        // Prefer short, structural labels (area paths, components, slices) over one-offs.
        const bonus = /^(\/\/areas\/|component:|slice:)/i.test(name) ? 0.5 : 0;
        return { name, score: hits === 0 ? 0 : hits + bonus - name.length / 400 };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 40).map((entry) => entry.name);
  }

  /** One host's items for a lane; `warning` is a non-fatal problem shown on the lane (e.g. unreadable results). */
  async function fetchSource(lane: Lane, source: Source): Promise<{ items: Item[]; warning: string }> {
    if (source === "gitstream") {
      const me = await resolveGitstreamMe();
      const data = parseJson(await tool(config.gsPath, gitstreamArgs(lane, me, Date.now(), config.maxAgeDays), SOURCE_LABEL.gitstream), SOURCE_LABEL.gitstream);
      if (!Array.isArray(data)) throw new UserError(`${SOURCE_LABEL.gitstream} did not return a JSON array.`);
      return { items: data.map(fromGitstream).filter((item): item is Item => item !== null), warning: "" };
    }
    if (source === "delta") {
      const data = parseJson(await tool(config.dtPath, deltaArgs(lane, Date.now(), config.maxAgeDays), SOURCE_LABEL.delta), SOURCE_LABEL.delta) as { items?: unknown };
      if (!Array.isArray(data.items)) throw new UserError(`${SOURCE_LABEL.delta} search did not return items.`);
      return { items: data.items.map(fromDelta).filter((item): item is Item => item !== null), warning: "" };
    }
    const { stdout, error } = await toolOutput(
      config.ghPath,
      [
        "api", "graphql",
        "-f", `query=${GITHUB_SEARCH_GRAPHQL}`,
        "-f", `q=${githubSearchQuery(withWindow(lane.query ?? "", lane.filter, Date.now(), config.maxAgeDays))}`,
        "-F", `n=${lane.limit ?? 30}`,
      ],
      "GitHub",
    );
    let data: { data?: { search?: { nodes?: unknown } | null } | null; errors?: { message?: unknown }[] } | null;
    try {
      data = JSON.parse(stdout) as typeof data;
    } catch {
      throw error ?? new UserError("GitHub returned invalid JSON.");
    }
    const nodes = data?.data?.search?.nodes;
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    if (!Array.isArray(nodes)) {
      if (error !== null) throw error;
      if (errors.length > 0) throw new UserError(`GitHub: ${typeof errors[0]?.message === "string" ? errors[0].message.slice(0, 200) : "query error"}`);
      return { items: [], warning: "" };
    }
    // A partial error (nodes behind SAML or an IP allowlist come back null): keep what is readable.
    if (errors.length === 0 && error !== null) throw error;
    const items = nodes.map(fromGithubNode).filter((item): item is Item => item !== null);
    const unreadable = nodes.filter((node) => node === null).length || errors.length;
    return { items, warning: errors.length > 0 ? `GitHub: ${unreadable} result(s) not accessible (SAML/permissions)` : "" };
  }

  /** Every source in parallel; a failing host is reported without hiding the others' items. */
  async function fetchLane(lane: Lane): Promise<{ items: Item[]; fetched: number; error: string }> {
    // Sources that are not configured are skipped, so default and shared lanes work anywhere.
    const enabled = enabledSources();
    const sources = lane.sources.filter((source) => enabled.includes(source));
    if (sources.length === 0) {
      throw new UserError(`${lane.sources.map((source) => SOURCE_LABEL[source]).join(" and ")} ${lane.sources.length === 1 ? "is" : "are"} not set up. Add ${lane.sources.length === 1 ? "it" : "them"} in Settings → Plugins → Radar.`);
    }
    const settled = await Promise.allSettled(sources.map((source) => fetchSource(lane, source)));
    const raw: Item[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        raw.push(...outcome.value.items);
        if (outcome.value.warning !== "") warnings.push(outcome.value.warning);
      } else {
        const error = outcome.reason;
        if (!(error instanceof UserError)) bb.log.warn(`lane ${lane.id} ${sources[index]} failed: ${String(error)}`);
        errors.push(error instanceof UserError ? error.message : `${SOURCE_LABEL[sources[index]!]}: could not be read.`);
      }
    });
    if (errors.length === settled.length) throw new UserError(errors.join(" · "));
    // `limit` is the lane's size: each host fetches up to it, the merged list is cut to it.
    const sorted = applyFilter(raw, lane.filter, Date.now(), config.maxAgeDays)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, lane.limit ?? 30);
    return { items: sorted, fetched: raw.length, error: [...errors, ...warnings].join(" · ") };
  }

  function withNew(laneId: string, items: Item[], complete: boolean): RadarItem[] {
    const marked = markNew(seen[laneId], items, complete);
    if (marked.seed !== null) {
      seen[laneId] = marked.seed;
      void persistSeen();
    }
    return marked.items;
  }

  /** False once the lane was deleted or its query edited after `lane` was read. */
  function stillCurrent(lane: Lane): boolean {
    const current = lanes.find((candidate) => candidate.id === lane.id);
    return current !== undefined && laneQueryKey(current) === laneQueryKey(lane);
  }

  /** In-flight lane refreshes by lane id, so concurrent refreshes of the same query share one fetch. */
  const laneFetches = new Map<string, { queryKey: string; promise: Promise<void> }>();

  function refreshLane(lane: Lane): Promise<void> {
    // A lane deleted or edited since `lane` was read: its own refresh covers it.
    if (disposed || !stillCurrent(lane)) return Promise.resolve();
    const queryKey = laneQueryKey(lane);
    const running = laneFetches.get(lane.id);
    if (running !== undefined && running.queryKey === queryKey) return running.promise;
    const promise = fetchIntoLane(lane).finally(() => {
      if (laneFetches.get(lane.id)?.promise === promise) laneFetches.delete(lane.id);
    });
    laneFetches.set(lane.id, { queryKey, promise });
    return promise;
  }

  async function fetchIntoLane(lane: Lane) {
    const previous = results[lane.id];
    results[lane.id] = {
      laneId: lane.id,
      items: previous?.items ?? [],
      fetched: previous?.fetched ?? 0,
      error: previous?.error ?? "",
      fetchedAt: previous?.fetchedAt ?? "",
      loading: true,
    };
    publish();
    try {
      const { items, fetched, error } = await fetchLane(lane);
      // An edit during the fetch starts its own refresh; this older result must not win.
      if (disposed || !stillCurrent(lane)) return;
      results[lane.id] = {
        laneId: lane.id,
        items: withNew(lane.id, items, error === ""),
        fetched,
        error,
        fetchedAt: new Date().toISOString(),
        loading: false,
      };
    } catch (error) {
      if (disposed || !stillCurrent(lane)) return;
      const message = error instanceof UserError ? error.message : "Lane could not be read.";
      if (!(error instanceof UserError)) bb.log.warn(`lane ${lane.id} failed: ${String(error)}`);
      results[lane.id] = { ...results[lane.id]!, error: message, loading: false };
    }
    publish();
  }

  async function pool<T>(values: T[], worker: (value: T) => Promise<void>) {
    let index = 0;
    const runners = Array.from({ length: Math.min(LANE_CONCURRENCY, values.length) }, async () => {
      while (index < values.length && !disposed) {
        const value = values[index++]!;
        await worker(value);
      }
    });
    await Promise.all(runners);
  }

  function refreshAll(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight !== null) return inFlight;
    refreshing = true;
    publish();
    inFlight = (async () => {
      try {
        if (githubLogin === "") {
          githubLogin = (await tool(config.ghPath, ["api", "user", "--jq", ".login"], "gh api user").catch(() => "")).trim();
        }
        // The panel needs your Delta identity to offer Rebase; one cached read per session.
        if (deltaMe === "" && hosts().delta !== null && config.deltaCheckout !== "") await resolveDeltaMe().catch(() => "");
        // By id, re-read when its turn comes: a lane edited while queued runs its current query.
        await pool(lanes.map((lane) => lane.id), async (id) => {
          const lane = lanes.find((candidate) => candidate.id === id);
          if (lane !== undefined) await refreshLane(lane);
        });
        // Mention acknowledgement is optional: its failure must never stop the board updating.
        await syncMentions().catch((error: unknown) => bb.log.warn(`mention sync failed: ${String(error)}`));
        fetchedAt = new Date().toISOString();
        reconcileHiddenItems();
        // Drop results and seen sets for lanes that no longer exist.
        const ids = new Set(lanes.map((lane) => lane.id));
        for (const id of Object.keys(results)) if (!ids.has(id)) delete results[id];
        let prunedSeen = false;
        for (const id of Object.keys(seen)) {
          if (!ids.has(id)) {
            delete seen[id];
            prunedSeen = true;
          }
        }
        if (prunedSeen) await persistSeen();
        await persistResults().catch((error: unknown) => bb.log.warn(`results cache write failed: ${String(error)}`));
      } finally {
        refreshing = false;
        inFlight = null;
        publish();
      }
    })();
    return inFlight;
  }

  // ---- AI drafting --------------------------------------------------------

  async function chat(system: string, user: string, maxTokens: number): Promise<string> {
    try {
      return await complete(bb, aiOverride, system, user, maxTokens, AI_TIMEOUT_MS, controller.signal, aiFallback());
    } catch (error) {
      throw new UserError(error instanceof Error ? error.message : "BB AI completion failed.");
    }
  }

  async function draftLane(description: string): Promise<DraftResult> {
    if (!aiState().available) throw new UserError(aiState().detail);
    const me =
      hosts().delta !== null
        ? await resolveDeltaMe().catch(() => "")
        : hosts().gitstream !== null
          ? await resolveGitstreamMe().catch(() => "")
          : "";
    const prompt = draftPrompt(description, {
      githubLogin,
      email: me,
      existing: lanes,
      candidateLabels: candidateLabels(description),
      notes: config.draftNotes,
    });
    const content = await chat(prompt.system, prompt.user, 800);
    let drafted: Omit<Lane, "id">;
    try {
      drafted = parseDraft(content);
    } catch (error) {
      throw new UserError((error as Error).message);
    }
    const lane: Lane = {
      ...drafted,
      id: slugify(drafted.title, new Set(lanes.map((existing) => existing.id))),
      description,
    };
    // Run it once so the user sees what they would get before adding it.
    let preview: LaneResult;
    try {
      const { items, fetched } = await fetchLane(lane);
      preview = {
        laneId: lane.id,
        items: items.map((item) => ({ ...item, isNew: false })),
        fetched,
        error: "",
        fetchedAt: new Date().toISOString(),
        loading: false,
      };
    } catch (error) {
      preview = {
        laneId: lane.id,
        items: [],
        fetched: 0,
        error: error instanceof UserError ? error.message : "Preview failed.",
        fetchedAt: "",
        loading: false,
      };
    }
    return { lane, preview };
  }

  // ---- mutations ----------------------------------------------------------

  async function upsertLane(input: unknown): Promise<RadarSnapshot> {
    await putLane(input);
    return snapshot();
  }

  /** Creates or replaces a lane; returns its id (generated from the title when none was given). */
  async function putLane(input: unknown): Promise<string> {
    const candidate = input as Partial<Lane> | null;
    if (candidate === null || typeof candidate !== "object") throw new UserError("Missing lane.");
    const id =
      typeof candidate.id === "string" && candidate.id !== ""
        ? candidate.id
        : slugify(String(candidate.title ?? "lane"), new Set(lanes.map((lane) => lane.id)));
    const existing = lanes.find((lane) => lane.id === id);
    // A category the caller set by hand is pinned; otherwise it follows the query.
    const { categoryPinned: _pinned, ...rest } = candidate;
    const parsed = laneSchema.safeParse({ ...rest, id, ...requestedCategory(candidate, existing) });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new UserError(`${issue?.path.join(".") || "lane"}: ${issue?.message}`);
    }
    const lane = parsed.data;
    const index = lanes.findIndex((existing) => existing.id === lane.id);
    if (index < 0 && lanes.length >= MAX_LANES) throw new UserError(`Radar holds at most ${MAX_LANES} lanes.`);
    const previous = index >= 0 ? lanes[index] : undefined;
    const next = [...lanes];
    if (index >= 0) next[index] = lane;
    else next.push(lane);
    await saveLanes(next);
    // A changed query starts fresh; a collapse toggle must not refetch.
    const queryChanged = previous === undefined || laneQueryKey(previous) !== laneQueryKey(lane);
    if (queryChanged) {
      if (previous !== undefined) {
        delete seen[lane.id];
        await persistSeen();
      }
      void refreshLane(lane).then(() => isMentionLane(lane) ? syncMentions() : undefined).catch(error => bb.log.warn(`lane refresh failed: ${String(error)}`));
    }
    publish();
    return lane.id;
  }

  async function deleteLane(laneId: string): Promise<RadarSnapshot> {
    await saveLanes(lanes.filter((lane) => lane.id !== laneId));
    delete results[laneId];
    delete seen[laneId];
    await persistSeen();
    publish();
    return snapshot();
  }

  async function reorder(ids: string[]): Promise<RadarSnapshot> {
    const byId = new Map(lanes.map((lane) => [lane.id, lane]));
    const ordered = ids.map((id) => byId.get(id)).filter((lane): lane is Lane => lane !== undefined);
    const rest = lanes.filter((lane) => !ids.includes(lane.id));
    await saveLanes([...ordered, ...rest]);
    publish();
    return snapshot();
  }

  /** Marks a lane's (or every lane's) items seen; `view` limits it to what that view shows. */
  async function markSeen(laneId?: string, view: View = "all"): Promise<RadarSnapshot> {
    for (const lane of lanes) {
      if (laneId !== undefined && lane.id !== laneId) continue;
      if (laneId === undefined && !laneInView(lane, view)) continue;
      const result = results[lane.id];
      if (result === undefined) continue;
      // Focus-hidden and hidden items stay new so they surface when the filter changes or they're unhidden.
      const hit = (item: RadarItem) => itemInView(item, view) && visible(item) && !isHidden(item);
      // Non-new items are already seen, so this keeps the other view's new items new. Keys seen
      // before but missing now (a host that is down, the limit cut) are kept, capped, so they
      // do not come back as new.
      const current = new Set(result.items.map((item) => item.key));
      const carried = (seen[lane.id] ?? []).filter((key) => !current.has(key)).slice(-SEEN_CARRY_FACTOR * (lane.limit ?? 30));
      seen[lane.id] = [...carried, ...result.items.filter((item) => !item.isNew || hit(item)).map((item) => item.key)];
      result.items = result.items.map((item) => (hit(item) ? { ...item, isNew: false } : item));
    }
    await persistSeen();
    publish();
    return snapshot();
  }

  function findItem(key: string): RadarItem | undefined {
    for (const result of Object.values(results)) {
      const item = result.items.find((candidate) => candidate.key === key);
      if (item !== undefined) return item;
    }
    return undefined;
  }

  /** Bumps lastSeenAt for hidden items still on the board; prunes ones gone 30+ days. */
  function reconcileHiddenItems(): void {
    if (hiddenItems.length === 0) return;
    const canPrune = lanes.some((lane) => {
      const result = results[lane.id];
      return result !== undefined && result.error === "" && result.fetchedAt !== "";
    });
    const { entries, touched, pruned } = reconcileHidden(hiddenItems, allItems(), new Date(), canPrune);
    if (touched.length === 0 && pruned.length === 0) return;
    try {
      putHiddenRows(touched);
      deleteHiddenRows(pruned);
      setHidden(entries);
      if (pruned.length > 0) bb.log.info(`unhid ${pruned.length} item(s) not seen in any lane for ${HIDDEN_STALE_DAYS} days`);
    } catch (error) {
      bb.log.warn(`hidden items write failed: ${String(error)}`);
    }
  }

  async function hideItem(key: string): Promise<RadarSnapshot> {
    const item = shownItems().find((candidate) => normKey(candidate.key) === normKey(key));
    if (item === undefined) {
      if (hiddenKeys.has(normKey(key))) return snapshot();
      throw new UserError("That item is no longer in any lane; refresh and try again.");
    }
    const entry = entryFor(item, new Date());
    if (entry === null) throw new UserError("That item can't be hidden (unexpected key or data).");
    const { entries, evicted } = addHidden(hiddenItems, entry);
    putHiddenRows([entry]);
    deleteHiddenRows(evicted);
    setHidden(entries);
    publish();
    return snapshot();
  }

  async function unhideItems(keys: string[] | "all"): Promise<{ snapshot: RadarSnapshot; removed: HiddenEntry[] }> {
    const { entries, removed } = removeHidden(hiddenItems, keys);
    if (keys === "all") replaceHiddenRows([]);
    else deleteHiddenRows(removed);
    setHidden(entries);
    publish();
    return { snapshot: snapshot(), removed };
  }

  /** CLI <url|key|owner/repo#n> → a key on the board or in the hidden list. */
  function cliItemKey(input: string, among: { key: string; source: Source; repo: string; number: number }[]): string {
    const ref = parseItemRef(input);
    if (ref === null) throw new UserError(`"${input.slice(0, 120)}" is not a PR/issue URL, a Radar key (github:owner/repo#12) or owner/repo#12.`);
    const key = resolveItemKey(ref, among);
    if (typeof key !== "string") throw new UserError(key.error);
    return key;
  }

  /** Unique new items across lanes (an item can sit in several lanes), focus filter applied. */
  function newCount(): number {
    const keys = new Set<string>();
    for (const result of Object.values(boardResults())) {
      for (const item of result.items) if (item.isNew && visible(item)) keys.add(item.key);
    }
    return keys.size;
  }

  function allItems(): RadarItem[] {
    return Object.values(results).flatMap((result) => result.items);
  }

  /** Board items (no hidden items, no acknowledged mentions): what every count and scope list is built from. */
  function shownItems(): RadarItem[] {
    return Object.values(boardResults()).flatMap((result) => result.items);
  }

  function catalog(): ScopeEntry[] {
    return scopeCatalog(shownItems(), scope);
  }

  async function saveFocus(next: FocusState): Promise<RadarSnapshot> {
    const parsed = focusStateSchema.safeParse(next);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new UserError(issue?.path[0] === "description" ? DESCRIPTION_TOO_LONG : "Too many repos or areas in the focus.");
    }
    focusState = parsed.data;
    scope = effectiveScope(focusState);
    visible = scopePredicate(scope);
    await bb.storage.kv.set("focus", focusState);
    publish();
    return snapshot();
  }

  /** "i don't want to see any billing stuff" → hide acme/billing, Focus on. */
  async function describeFocus(description: string): Promise<RadarSnapshot> {
    const entries = scopeCatalog(shownItems(), EMPTY_SCOPE);
    const known = [...new Set([...catalogKeys(entries), ...focusState.focus, ...focusState.hidden])];
    let choice: { focus: string[]; hidden: string[]; summary: string };
    if (!aiState().available) {
      try {
        choice = heuristicFocus(description, known);
      } catch (error) {
        throw new UserError(`${(error as Error).message} (${aiState().detail} Name a repo or area, e.g. “no billing”.)`);
      }
    } else {
      const prompt = focusPrompt(description, entries);
      try {
        choice = parseFocusReply(await chat(prompt.system, prompt.user, 400), known);
      } catch (error) {
        // An AI outage should not block a simple "no billing".
        try {
          choice = heuristicFocus(description, known);
        } catch {
          throw error instanceof UserError ? error : new UserError((error as Error).message);
        }
      }
    }
    return saveFocus({ enabled: true, description, ...choice });
  }

  async function setFocusEnabled(enabled: boolean): Promise<RadarSnapshot> {
    if (enabled && !isActive(focusState)) throw new UserError("No focus yet. Describe what to focus on.");
    return saveFocus({ ...focusState, enabled });
  }

  /** Typed names → scope keys, matched against repos/areas in current results. */
  function resolveScopes(inputs: string[]): string[] {
    const known = catalogKeys(catalog());
    return inputs.map((input) => {
      try {
        return resolveScope(input, known);
      } catch (error) {
        throw new UserError((error as Error).message);
      }
    });
  }

  async function editScope(op: ScopeOp, keys: string[]): Promise<RadarSnapshot> {
    if (op !== "clear" && keys.length === 0) throw new UserError("Name at least one repo or area.");
    // "clear" is Focus off; the last focus is kept so it can be resumed.
    if (op === "clear") return setFocusEnabled(false);
    const knownAreas = [...new Set(allItems().flatMap(itemAreas))];
    // Showing something while Focus is off changes nothing; keep the saved focus for --on.
    if (!focusState.enabled && op === "show") return snapshot();
    // Picking scopes while Focus is off starts a fresh, hand-picked focus.
    const base = focusState.enabled ? focusState : FOCUS_OFF;
    const next = applyScopeOp(base, op, keys, knownAreas);
    const active = isActive(next);
    return saveFocus({
      ...next,
      enabled: active,
      description: active ? base.description : "",
      summary: describeScope(next),
    });
  }

  async function defaultProjectFor(repo: string): Promise<string | null> {
    const remembered = reviewProjects[repo];
    const projects = await bb.sdk.projects.list({ includePersonal: false });
    const list = Array.isArray(projects) ? projects : ((projects as { projects?: unknown[] }).projects ?? []);
    const rows = list as { id: string; gitRemoteUrl: string | null }[];
    if (remembered !== undefined && rows.some((project) => project.id === remembered)) return remembered;
    const match = rows.find((project) => project.gitRemoteUrl !== null && remoteRepo(project.gitRemoteUrl) === repo.toLowerCase());
    return match?.id ?? null;
  }

  async function reviewContext(key: string): Promise<ReviewContext> {
    const item = findItem(key);
    if (item === undefined) throw new UserError("That item is no longer in any lane; refresh and try again.");
    return {
      title: reviewTitle(item),
      prompt: reviewPrompt(item),
      defaultProjectId: await defaultProjectFor(item.repo),
    };
  }

  async function startReview(key: string, request: Record<string, unknown>): Promise<{ threadId: string }> {
    const item = findItem(key);
    if (item === undefined) throw new UserError("That item is no longer in any lane; refresh and try again.");
    const projectId = typeof request.projectId === "string" ? request.projectId : null;
    const [context, sectionId, skill] = await Promise.all([reviewContext(key), reviewSectionId(), availableHostSkill(item, projectId)]);
    const withSkill = skill !== null ? withSkillMention(request as { input?: unknown; prompt?: unknown }, skill) : request;
    const thread = (await bb.sdk.threads.spawn({
      ...(withSkill as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]),
      ...(sectionId !== null ? { sectionId } : {}),
      title: context.title,
      pluginMetadata: { itemKey: key, url: item.url, action: actionFor(item.kind), source: item.source },
    })) as { id?: string; thread?: { id?: string } };
    const threadId = thread.id ?? thread.thread?.id;
    if (threadId === undefined) throw new Error("bb did not return the new thread id");
    reviews = { ...reviews, [key]: { threadId, at: new Date().toISOString() } };
    if (typeof request.projectId === "string") reviewProjects = { ...reviewProjects, [item.repo]: request.projectId };
    await Promise.all([bb.storage.kv.set("reviews", reviews), bb.storage.kv.set("reviewProjects", reviewProjects)]);
    publish();
    return { threadId };
  }

  /**
   * The configured host skill for this item, if the target project can see it. An unknown
   * skill would just render as literal "/name" text, so it is dropped (and logged) instead.
   */
  async function availableHostSkill(item: Item, projectId: string | null): Promise<string | null> {
    const name = hostSkillFor(item, config);
    if (name === null) return null;
    if (projectId === null) return name;
    try {
      const { skills } = await bb.sdk.skills.list({ projectId, environmentId: null });
      if (skills.some((skill) => skill.name === name)) return name;
      bb.log.warn(`review skill "${name}" is not installed for project ${projectId}; starting without it`);
      return null;
    } catch (error) {
      bb.log.warn(`could not list skills for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
      return name;
    }
  }

  /**
   * The id of the configured review section (default "Reviews"), creating it when missing.
   * A failure here never blocks a review: the thread just lands unsectioned.
   */
  async function reviewSectionId(): Promise<string | null> {
    const name = config.reviewSection;
    if (name === "") return null;
    try {
      const existing = findSection(await bb.sdk.threadSections.list(), name);
      if (existing !== null) return existing;
      return (await bb.sdk.threadSections.create({ name })).id;
    } catch (error) {
      bb.log.warn(`review section "${name}" unavailable: ${String(error)}`);
      return null;
    }
  }

  /** One-time move of review threads started before sections were applied. */
  async function backfillReviewSection(): Promise<void> {
    if ((await bb.storage.kv.get<boolean>("reviewSectionBackfilled")) === true) return;
    const sectionId = await reviewSectionId();
    if (sectionId === null) return;
    const threads = await Promise.all(
      Object.values(reviews).map(async ({ threadId }) => {
        try {
          const thread = (await bb.sdk.threads.get({ threadId })) as { sectionId?: string | null };
          return { id: threadId, sectionId: thread.sectionId ?? null };
        } catch {
          return { id: threadId, sectionId: "unknown" };
        }
      }),
    );
    await Promise.all(threadsToSection(threads).map((threadId) => bb.sdk.threads.update({ threadId, sectionId })));
    await bb.storage.kv.set("reviewSectionBackfilled", true);
  }

  /** Drop links to threads that were archived or deleted; the user is done with them. */
  async function pruneReviews(): Promise<void> {
    const entries = Object.entries(reviews);
    if (entries.length === 0) return;
    const keep: Reviews = {};
    await Promise.all(
      entries.map(async ([key, review]) => {
        try {
          const thread = (await bb.sdk.threads.get({ threadId: review.threadId })) as {
            archivedAt?: number | null;
            deletedAt?: number | null;
          };
          if (thread.archivedAt == null && thread.deletedAt == null) keep[key] = review;
        } catch (error) {
          // Unknown thread → gone. Anything else (transient) keeps the link.
          if (!/not.?found|404/i.test(String(error))) keep[key] = review;
        }
      }),
    );
    if (Object.keys(keep).length === entries.length) return;
    reviews = keep;
    await bb.storage.kv.set("reviews", reviews);
    publish();
  }

  // ---- rebase ---------------------------------------------------------------

  /**
   * Like `tool`, but a non-zero exit returns stdout+stderr for classification instead of throwing.
   * `detached` runs without the shutdown signal (cleanup that must still happen during a reload).
   */
  async function capture(
    bin: string,
    args: string[],
    label: string,
    options: { cwd?: string; timeoutMs?: number; detached?: boolean } = {},
  ): Promise<{ ok: boolean; stdout: string; output: string }> {
    try {
      const { stdout } = await run(bin, args, {
        cwd: options.cwd ?? homedir(),
        // Never prompt for credentials or an editor from the server process.
        env: { ...toolEnv, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
        maxBuffer: MAX_OUTPUT_BYTES,
        // A rebase replays commits; give it more room than a read.
        timeout: options.timeoutMs ?? TOOL_TIMEOUT_MS * 3,
        ...(options.detached === true ? {} : { signal: controller.signal }),
        killSignal: "SIGKILL",
      });
      return { ok: true, stdout, output: stdout };
    } catch (error) {
      const failure = captureFailure(error, options.detached !== true && controller.signal.aborted, label, bin);
      if (failure.kind === "throw") throw new UserError(failure.message);
      return { ok: false, stdout: failure.stdout, output: failure.output };
    }
  }

  async function rebaseGithub(target: RebaseTarget): Promise<RebaseResult> {
    const read = await capture(config.ghPath, githubPrArgs(target.repo, target.number), "GitHub");
    const parsed = (() => {
      try {
        return JSON.parse(read.stdout) as unknown;
      } catch {
        return null;
      }
    })();
    if (!read.ok && parsed === null) {
      const failure = classifyRebaseFailure("github", read.output);
      throw new UserError(failure.upToDate ? "GitHub could not read that pull request." : failure.message);
    }
    const verified = verifyGithubPr(parsed);
    if (!verified.ok) throw new UserError(verified.reason);
    const { id, headOid, baseOid } = verified.value;
    // Skip the rewrite entirely when the base is already in the head.
    const behind = await capture(config.ghPath, githubCompareArgs(target.repo, baseOid, headOid), "GitHub compare");
    if (behind.ok && behind.stdout.trim() === "0") return { status: "up-to-date", message: "Already up to date.", headSha: headOid };
    const result = await capture(config.ghPath, githubRebaseArgs(id, headOid), "GitHub rebase");
    const body = (() => {
      try {
        return JSON.parse(result.stdout) as {
          data?: { updatePullRequestBranch?: { pullRequest?: { headRefOid?: unknown } } | null };
          errors?: { message?: unknown }[];
        };
      } catch {
        return null;
      }
    })();
    const errors = (body?.errors ?? []).map((error) => (typeof error.message === "string" ? error.message : "")).join("\n");
    if (!result.ok || errors !== "") {
      const failure = classifyRebaseFailure("github", `${errors}\n${result.output}`);
      if (failure.upToDate) return { status: "up-to-date", message: "Already up to date.", headSha: headOid };
      throw new UserError(failure.message);
    }
    const next = body?.data?.updatePullRequestBranch?.pullRequest?.headRefOid;
    return { status: "rebased", message: "Rebased onto the latest base.", headSha: typeof next === "string" ? next : headOid };
  }

  /**
   * Delta has no server-side rebase, so this is plain git against `origin` in the configured
   * checkout, touching only private refs/radar/* refs (never the worktree, HEAD or origin/*):
   * verify on Delta, fetch base+head, refuse merge commits, `git replay`, then push leased
   * to the head Delta reported. One fetch and one push per click keeps Delta load light.
   */
  const gitFailure = (output: string, fallback: string) => {
    const failure = classifyRebaseFailure("delta", output);
    return failure.upToDate ? fallback : failure.message;
  };

  async function rebaseDelta(target: RebaseTarget): Promise<RebaseResult> {
    const delta = hosts().delta;
    if (delta === null) throw new UserError("Delta is not configured.");
    const cwd = config.deltaCheckout;
    if (cwd === "") throw new UserError(`Set "Local checkout of the Delta repo used for Rebase" in Radar settings to rebase ${SOURCE_LABEL.delta} PRs.`);
    if (target.repo.toLowerCase() !== delta.repo.toLowerCase()) throw new UserError(`Radar only rebases ${delta.repo} PRs on ${SOURCE_LABEL.delta}.`);
    const git = (args: string[], label: string, timeoutMs?: number) => capture("git", args, label, { cwd, timeoutMs });
    const origin = await git(gitOriginArgs(), "git remote");
    // The push goes to origin's push URLs (pushurl, pushInsteadOf), so check those as well as the fetch URL.
    const pushUrls = origin.ok && originMatches(origin.stdout, delta.host, delta.repo) ? await git(gitPushUrlsArgs(), "git remote") : null;
    if (pushUrls === null || !pushUrls.ok || !pushUrlsMatch(pushUrls.stdout, delta.host, delta.repo)) {
      throw new UserError(`The rebase checkout's origin is not https://${delta.host}/${delta.repo}. Fix the checkout path in Radar settings.`);
    }
    // Sweep refs a reload left mid-rebase (not those of other rebases still running here).
    const running = new Set([...rebasing].flatMap((key) => {
      const match = /^delta:.*#(\d+)$/.exec(key);
      return match !== null && Number(match[1]) !== target.number ? [Number(match[1])] : [];
    }));
    await sweepRadarRefs(cwd, running);
    const me = await resolveDeltaMe();
    const pr = parseJson(await tool(config.dtPath, deltaPrArgs(delta.host, target.repo, target.number), SOURCE_LABEL.delta), SOURCE_LABEL.delta);
    const verified = verifyDeltaPr(pr, me, target.repo);
    if (!verified.ok) throw new UserError(verified.reason);
    const { headSha, headRef, baseRef } = verified.value;
    const refs = radarRefs(target.number);
    try {
      const fetched = await git(gitFetchArgs(target.number, baseRef, headRef), "git fetch", TOOL_TIMEOUT_MS * 6);
      if (!fetched.ok) throw new UserError(gitFailure(fetched.output, "git fetch failed."));
      const oid = async (ref: string) => {
        const result = await git(gitRevParseArgs(ref), "git rev-parse");
        const value = result.stdout.trim().toLowerCase();
        if (!result.ok || !/^[0-9a-f]{40}$/.test(value)) throw new UserError("git could not read the fetched branches.");
        return value;
      };
      const [base, head] = [await oid(refs.base), await oid(refs.head)];
      if (head !== headSha) throw new UserError("The branch changed since Delta last reported it. Refresh and try again.");
      if ((await git(gitIsAncestorArgs(base, head), "git merge-base")).ok) return { status: "up-to-date", message: "Already up to date.", headSha: head };
      const merges = await git(gitMergesArgs(base, head), "git rev-list");
      if (!merges.ok || merges.stdout.trim() !== "0") throw new UserError("Can't rebase cleanly (conflicts or merge commits). Rebase locally instead.");
      const replay = await git(gitReplayArgs(target.number, base, head), "git replay", TOOL_TIMEOUT_MS * 4);
      if (!replay.ok) {
        if (/unknown option|usage: .*git replay|is not a git command/i.test(replay.output)) throw new UserError("Rebase on Delta needs git 2.52 or newer (git replay --ref-action).");
        throw new UserError("Can't rebase cleanly (conflicts or merge commits). Rebase locally instead.");
      }
      const next = replayedHead(replay.stdout, target.number, head);
      if (next === null) throw new UserError("git replay did not produce a rebased head.");
      // Delta writes can take minutes; a timeout may still land, so say so instead of retrying.
      const pushed = await git(gitPushArgs(headRef, next, head), "git push", 5 * 60_000);
      if (!pushed.ok) throw new UserError(gitFailure(pushed.output, "git push failed."));
      return { status: "rebased", message: "Rebased onto the latest base.", headSha: next };
    } finally {
      // Not through the shutdown signal: a reload mid-rebase must still clean up.
      for (const ref of [refs.base, refs.head]) {
        await capture("git", gitDeleteRefArgs(ref), "git update-ref", { cwd, timeoutMs: 10_000, detached: true }).catch(() => undefined);
      }
    }
  }

  const rebasing = new Set<string>();

  async function sweepRadarRefs(cwd: string, running: ReadonlySet<number>): Promise<void> {
    const listed = await capture("git", gitListRadarRefsArgs(), "git for-each-ref", { cwd, timeoutMs: 10_000 });
    if (!listed.ok) return;
    for (const ref of staleRadarRefs(listed.stdout, running)) {
      await capture("git", gitDeleteRefArgs(ref), "git update-ref", { cwd, timeoutMs: 10_000 }).catch(() => undefined);
    }
  }

  async function rebase(target: RebaseTarget): Promise<RebaseResult> {
    if (!REBASE_SOURCES.has(target.source)) {
      throw new UserError(`${SOURCE_LABEL[target.source]} is read-only (Gitstream no longer accepts PR writes), so Radar can't rebase it. Rebase the matching ${SOURCE_LABEL.delta} PR instead.`);
    }
    const key = `${target.source}:${target.repo}#${target.number}`;
    if (rebasing.has(key)) throw new UserError("A rebase of this pull request is already running.");
    rebasing.add(key);
    try {
      const result = target.source === "github" ? await rebaseGithub(target) : await rebaseDelta(target);
      bb.log.info(`rebase ${key}: ${result.status} ${result.headSha.slice(0, 12)}`);
      if (result.status === "rebased") {
        // Refresh every lane showing this PR so its row reflects the new head.
        const showing = lanes.filter((lane) => results[lane.id]?.items.some((item) => item.key === key));
        void Promise.all(showing.map(refreshLane));
      }
      return result;
    } finally {
      rebasing.delete(key);
    }
  }

  /** CLI target → source: explicit flag, URL host, else the matching item in lanes. */
  function resolveRebaseTarget(input: string, sourceFlag: string | undefined): RebaseTarget {
    const parsed = parseRebaseTarget(input);
    if (parsed === null) throw new UserError("Usage: bb radar rebase <PR url | owner/repo#number> [--source github|delta] [--yes]");
    if (sourceFlag !== undefined && sourceFlag !== "github" && sourceFlag !== "gitstream" && sourceFlag !== "delta") {
      throw new UserError("--source must be github or delta (gitstream is read-only history).");
    }
    const flagged = sourceFlag as RebaseTarget["source"] | undefined;
    if (parsed.source !== null && flagged !== undefined && parsed.source !== flagged) throw new UserError("--source does not match the URL.");
    let source = parsed.source ?? flagged;
    if (source === undefined) {
      const sources = [...new Set(shownItems().filter((item) => item.kind === "pr" && item.repo.toLowerCase() === parsed.repo.toLowerCase() && item.number === parsed.number).map((item) => item.source))];
      if (sources.length > 1) throw new UserError(`${parsed.repo}#${parsed.number} is on ${sources.join(" and ")}; pass --source.`);
      const { gitstream, delta } = hosts();
      const elsewhere = [delta, gitstream].filter((host) => host !== null && host.repo.toLowerCase() === parsed.repo.toLowerCase());
      source = sources[0] ?? (elsewhere.length > 0 ? undefined : "github");
      if (source === undefined) throw new UserError(`${parsed.repo} PRs live on ${elsewhere.map((host) => host!.label).join(" or ")}; pass a URL or --source.`);
    }
    return { source, repo: parsed.repo, number: parsed.number };
  }

  // ---- Slack context ------------------------------------------------------
  //
  // A slow background sweep (its own service, so the board's 90s poll never waits on Slack):
  // a few open GitHub issues per sweep, least recently checked first, are searched for public
  // Slack messages that link them. Their threads are followed; when a thread has human
  // messages newer than the last summary, the AI drafts an update. Drafts wait for approval.

  const SLACK_ISSUES_PER_SWEEP = 8;
  const SLACK_CALL_GAP_MS = 1_200;
  const SLACK_TOKEN_TTL_MS = 20 * 60_000;
  const SLACK_MARK = "radar:slack-context";
  type SlackThreadRow = {
    issue_key: string;
    channel_id: string;
    thread_ts: string;
    channel_name: string;
    permalink: string;
    latest_ts: string;
    synced_ts: string;
  };
  const slackDraftSchema = z.object({
    repo: z.string(),
    number: z.number(),
    title: z.string(),
    url: z.string(),
    summary: z.string(),
    current: z.string(),
    at: z.string(),
    /** thread key (channel:ts) → the latest_ts the draft covers; approving marks exactly these read. */
    marks: z.record(z.string(), z.string()),
  });
  type SlackDraft = z.infer<typeof slackDraftSchema>;
  let slackError = "";
  let slackSweptAt = "";
  let slackToken: { value: string; at: number } | null = null;
  let slackLastCall = 0;
  let slackSweep: Promise<void> | null = null;
  let wakeSlack: (() => void) | undefined;
  /** Per-issue lock, so a manual check, a sweep and an approval never interleave on one issue. */
  const slackBusy = new Map<string, Promise<unknown>>();

  const slackEnabled = () => config.slackMcpUrl !== "" && config.slackTokenCommand !== "";
  const threadKey = (row: Pick<SlackThreadRow, "channel_id" | "thread_ts">) => `${row.channel_id}:${row.thread_ts}`;

  function slackThreads(key: string): SlackThreadRow[] {
    return db.prepare("SELECT * FROM slack_threads WHERE issue_key = ? ORDER BY CAST(thread_ts AS REAL) DESC").all(key) as SlackThreadRow[];
  }
  function slackDraft(key: string): SlackDraft | null {
    const row = db.prepare("SELECT draft FROM slack_drafts WHERE issue_key = ?").get(key) as { draft: string } | undefined;
    const parsed = slackDraftSchema.safeParse(parseRow(row?.draft));
    return parsed.success ? parsed.data : null;
  }
  function slackDrafts(): Map<string, SlackDraft> {
    const rows = db.prepare("SELECT issue_key, draft FROM slack_drafts").all() as { issue_key: string; draft: string }[];
    const drafts = new Map<string, SlackDraft>();
    for (const row of rows) {
      const parsed = slackDraftSchema.safeParse(parseRow(row.draft));
      if (parsed.success) drafts.set(row.issue_key, parsed.data);
    }
    return drafts;
  }

  /** Open GitHub issues on the board (hidden items excluded); Slack context only touches these. */
  function slackCandidates(): RadarItem[] {
    const unique = new Map<string, RadarItem>();
    for (const item of shownItems()) {
      if (item.source === "github" && item.kind === "issue" && item.state.toLowerCase() !== "closed") unique.set(item.key, item);
    }
    return [...unique.values()];
  }

  function slackState() {
    const board = new Set(slackCandidates().map((item) => item.key));
    const drafts: Record<string, { at: string; threads: number }> = {};
    for (const [key, draft] of slackDrafts()) if (board.has(key)) drafts[key] = { at: draft.at, threads: Object.keys(draft.marks).length };
    return { enabled: slackEnabled(), error: slackEnabled() ? slackError : "", sweptAt: slackSweptAt, drafts };
  }

  function slackSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0 || controller.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      controller.signal.addEventListener("abort", done, { once: true });
    });
  }

  async function slackTokenValue(force: boolean): Promise<string> {
    if (!force && slackToken !== null && Date.now() - slackToken.at < SLACK_TOKEN_TTL_MS) return slackToken.value;
    const [bin, ...args] = config.slackTokenCommand.split(/\s+/);
    if (bin === undefined || bin === "") throw new UserError("Set the Slack token command in Radar settings.");
    const out = await tool(bin, args, "Slack token command");
    const value = out.trim().split("\n").pop()?.trim() ?? "";
    if (value === "" || /\s/.test(value)) throw new UserError("The Slack token command printed no token.");
    slackToken = { value, at: Date.now() };
    return value;
  }

  /** One Tool Gateway call, spaced out from the last; an expired token is re-fetched once. */
  async function slackCall(name: string, args: Record<string, unknown>): Promise<string> {
    await slackSleep(slackLastCall + SLACK_CALL_GAP_MS - Date.now());
    if (controller.signal.aborted) throw new ToolAborted("Slack");
    slackLastCall = Date.now();
    try {
      return await mcpTool(config.slackMcpUrl, await slackTokenValue(false), name, args, controller.signal);
    } catch (error) {
      if (!(error instanceof SlackAuthError)) throw error;
      return mcpTool(config.slackMcpUrl, await slackTokenValue(true), name, args, controller.signal);
    }
  }

  /** Radar's own Slack-context comment on the issue (yours, carrying the marker), newest wins. */
  async function slackComment(repo: string, number: number): Promise<{ id: number; url: string; body: string } | null> {
    if (githubLogin === "") throw new UserError("GitHub login unknown; is gh signed in?");
    const filter = `.[] | select(.user.login == ${JSON.stringify(githubLogin)} and (.body | contains(${JSON.stringify(SLACK_MARK)}))) | {id, url: .html_url, body}`;
    const out = await tool(config.ghPath, ["api", `repos/${repo}/issues/${number}/comments?per_page=100`, "--paginate", "--jq", filter], "GitHub comments");
    const last = out.trim().split("\n").filter(Boolean).pop();
    if (last === undefined) return null;
    const parsed = z.object({ id: z.number(), url: z.string(), body: z.string() }).safeParse(parseRow(last));
    return parsed.success ? parsed.data : null;
  }

  function markSynced(key: string, marks: Record<string, string>) {
    const update = db.prepare("UPDATE slack_threads SET synced_ts = ? WHERE issue_key = ? AND channel_id = ? AND thread_ts = ?");
    for (const [thread, ts] of Object.entries(marks)) {
      const [channel, threadTs] = thread.split(":");
      if (channel !== undefined && threadTs !== undefined) update.run(ts, key, channel, threadTs);
    }
  }

  function slackLocked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = slackBusy.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    slackBusy.set(key, next);
    void next.catch(() => undefined).finally(() => {
      if (slackBusy.get(key) === next) slackBusy.delete(key);
    });
    return next;
  }

  /** Search, follow threads, and draft when there is something new. Returns whether a draft is waiting. */
  function checkSlackIssue(item: RadarItem): Promise<boolean> {
    return slackLocked(item.key, async () => {
      const checked = db.prepare("SELECT checked_at FROM slack_issues WHERE issue_key = ?").get(item.key) as { checked_at: string } | undefined;
      // Overlap two days so a message indexed late is still found.
      const after = checked ? Date.parse(checked.checked_at) / 1000 - 2 * 86_400 : null;
      const startedAt = new Date().toISOString();
      const found = parseSearchResults(
        unwrapText(await slackCall("slack_search_public", searchArguments(item.repo, item.number, Number.isFinite(after) ? after : null)), "results"),
        item.repo,
        item.number,
      );
      const upsert = db.prepare(
        "INSERT INTO slack_threads (issue_key, channel_id, thread_ts, channel_name, permalink, latest_ts, synced_ts) VALUES (?, ?, ?, ?, ?, '', '') " +
          "ON CONFLICT (issue_key, channel_id, thread_ts) DO UPDATE SET channel_name = excluded.channel_name, permalink = CASE WHEN excluded.permalink = '' THEN slack_threads.permalink ELSE excluded.permalink END",
      );
      for (const hit of found) upsert.run(item.key, hit.channelId, hit.threadTs, hit.channelName, hit.permalink);

      const threads = slackThreads(item.key).slice(0, MAX_THREADS_PER_ISSUE);
      const setLatest = db.prepare("UPDATE slack_threads SET latest_ts = ? WHERE issue_key = ? AND channel_id = ? AND thread_ts = ?");
      for (const thread of threads) {
        const read = parseThreadJson(await slackCall("slack_read_thread", { channel_id: thread.channel_id, ts: thread.thread_ts, message_ts: thread.thread_ts, format: "json", limit: 200 }));
        if (read.latestTs !== "" && compareTs(read.latestTs, thread.latest_ts) > 0) {
          setLatest.run(read.latestTs, item.key, thread.channel_id, thread.thread_ts);
          thread.latest_ts = read.latestTs;
        }
      }
      db.prepare("INSERT INTO slack_issues (issue_key, checked_at) VALUES (?, ?) ON CONFLICT (issue_key) DO UPDATE SET checked_at = excluded.checked_at").run(item.key, startedAt);

      const unsynced = threads.filter((thread) => compareTs(thread.latest_ts, thread.synced_ts) > 0);
      if (unsynced.length === 0) return slackDraft(item.key) !== null;
      const existing = slackDraft(item.key);
      // A waiting draft that already covers every new message needs no second AI call.
      if (existing !== null && unsynced.every((thread) => compareTs(existing.marks[threadKey(thread)] ?? "", thread.latest_ts) >= 0)) return true;
      if (aiBackend(bb, aiFallback()) === null) throw new UserError("Slack context needs AI to draft summaries; set up AI in Radar settings.");

      const comment = await slackComment(item.repo, item.number);
      const current = comment ? extractSummary(comment.body) : "";
      const texts = [];
      for (const thread of threads.filter((row) => row.latest_ts !== "")) {
        const text = unwrapText(await slackCall("slack_read_thread", { channel_id: thread.channel_id, ts: thread.thread_ts, message_ts: thread.thread_ts, response_format: "concise", limit: 200 }), "messages");
        texts.push({ channelName: thread.channel_name, text });
      }
      const marks = Object.fromEntries(threads.filter((row) => row.latest_ts !== "").map((row) => [threadKey(row), row.latest_ts]));
      const reply = parseSummaryReply(await chat(SUMMARY_SYSTEM, summaryPrompt(item, current, texts), 700));
      if (!reply.changed) {
        // Nothing material: mark read so the same messages don't draft again.
        markSynced(item.key, marks);
        db.prepare("DELETE FROM slack_drafts WHERE issue_key = ?").run(item.key);
        return false;
      }
      const draft: SlackDraft = { repo: item.repo, number: item.number, title: item.title, url: item.url, summary: reply.summary, current, at: new Date().toISOString(), marks };
      db.prepare("INSERT INTO slack_drafts (issue_key, draft) VALUES (?, ?) ON CONFLICT (issue_key) DO UPDATE SET draft = excluded.draft").run(item.key, JSON.stringify(draft));
      return true;
    });
  }

  function sweepSlack(): Promise<void> {
    if (!slackEnabled() || disposed) return Promise.resolve();
    if (slackSweep !== null) return slackSweep;
    slackSweep = (async () => {
      try {
        const checked = new Map(
          (db.prepare("SELECT issue_key, checked_at FROM slack_issues").all() as { issue_key: string; checked_at: string }[]).map((row) => [row.issue_key, row.checked_at]),
        );
        const due = slackCandidates()
          .sort((a, b) => (checked.get(a.key) ?? "").localeCompare(checked.get(b.key) ?? ""))
          .slice(0, SLACK_ISSUES_PER_SWEEP);
        let failure = "";
        for (const item of due) {
          if (disposed) return;
          try {
            await checkSlackIssue(item);
          } catch (error) {
            if (error instanceof ToolAborted) return;
            failure = `${item.repo}#${item.number}: ${error instanceof Error ? error.message : String(error)}`;
            if (error instanceof SlackRateLimited || error instanceof SlackAuthError) break;
          }
          publish();
        }
        slackError = failure;
        slackSweptAt = new Date().toISOString();
      } finally {
        slackSweep = null;
        publish();
      }
    })();
    return slackSweep;
  }

  function slackItem(key: string): RadarItem {
    const item = slackCandidates().find((candidate) => candidate.key === key);
    if (item === undefined) throw new UserError("Slack context works on open GitHub issues on your board.");
    return item;
  }

  function slackDraftView(key: string): SlackDraftView {
    const draft = slackDraft(key);
    if (draft === null) throw new UserError("No Slack context draft for this issue. It may have been posted or dismissed.");
    const sources = slackThreads(key)
      .filter((thread) => thread.latest_ts !== "" && draft.marks[threadKey(thread)] !== undefined)
      .map((thread) => ({ channelName: thread.channel_name, permalink: thread.permalink }));
    return { key, repo: draft.repo, number: draft.number, title: draft.title, url: draft.url, summary: draft.summary, current: draft.current, sources, at: draft.at };
  }

  function publishSlack(key: string, summary: string): Promise<{ url: string }> {
    return slackLocked(key, async () => {
      const view = slackDraftView(key);
      const draft = slackDraft(key)!;
      const body = renderComment(summary, view.sources, new Date().toISOString().slice(0, 10));
      const existing = await slackComment(view.repo, view.number);
      const args = existing !== null
        ? ["api", "-X", "PATCH", `repos/${view.repo}/issues/comments/${existing.id}`, "-f", `body=${body}`, "--jq", ".html_url"]
        : ["api", "-X", "POST", `repos/${view.repo}/issues/${view.number}/comments`, "-f", `body=${body}`, "--jq", ".html_url"];
      const url = (await tool(config.ghPath, args, existing !== null ? "Updating the Slack context comment" : "Posting the Slack context comment")).trim();
      markSynced(key, draft.marks);
      db.prepare("DELETE FROM slack_drafts WHERE issue_key = ?").run(key);
      publish();
      return { url: url || existing?.url || view.url };
    });
  }

  function dismissSlack(key: string): Promise<RadarSnapshot> {
    return slackLocked(key, async () => {
      const draft = slackDraft(key);
      if (draft !== null) markSynced(key, draft.marks);
      db.prepare("DELETE FROM slack_drafts WHERE issue_key = ?").run(key);
      publish();
      return snapshot();
    });
  }

  bb.background.service("slack-context", {
    async start(signal) {
      // Let the board load first; Slack is never on the critical path.
      await slackSleep(60_000);
      while (!signal.aborted && !disposed) {
        await sweepSlack().catch((error: unknown) => bb.log.warn(`slack sweep failed: ${String(error)}`));
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            if (wakeSlack === finish) wakeSlack = undefined;
            resolve();
          };
          const timer = setTimeout(finish, config.slackSweepMinutes * 60_000);
          wakeSlack = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    },
  });

  // Read by the rail-badge content script; local auth keeps it to bb app origins.
  bb.http.route("GET", "/badge", (c) => c.json({ new: newCount(), fetchedAt }));

  bb.rpc.register(rpcContract, {
    radar_snapshot: () => snapshot(),
    radar_ai_get: () => aiOverride,
    radar_ai_set: async (next) => {
      await bb.storage.kv.set("aiOverride", next);
      aiOverride = next;
      publish();
      return aiOverride;
    },
    radar_refresh: async (input) => {
      const lane = input?.laneId === undefined ? undefined : lanes.find((candidate) => candidate.id === input.laneId);
      if (lane !== undefined) {
        await refreshLane(lane);
        if (isMentionLane(lane)) await syncMentions().catch((error: unknown) => bb.log.warn(`mention sync failed: ${String(error)}`));
      }
      else await refreshAll();
      return snapshot();
    },
    radar_lane_upsert: ({ lane }) => upsertLane(lane),
    radar_lane_delete: ({ laneId }) => deleteLane(laneId),
    radar_lanes_reorder: ({ ids }) => reorder(ids),
    radar_lanes_reset: async () => {
      await saveLanes(DEFAULT_LANES.map((lane) => ({ ...lane })));
      seen = {};
      await persistSeen();
      void refreshAll();
      return snapshot();
    },
    radar_acknowledge: async ({ key }) => {
      const eligible = lanes.filter(isMentionLane).some(lane => results[lane.id]?.items.some(item => item.key === key && item.source === "github"));
      if (!eligible || !mentions.acknowledge(key)) throw new UserError("This mention is no longer available to acknowledge. Refresh and try again.");
      await persistMentions();
      publish();
      // Do not make local clearing wait for GitHub. Failed writes remain queued for refresh.
      void syncMentions().catch(error => bb.log.warn(`mention sync failed: ${String(error)}`));
      return snapshot();
    },
    radar_hide_item: ({ key }) => hideItem(key),
    radar_unhide_item: async (input) => (await unhideItems("all" in input ? "all" : [input.key])).snapshot,
    radar_hidden_items: () => hiddenItems,
    radar_mark_seen: ({ laneId, view, kind }) => markSeen(laneId, view ?? (kind === "pr" ? "prs" : kind === "issue" ? "issues" : "all")),
    radar_draft: ({ description }) => draftLane(description),
    radar_scope: ({ op, keys }) => editScope(op, keys),
    radar_focus_describe: ({ description }) => describeFocus(description),
    radar_focus_set: ({ enabled }) => setFocusEnabled(enabled),
    radar_review_context: ({ key }) => reviewContext(key),
    radar_review_start: ({ key, request }) => startReview(key, request),
    radar_rebase: ({ source, repo, number }) => rebase({ source, repo, number }),
    radar_slack_draft: ({ key }) => slackDraftView(key),
    radar_slack_publish: ({ key, summary }) => publishSlack(key, summary),
    radar_slack_dismiss: ({ key }) => dismissSlack(key),
    radar_slack_check: async ({ key }) => {
      if (!slackEnabled()) throw new UserError("Slack context is off. Set the Slack endpoint and token command in Radar settings.");
      await checkSlackIssue(slackItem(key));
      publish();
      return snapshot();
    },
  });

  settings.onChange((values) => {
    if (disposed) return;
    const hadLabels = labelRepo();
    const hadDelta = JSON.stringify(hosts().delta);
    config = readConfig(values);
    applyHosts(config);
    if (JSON.stringify(hosts().delta) !== hadDelta) deltaMe = "";
    if (labelRepo() !== "" && labelRepo() !== hadLabels) void buildLabelIndex();
    slackToken = null;
    publish();
    wakeSleep?.();
    wakeSlack?.();
  });

  bb.background.service("poll", {
    async start(signal) {
      const maxAge = hosts().delta !== null ? 7 * 24 * 3_600_000 : 24 * 3_600_000;
      const stale = labelRepo() !== "" && (labelIndex === null || Date.now() - Date.parse(labelIndex.at) > maxAge);
      if (stale) void buildLabelIndex();
      await refreshAll();
      void pruneReviews()
        .then(backfillReviewSection)
        .catch((error) => bb.log.warn(`review prune/backfill failed: ${String(error)}`));
      while (!signal.aborted && !disposed) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            if (wakeSleep === finish) wakeSleep = undefined;
            resolve();
          };
          const timer = setTimeout(finish, config.refreshSeconds * 1000);
          wakeSleep = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
        if (signal.aborted || disposed) return;
        await refreshAll();
        void pruneReviews().catch((error) => bb.log.warn(`review prune failed: ${String(error)}`));
      }
    },
  });

  // ---- CLI ------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb radar status [--json]                  lane counts, new counts, errors",
    "  bb radar list [--lane <id>] [--view reviews|prs|issues|all] [--new] [--all] [--json]",
    "                                            --view: what that panel view shows; --all ignores the focus filter",
    "  bb radar lanes [--json]                   configured lanes, their view (category) and queries",
    "  bb radar add <description…> [--dry-run] [--json]  draft a lane with the LLM and add it",
    "  bb radar remove <lane-id>",
    "  bb radar seen [<lane-id>]                 mark items as seen",
    "  bb radar refresh",
    "  bb radar defaults                         add missing default lanes",
    "  bb radar put '<lane json>'                create or replace a lane (category inferred unless given; prints its id)",
    "  bb radar scopes [--json]                  repos (and area-repo areas) in results, with the focus filter",
    "  bb radar focus <description…> [--json]    e.g. \"no billing stuff\": AI picks repos/areas, Focus on",
    "  bb radar focus <repo|area>…               show only these (exact names)",
    "  bb radar focus --add <repo|area>…         add to the focus",
    "  bb radar focus --off | --on               turn Focus off (back to normal) / resume the last one",
    "  bb radar hide <repo|area>… [--json]       hide from every lane, view and the badge",
    "  bb radar show <repo|area>… [--json]       undo hide (adds to the focus while one is set)",
    "  bb radar hide-item <url|key> [--json]     hide one PR or issue everywhere until unhidden",
    "  bb radar unhide-item <url|key> | --all [--json]  bring hidden items back",
    "  bb radar hidden [--json]                  list items hidden one by one",
    "  bb radar slack [--json]                   Slack context drafts waiting for approval",
    "  bb radar slack-check <url|key> [--json]   check one GitHub issue against Slack now (drafts only; never posts)",
    "  bb radar rebase <url|owner/repo#n> [--source github|delta] --yes [--json]",
    "                                            rebase your own open PR (GitHub server-side; Delta via git)",
    "",
    "Repos are owner/name (or a unique tail, e.g. billing); areas of the area repo (a setting)",
    "are //<path> label keys (or a unique tail, e.g. mobile); no-area is that repo without an area label.",
    "hide/show work on whole repos/areas (Focus); hide-item/unhide-item on single items. An item hide",
    `lasts until undone; one whose item has been in no lane for ${HIDDEN_STALE_DAYS} days is dropped.`,
  ].join("\n");

  function describeLane(lane: Lane): string {
    const scope = lane.sources
      .map((source) => (source === "gitstream" ? `${SOURCE_LABEL.gitstream.toLowerCase()}: ${JSON.stringify(lane.gitstream ?? {})}` : `${source}: ${source === "delta" ? deltaQuery(lane.query ?? "") : lane.query}`))
      .join("\n" + "".padEnd(25));
    const filter = lane.filter === undefined ? "" : `  filter=${JSON.stringify(lane.filter)}`;
    const category = `[${lane.category}${lane.categoryPinned === true ? ", pinned" : ""}]`;
    return `${lane.id.padEnd(24)} ${lane.title}  ${category}\n${"".padEnd(25)}${scope}${filter}`;
  }

  bb.cli.register({
    name: "radar",
    summary: "Live PR/issue queues that need you (Delta and GitHub, plus optional read-only Gitstream history)",
    commands: [
      { name: "status", summary: "Per-lane counts", usage: "bb radar status [--json]" },
      { name: "list", summary: "List items", usage: "bb radar list [--lane <id>] [--view reviews|prs|issues|all] [--new] [--all] [--json]" },
      { name: "lanes", summary: "List configured lanes with their view (category)", usage: "bb radar lanes [--json]" },
      { name: "add", summary: "Draft a lane from a description and add it", usage: "bb radar add <description…> [--dry-run] [--json]" },
      { name: "remove", summary: "Remove a lane", usage: "bb radar remove <lane-id>" },
      { name: "seen", summary: "Mark items seen", usage: "bb radar seen [<lane-id>]" },
      { name: "refresh", summary: "Refetch every lane now", usage: "bb radar refresh" },
      { name: "put", summary: "Create or replace a lane from JSON; prints its id", usage: "bb radar put '<lane json>'" },
      { name: "defaults", summary: "Add any missing default lanes (keeps yours)", usage: "bb radar defaults" },
      { name: "scopes", summary: "Repos and areas in results, with the focus filter", usage: "bb radar scopes [--json]" },
      { name: "focus", summary: "Focus mode: describe it, or name repos/areas; --off / --on", usage: "bb radar focus <description…> | <repo|area>… | --add <…> | --off | --on [--json]" },
      { name: "hide", summary: "Hide repos/areas everywhere", usage: "bb radar hide <repo|area>… [--json]" },
      { name: "show", summary: "Unhide repos/areas", usage: "bb radar show <repo|area>… [--json]" },
      { name: "hide-item", summary: "Hide one PR or issue everywhere", usage: "bb radar hide-item <url|key|owner/repo#n> [--json]" },
      { name: "unhide-item", summary: "Unhide one item, or all", usage: "bb radar unhide-item <url|key|owner/repo#n> | --all [--json]" },
      { name: "hidden", summary: "List items hidden one by one", usage: "bb radar hidden [--json]" },
      { name: "slack", summary: "Slack context drafts waiting for approval (approve them in the panel)", usage: "bb radar slack [--json]" },
      { name: "slack-check", summary: "Check one GitHub issue against Slack now", usage: "bb radar slack-check <url|key|owner/repo#n> [--json]" },
      {
        name: "rebase",
        summary: "Rebase your own open PR onto its base (GitHub server-side, Delta via git replay + leased push; needs --yes)",
        usage: "bb radar rebase <PR url | owner/repo#number> [--source github|delta] [--yes] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "refresh":
            await refreshAll();
            return { exitCode: 0, stdout: `Refreshed ${lanes.length} lanes.` };
          case "status": {
            if (fetchedAt === "") await refreshAll();
            const board = boardResults();
            const focusHidden = new Set(Object.values(board).flatMap((result) => result.items).filter((item) => !visible(item)).map((item) => item.key));
            if (json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ ...snapshot(), scopeSummary: { active: isActive(scope), hiddenItems: focusHidden.size, newCount: newCount() } }),
              };
            }
            const lines = lanes.map((lane) => {
              const result = board[lane.id];
              const mine = result?.items ?? [];
              const shown = mine.filter(visible);
              const hidden = mine.length - shown.length;
              const fresh = shown.filter((item) => item.isNew).length;
              const notes = [fresh > 0 ? `${fresh} new` : "", hidden > 0 ? `${hidden} hidden` : ""].filter(Boolean).join(", ");
              const tail = result?.error ? `  ERROR: ${result.error}` : notes ? `  (${notes})` : "";
              return `${String(shown.length).padStart(3)}  ${lane.title} [${lane.id}]${tail}`;
            });
            const filterLine = isActive(scope)
              ? `focus: ON ${focusState.description ? `“${focusState.description}” → ` : ""}${describeScope(scope)} (${focusHidden.size} item${focusHidden.size === 1 ? "" : "s"} hidden; bb radar focus --off to turn off)`
              : isActive(focusState)
                ? `focus: off (last: ${focusState.summary || describeScope(focusState)}; bb radar focus --on to resume)`
                : "focus: off";
            const hiddenLine = hiddenItems.length > 0 ? [`hidden items: ${hiddenItems.length} (bb radar hidden)`] : [];
            return { exitCode: 0, stdout: [`fetched ${fetchedAt || "(never)"}`, filterLine, ...hiddenLine, ...lines].join("\n") };
          }
          case "list": {
            if (fetchedAt === "") await refreshAll();
            const laneIndex = rest.indexOf("--lane");
            const laneId = laneIndex >= 0 ? rest[laneIndex + 1] : undefined;
            const viewIndex = rest.indexOf("--view");
            const viewArg = viewIndex >= 0 ? rest[viewIndex + 1] : undefined;
            if ((laneIndex >= 0 && laneId === undefined) || (viewIndex >= 0 && viewArg === undefined)) {
              return { exitCode: 1, stderr: "Usage: bb radar list [--lane <id>] [--view <view>] [--new] [--all] [--json]" };
            }
            if (laneId !== undefined && !lanes.some((lane) => lane.id === laneId)) {
              return { exitCode: 1, stderr: `No lane "${laneId}". Run bb radar lanes.` };
            }
            if (viewArg !== undefined && !(CATEGORIES as readonly string[]).includes(viewArg)) {
              return { exitCode: 1, stderr: `--view must be one of ${CATEGORIES.join(", ")}.` };
            }
            const view = (viewArg ?? "all") as View;
            const onlyNew = rest.includes("--new");
            const everything = rest.includes("--all");
            const board = boardResults();
            const rows = lanes
              .filter((lane) => (laneId === undefined || lane.id === laneId) && laneInView(lane, view))
              .flatMap((lane) =>
                (board[lane.id]?.items ?? [])
                  .filter((item) => itemInView(item, view) && (!onlyNew || item.isNew) && (everything || visible(item)))
                  .map((item) => ({ lane: lane.id, ...item })),
              );
            if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
            if (rows.length === 0) return { exitCode: 0, stdout: "Nothing here." };
            const shown = rows.slice(0, CLI_ROW_LIMIT).map(
              (row) =>
                `${row.isNew ? "*" : " "} ${row.lane.padEnd(18).slice(0, 18)} ${`${row.repo}#${row.number}`.padEnd(30)} ${row.title.slice(0, 80)}  ${row.url}`,
            );
            if (rows.length > CLI_ROW_LIMIT) shown.push(`… ${rows.length - CLI_ROW_LIMIT} more (use --json)`);
            return { exitCode: 0, stdout: shown.join("\n") };
          }
          case "defaults": {
            const missing = missingDefaults(lanes);
            if (missing.length === 0) return { exitCode: 0, stdout: "All default lanes are present." };
            await saveLanes([...lanes, ...missing.map((lane) => ({ ...lane }))]);
            publish();
            void refreshAll();
            return { exitCode: 0, stdout: `Added ${missing.map((lane) => lane.id).join(", ")}.` };
          }
          case "lanes":
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(lanes) : lanes.map(describeLane).join("\n"),
            };
          case "add": {
            const dryRun = rest.includes("--dry-run");
            const description = rest.filter((arg) => arg !== "--dry-run").join(" ").trim();
            if (description.length < 3) return { exitCode: 1, stderr: "Describe what to track." };
            if (description.length > MAX_DESCRIPTION) return { exitCode: 1, stderr: DESCRIPTION_TOO_LONG };
            const draft = await draftLane(description);
            if (!dryRun) await upsertLane(draft.lane);
            const preview = draft.preview.error
              ? `preview error: ${draft.preview.error}`
              : `${draft.preview.items.length} item(s) match now`;
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(draft)
                : `${dryRun ? "Drafted (not added)" : "Added"}:\n${describeLane(draft.lane)}\n${preview}`,
            };
          }
          case "put": {
            // Agent/scripting path: upsert one lane from JSON (same schema as `bb radar lanes --json`).
            let lane: unknown;
            try {
              lane = JSON.parse(rest.join(" "));
            } catch {
              return { exitCode: 1, stderr: "Usage: bb radar put '<lane json>'" };
            }
            let id: string;
            try {
              id = await putLane(lane);
            } catch (error) {
              return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
            }
            return { exitCode: 0, stdout: `Saved ${id}.` };
          }
          case "remove": {
            const id = rest[0];
            if (id === undefined || !lanes.some((lane) => lane.id === id)) {
              return { exitCode: 1, stderr: `No lane "${id ?? ""}". Run bb radar lanes.` };
            }
            await deleteLane(id);
            return { exitCode: 0, stdout: `Removed ${id}.` };
          }
          case "seen":
            if (rest[0] !== undefined && !lanes.some((lane) => lane.id === rest[0])) {
              return { exitCode: 1, stderr: `No lane "${rest[0]}". Run bb radar lanes.` };
            }
            await markSeen(rest[0]);
            return { exitCode: 0, stdout: "Marked seen." };
          case "scopes": {
            if (fetchedAt === "") await refreshAll();
            const entries = catalog();
            if (json) return { exitCode: 0, stdout: JSON.stringify({ filter: scope, focus: focusState, scopes: entries }) };
            const row = (entry: ScopeEntry, indent: string) => {
              const mark = entry.state === "hidden" ? "-" : entry.state === "unfocused" ? "·" : entry.state === "focused" ? "*" : " ";
              const counts = `${entry.total}${entry.fresh > 0 ? ` (${entry.fresh} new)` : ""}${entry.hiddenItems > 0 ? ` [${entry.hiddenItems} hidden]` : ""}`;
              return `${mark} ${indent}${entry.key.padEnd(40 - indent.length)} ${counts}`;
            };
            const lines = entries.flatMap((entry) => [row(entry, ""), ...(entry.children ?? []).map((child) => row(child, "  "))]);
            return {
              exitCode: 0,
              stdout: [`filter: ${describeScope(scope)}   (* focused, · outside focus, - hidden)`, ...lines].join("\n"),
            };
          }
          case "focus":
          case "hide":
          case "show": {
            if (fetchedAt === "") await refreshAll();
            const flags = new Set(["--clear", "--off", "--on", "--add"]);
            const names = rest.filter((arg) => !flags.has(arg));
            if (command === "focus" && (rest.includes("--off") || rest.includes("--clear"))) await setFocusEnabled(false);
            else if (command === "focus" && rest.includes("--on")) await setFocusEnabled(true);
            else if (names.length === 0) {
              return { exitCode: 1, stderr: `Usage: bb radar ${command} ${command === "focus" ? "<description…> | <repo|area>… | --on | --off" : "<repo|area>…"}` };
            } else if (command === "focus" && !rest.includes("--add")) {
              // Exact repo/area names focus on them; anything else is a description.
              let keys: string[] | null;
              try {
                keys = resolveScopes(names);
              } catch {
                keys = null;
              }
              if (keys !== null) await editScope("focus", keys);
              else if (names.join(" ").length > MAX_DESCRIPTION) return { exitCode: 1, stderr: DESCRIPTION_TOO_LONG };
              else await describeFocus(names.join(" "));
            } else {
              await editScope(command === "focus" ? "add-focus" : (command as ScopeOp), resolveScopes(names));
            }
            const hidden = new Set(shownItems().filter((item) => !visible(item)).map((item) => item.key)).size;
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(focusState)
                : isActive(scope)
                  ? `Focus on: ${describeScope(scope)} (${hidden} hidden)`
                  : "Focus off: showing everything.",
            };
          }
          case "hide-item": {
            if (rest.length !== 1) return { exitCode: 1, stderr: "Usage: bb radar hide-item <url|key|owner/repo#n>" };
            if (fetchedAt === "") await refreshAll();
            // Board items, plus hidden ones so re-hiding says "Already hidden".
            const key = cliItemKey(rest[0]!, [...shownItems(), ...hiddenItems]);
            const already = hiddenKeys.has(normKey(key));
            await hideItem(key);
            const entry = hiddenItems.find((candidate) => normKey(candidate.key) === normKey(key));
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(entry ?? null) : `${already ? "Already hidden" : "Hidden"}: ${key}${entry?.title ? `  ${entry.title.slice(0, 80)}` : ""}`,
            };
          }
          case "unhide-item": {
            const all = rest.includes("--all");
            const positional = rest.filter((arg) => arg !== "--all");
            if (all === (positional.length > 0) || positional.length > 1) {
              return { exitCode: 1, stderr: "Usage: bb radar unhide-item <url|key|owner/repo#n> | --all" };
            }
            const { removed } = all ? await unhideItems("all") : await unhideItems([cliItemKey(positional[0]!, hiddenItems)]);
            if (!all && removed.length === 0) return { exitCode: 1, stderr: `${positional[0]} is not hidden. Run bb radar hidden.` };
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(removed) : all ? `Unhid ${removed.length} item${removed.length === 1 ? "" : "s"}.` : `Unhid ${removed[0]!.key}.`,
            };
          }
          case "hidden": {
            if (json) return { exitCode: 0, stdout: JSON.stringify(hiddenItems) };
            if (hiddenItems.length === 0) return { exitCode: 0, stdout: "No hidden items." };
            return {
              exitCode: 0,
              stdout: hiddenItems
                .map((entry) => `${entry.hiddenAt.slice(0, 10)}  ${entry.key.padEnd(40)} ${entry.title.slice(0, 70)}  ${entry.url}`)
                .join("\n"),
            };
          }
          case "slack": {
            const state = slackState();
            const drafts = Object.keys(state.drafts).map((key) => slackDraftView(key));
            if (json) return { exitCode: 0, stdout: JSON.stringify({ ...state, drafts }) };
            if (!state.enabled) return { exitCode: 0, stdout: "Slack context is off (set the Slack endpoint and token command in Radar settings)." };
            const head = [`last sweep ${state.sweptAt || "(not yet)"}${state.error ? `  ERROR: ${state.error}` : ""}`];
            if (drafts.length === 0) return { exitCode: 0, stdout: [...head, "No drafts waiting."].join("\n") };
            return {
              exitCode: 0,
              stdout: [
                ...head,
                ...drafts.map((draft) => `${draft.repo}#${draft.number}  ${draft.title.slice(0, 70)}\n  ${draft.summary.replace(/\n/g, "\n  ")}\n  sources: ${draft.sources.map((source) => `#${source.channelName}`).join(", ")}`),
                "Approve, edit or dismiss them in the Radar panel.",
              ].join("\n"),
            };
          }
          case "slack-check": {
            if (!slackEnabled()) return { exitCode: 1, stderr: "Slack context is off. Set the Slack endpoint and token command in Radar settings." };
            if (rest[0] === undefined) return { exitCode: 1, stderr: "Usage: bb radar slack-check <url|key|owner/repo#n>" };
            if (fetchedAt === "") await refreshAll();
            const key = cliItemKey(rest[0], slackCandidates());
            const drafted = await checkSlackIssue(slackItem(key));
            publish();
            if (json) return { exitCode: 0, stdout: JSON.stringify({ key, draft: drafted ? slackDraftView(key) : null, threads: slackThreads(key).length }) };
            const threads = slackThreads(key).length;
            return { exitCode: 0, stdout: drafted ? `Draft ready (${threads} thread${threads === 1 ? "" : "s"}); review it in the Radar panel.` : `No new Slack context (${threads} linked thread${threads === 1 ? "" : "s"}).` };
          }
          case "rebase": {
            const sourceIndex = rest.indexOf("--source");
            const sourceFlag = sourceIndex >= 0 ? rest[sourceIndex + 1] : undefined;
            const positional = rest.filter((arg, index) => !arg.startsWith("--") && (sourceIndex < 0 || index !== sourceIndex + 1));
            if (positional.length !== 1 || (sourceIndex >= 0 && (sourceFlag === undefined || sourceFlag.startsWith("--")))) {
              return { exitCode: 1, stderr: "Usage: bb radar rebase <PR url | owner/repo#number> [--source github|delta] [--yes]" };
            }
            if (fetchedAt === "") await refreshAll();
            const target = resolveRebaseTarget(positional[0]!, sourceFlag);
            const name = `${SOURCE_LABEL[target.source]} ${target.repo}#${target.number}`;
            if (!rest.includes("--yes")) {
              return {
                exitCode: 1,
                stderr: `This rewrites the remote branch of ${name}. Re-run with --yes to rebase it onto its base.`,
              };
            }
            const result = await rebase(target);
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify({ ...target, ...result }) : `${name}: ${result.message} (head ${result.headSha.slice(0, 12)})`,
            };
          }
          default:
            return { exitCode: 1, stderr: usage };
        }
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  bb.onDispose(async () => {
    disposed = true;
    controller.abort();
    wakeSleep?.();
    wakeSlack?.();
    if (publishTimer !== undefined) clearTimeout(publishTimer);
    await inFlight?.catch(() => undefined);
    await slackSweep?.catch(() => undefined);
  });
}
