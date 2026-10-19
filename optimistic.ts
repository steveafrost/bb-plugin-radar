// Optimistic board updates. Acknowledging a mention or marking items seen changes the
// board at once; the server's snapshot replaces the guess when its RPC returns.
import { itemInView, laneInView, type View } from "./lanes";
import { scopePredicate } from "./scope";
import type { RadarSnapshot } from "./server";

export type PendingOp =
  | { kind: "acknowledge"; key: string }
  | { kind: "seen"; laneId?: string; view: View };

/** Mirrors the server: an acknowledged mention leaves the lanes where it could be acknowledged. */
function acknowledge(snapshot: RadarSnapshot, key: string): RadarSnapshot {
  const results = Object.fromEntries(Object.entries(snapshot.results).map(([id, result]) => {
    if (!result.items.some((item) => item.key === key && item.canAcknowledge)) return [id, result];
    return [id, { ...result, items: result.items.filter((item) => !(item.key === key && item.canAcknowledge)) }];
  }));
  return { ...snapshot, results };
}

/** Mirrors server markSeen: items in the view that the focus filter shows stop being new. */
function markSeen(snapshot: RadarSnapshot, laneId: string | undefined, view: View): RadarSnapshot {
  const visible = scopePredicate(snapshot.scope);
  const results = { ...snapshot.results };
  for (const lane of snapshot.lanes) {
    if (laneId !== undefined ? lane.id !== laneId : !laneInView(lane, view)) continue;
    const result = results[lane.id];
    if (result === undefined) continue;
    const hit = (item: (typeof result.items)[number]) => item.isNew && itemInView(item, view) && visible(item);
    if (!result.items.some(hit)) continue;
    results[lane.id] = { ...result, items: result.items.map((item) => (hit(item) ? { ...item, isNew: false } : item)) };
  }
  return { ...snapshot, results };
}

/** Applies ops still waiting on the server, in order, so a stale snapshot can't undo them. */
export function applyPending(snapshot: RadarSnapshot, ops: Iterable<PendingOp>): RadarSnapshot {
  let next = snapshot;
  for (const op of ops) next = op.kind === "acknowledge" ? acknowledge(next, op.key) : markSeen(next, op.laneId, op.view);
  return next;
}
