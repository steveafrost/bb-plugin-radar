/**
 * Focus filter: hide repositories (and, inside the area repo, areas) across every
 * lane, view, and the rail badge. Pure functions only; the server persists the
 * filter in plugin kv and the panel and CLI share these rules.
 *
 * Scope keys:
 * - a repository, as `owner/name` (`acme/billing`, `acme/monorepo`)
 * - an area of the area repo (a monorepo set in settings), as its `//` label path
 *   cut to three segments (`//areas/clients/mobile`)
 * - `//no-area`: area-repo items with no area label
 *
 * Keys compare case-insensitively.
 */
import { z } from "zod";
import { hosts } from "./hosts";

/** The monorepo whose `//` labels are areas ("" = areas off). */
const areaRepo = () => hosts().areaRepo;
export const NO_AREA = "//no-area";
/** `//areas/clients/mobile/...` → three segments: a group and an area. */
const AREA_DEPTH = 3;
const MAX_KEYS = 60;

const scopeKey = z.string().trim().min(1).max(200);
export const scopeFilterSchema = z
  .object({
    /** When non-empty, only items in one of these scopes show. */
    focus: z.array(scopeKey).max(MAX_KEYS),
    /** Items in these scopes are hidden (an area item hides when all its areas are hidden). */
    hidden: z.array(scopeKey).max(MAX_KEYS),
  })
  .strict();
export type ScopeFilter = z.infer<typeof scopeFilterSchema>;
export const EMPTY_SCOPE: ScopeFilter = { focus: [], hidden: [] };

type Scoped = { repo: string; labels: string[]; isNew?: boolean };

const lower = (value: string) => value.toLowerCase();
export const isAreaRepo = (repo: string) => areaRepo() !== "" && lower(repo) === lower(areaRepo());
export const isArea = (key: string) => key.startsWith("//");

/** A `//…` label (or typed path) → its area key, or null. */
export function areaKey(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed.startsWith("//")) return null;
  const parts = trimmed.slice(2).split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return `//${parts.slice(0, AREA_DEPTH).join("/")}`;
}

/** The area keys of an area-repo item (`[NO_AREA]` when it has none); [] for other repos. */
export function itemAreas(item: Scoped): string[] {
  if (!isAreaRepo(item.repo)) return [];
  const areas = new Set<string>();
  for (const label of item.labels) {
    const key = areaKey(label);
    if (key !== null) areas.add(key);
  }
  return areas.size === 0 ? [NO_AREA] : [...areas].sort();
}

export const isActive = (filter: ScopeFilter) => filter.focus.length > 0 || filter.hidden.length > 0;

/** Builds a fast visibility predicate for one filter. */
export function scopePredicate(filter: ScopeFilter): (item: Scoped) => boolean {
  const focus = new Set(filter.focus.map(lower));
  const hidden = new Set(filter.hidden.map(lower));
  if (focus.size === 0 && hidden.size === 0) return () => true;
  return (item) => {
    const repo = lower(item.repo);
    const areas = itemAreas(item).map(lower);
    if (focus.size > 0 && !focus.has(repo) && !areas.some((area) => focus.has(area))) return false;
    if (hidden.has(repo)) return false;
    // A PR touching several areas stays while any of them is still shown.
    if (areas.length > 0 && areas.every((area) => hidden.has(area))) return false;
    return true;
  };
}

export const scopeVisible = (item: Scoped, filter: ScopeFilter) => scopePredicate(filter)(item);

export function scopeLabel(key: string): string {
  if (lower(key) === NO_AREA) return `${areaRepo() || "repo"} (no area)`;
  if (isArea(key)) return key.replace(/^\/\/areas\//, "").replace(/^\/\//, "");
  return key;
}

export type ScopeEntry = {
  key: string;
  label: string;
  kind: "repo" | "area";
  /** Items in this scope (each counted once; a multi-area PR counts in each area). */
  total: number;
  fresh: number;
  /** Of `total`, how many the filter hides. */
  hiddenItems: number;
  /** The scope itself is hidden, or excluded by a focus elsewhere. */
  state: "shown" | "hidden" | "focused" | "unfocused";
  /** Area-repo areas, sorted by count. */
  children?: ScopeEntry[];
};

/**
 * Repos (with the area repo's areas nested) present in `items`, plus any filter keys
 * that are not, so a hidden scope can always be shown again. Sorted by count.
 */
export function scopeCatalog(items: (Scoped & { key: string })[], filter: ScopeFilter): ScopeEntry[] {
  const visible = scopePredicate(filter);
  const focus = new Set(filter.focus.map(lower));
  const hidden = new Set(filter.hidden.map(lower));
  type Acc = { key: string; total: number; fresh: number; hiddenItems: number };
  const repos = new Map<string, Acc>();
  const areas = new Map<string, Acc>();
  const seen = new Set<string>();
  const bump = (map: Map<string, Acc>, key: string, item: Scoped, shown: boolean) => {
    const id = lower(key);
    const acc = map.get(id) ?? { key, total: 0, fresh: 0, hiddenItems: 0 };
    acc.total++;
    if (item.isNew === true && shown) acc.fresh++;
    if (!shown) acc.hiddenItems++;
    map.set(id, acc);
  };
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const shown = visible(item);
    bump(repos, item.repo, item, shown);
    for (const area of itemAreas(item)) bump(areas, area, item, shown);
  }
  for (const key of [...filter.focus, ...filter.hidden]) {
    const map = isArea(key) ? areas : repos;
    if (!map.has(lower(key))) map.set(lower(key), { key, total: 0, fresh: 0, hiddenItems: 0 });
  }
  const world = areaRepo();
  if (areas.size > 0 && world !== "" && !repos.has(lower(world))) repos.set(lower(world), { key: world, total: 0, fresh: 0, hiddenItems: 0 });
  const stateOf = (key: string, parentFocused = false): ScopeEntry["state"] => {
    const id = lower(key);
    if (hidden.has(id)) return "hidden";
    if (focus.has(id) || parentFocused) return "focused";
    return focus.size > 0 ? "unfocused" : "shown";
  };
  const byCount = (a: ScopeEntry, b: ScopeEntry) => b.total - a.total || a.label.localeCompare(b.label);
  return [...repos.values()]
    .map((acc): ScopeEntry => {
      const state = stateOf(acc.key);
      const entry: ScopeEntry = { ...acc, label: scopeLabel(acc.key), kind: "repo", state };
      if (isAreaRepo(acc.key) && areas.size > 0) {
        entry.children = [...areas.values()]
          .map((area): ScopeEntry => {
            const own = stateOf(area.key, state === "focused");
            return {
              ...area,
              label: scopeLabel(area.key),
              kind: "area",
              state: state === "hidden" && own !== "hidden" ? "hidden" : own,
            };
          })
          .sort((a, b) => (a.key === NO_AREA ? 1 : b.key === NO_AREA ? -1 : byCount(a, b)));
      }
      return entry;
    })
    .sort(byCount);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export type ScopeOp = "focus" | "add-focus" | "hide" | "show" | "clear";

const without = (list: string[], keys: string[]) => {
  const drop = new Set(keys.map(lower));
  return list.filter((key) => !drop.has(lower(key)));
};
const union = (list: string[], keys: string[]) => {
  const out = [...list];
  const have = new Set(list.map(lower));
  for (const key of keys) {
    if (have.has(lower(key))) continue;
    have.add(lower(key));
    out.push(key);
  }
  return out;
};

/**
 * `focus` replaces the focus set; `add-focus` extends it; `hide` / `show` toggle
 * scopes; `clear` resets. `knownAreas` lets showing one area inside a hidden
 * area repo keep its sibling areas hidden.
 */
export function applyScopeOp(filter: ScopeFilter, op: ScopeOp, keys: string[], knownAreas: string[] = []): ScopeFilter {
  switch (op) {
    case "clear":
      return { focus: [], hidden: [] };
    case "focus":
      return { focus: union([], keys), hidden: without(filter.hidden, keys) };
    case "add-focus":
      return { focus: union(filter.focus, keys), hidden: without(filter.hidden, keys) };
    case "hide":
      return { focus: without(filter.focus, keys), hidden: union(filter.hidden, keys) };
    case "show": {
      let hidden = without(filter.hidden, keys);
      const areas = keys.filter(isArea);
      if (areas.length > 0 && hidden.some(isAreaRepo)) {
        // Unhide the area repo but keep its other areas hidden.
        const siblings = without(knownAreas.filter(isArea), areas);
        hidden = union(without(hidden, [areaRepo()]), siblings);
      }
      // While focusing, showing a scope means adding it to the focus.
      const focus = filter.focus.length > 0 ? union(filter.focus, keys) : filter.focus;
      return { focus, hidden };
    }
  }
}

/**
 * Typed CLI input → a scope key. Exact keys win, then a unique trailing match
 * (`billing`, `mobile`, `clients/mobile`), then any
 * well-formed `owner/name` or `//path`.
 */
export function resolveScope(input: string, known: string[]): string {
  let value = input.trim().replace(/\/+$/, "");
  if (value === "") throw new Error("Empty scope.");
  if (/^(no-?area|none|[\w.-]+\/[\w.-]+:no-?area|[\w.-]+\/[\w.-]+ \(no area\))$/i.test(value)) return NO_AREA;
  if (/^areas\//i.test(value)) value = `//${value}`;
  if (isArea(value)) value = areaKey(value) ?? value;
  const keys = [...new Set(known)];
  const exact = keys.find((key) => lower(key) === lower(value));
  if (exact !== undefined) return exact;
  const needle = `/${lower(value.replace(/^\/+/, ""))}`;
  const matches = keys.filter((key) => lower(key).endsWith(needle));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${input}" is ambiguous: ${matches.join(", ")}.`);
  if (isArea(value) || /^[\w.-]+\/[\w.-]+$/.test(value)) return value;
  throw new Error(`Unknown repo or area "${input}". Run bb radar scopes to list them.`);
}

/** One line for status output. */
export function describeScope(filter: ScopeFilter): string {
  if (!isActive(filter)) return "all repos";
  const parts: string[] = [];
  if (filter.focus.length > 0) parts.push(`only ${filter.focus.map(scopeLabel).join(", ")}`);
  if (filter.hidden.length > 0) parts.push(`hiding ${filter.hidden.map(scopeLabel).join(", ")}`);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Focus mode: a described focus, turned on and off as a whole
// ---------------------------------------------------------------------------

export const focusStateSchema = scopeFilterSchema
  .extend({
    /** Off keeps the last focus so it can be resumed; the board shows everything. */
    enabled: z.boolean(),
    /** What the user asked for, in their words. */
    description: z.string().max(600),
    /** Short phrase for the UI ("No billing"). */
    summary: z.string().max(120),
  })
  .strict();
export type FocusState = z.infer<typeof focusStateSchema>;
export const FOCUS_OFF: FocusState = { enabled: false, description: "", summary: "", focus: [], hidden: [] };

/** What the board filters by right now. */
export const effectiveScope = (state: FocusState): ScopeFilter =>
  state.enabled ? { focus: state.focus, hidden: state.hidden } : EMPTY_SCOPE;

/** Every key in a catalog, areas included. */
export const catalogKeys = (entries: ScopeEntry[]): string[] =>
  entries.flatMap((entry) => [entry.key, ...(entry.children ?? []).map((child) => child.key)]);

export function focusPrompt(description: string, entries: ScopeEntry[]) {
  const world = areaRepo() || "the area repo";
  const lines = entries.flatMap((entry) => [
    `${entry.key}  (${entry.total} items)`,
    ...(entry.children ?? []).map((child) => `  ${child.key}  (${child.total} items; ${child.key === NO_AREA ? `${world} items without an area label` : `${world} area`})`),
  ]);
  const system = `You set a focus filter for a panel of pull requests and issues. The user describes what helps them focus; you choose which repositories${areaRepo() ? ` or ${world} areas` : ""} to show or hide.
Reply with ONE JSON object and nothing else:
{ "focus": string[], "hidden": string[], "summary": string }

- "focus": scopes to show exclusively ("only mobile", "just billing"). Leave empty unless the user wants to narrow to something.
- "hidden": scopes to remove ("no billing", "I don't want to see the docs repo", "hide the personal repos").
- Use keys exactly as listed below. Repositories are owner/name${areaRepo() ? `; ${world} areas are //<path> label keys; ${NO_AREA} is ${world} without an area.
- To narrow inside ${world}, use area keys; to drop all of ${world} use "${world}".` : "."}
- A repo the user names that is not listed may still be used as owner/name if they spell it fully.
- "summary": 2-6 words describing the focus, e.g. "No billing", "Only mobile".

Scopes currently on the board:
${lines.join("\n") || "(none yet)"}`;
  return { system, user: description };
}

export type FocusChoice = { focus: string[]; hidden: string[]; summary: string };

/** Model text → a validated choice; unknown names are dropped. Throws when nothing usable remains. */
export function parseFocusReply(text: string, known: string[]): FocusChoice {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return a focus. Try rephrasing.");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("The model returned malformed JSON. Try again.");
  }
  const keys = (value: unknown) => {
    const out: string[] = [];
    for (const name of Array.isArray(value) ? value : []) {
      if (typeof name !== "string") continue;
      try {
        const key = resolveScope(name, known);
        if (!out.some((have) => lower(have) === lower(key))) out.push(key);
      } catch {
        // Not a scope on the board; skip it.
      }
    }
    return out.slice(0, MAX_KEYS);
  };
  const focus = keys(raw.focus);
  const hidden = keys(raw.hidden).filter((key) => !focus.some((have) => lower(have) === lower(key)));
  if (focus.length === 0 && hidden.length === 0) {
    throw new Error("That did not match any repository or area on the board. Name one, e.g. “no billing”.");
  }
  const summary = typeof raw.summary === "string" && raw.summary.trim() !== "" ? raw.summary.trim().slice(0, 120) : describeScope({ focus, hidden });
  return { focus, hidden, summary };
}

const NEGATION = /\b(no|not|don'?t|dont|without|hide|hiding|except|exclude|excluding|minus|skip|ignore|less)\b/i;

/**
 * Offline fallback when no AI is configured: scopes whose last path segment appears in the
 * text. Each clause ("only mobile, no billing") decides on its own: a negation in that
 * clause hides its hits, otherwise they're focused.
 */
export function heuristicFocus(description: string, known: string[]): FocusChoice {
  const unique = [...new Set(known)];
  const tailOf = (key: string) => lower(key === NO_AREA ? "no-area" : key.split("/").filter(Boolean).pop() ?? key);
  const focus: string[] = [];
  const hidden: string[] = [];
  for (const clause of description.toLowerCase().split(/[,;.]|\bbut\b|\band\b/)) {
    const text = ` ${clause.replace(/[^a-z0-9/_.-]+/g, " ")} `;
    const hits = unique.filter((key) => {
      const tail = tailOf(key);
      return tail.length >= 4 && (text.includes(` ${tail} `) || text.includes(` ${lower(key)} `));
    });
    if (hits.length === 0) continue;
    // "no-area" is a name, not a negation.
    const negated = NEGATION.test(clause.replace(/no-area/g, " "));
    for (const key of hits) {
      const target = negated ? hidden : focus;
      if (!focus.includes(key) && !hidden.includes(key)) target.push(key);
    }
  }
  if (focus.length === 0 && hidden.length === 0) throw new Error("That did not match any repository or area on the board.");
  const choice = { focus, hidden };
  return { ...choice, summary: describeScope(choice) };
}
