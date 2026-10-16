/** Editor form state <-> Lane. Pure, so the round trip is unit-tested. */
import { enabledSources, inferCategory, SOURCES, type Category, type Lane, type Source } from "./lanes";

export type ListKey = "labels" | "excludeLabels" | "titleIncludes" | "labelsAny" | "excludeAuthors";

export type Draft = {
  id?: string;
  title: string;
  sources: Source[];
  query: string;
  reviewRequested: string;
  author: string;
  excludeAuthor: string;
  assignee: string;
  reviewedBy: string;
  base: string;
  head: string;
  state: "" | "open" | "closed" | "all";
  everyone: boolean;
  labels: string[];
  excludeLabels: string[];
  textQuery: string;
  draftState: "" | "true" | "false";
  approval: "" | "true" | "false";
  titleIncludes: string[];
  labelsAny: string[];
  excludeAuthors: string[];
  excludeDrafts: boolean;
  updatedWithinDays: string;
  limit: string;
  description?: string;
  collapsed?: boolean;
  /** Only meaningful while pinned; unpinned lanes take the category their query implies. */
  category: Category;
  categoryPinned: boolean;
};

const tri = (value: boolean | undefined) => (value === undefined ? "" : value ? "true" : "false");

export function toDraft(lane?: Lane): Draft {
  const q = lane?.gitstream ?? {};
  const f = lane?.filter ?? {};
  return {
    id: lane?.id,
    title: lane?.title ?? "",
    sources: lane?.sources ?? enabledSources(),
    query: lane?.query ?? "is:open is:pr ",
    reviewRequested: q.reviewRequested ?? "",
    author: q.author ?? "",
    excludeAuthor: q.excludeAuthor ?? "",
    assignee: q.assignee ?? "",
    reviewedBy: q.reviewedBy ?? "",
    base: q.base ?? "",
    head: q.head ?? "",
    state: q.state ?? "",
    everyone: q.everyone === true,
    labels: q.labels ?? [],
    excludeLabels: q.excludeLabels ?? [],
    textQuery: q.query ?? "",
    draftState: tri(q.draft),
    approval: tri(q.hasApproval),
    titleIncludes: f.titleIncludes ?? [],
    labelsAny: f.labelsAny ?? [],
    excludeAuthors: f.excludeAuthors ?? [],
    excludeDrafts: f.excludeDrafts === true,
    updatedWithinDays: f.updatedWithinDays === undefined ? "" : String(f.updatedWithinDays),
    limit: lane?.limit === undefined ? "" : String(lane.limit),
    description: lane?.description,
    collapsed: lane?.collapsed,
    category: lane?.category ?? "prs",
    categoryPinned: lane?.categoryPinned === true,
  };
}

/** The category the form's query implies, ignoring any pin. */
export const draftInferredCategory = (draft: Draft): Category => inferCategory(fromDraft({ ...draft, categoryPinned: false }));

/** The category the lane will be saved with. */
export const draftCategory = (draft: Draft): Category => (draft.categoryPinned ? draft.category : draftInferredCategory(draft));

/** Picking the inferred category un-pins, so the lane follows its query again. */
export function pickCategory(draft: Draft, category: Category): Draft {
  return draftInferredCategory(draft) === category ? { ...draft, category, categoryPinned: false } : { ...draft, category, categoryPinned: true };
}

/** Gitstream principals that replace the author=@me default. */
export const gitstreamScoped = (draft: Draft) =>
  [draft.reviewRequested, draft.author, draft.assignee, draft.reviewedBy, draft.head].some((value) => value.trim() !== "");

export function fromDraft(draft: Draft): Partial<Lane> {
  const opt = (value: string) => (value.trim() === "" ? undefined : value.trim());
  const arr = (value: string[]) => (value.length ? value : undefined);
  const bool = (value: "" | "true" | "false") => (value === "" ? undefined : value === "true");
  const filter = {
    titleIncludes: arr(draft.titleIncludes),
    labelsAny: arr(draft.labelsAny),
    excludeAuthors: arr(draft.excludeAuthors),
    excludeDrafts: draft.excludeDrafts || undefined,
    updatedWithinDays: opt(draft.updatedWithinDays) === undefined ? undefined : Number(draft.updatedWithinDays),
  };
  const hasFilter = Object.values(filter).some((value) => value !== undefined);
  const lane = JSON.parse(
    JSON.stringify({
      id: draft.id,
      title: draft.title.trim(),
      sources: SOURCES.filter((source) => draft.sources.includes(source)),
      query: draft.sources.some((source) => source !== "gitstream") ? draft.query.trim() : undefined,
      gitstream:
        draft.sources.includes("gitstream")
          ? {
              reviewRequested: opt(draft.reviewRequested),
              author: opt(draft.author),
              excludeAuthor: opt(draft.excludeAuthor),
              assignee: opt(draft.assignee),
              reviewedBy: opt(draft.reviewedBy),
              base: opt(draft.base),
              head: opt(draft.head),
              state: draft.state === "" ? undefined : draft.state,
              // Only meaningful without a principal; dropped otherwise so it can't go stale.
              everyone: (draft.everyone && !gitstreamScoped(draft)) || undefined,
              labels: arr(draft.labels),
              excludeLabels: arr(draft.excludeLabels),
              query: opt(draft.textQuery),
              draft: bool(draft.draftState),
              hasApproval: bool(draft.approval),
            }
          : undefined,
      filter: hasFilter ? filter : undefined,
      limit: opt(draft.limit) === undefined ? undefined : Number(draft.limit),
      description: draft.description,
      collapsed: draft.collapsed,
    }),
  ) as Partial<Lane>;
  return draft.categoryPinned ? { ...lane, category: draft.category, categoryPinned: true } : { ...lane, category: inferCategory(lane) };
}

