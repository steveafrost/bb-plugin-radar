// Per-item hides: one PR or issue taken off every lane, view, count and the rail badge.
// Separate from Focus (which hides whole repos/areas). Pure, so the rules are tested;
// server.ts persists the list in the plugin database (1000 entries with titles and URLs
// would not fit in one 256KB kv value).
import { z } from "zod";
import { hosts } from "./hosts";
import type { Source } from "./lanes";

export const MAX_HIDDEN = 1000;
/** A hide lasts until undone, unless its item has been in no lane result for this long. */
export const HIDDEN_STALE_DAYS = 30;
/** lastSeenAt is rewritten at most this often, so a 90s poll doesn't write every cycle. */
export const TOUCH_INTERVAL_MS = 6 * 3_600_000;

const SOURCES = ["github", "delta", "gitstream"] as const;
export const KEY_PATTERN = /^(github|delta|gitstream):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d{1,10}$/;

/** PR data is untrusted: bounded strings, http(s) URLs only (rendered as text and UrlLink, never HTML). */
export const hiddenEntrySchema = z.object({
  key: z.string().max(260).regex(KEY_PATTERN),
  source: z.enum(SOURCES),
  kind: z.enum(["pr", "issue"]),
  repo: z.string().min(1).max(200),
  number: z.number().int().positive().max(1e10),
  title: z.string().max(300),
  url: z.string().max(600).refine((url) => url === "" || /^https?:\/\//i.test(url), "url must be http(s)"),
  hiddenAt: z.string().max(40).refine((stamp) => Number.isFinite(Date.parse(stamp)), "invalid date"),
  /** Last refresh the item was in any lane result; pruning keys off this. */
  lastSeenAt: z.string().max(40).refine((stamp) => Number.isFinite(Date.parse(stamp)), "invalid date"),
});
export type HiddenEntry = z.infer<typeof hiddenEntrySchema>;

/** Keys compare case-insensitively: a URL typed with different case is the same item. */
export const normKey = (key: string) => key.toLowerCase();

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

type ItemLike = { key: string; source: Source; kind: "pr" | "issue"; repo: string; number: number; title: string; url: string };

/** Item → entry, clipped to the schema's limits. Null when the item can't be stored. */
export function entryFor(item: ItemLike, now: Date): HiddenEntry | null {
  const stamp = now.toISOString();
  const parsed = hiddenEntrySchema.safeParse({
    key: item.key,
    source: item.source,
    kind: item.kind,
    repo: clip(item.repo, 200),
    number: item.number,
    title: clip(item.title.replace(/\s+/g, " ").trim(), 300),
    url: /^https?:\/\//i.test(item.url) && item.url.length <= 600 ? item.url : "",
    hiddenAt: stamp,
    lastSeenAt: stamp,
  });
  return parsed.success ? parsed.data : null;
}

/** Stored rows → valid entries (bad rows dropped, duplicates keep the newest), newest first, capped. */
export function parseHidden(rows: unknown): { entries: HiddenEntry[]; dropped: number } {
  if (!Array.isArray(rows)) return { entries: [], dropped: 0 };
  const byKey = new Map<string, HiddenEntry>();
  let dropped = 0;
  for (const row of rows) {
    const parsed = hiddenEntrySchema.safeParse(row);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    const id = normKey(parsed.data.key);
    const existing = byKey.get(id);
    if (existing !== undefined) dropped++;
    if (existing === undefined || existing.hiddenAt < parsed.data.hiddenAt) byKey.set(id, parsed.data);
  }
  const sorted = sortNewest([...byKey.values()]);
  return { entries: sorted.slice(0, MAX_HIDDEN), dropped: dropped + Math.max(0, sorted.length - MAX_HIDDEN) };
}

const sortNewest = (entries: HiddenEntry[]) => [...entries].sort((a, b) => b.hiddenAt.localeCompare(a.hiddenAt));

/** Adds (or re-hides) an entry; over the cap, the oldest hides are dropped. */
export function addHidden(entries: HiddenEntry[], entry: HiddenEntry, cap = MAX_HIDDEN): { entries: HiddenEntry[]; evicted: HiddenEntry[] } {
  const rest = entries.filter((existing) => normKey(existing.key) !== normKey(entry.key));
  const next = sortNewest([entry, ...rest]);
  return { entries: next.slice(0, cap), evicted: next.slice(cap) };
}

export function removeHidden(entries: HiddenEntry[], keys: string[] | "all"): { entries: HiddenEntry[]; removed: HiddenEntry[] } {
  if (keys === "all") return { entries: [], removed: entries };
  const drop = new Set(keys.map(normKey));
  return {
    entries: entries.filter((entry) => !drop.has(normKey(entry.key))),
    removed: entries.filter((entry) => drop.has(normKey(entry.key))),
  };
}

/**
 * After a refresh: entries whose item is in a lane result get a fresh lastSeenAt (and title/url,
 * at most every TOUCH_INTERVAL_MS); entries unseen for HIDDEN_STALE_DAYS are pruned. Pruning is
 * skipped when no lane fetched cleanly, so an outage can't empty the list.
 */
export function reconcileHidden(
  entries: HiddenEntry[],
  present: ItemLike[],
  now: Date,
  canPrune: boolean,
  staleDays = HIDDEN_STALE_DAYS,
): { entries: HiddenEntry[]; touched: HiddenEntry[]; pruned: HiddenEntry[] } {
  const byKey = new Map(present.map((item) => [normKey(item.key), item]));
  const stamp = now.toISOString();
  const touched: HiddenEntry[] = [];
  const pruned: HiddenEntry[] = [];
  const kept: HiddenEntry[] = [];
  for (const entry of entries) {
    const item = byKey.get(normKey(entry.key));
    if (item !== undefined) {
      if (now.getTime() - Date.parse(entry.lastSeenAt) < TOUCH_INTERVAL_MS) {
        kept.push(entry);
        continue;
      }
      const fresh = entryFor(item, now);
      const next = { ...entry, lastSeenAt: stamp, ...(fresh === null ? {} : { title: fresh.title, url: fresh.url || entry.url }) };
      touched.push(next);
      kept.push(next);
    } else if (canPrune && now.getTime() - Date.parse(entry.lastSeenAt) > staleDays * 86_400_000) {
      pruned.push(entry);
    } else kept.push(entry);
  }
  return { entries: kept, touched, pruned };
}

/** Removes hidden items from every lane result. Returns `results` unchanged when nothing is hidden. */
export function withoutHidden<R extends { items: { key: string }[] }>(results: Record<string, R>, hidden: ReadonlySet<string>): Record<string, R> {
  if (hidden.size === 0) return results;
  return Object.fromEntries(
    Object.entries(results).map(([id, result]) => {
      if (!result.items.some((item) => hidden.has(normKey(item.key)))) return [id, result];
      return [id, { ...result, items: result.items.filter((item) => !hidden.has(normKey(item.key))) }];
    }),
  );
}

export const hiddenSet = (entries: Iterable<{ key: string }>): Set<string> => new Set([...entries].map((entry) => normKey(entry.key)));

export type ItemRef = { key: string } | { source: Source | null; repo: string; number: number };

/**
 * CLI argument → item: a Radar key (github:owner/repo#12), a GitHub, Delta or Gitstream web URL
 * of a PR or issue, or owner/repo#12 (source resolved against the board by the caller).
 */
export function parseItemRef(input: string): ItemRef | null {
  const value = input.trim();
  const keyed = value.match(/^(github|delta|gitstream):(.*)$/i);
  if (keyed !== null && KEY_PATTERN.test(`${keyed[1]!.toLowerCase()}:${keyed[2]}`)) return { key: `${keyed[1]!.toLowerCase()}:${keyed[2]}` };
  const { gitstream, delta } = hosts();
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: [RegExp, Source | null][] = [
    [/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/i, "github"],
    ...(delta === null ? [] : [[new RegExp(`^https://${escape(delta.host)}/([^/]+/[^/]+)/(?:pull|pulls|issues)/(\\d+)(?:[/?#].*)?$`, "i"), "delta"] as [RegExp, Source]]),
    ...(gitstream === null ? [] : [[new RegExp(`^${escape(gitstream.web)}/repos/([^/]+/[^/]+)/pulls/(\\d+)(?:[/?#].*)?$`, "i"), "gitstream"] as [RegExp, Source]]),
    [/^([^/\s#]+\/[^/\s#]+)#(\d+)$/, null],
  ];
  for (const [pattern, source] of patterns) {
    const match = value.match(pattern);
    if (match === null) continue;
    const repo = match[1]!;
    const number = Number(match[2]);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes("..") || !Number.isSafeInteger(number) || number <= 0) return null;
    return source === null ? { source, repo, number } : { key: `${source}:${repo}#${number}` };
  }
  return null;
}

/**
 * Resolves a ref to one key among `candidates` (board items and hidden entries).
 * A full key or URL matches case-insensitively; owner/repo#n must be unique across sources.
 */
export function resolveItemKey(ref: ItemRef, candidates: { key: string; source: Source; repo: string; number: number }[]): string | { error: string } {
  if ("key" in ref) return candidates.find((candidate) => normKey(candidate.key) === normKey(ref.key))?.key ?? ref.key;
  const matches = [...new Set(candidates
    .filter((candidate) => candidate.repo.toLowerCase() === ref.repo.toLowerCase() && candidate.number === ref.number)
    .map((candidate) => candidate.key))];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) return { error: `${ref.repo}#${ref.number} is not on the board. Pass its URL or key (e.g. github:${ref.repo}#${ref.number}).` };
  return { error: `${ref.repo}#${ref.number} is on more than one host (${matches.join(", ")}); pass the URL or key.` };
}
