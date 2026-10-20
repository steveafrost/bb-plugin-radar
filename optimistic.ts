// Optimistic board updates. Acknowledging a mention, marking items seen or hiding one changes the
// board at once; the server's snapshot replaces the guess when its RPC returns.
import { normKey } from "./hidden";
import { itemInView, laneInView, type View } from "./lanes";
import { scopePredicate } from "./scope";
import type { RadarSnapshot } from "./server";

export type PendingOp =
  | { kind: "acknowledge"; key: string }
  | { kind: "seen"; laneId?: string; view: View }
  | { kind: "hide"; key: string };

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

/** Mirrors the server: a hidden item leaves every lane, view, count and the badge. */
function hide(snapshot: RadarSnapshot, key: string): RadarSnapshot {
  const id = normKey(key);
  let found = false;
  const results = Object.fromEntries(Object.entries(snapshot.results).map(([lane, result]) => {
    if (!result.items.some((item) => normKey(item.key) === id)) return [lane, result];
    found = true;
    return [lane, { ...result, items: result.items.filter((item) => normKey(item.key) !== id) }];
  }));
  return found ? { ...snapshot, results, hiddenCount: snapshot.hiddenCount + 1 } : snapshot;
}

/** Applies ops still waiting on the server, in order, so a stale snapshot can't undo them. */
export function applyPending(snapshot: RadarSnapshot, ops: Iterable<PendingOp>): RadarSnapshot {
  let next = snapshot;
  for (const op of ops) {
    if (op.kind === "acknowledge") next = acknowledge(next, op.key);
    else if (op.kind === "seen") next = markSeen(next, op.laneId, op.view);
    else next = hide(next, op.key);
  }
  return next;
}
