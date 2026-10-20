import { describe, expect, it } from "vitest";
import {
  addHidden,
  entryFor,
  hiddenSet,
  MAX_HIDDEN,
  parseHidden,
  parseItemRef,
  reconcileHidden,
  removeHidden,
  resolveItemKey,
  TOUCH_INTERVAL_MS,
  withoutHidden,
  type HiddenEntry,
} from "../hidden";
import { applyPending } from "../optimistic";
import type { RadarSnapshot } from "../server";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const item = (number: number, extra: Record<string, unknown> = {}) => ({
  key: `github:acme/web#${number}`,
  source: "github" as const,
  kind: "pr" as const,
  repo: "acme/web",
  number,
  title: `Fix ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  ...extra,
});

const entry = (number: number, at = NOW, extra: Partial<HiddenEntry> = {}): HiddenEntry => ({ ...entryFor(item(number), at)!, ...extra });

describe("entryFor", () => {
  it("keeps what the restore list needs", () => {
    expect(entryFor(item(7), NOW)).toEqual({
      key: "github:acme/web#7", source: "github", kind: "pr", repo: "acme/web", number: 7, title: "Fix 7",
      url: "https://github.com/acme/web/pull/7", hiddenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(),
    });
  });

  it("treats PR data as untrusted: clips titles, drops non-http URLs, rejects odd keys", () => {
    const long = entryFor(item(1, { title: `<b>${"x".repeat(1000)}</b>\n` }), NOW)!;
    expect(long.title.length).toBeLessThanOrEqual(300);
    expect(entryFor(item(1, { url: "javascript:alert(1)" }), NOW)!.url).toBe("");
    expect(entryFor(item(1, { key: "github:acme/web#1<script>" }), NOW)).toBeNull();
  });
});

describe("parseHidden", () => {
  it("tolerates bad data: non-arrays, bad rows, duplicates", () => {
    expect(parseHidden(undefined)).toEqual({ entries: [], dropped: 0 });
    expect(parseHidden({ nope: 1 })).toEqual({ entries: [], dropped: 0 });
    const older = entry(1, days(3));
    const newer = { ...entry(1, days(1)), key: "github:ACME/web#1" };
    const { entries, dropped } = parseHidden([null, "x", { ...entry(2), url: "file:///etc" }, { ...entry(3), hiddenAt: "never" }, older, newer, entry(4)]);
    expect(entries.map((e) => e.key)).toEqual(["github:acme/web#4", "github:ACME/web#1"]);
    expect(dropped).toBe(5);
  });

  it("caps at MAX_HIDDEN, keeping the newest", () => {
    const rows = Array.from({ length: MAX_HIDDEN + 5 }, (_, i) => entry(i + 1, new Date(NOW.getTime() - i * 1000)));
    const { entries, dropped } = parseHidden(rows);
    expect(entries).toHaveLength(MAX_HIDDEN);
    expect(entries[0]!.number).toBe(1);
    expect(dropped).toBe(5);
  });
});

describe("hide and unhide", () => {
  it("adds newest first, re-hiding moves to the top, and evicts the oldest over the cap", () => {
    let list: HiddenEntry[] = [];
    list = addHidden(list, entry(1, days(2))).entries;
    list = addHidden(list, entry(2, days(1))).entries;
    list = addHidden(list, entry(1, NOW)).entries;
    expect(list.map((e) => e.number)).toEqual([1, 2]);
    const capped = addHidden(list, entry(3, NOW), 2);
    expect(capped.entries.map((e) => e.number)).toEqual([3, 1]);
    expect(capped.evicted.map((e) => e.number)).toEqual([2]);
  });

  it("unhides one (case-insensitively) or all", () => {
    const list = [entry(1), entry(2)];
    expect(removeHidden(list, ["GITHUB:acme/WEB#1"])).toEqual({ entries: [entry(2)], removed: [entry(1)] });
    expect(removeHidden(list, ["github:acme/web#9"]).removed).toEqual([]);
    expect(removeHidden(list, "all")).toEqual({ entries: [], removed: list });
  });
});

describe("reconcileHidden (pruning)", () => {
  it("prunes entries whose item has been in no lane for 30+ days; a hide on the board stays", () => {
    const list = [entry(1, days(90), { lastSeenAt: days(40).toISOString() }), entry(2, days(90), { lastSeenAt: days(40).toISOString() }), entry(3, days(10))];
    const { entries, pruned, touched } = reconcileHidden(list, [item(2, { title: "Renamed" })], NOW, true);
    expect(pruned.map((e) => e.number)).toEqual([1]);
    expect(entries.map((e) => e.number)).toEqual([2, 3]);
    expect(touched).toEqual([{ ...list[1]!, lastSeenAt: NOW.toISOString(), title: "Renamed" }]);
  });

  it("doesn't prune when no lane fetched cleanly, and doesn't rewrite lastSeenAt every poll", () => {
    const stale = entry(1, days(90), { lastSeenAt: days(40).toISOString() });
    expect(reconcileHidden([stale], [], NOW, false).pruned).toEqual([]);
    const recent = entry(2, new Date(NOW.getTime() - TOUCH_INTERVAL_MS / 2));
    expect(reconcileHidden([recent], [item(2)], NOW, true).touched).toEqual([]);
  });
});

describe("filtering", () => {
  it("removes a hidden item from every lane, matching keys case-insensitively", () => {
    const results = {
      a: { items: [item(1), item(2)] },
      b: { items: [{ ...item(1), key: "github:Acme/Web#1" }] },
      c: { items: [item(3)] },
    };
    const next = withoutHidden(results, hiddenSet([entry(1)]));
    expect(next.a!.items.map((i) => i.number)).toEqual([2]);
    expect(next.b!.items).toEqual([]);
    expect(next.c).toBe(results.c);
    expect(withoutHidden(results, new Set())).toBe(results);
  });

  it("the optimistic hide drops the item everywhere and counts it once", () => {
    const board = {
      lanes: [{ id: "a", category: "prs" }, { id: "b", category: "reviews" }],
      results: { a: { items: [{ ...item(1), isNew: true }] }, b: { items: [{ ...item(1), isNew: true }, { ...item(2), isNew: true }] } },
      scope: { focus: [], hidden: [] },
      hiddenCount: 0,
    } as unknown as RadarSnapshot;
    const next = applyPending(board, [{ kind: "hide", key: "github:acme/web#1" }]);
    expect(next.results.a!.items).toEqual([]);
    expect(next.results.b!.items.map((i) => i.number)).toEqual([2]);
    expect(next.hiddenCount).toBe(1);
    // Badge/tab counts are unique new items over the snapshot: the hidden one is gone.
    const fresh = new Set(Object.values(next.results).flatMap((r) => r.items.filter((i) => i.isNew).map((i) => i.key)));
    expect([...fresh]).toEqual(["github:acme/web#2"]);
    // Once the server snapshot already omits it, re-applying is a no-op (no double count).
    const settled = { ...board, results: withoutHidden(board.results, hiddenSet([entry(1)])), hiddenCount: 1 } as RadarSnapshot;
    expect(applyPending(settled, [{ kind: "hide", key: "github:acme/web#1" }])).toBe(settled);
  });
});

describe("parseItemRef (CLI url → key)", () => {
  it.each([
    ["github:acme/web#12", "github:acme/web#12"],
    ["GITHUB:Acme/Web#12", "github:Acme/Web#12"],
    ["https://github.com/acme/web/pull/12", "github:acme/web#12"],
    ["https://github.com/acme/web/pull/12/files?x=1", "github:acme/web#12"],
    ["https://github.com/acme/web/issues/34#issuecomment-1", "github:acme/web#34"],
    ["https://delta.example.com/acme/monorepo/pull/56", "delta:acme/monorepo#56"],
    ["https://delta.example.com/acme/monorepo/issues/57", "delta:acme/monorepo#57"],
    ["https://gitstream.example.com/repos/acme/monorepo/pulls/78", "gitstream:acme/monorepo#78"],
  ])("%s → %s", (input, key) => {
    expect(parseItemRef(input)).toEqual({ key });
  });

  it("leaves owner/repo#n to be resolved against the board", () => {
    expect(parseItemRef("acme/web#9")).toEqual({ source: null, repo: "acme/web", number: 9 });
  });

  it.each(["", "hide", "https://evil.example.com/acme/web/pull/1", "https://github.com/acme/web/pull/0", "acme/../x#1", "github:acme/web#x"])("rejects %j", (input) => {
    expect(parseItemRef(input)).toBeNull();
  });
});

describe("resolveItemKey", () => {
  const board = [item(1), { ...item(2), key: "delta:acme/web#2", source: "delta" as const }, { ...item(3), key: "delta:acme/web#3", source: "delta" as const }, item(3)];
  it("matches a key case-insensitively to the stored spelling", () => {
    expect(resolveItemKey({ key: "github:ACME/web#1" }, board)).toBe("github:acme/web#1");
    expect(resolveItemKey({ key: "github:acme/web#99" }, board)).toBe("github:acme/web#99");
  });
  it("resolves owner/repo#n when unique, errors when missing or on two hosts", () => {
    expect(resolveItemKey({ source: null, repo: "Acme/Web", number: 2 }, board)).toBe("delta:acme/web#2");
    expect(resolveItemKey({ source: null, repo: "acme/web", number: 5 }, board)).toHaveProperty("error");
    expect(resolveItemKey({ source: null, repo: "acme/web", number: 3 }, board)).toHaveProperty("error");
  });
});
