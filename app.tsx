// bb-plugin-radar — panel frontend. Compiled by `bb plugin build`.
import { createContext, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_ProviderModelPicker as ProviderModelPicker,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DraftResult, HiddenEntry, Lane, LaneResult, RadarItem, RadarSnapshot, RebaseResult, ReviewContext, rpcContract, SlackDraftView } from "./server";
import type { NewThreadComposerProps, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { mountRailBadge } from "./badge";
import type { AiOverride } from "./ai";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { CATEGORY_LABEL, enabledSources, itemInView, laneInView, moveInView, SOURCE_LABEL, SOURCES, viewFrom, VIEWS, type Category, type Source, type View } from "./lanes";

const sourceHint = (source: Source): string => {
  const { gitstream, delta } = hosts();
  if (source === "gitstream") {
    return gitstream === null
      ? "Read-only history, off: turn on Gitstream history in Settings → Plugins → Radar"
      : `${gitstream.repo} · gs · read-only history (no PR writes)`;
  }
  if (source === "delta") return delta === null ? "Not set up: add a Delta host and repo in Settings → Plugins → Radar" : `${delta.repo} · dt`;
  return "github.com";
};
import { displayLabels } from "./lanes";
import { hosts, setHosts } from "./hosts";
import { describeScope, EMPTY_SCOPE, isActive, scopeCatalog, scopePredicate, type FocusState, type ScopeEntry, type ScopeFilter, type ScopeOp } from "./scope";
import { Glyph, type GlyphName } from "./glyphs";
import { canRebase, rebaseHelp, type Viewer } from "./rebase";
import { DEFAULT_SKILL_SETTINGS, threadSkills, type SkillSettings } from "./review-skills";
import { summarizeLane } from "./lane-summary";
import { draftCategory, draftInferredCategory, fromDraft, gitstreamScoped, pickCategory, toDraft, type Draft, type ListKey } from "./lane-draft";
import { applyPending, type PendingOp } from "./optimistic";
import { createEscapeStack } from "./escape";
import "./app.css";

const escapes = createEscapeStack();
const onEscapeKey = (event: KeyboardEvent) => void escapes.handle(event);
/** While `active`, Escape runs `handler` if this is the most recently opened Radar surface. */
function useEscape(active: boolean, handler: () => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    const off = escapes.push(() => latest.current());
    if (escapes.size === 1) window.addEventListener("keydown", onEscapeKey);
    return () => {
      off();
      if (escapes.size === 0) window.removeEventListener("keydown", onEscapeKey);
    };
  }, [active]);
}

const LANE_PREVIEW = 8;

function relative(stamp: string): string {
  const time = Date.parse(stamp);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function shortAuthor(author: string): string {
  return author.replace(/@.*\.iam\.gserviceaccount\.com$/, " (bot)").replace(/@[^@\s]+$/, "");
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useRadar() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<RadarSnapshot | null>(null);
  const [error, setError] = useState("");
  const call = useCallback(
    async <T,>(promise: Promise<T>): Promise<T | null> => {
      try {
        const result = await promise;
        setError("");
        return result;
      } catch (cause) {
        setError(errorText(cause));
        return null;
      }
    },
    [],
  );
  // Hosts are module state shared with the lane helpers, so set them before the render that reads them.
  // Ops sent but not yet answered. Each server snapshot is shown with them re-applied,
  // so the board changes on click and a refetch racing the RPC can't bring items back.
  const pending = useRef(new Set<PendingOp>());
  const latest = useRef<RadarSnapshot | null>(null);
  const show = useCallback(() => {
    if (latest.current !== null) setSnapshot(applyPending(latest.current, pending.current));
  }, []);
  const apply = useCallback((next: RadarSnapshot) => {
    if (next.hosts !== undefined) setHosts(next.hosts);
    latest.current = next;
    show();
  }, [show]);
  const refetch = useCallback(() => {
    void call(rpc.call("radar_snapshot", null) as Promise<RadarSnapshot>).then((next) => {
      if (next !== null) apply(next);
    });
  }, [rpc, call, apply]);
  useEffect(refetch, [refetch]);
  useRealtime("radar-changed", refetch);
  const mutate = useCallback(
    async (promise: Promise<unknown>) => {
      const next = (await call(promise)) as RadarSnapshot | null;
      if (next !== null && Array.isArray(next.lanes)) apply(next);
      return next;
    },
    [call, apply],
  );
  /** Shows `op` at once, then settles on the server's answer (or reverts if the call fails). */
  const optimistic = useCallback(
    async (op: PendingOp, promise: Promise<unknown>) => {
      pending.current.add(op);
      show();
      try {
        return await mutate(promise);
      } finally {
        pending.current.delete(op);
        show();
      }
    },
    [mutate, show],
  );
  return { rpc, snapshot, error, setError, mutate, call, optimistic };
}

// ---------------------------------------------------------------------------

/** "Describe what to track" box visibility, shared by the title-bar sparkle and the board. */
const trackBox = (() => {
  let open = false;
  const listeners = new Set<() => void>();
  return {
    get: () => open,
    set: (next: boolean) => {
      if (next === open) return;
      open = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

const useTrackBoxOpen = () => useSyncExternalStore(trackBox.subscribe, trackBox.get);

/** Present inside lanes only; draft previews have no review action. */
const ReviewActions = createContext<{
  threadFor: (key: string) => string | undefined;
  review: (item: RadarItem) => void;
  acknowledge: (item: RadarItem) => void;
  hide: (item: RadarItem) => void;
  open: (threadId: string) => void;
  viewer: Viewer;
  rebase: (item: RadarItem) => Promise<RebaseResult>;
  skills: SkillSettings;
  /** Slack context: off, or whether a draft waits for this item. */
  slack: (item: RadarItem) => "off" | "draft" | "check";
  openSlack: (item: RadarItem) => void;
  checkSlack: (item: RadarItem) => Promise<void>;
} | null>(null);

/** Pulse-style row action: icon button with a hover/focus tooltip (data-tip). */
function ActionIcon({ icon, label, tip, onClick }: { icon: GlyphName; label: string; tip?: string; onClick: () => void }) {
  return (
    <button type="button" className="radar-act" aria-label={label} data-tip={tip ?? label} onClick={onClick}>
      <Glyph name={icon} className="radar-act__icon" />
    </button>
  );
}

type RebaseState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "busy" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

/** Rebase → inline "Rebase onto base?" Confirm/Cancel → busy → result, all on the row. */
function RebaseAction({ item, rebase, onActive }: { item: RadarItem; rebase: (item: RadarItem) => Promise<RebaseResult>; onActive: (active: boolean) => void }) {
  const [state, setState] = useState<RebaseState>({ phase: "idle" });
  useEffect(() => onActive(state.phase !== "idle"), [state.phase, onActive]);
  const reset = () => setState({ phase: "idle" });
  const confirm = () => {
    setState({ phase: "busy" });
    rebase(item).then(
      (result) => setState({ phase: "done", message: result.status === "up-to-date" ? "Up to date" : "Rebased" }),
      (cause) => setState({ phase: "error", message: errorText(cause) }),
    );
  };
  switch (state.phase) {
    case "idle":
      return (
        <ActionIcon icon="rebase" label="Rebase onto base" tip={rebaseHelp(item.source)} onClick={() => setState({ phase: "confirm" })} />
      );
    case "confirm":
      return (
        <span className="radar-item__confirm" role="group" aria-label="Confirm rebase">
          <span className="radar-item__prompt">Rebase onto base?</span>
          <button type="button" className="radar-item__rebase radar-item__rebase--go" title="Rewrites the remote branch" onClick={confirm} autoFocus>
            Confirm
          </button>
          <button type="button" className="radar-item__rebase" onClick={reset}>
            Cancel
          </button>
        </span>
      );
    case "busy":
      return (
        <button type="button" className="radar-item__rebase" disabled aria-busy="true">
          Rebasing…
        </button>
      );
    case "done":
      return (
        <button type="button" className="radar-item__rebase radar-item__rebase--ok" title="Dismiss" onClick={reset}>
          {state.message}
        </button>
      );
    case "error":
      return (
        <button type="button" className="radar-item__rebase radar-item__rebase--fail" title={`${state.message} (click to dismiss)`} onClick={reset}>
          {state.message.length > 48 ? `${state.message.slice(0, 47)}…` : state.message}
        </button>
      );
  }
}

/** Slack context on a GitHub issue row: a marked icon when a draft waits, else "check now". */
function SlackAction({ item }: { item: RadarItem }) {
  const actions = useContext(ReviewActions);
  const [busy, setBusy] = useState(false);
  const mode = actions?.slack(item) ?? "off";
  if (actions === null || mode === "off") return null;
  if (mode === "draft") {
    return (
      <span className="radar-act-wrap" data-slack-draft="">
        <ActionIcon icon="slack" label="Review Slack context update" tip="Slack context update ready: review before it posts" onClick={() => actions.openSlack(item)} />
      </span>
    );
  }
  return busy ? (
    <span className="radar-act" aria-busy="true" aria-label="Checking Slack">
      <Glyph name="spinner" className="radar-act__icon radar-spin" />
    </span>
  ) : (
    <ActionIcon
      icon="slack"
      label="Check Slack for this issue"
      tip="Check public Slack threads that link this issue (drafts only; nothing posts)"
      onClick={() => {
        setBusy(true);
        void actions.checkSlack(item).finally(() => setBusy(false));
      }}
    />
  );
}

function ItemRow({ item }: { item: RadarItem }) {
  const labels = displayLabels(item.labels);
  const actions = useContext(ReviewActions);
  const threadId = actions?.threadFor(item.key);
  const [rebaseActive, setRebaseActive] = useState(false);
  const showRebase = actions !== null && canRebase(item, actions.viewer);
  return (
    <li className="radar-item" data-new={item.isNew || undefined}>
      <span className="radar-item__dot" aria-hidden="true" />
      <Glyph name={item.kind === "pr" ? "pr" : "issue"} className="radar-item__kind" />
      <div className="radar-item__main">
        <UrlLink className="radar-item__title" href={item.url}>
          {item.isNew ? <span className="radar-sr">New: </span> : null}
          {item.title}
        </UrlLink>
        <div className="radar-item__meta">
          <span className="radar-mono">
            {item.repo}#{item.number}
          </span>
          {item.source !== "github" ? <span className="radar-chip radar-chip--muted">{SOURCE_LABEL[item.source]}</span> : null}
          <span>{shortAuthor(item.author)}</span>
          {item.draft ? <span className="radar-chip radar-chip--muted">draft</span> : null}
          {labels.map((label) => (
            <span key={label} className="radar-chip">
              {label}
            </span>
          ))}
        </div>
      </div>
      {actions !== null ? (
        <span className="radar-item__actions" data-active={rebaseActive || undefined}>
          <ActionIcon icon="eyeOff" label="Hide from Radar" tip="Hide from Radar" onClick={() => actions.hide(item)} />
          {item.canAcknowledge ? <ActionIcon icon="check" label="Acknowledge" tip="Clear this mention and mark its GitHub notification read" onClick={() => actions.acknowledge(item)} /> : null}
          {showRebase ? <RebaseAction item={item} rebase={actions.rebase} onActive={setRebaseActive} /> : null}
          <SlackAction item={item} />
          {threadId !== undefined ? (
            <ActionIcon icon="external" label="Open thread" tip="Open the bb thread started for this" onClick={() => actions.open(threadId)} />
          ) : null}
          <ActionIcon
            icon="bot"
            label="Start agent thread"
            tip={`${threadId !== undefined ? "Start a new agent thread" : "Start agent thread"} \u00b7 skills: ${threadSkills(item, actions.skills).join(", ")}`}
            onClick={() => actions.review(item)}
          />
        </span>
      ) : null}
      <time className="radar-item__age" title={item.updatedAt}>
        {relative(item.updatedAt)}
      </time>
    </li>
  );
}

/** Title-bar tab glyphs; VIEWS sets the order. Old board/prs and board/issues routes keep working. */
const VIEW_GLYPH: Record<View, GlyphName> = { reviews: "review", prs: "pr", issues: "issue", all: "stack" };

const scopeOf = (snapshot: RadarSnapshot | null): ScopeFilter => snapshot?.scope ?? EMPTY_SCOPE;

/** Every unique item of one view (focus filter not applied). */
function viewItems(snapshot: RadarSnapshot | null, view: View): RadarItem[] {
  const keys = new Set<string>();
  const out: RadarItem[] = [];
  for (const lane of snapshot?.lanes ?? []) {
    if (!laneInView(lane, view)) continue;
    for (const item of snapshot?.results[lane.id]?.items ?? []) {
      if (!itemInView(item, view) || keys.has(item.key)) continue;
      keys.add(item.key);
      out.push(item);
    }
  }
  return out;
}

/** Unique items, unseen ones, and focus-hidden ones per view across all lanes. */
function viewTotals(snapshot: RadarSnapshot | null): Record<View, { items: number; fresh: number; hidden: number }> {
  const visible = scopePredicate(scopeOf(snapshot));
  const total = (view: View) => {
    const counts = { items: 0, fresh: 0, hidden: 0 };
    for (const item of viewItems(snapshot, view)) {
      if (!visible(item)) counts.hidden++;
      else {
        counts.items++;
        if (item.isNew) counts.fresh++;
      }
    }
    return counts;
  };
  return Object.fromEntries(VIEWS.map((view) => [view, total(view)])) as Record<View, { items: number; fresh: number; hidden: number }>;
}

// ---------------------------------------------------------------------------
// Focus filter: hide repos (and area-repo areas) across every lane and view.

function ScopeRow({
  entry,
  child,
  onOp,
}: {
  entry: ScopeEntry;
  child?: boolean;
  onOp: (op: ScopeOp, keys: string[]) => void;
}) {
  const off = entry.state === "hidden" || entry.state === "unfocused";
  const label = child ? entry.label.replace(/^[^/]+\//, "") : entry.label;
  const name = label;
  return (
    <li className="radar-scope__row" data-off={off || undefined} data-child={child || undefined} data-state={entry.state}>
      <button
        type="button"
        className="radar-scope__toggle"
        role="switch"
        aria-checked={!off}
        aria-label={off ? `Show ${entry.label}` : `Hide ${entry.label}`}
        onClick={() => onOp(off ? "show" : "hide", [entry.key])}
      >
        <Glyph name={off ? "eyeOff" : "eye"} className="radar-scope__eye" />
        <span className="radar-scope__name" title={entry.label}>{name}</span>
      </button>
      <button
        type="button"
        className="radar-scope__only"
        aria-label={`Show only ${entry.label}`}
        onClick={() => onOp("focus", [entry.key])}
      >
        Only
      </button>
      <span className="radar-scope__counts">
        {entry.fresh > 0 ? <span className="radar-scope__new">{entry.fresh} new</span> : null}
        <span>{entry.total}</span>
      </span>
    </li>
  );
}

function FocusControl({
  view,
  onView,
  counts,
  entries,
  state,
  hidden,
  aiAvailable,
  onOp,
  onDescribe,
  onSet,
}: {
  view: View;
  onView: (view: View) => void;
  /** Per-view counts for the view tooltips; undefined until the first snapshot. */
  counts: Record<View, { items: number; fresh: number }> | undefined;
  entries: ScopeEntry[];
  state: FocusState | undefined;
  hidden: number;
  aiAvailable: boolean;
  onOp: (op: ScopeOp, keys: string[]) => void;
  onDescribe: (description: string) => Promise<boolean>;
  onSet: (enabled: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const on = state?.enabled === true && isActive(state);
  const resumable = state !== undefined && !state.enabled && isActive(state);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => { setMenuOpen(false); setOpen(false); };
    const onDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.(".radar-filter")) close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);
  useEscape(menuOpen, () => {
    if (open) {
      setOpen(false);
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".radar-filter__zen")?.focus());
    } else {
      setMenuOpen(false);
      document.querySelector<HTMLButtonElement>(".radar-filter__trigger")?.focus();
    }
  });
  const submit = () => {
    if (text.trim().length < 2 || busy) return;
    setBusy(true);
    void onDescribe(text.trim()).then((ok) => {
      setBusy(false);
      if (ok) {
        setText("");
        setOpen(false);
      }
    });
  };
  return (
    <div className="radar-scope radar-filter">
      <button
        type="button"
        className="radar-btn radar-focus radar-filter__trigger"
        data-on={on || view !== "all" || undefined}
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        aria-label={`Filter: ${CATEGORY_LABEL[view]}${on ? ", Zen active" : ""}`}
        onClick={() => { setMenuOpen((value) => !value); setOpen(false); }}
      >
        <span>Filter</span>
        <svg className="radar-filter__chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        {on || view !== "all" ? <span className="radar-views__dot" aria-hidden="true" /> : null}
      </button>
      {menuOpen ? (
        <div className={`radar-scope__pop radar-filter__pop${open ? " radar-filter__pop--zen" : ""}`} role="dialog" aria-label="Filter">
          {!open ? <div className="radar-filter__main">
          <div className="radar-scope__section radar-filter__views">
            {(["all", "prs", "issues", "reviews"] as View[]).map((value) => (
              <button key={value} type="button" className="radar-scope__item" aria-pressed={view === value}
                title={counts === undefined ? undefined : `${counts[value].items} item${counts[value].items === 1 ? "" : "s"}${counts[value].fresh > 0 ? ` · ${counts[value].fresh} new` : ""}`}
                onClick={() => { onView(value); setMenuOpen(false); setOpen(false); }}>
                <span className="radar-scope__name">{CATEGORY_LABEL[value]}</span>
                <span className="radar-filter__check" aria-hidden="true">{view === value ? "✓" : ""}</span>
              </button>
            ))}
          </div>
          <div className="radar-scope__section">
            <button type="button" className="radar-scope__item radar-filter__zen" aria-expanded={open}
              onClick={() => setOpen((value) => !value)}>
              <span className="radar-scope__name">Zen</span>
              {on ? <span className="radar-views__dot" aria-label="Active" /> : null}
              <span aria-hidden="true">›</span>
            </button>
          </div>
          </div> : null}
      {open ? (
        <div className="radar-filter__submenu" role="group" aria-label="Zen">
          <button type="button" className="radar-scope__item radar-filter__back"
            onClick={() => {
              setOpen(false);
              requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".radar-filter__zen")?.focus());
            }}>
            <span aria-hidden="true">‹</span>
            <span>Back</span>
            <span className="radar-filter__back-title">Zen</span>
          </button>
          <form
            className="radar-scope__ask"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Glyph name={busy ? "spinner" : "sparkles"} className={busy ? "radar-icon radar-spin" : "radar-icon radar-scope__spark"} />
            <input
              className="radar-scope__input"
              autoFocus
              value={text}
              disabled={busy}
              aria-label="What would help you focus?"
              placeholder={on ? "Refocus… e.g. only the mobile app" : "What would help you focus?"}
              onChange={(event) => setText(event.target.value)}
            />
            {text.trim().length >= 2 && !busy ? <kbd className="radar-scope__kbd">↵</kbd> : null}
          </form>
          {on || resumable ? (
            <div className="radar-scope__section">
              {on ? (
                <div className="radar-scope__current">
                  <Glyph name="zen" className="radar-icon" />
                  <span className="radar-scope__current-text">{state?.summary || describeScope(state!)}</span>
                  {hidden > 0 ? <span className="radar-scope__muted" title="Items this focus leaves out">{hidden} filtered out</span> : null}
                  <button type="button" className="radar-scope__action" onClick={() => onSet(false)}>
                    Turn off
                  </button>
                </div>
              ) : (
                <button type="button" className="radar-scope__item" onClick={() => onSet(true)} title={state?.description}>
                  <Glyph name="refresh" className="radar-icon" />
                  <span className="radar-scope__name">Resume “{state?.summary || describeScope(state!)}”</span>
                </button>
              )}
            </div>
          ) : null}
          <div className="radar-scope__section">
            <div className="radar-scope__label">Repositories in this view</div>
            {entries.length === 0 ? <p className="radar-scope__empty">Nothing on the board yet.</p> : null}
            <ul className="radar-scope__list">
              {entries.map((entry) => (
                <ScopeGroup key={entry.key} entry={entry} onOp={onOp} />
              ))}
            </ul>
          </div>
          {!aiAvailable ? <p className="radar-scope__foot">AI unavailable: descriptions match repo and area names only.</p> : null}
        </div>
      ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ScopeGroup({ entry, onOp }: { entry: ScopeEntry; onOp: (op: ScopeOp, keys: string[]) => void }) {
  return (
    <>
      <ScopeRow entry={entry} onOp={onOp} />
      {(entry.children ?? []).map((child) => (
        <ScopeRow key={child.key} entry={child} child onOp={onOp} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// The just-hidden item's Undo lives in the title bar (navPanel headerContent), a separate
// component from the board, so the board publishes it through this small store.

type UndoNotice = { key: string; title: string; undo: () => void };
const undoNotice = (() => {
  let current: UndoNotice | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next: UndoNotice | null) => { current = next; listeners.forEach((listener) => listener()); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
})();

function RadarHeader() {
  const notice = useSyncExternalStore(undoNotice.subscribe, undoNotice.get, undoNotice.get);
  return (
    <span className="radar-header-anchor">
      {notice !== null ? (
        <span className="radar radar-header-undo" role="status">
          <span className="radar-header-undo__text" title={notice.title}>Hidden</span>
          <button type="button" className="radar-scope__action" onClick={notice.undo}>Undo</button>
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Items hidden one by one (row "Hide from Radar"); separate from Focus, which hides repos/areas.

function HiddenControl({
  count,
  revision,
  load,
  onUnhide,
}: {
  count: number;
  /** Changes when a hide settles on the server, so one that lands after opening shows up. */
  revision: number;
  load: () => Promise<HiddenEntry[] | null>;
  onUnhide: (key: string | "all") => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HiddenEntry[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void load().then((list) => { if (active && list !== null) setEntries(list); });
    return () => { active = false; };
  }, [open, count, revision, load]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.(".radar-hidden")) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  useEscape(open, () => {
    setOpen(false);
    document.querySelector<HTMLButtonElement>(".radar-hidden__trigger")?.focus();
  });
  useEffect(() => { if (count === 0) setOpen(false); }, [count]);
  if (count === 0 && !open) return null;
  const unhide = (key: string | "all") => {
    setEntries((list) => (list === null ? list : key === "all" ? [] : list.filter((entry) => entry.key !== key)));
    // A failed unhide leaves the count unchanged, so the effect above won't reload; do it here.
    void onUnhide(key).then((ok) => {
      if (!ok) void load().then((list) => { if (list !== null) setEntries(list); });
    });
  };
  const tip = `${count} item${count === 1 ? "" : "s"} hidden from Radar`;
  return (
    <div className="radar-scope radar-hidden">
      {count > 0 ? (
        <button
          type="button"
          className="radar-icon-btn radar-hidden__trigger"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={tip}
          title={tip}
          onClick={() => setOpen((value) => !value)}
        >
          <Glyph name="eyeOff" className="radar-icon" />
          <span className="radar-hidden__count">{count}</span>
        </button>
      ) : null}
      {open ? (
        <div className="radar-scope__pop radar-hidden__pop" role="dialog" aria-label="Hidden items">
          <div className="radar-scope__label radar-hidden__head">
            <span>Hidden from Radar</span>
            {(entries?.length ?? 0) > 1 ? (
              <button type="button" className="radar-scope__action" onClick={() => unhide("all")}>Unhide all</button>
            ) : null}
          </div>
          {entries === null ? <p className="radar-scope__empty">Loading…</p> : null}
          {entries !== null && entries.length === 0 ? <p className="radar-scope__empty">Nothing hidden.</p> : null}
          <ul className="radar-scope__list">
            {(entries ?? []).map((entry) => (
              <li key={entry.key} className="radar-hidden__row">
                <Glyph name={entry.kind === "pr" ? "pr" : "issue"} className="radar-icon radar-hidden__kind" />
                <span className="radar-hidden__main">
                  {entry.url !== "" ? (
                    <UrlLink className="radar-hidden__title" href={entry.url}>{entry.title || `#${entry.number}`}</UrlLink>
                  ) : (
                    <span className="radar-hidden__title">{entry.title || `#${entry.number}`}</span>
                  )}
                  <span className="radar-hidden__meta radar-mono" title={`Hidden ${entry.hiddenAt.slice(0, 10)}`}>
                    {entry.repo}#{entry.number}{entry.source !== "github" ? ` · ${SOURCE_LABEL[entry.source]}` : ""}
                  </span>
                </span>
                <button type="button" className="radar-scope__action" aria-label={`Unhide ${entry.repo}#${entry.number}`} onClick={() => unhide(entry.key)}>
                  Unhide
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function LaneCard({
  lane,
  result,
  query,
  hidden,
  otherKind,
  view,
  first,
  last,
  onToggle,
  onEdit,
  onDelete,
  onMove,
  onSeen,
  onRefresh,
}: {
  lane: Lane;
  result: LaneResult | undefined;
  query: string;
  /** Items the focus filter removed from this lane. */
  hidden: number;
  /** Items of the other kind, left out of the Pull requests / Issues view. */
  otherKind: number;
  view: View;
  first: boolean;
  last: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  onSeen: () => void;
  onRefresh: () => void;
}) {
  const items = useMemo(
    () =>
      (result?.items ?? []).filter(
        (item) =>
          query === "" ||
          `${item.title} ${item.repo} ${item.number} ${item.author} ${item.labels.join(" ")}`
            .toLowerCase()
            .includes(query),
      ),
    [result, query],
  );
  const fresh = items.filter((item) => item.isNew).length;
  const collapsed = lane.collapsed === true && query === "";
  const [expanded, setExpanded] = useState(false);
  // New items first so a capped lane never hides an arrival.
  const ordered = useMemo(() => [...items.filter((item) => item.isNew), ...items.filter((item) => !item.isNew)], [items]);
  const shown = expanded || query !== "" ? ordered : ordered.slice(0, LANE_PREVIEW);
  return (
    <section className="radar-lane" data-collapsed={collapsed || undefined}>
      <header className="radar-lane__head">
        <button
          type="button"
          className="radar-lane__toggle"
          aria-expanded={!collapsed}
          disabled={query !== ""}
          title={`${items.length} item${items.length === 1 ? "" : "s"}${fresh > 0 ? ` · ${fresh} new` : ""}`}
          onClick={onToggle}
        >
          <Glyph name={collapsed ? "chevronRight" : "chevronDown"} className="radar-icon" />
          <span className="radar-lane__title">{lane.title}</span>
          {result?.loading ? <Glyph name="spinner" className="radar-icon radar-spin" /> : null}
        </button>
        <span className="radar-lane__tools">
          {fresh > 0 ? (
            <button type="button" className="radar-icon-btn" title="Mark all seen" onClick={onSeen}>
              <Glyph name="seen" className="radar-icon" />
            </button>
          ) : null}
          <button type="button" className="radar-icon-btn" title="Refresh lane" onClick={onRefresh}>
            <Glyph name="refresh" className="radar-icon" />
          </button>
          <button type="button" className="radar-icon-btn" title="Move up" disabled={first} onClick={() => onMove(-1)}>
            <Glyph name="up" className="radar-icon" />
          </button>
          <button type="button" className="radar-icon-btn" title="Move down" disabled={last} onClick={() => onMove(1)}>
            <Glyph name="down" className="radar-icon" />
          </button>
          <button type="button" className="radar-icon-btn" title="Edit lane" onClick={onEdit}>
            <Glyph name="edit" className="radar-icon" />
          </button>
          <button type="button" className="radar-icon-btn" title="Remove lane" onClick={onDelete}>
            <Glyph name="trash" className="radar-icon" />
          </button>
        </span>
      </header>
      {collapsed ? null : (
        <>
          {result?.error ? <p className="radar-error">{result.error}</p> : null}
          {/* Keep the body's height while the first fetch runs; later refreshes keep the last result on screen. */}
          {(result === undefined || (result.loading && result.fetchedAt === "")) && items.length === 0 ? (
            <p className="radar-empty">Loading…</p>
          ) : null}
          {result !== undefined && items.length === 0 && (!result.loading || result.fetchedAt !== "") && !result.error ? (
            <p className="radar-empty">
              {query === ""
                ? hidden > 0
                  ? "Everything here is hidden by the focus filter."
                  : otherKind > 0
                    ? `No ${view === "prs" ? "pull requests" : "issues"} here; ${otherKind} ${view === "prs" ? (otherKind === 1 ? "issue shows" : "issues show") : otherKind === 1 ? "pull request shows" : "pull requests show"} in All.`
                    : "Nothing needs you here."
                : "No matches."}
              {result.fetched > 0 && query === "" && hidden === 0 && otherKind === 0 ? ` (${result.fetched} fetched, all filtered out)` : ""}
            </p>
          ) : null}
          {items.length > 0 ? (
            <ul className="radar-items">
              {shown.map((item) => (
                <ItemRow key={item.key} item={item} />
              ))}
            </ul>
          ) : null}
          {ordered.length > shown.length || (expanded && ordered.length > LANE_PREVIEW) ? (
            <button type="button" className="radar-more" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Show fewer" : `Show ${ordered.length - shown.length} more`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Label/value row. `tip` is the help text, shown on hover over the label. */
function Row({ label, tip, children, note }: { label: string; tip?: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="radar-ed__row">
      <span className="radar-ed__label" title={tip} data-tip={tip ? true : undefined}>
        {label}
      </span>
      <div className="radar-ed__control">
        {children}
        {note ? <p className="radar-ed__note">{note}</p> : null}
      </div>
    </div>
  );
}

/** Comma-separated list as chips: Enter or comma adds, Backspace on empty removes the last. */
function TokenInput({ value, onChange, placeholder, label }: { value: string[]; onChange: (next: string[]) => void; placeholder?: string; label: string }) {
  const [text, setText] = useState("");
  const commit = (raw: string) => {
    const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((part) => !value.includes(part))]);
    setText("");
  };
  return (
    <div className="radar-ed__tokens">
      {value.map((token) => (
        <span key={token} className="radar-ed__token" title={token}>
          <span className="radar-ed__token-text">{token}</span>
          <button type="button" aria-label={`Remove ${token}`} onClick={() => onChange(value.filter((entry) => entry !== token))}>
            <Glyph name="x" className="radar-icon" />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={text}
        placeholder={value.length ? "" : placeholder}
        onChange={(event) => (event.target.value.includes(",") ? commit(event.target.value) : setText(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && text.trim()) {
            event.preventDefault();
            commit(text);
          } else if (event.key === "Backspace" && text === "" && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(text)}
      />
    </div>
  );
}

function Segmented<V extends string>({ value, options, onChange, label }: { value: V; options: [V, string][]; onChange: (next: V) => void; label: string }) {
  return (
    <div className="radar-ed__seg" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Section({
  title,
  sources,
  children,
  more,
  moreCount,
}: {
  title: string;
  sources?: string;
  children: React.ReactNode;
  more?: React.ReactNode;
  moreCount?: number;
}) {
  const [open, setOpen] = useState((moreCount ?? 0) > 0);
  return (
    <section className="radar-ed__section">
      <header className="radar-ed__section-head">
        <span>{title}</span>
        {sources ? <span className="radar-ed__applies">{sources}</span> : null}
      </header>
      {children}
      {more ? (
        <>
          <button type="button" className="radar-ed__more" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Glyph name={open ? "chevronDown" : "chevronRight"} className="radar-icon" />
            More filters
            {moreCount ? <span className="radar-ed__count">{moreCount}</span> : null}
          </button>
          {open ? more : null}
        </>
      ) : null}
    </section>
  );
}

/** Which view the lane shows in. Picking the inferred one goes back to following the query. */
function CategoryPicker({ draft, onPick }: { draft: Draft; onPick: (category: Category) => void }) {
  const inferred = draftInferredCategory(draft);
  const current = draftCategory(draft);
  return (
    <span className="radar-ed__inline">
      <span className="radar-ed__seg radar-ed__seg--icons" role="radiogroup" aria-label="View">
        {VIEWS.map((category) => {
          const tip = `${CATEGORY_LABEL[category]}${category === inferred ? " (matches the query)" : ""}`;
          return (
            <button key={category} type="button" role="radio" aria-checked={current === category} aria-label={tip} title={tip} onClick={() => onPick(category)}>
              <Glyph name={VIEW_GLYPH[category]} className="radar-icon" />
            </button>
          );
        })}
      </span>
      <span className="radar-faint" title={draft.categoryPinned ? "Chosen by hand; stays put when the query changes" : "Follows the query"}>
        {draft.categoryPinned ? "pinned" : "auto"}
      </span>
    </span>
  );
}

function LaneEditor({
  initial,
  maxAgeDays,
  onSave,
  onCancel,
}: {
  initial: Draft;
  /** The "Max age" setting (0 = no limit): the window a lane gets without its own. */
  maxAgeDays: number;
  onSave: (lane: Partial<Lane>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const text = (key: keyof Draft, placeholder = "", props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      className="radar-input radar-ed__input"
      value={String(draft[key] ?? "")}
      placeholder={placeholder}
      onChange={(event) => set(key)(event.target.value as never)}
      {...props}
    />
  );
  const tokens = (key: ListKey, label: string, placeholder: string) => (
    <TokenInput value={draft[key]} onChange={set(key)} label={label} placeholder={placeholder} />
  );
  const toggle = (key: "everyone" | "excludeDrafts", label: string) => (
    <label className="radar-ed__switch">
      <input type="checkbox" role="switch" checked={draft[key]} onChange={(event) => set(key)(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
  const searched = draft.sources.filter((source) => source !== "gitstream");
  const gitstreamOn = draft.sources.includes("gitstream");
  const scoped = gitstreamScoped(draft);
  const queryRejected = draft.sources.includes("delta") && /(^|\s)-?(mentions|involves):/.test(draft.query);
  const set_ = (values: (string | string[] | boolean)[]) =>
    values.filter((value) => (Array.isArray(value) ? value.length > 0 : value !== "" && value !== false)).length;
  const gitstreamMore = set_([
    draft.assignee, draft.reviewedBy, draft.excludeAuthor, draft.excludeLabels, draft.textQuery,
    draft.base, draft.head, draft.state, draft.draftState, draft.approval,
  ]);
  const refineMore = set_([draft.titleIncludes, draft.labelsAny, draft.excludeAuthors]);
  const summary = summarizeLane(fromDraft(draft));
  return (
    <form
      className="radar-ed"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void onSave(fromDraft(draft)).then(() => setSaving(false));
      }}
    >
      <header className="radar-ed__head">
        <input
          className="radar-ed__title"
          aria-label="Lane title"
          value={draft.title}
          placeholder="Untitled lane"
          onChange={(event) => set("title")(event.target.value)}
          autoFocus={initial.id === undefined}
        />
        <p className="radar-ed__summary">{summary}</p>
      </header>

      <div className="radar-ed__rows">
        <Row label="Sources" tip="Each source is queried separately and merged into this one lane.">
          <div className="radar-ed__sources">
            {SOURCES.filter((source) => enabledSources().includes(source) || draft.sources.includes(source)).map((source) => {
              const on = draft.sources.includes(source);
              return (
                <button
                  key={source}
                  type="button"
                  aria-pressed={on}
                  title={sourceHint(source)}
                  disabled={on && draft.sources.length === 1}
                  onClick={() => set("sources")(on ? draft.sources.filter((entry) => entry !== source) : [...draft.sources, source])}
                >
                  {SOURCE_LABEL[source]}
                </button>
              );
            })}
          </div>
        </Row>
        <Row label="View" tip="The title-bar view this lane shows in; every lane also shows in All. Follows the query until you pick one; picking the one the query implies goes back to auto.">
          <CategoryPicker draft={draft} onPick={(category) => setDraft((current) => pickCategory(current, category))} />
        </Row>
        <Row label="Limit" tip="Most recently updated items in the lane, across all sources (1–100).">
          <span className="radar-ed__inline">
            {text("limit", "30", { inputMode: "numeric", className: "radar-input radar-ed__input radar-ed__input--num", "aria-label": "Lane limit" })}
            <span className="radar-faint">per source</span>
          </span>
        </Row>
      </div>

      {searched.length > 0 ? (
        <Section title="Search" sources={searched.map((source) => SOURCE_LABEL[source]).join(" + ")}>
          <div className="radar-ed__rows">
            <Row
              label="Query"
              tip={`GitHub search syntax, sent to ${searched.map((source) => SOURCE_LABEL[source]).join(" and ")}.${draft.sources.includes("delta") ? ` ${SOURCE_LABEL.delta} drops archived: automatically.` : ""}`}
              note={
                draft.query.trim() === "" ? (
                  <span className="radar-ed__warn">Required.</span>
                ) : queryRejected ? (
                  <span className="radar-ed__warn">{SOURCE_LABEL.delta} rejects mentions: and involves: queries. Turn {SOURCE_LABEL.delta} off for this lane.</span>
                ) : null
              }
            >
              {text("query", "is:open is:pr review-requested:@me", { className: "radar-input radar-ed__input radar-mono", "aria-label": "Search query", spellCheck: false })}
            </Row>
          </div>
        </Section>
      ) : null}

      {gitstreamOn ? (
        <Section
          title={`${SOURCE_LABEL.gitstream} filters`}
          sources={hosts().gitstream?.repo ?? "not set up"}
          moreCount={gitstreamMore}
          more={
            <div className="radar-ed__rows">
              <Row label="Assignee">{text("assignee", "anyone")}</Row>
              <Row label="Reviewed by">{text("reviewedBy", "anyone")}</Row>
              <Row label="Exclude author">{text("excludeAuthor", "none")}</Row>
              <Row label="Exclude labels" tip="Exact label names.">{tokens("excludeLabels", "Exclude labels", "none")}</Row>
              <Row label="Text search" tip="Title and body. Slower; broad terms can time out.">{text("textQuery", "none")}</Row>
              <Row label="Base branch">{text("base", "any")}</Row>
              <Row label="Head branch">{text("head", "any")}</Row>
              <Row label="State">
                <Segmented label="State" value={draft.state === "open" ? "" : draft.state} onChange={set("state")} options={[["", "Open"], ["closed", "Closed"], ["all", "All"]]} />
              </Row>
              <Row label="Drafts">
                <Segmented label="Drafts" value={draft.draftState} onChange={set("draftState")} options={[["", "Any"], ["false", "Ready"], ["true", "Drafts"]]} />
              </Row>
              <Row label="Approval">
                <Segmented label="Approval" value={draft.approval} onChange={set("approval")} options={[["", "Any"], ["true", "Approved"], ["false", "Not approved"]]} />
              </Row>
            </div>
          }
        >
          <div className="radar-ed__rows">
            <Row label="Review requested" tip="@me, a login or an email.">{text("reviewRequested", "anyone")}</Row>
            <Row label="Author" tip="@me, a login or an email.">{text("author", scoped || draft.everyone ? "anyone" : "@me by default")}</Row>
            <Row label="Labels" tip="Exact label names; a PR must carry all of them.">
              {tokens("labels", "Labels", "e.g. //areas/clients/mobile")}
            </Row>
            {!scoped ? <Row label="">{toggle("everyone", "Everyone's PRs, not just mine")}</Row> : null}
          </div>
        </Section>
      ) : null}

      <Section
        title="Refine"
        sources="all sources, after fetch"
        moreCount={refineMore}
        more={
          <div className="radar-ed__rows">
            <Row label="Title contains" tip="Keep items whose title has any of these (case-insensitive).">{tokens("titleIncludes", "Title contains", "any title")}</Row>
            <Row label="Label contains" tip="Keep items with a label containing any of these (case-insensitive).">{tokens("labelsAny", "Label contains", "any label")}</Row>
            <Row label="Exclude authors">{tokens("excludeAuthors", "Exclude authors", "none")}</Row>
          </div>
        }
      >
        <div className="radar-ed__rows">
          <Row label="Updated within">
            <span className="radar-ed__inline">
              {text("updatedWithinDays", maxAgeDays > 0 ? String(maxAgeDays) : "any", { inputMode: "numeric", className: "radar-input radar-ed__input radar-ed__input--num", "aria-label": "Updated within days" })}
              <span className="radar-faint">days</span>
            </span>
          </Row>
          <Row label="">{toggle("excludeDrafts", "Hide drafts")}</Row>
        </div>
      </Section>

      <footer className="radar-ed__foot">
        <button type="button" className="radar-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="radar-btn radar-btn--primary" disabled={saving}>
          {initial.id === undefined ? "Add lane" : "Save"}
        </button>
      </footer>
    </form>
  );
}

// ---------------------------------------------------------------------------

function TrackBox({
  aiAvailable,
  aiDetail,
  onDraft,
  onManual,
}: {
  aiAvailable: boolean;
  aiDetail: string;
  onDraft: (description: string) => Promise<boolean>;
  onManual: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEscape(true, () => {
    if (!busy) trackBox.set(false);
  });
  const submit = () => {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    void onDraft(text.trim()).then((ok) => {
      setBusy(false);
      if (ok) setText("");
    });
  };
  return (
    <div className="radar-track">
      <Glyph name="sparkles" className="radar-icon radar-track__icon" />
      <textarea
        className="radar-track__input"
        rows={1}
        autoFocus
        value={text}
        disabled={!aiAvailable}
        placeholder={
          aiAvailable
            ? "Describe what to track… e.g. “PRs from my team that touch billing, not drafts”"
            : aiDetail
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button type="button" className="radar-btn radar-btn--primary" disabled={!aiAvailable || busy || text.trim().length < 3} onClick={submit}>
        {busy ? "Drafting…" : "Draft lane"}
      </button>
      <button type="button" className="radar-btn" onClick={onManual} title="Build a lane by hand">
        Manual
      </button>
    </div>
  );
}

function DraftPreview({
  draft,
  onAdd,
  onEdit,
  onDiscard,
}: {
  draft: DraftResult;
  onAdd: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const { lane, preview } = draft;
  return (
    <section className="radar-lane radar-lane--draft">
      <header className="radar-lane__head">
        <span className="radar-lane__toggle">
          <Glyph name="sparkles" className="radar-icon" />
          <span className="radar-lane__title">{lane.title}</span>
          <span className="radar-chip radar-chip--muted">preview</span>
          <span className="radar-chip radar-chip--muted radar-chip--view" title={lane.category === "all" ? "Shows in All" : `Shows in ${CATEGORY_LABEL[lane.category]} and All`}>
            <Glyph name={VIEW_GLYPH[lane.category]} className="radar-icon" />
            {CATEGORY_LABEL[lane.category]}
          </span>
        </span>
        <span className="radar-row">
          <button type="button" className="radar-btn radar-btn--primary" onClick={onAdd}>
            Add lane
          </button>
          <button type="button" className="radar-btn" onClick={onEdit}>
            Tweak
          </button>
          <button type="button" className="radar-btn" onClick={onDiscard}>
            Discard
          </button>
        </span>
      </header>
      {preview.error ? <p className="radar-error">{preview.error}</p> : null}
      {preview.items.length === 0 && !preview.error ? <p className="radar-empty">No items match right now.</p> : null}
      <ul className="radar-items">
        {preview.items.slice(0, 8).map((item) => (
          <ItemRow key={item.key} item={item} />
        ))}
      </ul>
      {preview.items.length > 8 ? <p className="radar-empty">+{preview.items.length - 8} more</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Keep Tab inside a sheet; the board behind it is only dimmed. */
function trapTab(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.offsetParent !== null);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Gives focus back to whatever opened a sheet when it closes. */
function useReturnFocus() {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
}

/**
 * Approve, edit or dismiss a Slack-context draft. Posting creates Radar's one marked comment
 * on the issue, or edits it if it exists; the sources line is added on post.
 */
function SlackSheet({
  draft,
  onPublish,
  onDismiss,
  onClose,
}: {
  draft: SlackDraftView;
  onPublish: (summary: string) => Promise<void>;
  onDismiss: () => Promise<void>;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState(draft.summary);
  const [busy, setBusy] = useState<"" | "post" | "dismiss">("");
  const [failure, setFailure] = useState("");
  useEscape(busy === "", onClose);
  useReturnFocus();
  const act = (kind: "post" | "dismiss", work: () => Promise<void>) => {
    setBusy(kind);
    setFailure("");
    work().catch((cause) => {
      setFailure(errorText(cause));
      setBusy("");
    });
  };
  return (
    <div className="radar-sheet" role="dialog" aria-modal="true" aria-label="Slack context" onMouseDown={(event) => event.target === event.currentTarget && busy === "" && onClose()}>
      <div className="radar-sheet__panel" onKeyDown={trapTab}>
        <header className="radar-sheet__head">
          <div className="radar-sheet__title">
            <strong>Slack context</strong>
            <UrlLink className="radar-mono" href={draft.url}>
              {draft.repo}#{draft.number}
            </UrlLink>
            <span className="radar-sheet__subject">{draft.title}</span>
          </div>
          <button type="button" className="radar-btn" onClick={onClose} disabled={busy !== ""}>
            Cancel
          </button>
        </header>
        <div className="radar-slack">
          <p className="radar-slack__hint">
            Drafted from {draft.sources.length} public Slack thread{draft.sources.length === 1 ? "" : "s"}. Edit it, then{" "}
            {draft.current ? "update Radar's comment on the issue" : "post it as a comment on the issue"}. Nothing has been posted yet.
          </p>
          <textarea
            className="radar-input radar-slack__text"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            rows={10}
            maxLength={4000}
            aria-label="Summary to post"
            autoFocus
          />
          <div className="radar-slack__sources">
            Sources:{" "}
            {draft.sources.map((source, index) => (
              <span key={source.permalink || index}>
                {index > 0 ? " · " : ""}
                {source.permalink ? <UrlLink href={source.permalink}>#{source.channelName}</UrlLink> : `#${source.channelName}`}
              </span>
            ))}
          </div>
          {draft.current ? (
            <details className="radar-slack__current">
              <summary>On the issue now</summary>
              <pre>{draft.current}</pre>
            </details>
          ) : null}
          {failure ? <p className="radar-error" role="alert">{failure}</p> : null}
          <footer className="radar-slack__foot">
            <button type="button" className="radar-btn" disabled={busy !== ""} title="Drop this draft; only newer Slack messages will draft again" onClick={() => act("dismiss", onDismiss)}>
              {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            </button>
            <button
              type="button"
              className="radar-btn radar-btn--primary"
              disabled={busy !== "" || summary.trim() === ""}
              onClick={() => act("post", () => onPublish(summary.trim()))}
            >
              {busy === "post" ? "Posting…" : draft.current ? "Update comment" : "Post comment"}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

function ReviewSheet({
  item,
  context,
  onSubmit,
  onClose,
}: {
  item: RadarItem;
  context: ReviewContext;
  onSubmit: NewThreadComposerProps["onSubmit"];
  onClose: () => void;
}) {
  useEscape(true, onClose);
  useReturnFocus();
  return (
    <div className="radar-sheet" role="dialog" aria-modal="true" aria-label={context.title} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="radar-sheet__panel" onKeyDown={trapTab}>
        <header className="radar-sheet__head">
          <div className="radar-sheet__title">
            <strong>{item.kind === "pr" ? "Review" : "Triage"}</strong>
            <span className="radar-mono">
              {item.repo}#{item.number}
            </span>
            <span className="radar-sheet__subject">{item.title}</span>
          </div>
          <button type="button" className="radar-btn" onClick={onClose}>
            Cancel
          </button>
        </header>
        <div className="radar-sheet__composer">
          <NewThreadComposer
            {...(context.defaultProjectId !== null ? { defaultProjectId: context.defaultProjectId } : {})}
            initialPrompt={context.prompt}
            draftKey={`radar-review:${item.key}`}
            layout="document"
            focusRequest={1}
            onSubmit={onSubmit}
          />
        </div>
      </div>
    </div>
  );
}

function RadarPage({ subPath }: PluginNavPanelProps) {
  const view = viewFrom(subPath);
  const { rpc, snapshot, error, setError, mutate, call, optimistic } = useRadar();
  const navigate = useBbNavigate();
  const [reviewing, setReviewing] = useState<{ item: RadarItem; context: ReviewContext } | null>(null);
  const [slackDraft, setSlackDraft] = useState<SlackDraftView | null>(null);
  const [undo, setUndo] = useState<{ key: string; title: string } | null>(null);
  /** In-flight hides, so an Undo can't reach the server before its hide. */
  const hiding = useRef(new Map<string, Promise<unknown>>());
  /** Bumped when a hide settles on the server, so an open Hidden list refetches. */
  const [hiddenRevision, setHiddenRevision] = useState(0);
  useEffect(() => {
    if (undo === null) return;
    const timer = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(timer);
  }, [undo]);
  const unhide = useCallback(
    async (key: string | "all") => {
      await Promise.all(key === "all" ? [...hiding.current.values()] : [hiding.current.get(key)]);
      return (await mutate(rpc.call("radar_unhide_item", key === "all" ? { all: true } : { key }))) !== null;
    },
    [mutate, rpc],
  );
  useEffect(() => {
    undoNotice.set(undo === null ? null : {
      ...undo,
      undo: () => {
        setUndo(null);
        void unhide(undo.key);
      },
    });
  }, [undo, unhide]);
  useEffect(() => () => undoNotice.set(null), []);
  const loadHidden = useCallback(() => call(rpc.call("radar_hidden_items", null) as Promise<HiddenEntry[]>), [call, rpc]);
  const reviewActions = useMemo(
    () => ({
      threadFor: (key: string) => snapshot?.reviews[key]?.threadId,
      hide: (item: RadarItem) => {
        setUndo({ key: item.key, title: item.title });
        const done = optimistic({ kind: "hide", key: item.key }, rpc.call("radar_hide_item", { key: item.key })).then((next) => {
          if (next === null) setUndo((current) => (current?.key === item.key ? null : current));
        });
        hiding.current.set(item.key, done);
        void done.finally(() => {
          if (hiding.current.get(item.key) === done) hiding.current.delete(item.key);
          setHiddenRevision((value) => value + 1);
        });
      },
      acknowledge: (item: RadarItem) => { void optimistic({ kind: "acknowledge", key: item.key }, rpc.call("radar_acknowledge", { key: item.key })); },
      open: (threadId: string) => navigate.toThread(threadId),
      review: (item: RadarItem) => {
        void call(rpc.call("radar_review_context", { key: item.key }) as Promise<ReviewContext>).then((context) => {
          if (context !== null) setReviewing({ item, context });
        });
      },
      // Delta rows offer Rebase only once a rebase checkout is configured.
      viewer: { github: snapshot?.githubLogin ?? "", delta: snapshot?.deltaRebase === true ? (snapshot?.deltaLogin ?? "") : "" },
      skills: snapshot?.skills ?? DEFAULT_SKILL_SETTINGS,
      // Errors stay on the row, not the page banner.
      rebase: (item: RadarItem) =>
        rpc.call("radar_rebase", { source: item.source, repo: item.repo, number: item.number }) as Promise<RebaseResult>,
      slack: (item: RadarItem) =>
        snapshot?.slack?.enabled !== true || item.source !== "github" || item.kind !== "issue"
          ? "off"
          : snapshot.slack.drafts[item.key] !== undefined
            ? "draft"
            : "check",
      openSlack: (item: RadarItem) => {
        void call(rpc.call("radar_slack_draft", { key: item.key }) as Promise<SlackDraftView>).then((draft) => {
          if (draft !== null) setSlackDraft(draft);
        });
      },
      checkSlack: async (item: RadarItem) => {
        const next = (await mutate(rpc.call("radar_slack_check", { key: item.key }))) as RadarSnapshot | null;
        if (next?.slack?.drafts[item.key] !== undefined) {
          const draft = (await call(rpc.call("radar_slack_draft", { key: item.key }) as Promise<SlackDraftView>));
          if (draft !== null) setSlackDraft(draft);
        }
      },
    }),
    [snapshot, navigate, call, rpc, mutate, optimistic],
  );
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  // Typing stays responsive on big boards: lanes filter against a deferred copy of the search.
  const query = useDeferredValue(search).trim().toLowerCase();
  const tracking = useTrackBoxOpen();

  const lanes = snapshot?.lanes ?? [];
  const scope = scopeOf(snapshot);
  const inScope = useMemo(() => scopePredicate(scope), [scope]);
  const entries = useMemo(() => scopeCatalog(viewItems(snapshot, view), scope), [snapshot, view, scope]);
  const allTotals = useMemo(() => viewTotals(snapshot), [snapshot]);
  const totals = allTotals[view];
  const refreshLabel = snapshot?.refreshing ? "Refreshing…" : snapshot?.fetchedAt
    ? `Refresh — updated ${relative(snapshot.fetchedAt) === "now" ? "just now" : `${relative(snapshot.fetchedAt)} ago`}`
    : "Refresh";

  const saveLane = async (lane: Partial<Lane>) => {
    const before = new Set(lanes.map((existing) => existing.id));
    const next = (await mutate(rpc.call("radar_lane_upsert", { lane }))) as RadarSnapshot | null;
    if (next !== null) {
      setEditing(null);
      setDraft(null);
      // A lane saved into another category would otherwise vanish from this view.
      const saved = next.lanes.find((entry) => (lane.id === undefined ? !before.has(entry.id) : entry.id === lane.id));
      if (saved !== undefined && !laneInView(saved, view)) navigate.toPluginPanel("board", { subPath: saved.category, replace: true });
    }
    return next !== null;
  };
  const move = (id: string, delta: -1 | 1) => {
    const ids = moveInView(lanes, id, delta, view);
    if (ids !== null) void mutate(rpc.call("radar_lanes_reorder", { ids }));
  };

  const visibleLanes = lanes
    .filter((lane) => laneInView(lane, view))
    .map((lane) => {
      const result = snapshot?.results[lane.id];
      if (result === undefined) return { lane, result, hidden: 0, otherKind: 0 };
      const mine = result.items.filter((item) => itemInView(item, view));
      const shown = mine.filter(inScope);
      return {
        lane,
        hidden: mine.length - shown.length,
        otherKind: result.items.length - mine.length,
        result: { ...result, items: shown },
      };
    });

  return (
    <div className="radar-frame">
    <div className="radar">
      <div className="radar__inner">
        <div className="radar-bar" role="group" aria-label="Radar tools">
            <input
              className="radar-input radar-search"
              placeholder="Search..."
              aria-label="Search items"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          <div className="radar-bar__actions">
            <FocusControl
              view={view}
              onView={(value) => navigate.toPluginPanel("board", { subPath: value, replace: true })}
              counts={snapshot === null ? undefined : allTotals}
              entries={entries}
              state={snapshot?.focus}
              hidden={totals.hidden}
              aiAvailable={snapshot?.ai.available ?? false}
              onOp={(op, keys) => void mutate(rpc.call("radar_scope", { op, keys }))}
              onSet={(enabled) => void mutate(rpc.call("radar_focus_set", { enabled }))}
              onDescribe={async (description) => (await mutate(rpc.call("radar_focus_describe", { description }))) !== null}
            />
            <span className="radar-toolbar-sep" aria-hidden="true" />
            <button
              type="button"
              className="radar-icon-btn radar-add-panel"
              aria-label="Add a panel"
              aria-pressed={tracking}
              title="Add a panel: describe what to track or add manually"
              onClick={() => trackBox.set(!tracking)}
            >
              <svg className="radar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v8M8 12h8" />
              </svg>
            </button>
            <span className="radar-toolbar-sep" aria-hidden="true" />
            <HiddenControl count={snapshot?.hiddenCount ?? 0} revision={hiddenRevision} load={loadHidden} onUnhide={unhide} />
            <button
              type="button"
              className="radar-icon-btn"
              title="Mark all seen — every lane, every view"
              aria-label="Mark all seen — every lane, every view"
              onClick={() => void optimistic({ kind: "seen", view: "all" }, rpc.call("radar_mark_seen", { view: "all" }))}
            >
              <Glyph name="seen" className="radar-icon" />
            </button>
            <button
              type="button"
              className="radar-icon-btn"
              title={refreshLabel}
              aria-label={refreshLabel}
              disabled={!snapshot || snapshot.refreshing}
              onClick={() => void mutate(rpc.call("radar_refresh", null))}
            >
              <Glyph name="refresh" className={`radar-icon${snapshot?.refreshing ? " radar-icon--spinning" : ""}`} />
            </button>
          </div>
        </div>

        {tracking ? (
          <TrackBox
            aiAvailable={snapshot?.ai.available ?? false}
            aiDetail={snapshot?.ai.detail ?? "Loading…"}
            onManual={() => {
              setDraft(null);
              setEditing(toDraft());
              trackBox.set(false);
            }}
            onDraft={async (description) => {
              setEditing(null);
              const result = (await call(rpc.call("radar_draft", { description }))) as DraftResult | null;
              if (result !== null) {
                setDraft(result);
                trackBox.set(false);
              }
              return result !== null;
            }}
          />
        ) : null}

        {error ? (
          <p className="radar-error" role="alert">
            {error}{" "}
            <button type="button" className="radar-link" onClick={() => setError("")}>
              dismiss
            </button>
          </p>
        ) : null}

        {draft !== null && editing === null ? (
          <DraftPreview
            draft={draft}
            onAdd={() => void saveLane(draft.lane)}
            onEdit={() => setEditing(toDraft({ ...draft.lane, id: undefined as unknown as string }))}
            onDiscard={() => setDraft(null)}
          />
        ) : null}

        {editing !== null ? (
          <section className="radar-lane radar-lane--editor" aria-label={editing.id === undefined ? "New lane" : `Edit ${editing.title}`}>
            <LaneEditor key={editing.id ?? "new"} initial={editing} maxAgeDays={snapshot?.maxAgeDays ?? 60} onSave={saveLane} onCancel={() => setEditing(null)} />
          </section>
        ) : null}

        <ReviewActions.Provider value={reviewActions}>
        {visibleLanes.map(({ lane, result, hidden, otherKind }, index) => (
          <LaneCard
            key={lane.id}
            lane={lane}
            result={result}
            query={query}
            hidden={hidden}
            otherKind={otherKind}
            view={view}
            first={index === 0}
            last={index === visibleLanes.length - 1}
            onToggle={() => void mutate(rpc.call("radar_lane_upsert", { lane: { ...lane, collapsed: !lane.collapsed } }))}
            onEdit={() => {
              setDraft(null);
              setEditing(toDraft(lane));
            }}
            onDelete={() => {
              if (window.confirm(`Remove the “${lane.title}” lane?`)) void mutate(rpc.call("radar_lane_delete", { laneId: lane.id }));
            }}
            onMove={(delta) => move(lane.id, delta)}
            onSeen={() => void optimistic({ kind: "seen", laneId: lane.id, view }, rpc.call("radar_mark_seen", { laneId: lane.id, view }))}
            onRefresh={() => void mutate(rpc.call("radar_refresh", { laneId: lane.id }))}
          />
        ))}
        </ReviewActions.Provider>

        {snapshot !== null && lanes.length === 0 ? (
          <p className="radar-empty">
            No lanes.{" "}
            <button type="button" className="radar-link" onClick={() => void mutate(rpc.call("radar_lanes_reset", null))}>
              Restore the defaults
            </button>
          </p>
        ) : null}
      </div>
    </div>

        {slackDraft !== null ? (
          <SlackSheet
            key={slackDraft.key}
            draft={slackDraft}
            onClose={() => setSlackDraft(null)}
            onDismiss={async () => {
              await rpc.call("radar_slack_dismiss", { key: slackDraft.key });
              setSlackDraft(null);
            }}
            onPublish={async (summary) => {
              await rpc.call("radar_slack_publish", { key: slackDraft.key, summary });
              setSlackDraft(null);
            }}
          />
        ) : null}
        {reviewing !== null ? (
          <ReviewSheet
            item={reviewing.item}
            context={reviewing.context}
            onClose={() => setReviewing(null)}
            onSubmit={async (request) => {
              // Throwing keeps the composer draft, so a failed spawn loses nothing.
              const started = (await rpc.call("radar_review_start", {
                key: reviewing.item.key,
                request: request as unknown as Record<string, unknown>,
              })) as { threadId: string };
              setReviewing(null);
              navigate.toThread(started.threadId);
            }}
          />
        ) : null}
    </div>
  );
}

function AiSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [selection, setSelection] = useState<AiOverride>(null);
  const [status, setStatus] = useState("Loading…");
  const [editing, setEditing] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([rpc.call("radar_ai_get", null), rpc.call("radar_snapshot", null)]).then(([value, snapshot]) => {
      if (!active) return;
      setSelection(value);
      setStatus((snapshot as RadarSnapshot).ai.detail);
      setReady(true);
    }).catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [rpc]);
  async function save(next: AiOverride) {
    setSaving(true);
    try {
      setSelection(await rpc.call("radar_ai_set", next));
      setError("");
      setEditing(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }
  const [draft, setDraft] = useState<ExperimentalProviderModelPickerValue>({ providerId: "", model: "", reasoningLevel: "medium" });
  return <section>
    <p>Draft lanes and interpret focus using BB’s configured providers. On BB builds without that, Radar uses the AI fallback settings (endpoint, key variable, model).</p>
    <p>{selection ? `${selection.providerId} / ${selection.model}` : "Use BB default"}</p>
    <p>{status}</p>
    <button className="radar-btn" disabled={!ready || saving} onClick={() => {
      setDraft({ providerId: selection?.providerId ?? "", model: selection?.model ?? "", reasoningLevel: "medium" });
      setEditing(true);
    }}>Choose override</button>
    {selection ? <button className="radar-btn" disabled={saving} onClick={() => void save(null)}>Use BB default</button> : null}
    {editing ? <div>
      <ProviderModelPicker value={draft} onChange={setDraft} disabled={saving} />
      <button className="radar-btn" disabled={saving || !draft.providerId || !draft.model} onClick={() => void save({ providerId: draft.providerId, model: draft.model })}>Save override</button>
      <button className="radar-btn" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "ai-focus", title: "AI & focus", component: AiSettings });
  app.slots.navPanel({
    headerContent: RadarHeader,
    id: "board",
    title: "Radar",
    icon: "Radar",
    path: "board",
    component: RadarPage,
  });
  app.contentScripts.register({ id: "rail-badge", mount: mountRailBadge });
});
