/**
 * One-line, human description of what a lane matches, e.g.
 * "Open PRs requesting your review · 3 sources". Heuristic: reads the common
 * GitHub qualifiers and Gitstream-history principals; anything else is left out.
 */
import { enabledSources, SOURCE_LABEL, type Lane } from "./lanes";

const person = (who: string) => (who === "@me" ? "you" : who.replace(/^@/, ""));
const possessive = (who: string) => (who === "@me" ? "your" : `${person(who)}'s`);
const shortLabel = (label: string) => label.replace(/^\/\/areas\/[^/]+\//, "").replace(/^\/\//, "");

const PHRASES: Record<string, (who: string) => string> = {
  "review-requested": (who) => `requesting ${possessive(who)} review`,
  author: (who) => `by ${person(who)}`,
  assignee: (who) => `assigned to ${person(who)}`,
  mentions: (who) => `mentioning ${person(who)}`,
  involves: (who) => `involving ${person(who)}`,
  "reviewed-by": (who) => `reviewed by ${person(who)}`,
  commenter: (who) => `commented on by ${person(who)}`,
};

export function summarizeLane(lane: Partial<Lane>): string {
  const sources = (lane.sources ?? []).filter((source) => enabledSources().includes(source));
  const searched = sources.some((source) => source !== "gitstream");
  const query = searched ? (lane.query ?? "") : "";
  const tokens = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const qualifier = (token: string) => {
    const match = token.match(/^(-?)([a-z-]+):(.+)$/);
    return match ? { negated: match[1] === "-", key: match[2]!, value: match[3]!.replace(/"/g, "") } : null;
  };
  const parsed = tokens.map(qualifier).filter((entry) => entry !== null);
  const has = (key: string, value?: string) => parsed.some((q) => !q.negated && q.key === key && (value === undefined || q.value === value));

  const gs = sources.includes("gitstream") ? (lane.gitstream ?? {}) : undefined;

  const prs = has("is", "pr") || has("type", "pr");
  const issues = has("is", "issue") || has("type", "issue");
  const kind = !searched || (prs && !issues) ? "PRs" : issues && !prs ? "issues" : "PRs and issues";

  const closed = has("is", "closed") || gs?.state === "closed";
  const open = has("is", "open") || (gs !== undefined && (gs.state === undefined || gs.state === "open"));
  const state = closed && !open ? "Closed" : open && !closed ? "Open" : "";

  const who = new Set<string>();
  for (const q of parsed) if (!q.negated && PHRASES[q.key]) who.add(PHRASES[q.key]!(q.value));
  if (gs) {
    if (gs.reviewRequested) who.add(PHRASES["review-requested"]!(gs.reviewRequested));
    if (gs.author) who.add(PHRASES.author!(gs.author));
    if (gs.assignee) who.add(PHRASES.assignee!(gs.assignee));
    if (gs.reviewedBy) who.add(PHRASES["reviewed-by"]!(gs.reviewedBy));
    const scoped = gs.reviewRequested || gs.author || gs.assignee || gs.reviewedBy || gs.head;
    if (!scoped) who.add(gs.everyone ? "from everyone" : PHRASES.author!("@me"));
  }

  const labels = new Set<string>();
  for (const q of parsed) if (!q.negated && q.key === "label") labels.add(shortLabel(q.value));
  for (const label of gs?.labels ?? []) labels.add(shortLabel(label));

  let head = [state, state ? kind : kind.charAt(0).toUpperCase() + kind.slice(1)].filter(Boolean).join(" ");
  if (who.size > 0) head += ` ${[...who].join(" or ")}`;
  if (labels.size > 0) head += ` in ${[...labels].join(", ")}`;

  const tail: string[] = [];
  if (sources.length === 1) tail.push(`${SOURCE_LABEL[sources[0]!]} only`);
  else if (sources.length > 1) tail.push(`${sources.length} sources`);
  const days = lane.filter?.updatedWithinDays;
  if (days !== undefined) tail.push(`updated in ${days}d`);
  if (lane.filter?.excludeDrafts || gs?.draft === false || parsed.some((q) => q.negated && q.key === "is" && q.value === "draft")) {
    tail.push("no drafts");
  }
  return [head, ...tail].join(" · ");
}
