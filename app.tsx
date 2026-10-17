// bb-plugin-radar — panel frontend. Compiled by `bb plugin build`.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DraftResult, Lane, LaneResult, RadarItem, RadarSnapshot, RebaseResult, ReviewContext, rpcContract } from "./server";
import type { NewThreadComposerProps, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { mountRailBadge } from "./badge";
import { CATEGORY_LABEL, enabledSources, itemInView, laneInView, SOURCE_LABEL, SOURCES, viewFrom, VIEWS, type Category, type Source, type View } from "./lanes";

const sourceHint = (source: Source): string => {
  const { gitstream, delta } = hosts();
  if (source === "gitstream") return gitstream === null ? "Not set up: add a Gitstream repo in Settings → Plugins → Radar" : `${gitstream.repo} · gs`;
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
import "./app.css";

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
  const apply = useCallback((next: RadarSnapshot) => {
    if (next.hosts !== undefined) setHosts(next.hosts);
    setSnapshot(next);
  }, []);
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
  return { rpc, snapshot, error, setError, mutate, call };
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
  open: (threadId: string) => void;
  viewer: Viewer;
  rebase: (item: RadarItem) => Promise<RebaseResult>;
  skills: SkillSettings;
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

function ItemRow({ item }: { item: RadarItem }) {
  const labels = displayLabels(item.labels);
  const actions = useContext(ReviewActions);
  const threadId = actions?.threadFor(item.key);
  const [rebaseActive, setRebaseActive] = useState(false);
  const showRebase = actions !== null && canRebase(item, actions.viewer);
  return (
    <li className="radar-item" data-new={item.isNew || undefined}>
      <span className="radar-item__dot" aria-label={item.isNew ? "new" : undefined} />
      <Glyph name={item.kind === "pr" ? "pr" : "issue"} className="radar-item__kind" />
      <div className="radar-item__main">
        <UrlLink className="radar-item__title" href={item.url}>
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
          {showRebase ? <RebaseAction item={item} rebase={actions.rebase} onActive={setRebaseActive} /> : null}
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
const VIEW_HELP: Record<View, string> = {
  reviews: "Review queues",
  prs: "Pull request lanes",
  issues: "Issue lanes",
  all: "Every lane",
};

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

function ViewToggle({ subPath }: PluginNavPanelProps) {
  const { rpc, snapshot, mutate } = useRadar();
  const navigate = useBbNavigate();
  const current = viewFrom(subPath);
  const totals = viewTotals(snapshot);
  const scope = scopeOf(snapshot);
  const entries = useMemo(() => scopeCatalog(viewItems(snapshot, current), scope), [snapshot, current, scope]);
  const tracking = useTrackBoxOpen();
  return (
    <div className="radar radar-views">
      <div className="radar-views__tabs" role="tablist" aria-label="Radar view">
        {VIEWS.map((view) => {
          const { items, fresh } = totals[view];
          const tip = `${CATEGORY_LABEL[view]}: ${items}${fresh > 0 ? `, ${fresh} new` : ""} · ${VIEW_HELP[view]}`;
          return (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={current === view}
              aria-label={tip}
              title={tip}
              className="radar-views__tab"
              onClick={() => navigate.toPluginPanel("board", { subPath: view, replace: true })}
            >
              <Glyph name={VIEW_GLYPH[view]} className="radar-views__icon" optical />
              {fresh > 0 ? <span className="radar-views__dot" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <span className="radar-views__sep" aria-hidden="true" />
      <button
        type="button"
        className="radar-views__tab"
        aria-pressed={tracking}
        aria-label="Track something new"
        title="Track something new: describe it and Radar drafts a lane"
        onClick={() => trackBox.set(!tracking)}
      >
        <Glyph name="sparkles" className="radar-views__icon" optical />
      </button>
      <FocusControl
        entries={entries}
        state={snapshot?.focus}
        hidden={totals[current].hidden}
        aiAvailable={snapshot?.ai.available ?? false}
        onOp={(op, keys) => void mutate(rpc.call("radar_scope", { op, keys }))}
        onSet={(enabled) => void mutate(rpc.call("radar_focus_set", { enabled }))}
        onDescribe={async (description) => (await mutate(rpc.call("radar_focus_describe", { description }))) !== null}
      />
    </div>
  );
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
  const [owner, name] = !child && label.includes("/") ? [label.slice(0, label.indexOf("/") + 1), label.slice(label.indexOf("/") + 1)] : ["", label];
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
        <span className="radar-scope__name">
          {owner ? <span className="radar-scope__owner">{owner}</span> : null}
          {name}
        </span>
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
  entries,
  state,
  hidden,
  aiAvailable,
  onOp,
  onDescribe,
  onSet,
}: {
  entries: ScopeEntry[];
  state: FocusState | undefined;
  hidden: number;
  aiAvailable: boolean;
  onOp: (op: ScopeOp, keys: string[]) => void;
  onDescribe: (description: string) => Promise<boolean>;
  onSet: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const on = state?.enabled === true && isActive(state);
  const resumable = state !== undefined && !state.enabled && isActive(state);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.(".radar-scope")) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);
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
    <div className="radar-scope">
      <button
        type="button"
        className="radar-views__tab radar-focus"
        data-on={on || undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={on ? `Focus: ${state?.summary || describeScope(state!)}${hidden > 0 ? `, ${hidden} hidden` : ""}` : "Focus"}
        title={
          on
            ? `Focus: ${state?.summary || describeScope(state!)}${hidden > 0 ? ` (${hidden} hidden)` : ""}. Click to change.`
            : "Focus: describe what helps you focus; Radar hides the rest"
        }
        onClick={() => setOpen((value) => !value)}
      >
        <Glyph name="zen" className="radar-views__icon" optical />
        {on ? <span className="radar-views__dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="radar-scope__pop" role="dialog" aria-label="Focus">
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
                  {hidden > 0 ? <span className="radar-scope__muted">{hidden} hidden</span> : null}
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
  onMove: (delta: number) => void;
  onSeen: () => void;
  onRefresh: () => void;
}) {
  const items = (result?.items ?? []).filter(
    (item) =>
      query === "" ||
      `${item.title} ${item.repo} ${item.number} ${item.author} ${item.labels.join(" ")}`
        .toLowerCase()
        .includes(query),
  );
  const fresh = items.filter((item) => item.isNew).length;
  const collapsed = lane.collapsed === true && query === "";
  const [expanded, setExpanded] = useState(false);
  // New items first so a capped lane never hides an arrival.
  const ordered = [...items.filter((item) => item.isNew), ...items.filter((item) => !item.isNew)];
  const shown = expanded || query !== "" ? ordered : ordered.slice(0, LANE_PREVIEW);
  return (
    <section className="radar-lane" data-collapsed={collapsed || undefined}>
      <header className="radar-lane__head">
        <button type="button" className="radar-lane__toggle" onClick={onToggle}>
          <Glyph name={collapsed ? "chevronRight" : "chevronDown"} className="radar-icon" />
          <span className="radar-lane__title">{lane.title}</span>
          <span className="radar-count">{result === undefined ? "…" : items.length}</span>
          {fresh > 0 ? <span className="radar-count radar-count--new">{fresh} new</span> : null}
          {hidden > 0 ? (
            <span className="radar-lane__hidden" title="Hidden by the repo / area focus filter">
              {hidden} hidden
            </span>
          ) : null}
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
          {result !== undefined && items.length === 0 && !result.loading && !result.error ? (
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !busy && trackBox.set(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);
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
          <span className="radar-count">{preview.items.length}</span>
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="radar-sheet" role="dialog" aria-label={context.title} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="radar-sheet__panel">
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
  const { rpc, snapshot, error, setError, mutate, call } = useRadar();
  const navigate = useBbNavigate();
  const [reviewing, setReviewing] = useState<{ item: RadarItem; context: ReviewContext } | null>(null);
  const reviewActions = useMemo(
    () => ({
      threadFor: (key: string) => snapshot?.reviews[key]?.threadId,
      open: (threadId: string) => navigate.toThread(threadId),
      review: (item: RadarItem) => {
        void call(rpc.call("radar_review_context", { key: item.key }) as Promise<ReviewContext>).then((context) => {
          if (context !== null) setReviewing({ item, context });
        });
      },
      viewer: { github: snapshot?.githubLogin ?? "", gitstream: snapshot?.gitstreamLogin ?? "" },
      skills: snapshot?.skills ?? DEFAULT_SKILL_SETTINGS,
      // Errors stay on the row, not the page banner.
      rebase: (item: RadarItem) =>
        rpc.call("radar_rebase", { source: item.source, repo: item.repo, number: item.number }) as Promise<RebaseResult>,
    }),
    [snapshot, navigate, call, rpc],
  );
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const query = search.trim().toLowerCase();
  const tracking = useTrackBoxOpen();

  const lanes = snapshot?.lanes ?? [];
  const totals = useMemo(() => viewTotals(snapshot)[view], [snapshot, view]);
  const scope = scopeOf(snapshot);
  const inScope = useMemo(() => scopePredicate(scope), [scope]);

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
  const move = (index: number, delta: number) => {
    const ids = lanes.map((lane) => lane.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void mutate(rpc.call("radar_lanes_reorder", { ids }));
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
        result: { ...result, items: shown.filter((item) => !onlyNew || item.isNew) },
      };
    })
    .filter(({ result }) => !onlyNew || (result?.items.length ?? 0) > 0);

  return (
    <div className="radar">
      <div className="radar__inner">
        <div className="radar-bar">
          <div className="radar-bar__facts">
            <span>
              <b>{totals.items}</b> items
            </span>
            <button
              type="button"
              className="radar-pill"
              aria-pressed={onlyNew}
              onClick={() => setOnlyNew((value) => !value)}
              title="Show only items you have not seen"
            >
              <b>{totals.fresh}</b> new
            </button>
            <span className="radar-faint">
              {snapshot?.refreshing ? "refreshing…" : snapshot?.fetchedAt
                  ? relative(snapshot.fetchedAt) === "now"
                    ? "updated just now"
                    : `updated ${relative(snapshot.fetchedAt)} ago`
                  : "loading…"}
            </span>
          </div>
          <div className="radar-row">
            <input
              className="radar-input radar-search"
              placeholder="Filter…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              type="button"
              className="radar-icon-btn"
              title="Mark all seen — every lane, every view"
              onClick={() => void mutate(rpc.call("radar_mark_seen", { view: "all" }))}
            >
              <Glyph name="seen" className="radar-icon" />
            </button>
            <button
              type="button"
              className="radar-btn"
              disabled={snapshot?.refreshing}
              onClick={() => void mutate(rpc.call("radar_refresh", null))}
            >
              <Glyph name="refresh" className="radar-icon" /> Refresh
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
            onMove={(delta) => move(lanes.indexOf(lane), delta)}
            onSeen={() => void mutate(rpc.call("radar_mark_seen", { laneId: lane.id, view }))}
            onRefresh={() => void mutate(rpc.call("radar_refresh", { laneId: lane.id }))}
          />
        ))}
        </ReviewActions.Provider>

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

        {snapshot !== null && lanes.length === 0 ? (
          <p className="radar-empty">
            No lanes.{" "}
            <button type="button" className="radar-link" onClick={() => void mutate(rpc.call("radar_lanes_reset", null))}>
              Restore the defaults
            </button>
          </p>
        ) : null}
        {onlyNew && visibleLanes.length === 0 ? <p className="radar-empty">You're caught up.</p> : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Radar",
    icon: "Radar",
    path: "board",
    component: RadarPage,
    headerContent: ViewToggle,
  });
  app.contentScripts.register({ id: "rail-badge", mount: mountRailBadge });
});
