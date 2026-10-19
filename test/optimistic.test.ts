import { describe, expect, it } from "vitest";
import { applyPending, type PendingOp } from "../optimistic";
import type { RadarSnapshot } from "../server";

const item = (key: string, extra: Record<string, unknown> = {}) =>
  ({ key, kind: "pr", repo: "acme/web", number: 1, isNew: true, ...extra }) as never;

function board(): RadarSnapshot {
  return {
    lanes: [
      { id: "mentions", category: "reviews" },
      { id: "mine", category: "prs" },
    ],
    results: {
      mentions: { items: [item("a", { canAcknowledge: true }), item("b", { canAcknowledge: true })] },
      mine: { items: [item("a"), item("c", { kind: "issue" })] },
    },
    scope: { focus: [], hidden: [] },
  } as unknown as RadarSnapshot;
}

describe("applyPending", () => {
  it("removes an acknowledged mention only where it could be acknowledged", () => {
    const next = applyPending(board(), [{ kind: "acknowledge", key: "a" }]);
    expect(next.results.mentions!.items.map((i) => i.key)).toEqual(["b"]);
    expect(next.results.mine!.items.map((i) => i.key)).toEqual(["a", "c"]);
  });

  it("marks one lane seen, limited to the view", () => {
    const next = applyPending(board(), [{ kind: "seen", laneId: "mine", view: "prs" }]);
    expect(next.results.mine!.items.map((i) => i.isNew)).toEqual([false, true]);
    expect(next.results.mentions!.items.every((i) => i.isNew)).toBe(true);
  });

  it("marks every lane seen for the all view, leaving focus-hidden items new", () => {
    const snapshot = { ...board(), scope: { focus: [], hidden: ["acme/web"] } } as unknown as RadarSnapshot;
    snapshot.results.mine!.items[1] = item("c", { kind: "issue", repo: "acme/api" });
    const next = applyPending(snapshot, [{ kind: "seen", view: "all" }]);
    expect(next.results.mine!.items.map((i) => i.isNew)).toEqual([true, false]);
  });

  it("does not mutate the server snapshot and is a no-op with nothing pending", () => {
    const snapshot = board();
    const ops: PendingOp[] = [{ kind: "acknowledge", key: "a" }, { kind: "seen", view: "all" }];
    applyPending(snapshot, ops);
    expect(snapshot.results.mentions!.items).toHaveLength(2);
    expect(snapshot.results.mine!.items[0]!.isNew).toBe(true);
    expect(applyPending(snapshot, [])).toBe(snapshot);
  });
});
