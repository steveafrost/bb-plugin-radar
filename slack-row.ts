/**
 * How a row's Slack action reads, from the snapshot's Slack state. Pure, so the board and tests
 * agree on it. A row the sweep has not searched yet is "unchecked", not "none": only a search
 * that ran and found no linked threads earns the cross.
 */
export type SlackRowMode = "unchecked" | "none" | "context" | "new";

export function slackRowMode(
  found: { threads: number; isNew: boolean } | undefined,
  searched: boolean,
): { mode: SlackRowMode; threads: number } {
  if (found !== undefined && found.threads > 0) return { mode: found.isNew ? "new" : "context", threads: found.threads };
  return { mode: searched ? "none" : "unchecked", threads: 0 };
}

/**
 * The snapshot's per-item Slack state for the board's candidate keys: `items` are linked from at
 * least one live thread, `none` were searched and nothing links them. Keys in neither have not
 * been searched (or every search of them failed), so the board must not call them "none found".
 */
export function slackBoardState(
  keys: Iterable<string>,
  threadsOf: (key: string) => number,
  searched: ReadonlySet<string>,
  isNewOf: (key: string) => boolean,
): { items: Record<string, { threads: number; isNew: boolean }>; none: string[] } {
  const items: Record<string, { threads: number; isNew: boolean }> = {};
  const none: string[] = [];
  for (const key of keys) {
    const threads = threadsOf(key);
    if (threads > 0) items[key] = { threads, isNew: isNewOf(key) };
    else if (searched.has(key)) none.push(key);
  }
  return { items, none };
}
