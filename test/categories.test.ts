import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANES,
  inferCategory,
  itemInView,
  laneInView,
  lanesSchema,
  laneSchema,
  parseDraft,
  requestedCategory,
  viewFrom,
  VIEWS,
  type Lane,
} from "../lanes";
import { draftCategory, fromDraft, pickCategory, toDraft } from "../lane-draft";

const gh = (query: string) => ({ sources: ["github"], query });

describe("inferCategory", () => {
  it("puts review queues in reviews", () => {
    expect(inferCategory(gh("is:open is:pr review-requested:@me"))).toBe("reviews");
    expect(inferCategory(gh("is:pr reviewed-by:@me"))).toBe("reviews");
    expect(inferCategory(gh("is:pr user-review-requested:@me"))).toBe("reviews");
    expect(inferCategory(gh("is:pr team-review-requested:acme/payments"))).toBe("reviews");
    expect(inferCategory({ sources: ["gitstream"], gitstream: { reviewRequested: "@me" } })).toBe("reviews");
    expect(inferCategory({ sources: ["gitstream"], gitstream: { reviewedBy: "a@example.com" } })).toBe("reviews");
  });

  it("does not treat a negated review qualifier as a review queue", () => {
    expect(inferCategory(gh("is:pr author:@me -review-requested:@me"))).toBe("prs");
  });

  it("ignores fields of a source the lane does not read", () => {
    // Gitstream filters left on a GitHub-only lane, and a query left on a Gitstream-only lane.
    expect(inferCategory({ sources: ["github"], query: "is:pr author:@me", gitstream: { reviewRequested: "@me" } })).toBe("prs");
    expect(inferCategory({ sources: ["gitstream"], query: "is:issue", gitstream: { author: "@me" } })).toBe("prs");
  });

  it("puts PR-only lanes in prs", () => {
    expect(inferCategory(gh("is:open is:pr author:@me"))).toBe("prs");
    expect(inferCategory(gh("type:pr label:x"))).toBe("prs");
    expect(inferCategory(gh("-is:issue author:@me"))).toBe("prs");
    expect(inferCategory({ sources: ["gitstream"], gitstream: {} })).toBe("prs");
    expect(inferCategory({ sources: ["github", "gitstream", "delta"], query: "is:open is:pr author:@me", gitstream: { author: "@me" } })).toBe("prs");
  });

  it("puts issue-only lanes in issues", () => {
    expect(inferCategory(gh("is:open is:issue assignee:@me"))).toBe("issues");
    expect(inferCategory(gh("-is:pr repo:acme/issues"))).toBe("issues");
  });

  it("puts mixed or unclear lanes in all", () => {
    expect(inferCategory(gh("is:open mentions:@me"))).toBe("all");
    expect(inferCategory(gh("is:pr is:issue"))).toBe("all");
    // Gitstream only has PRs, so an issue query beside it mixes kinds.
    expect(inferCategory({ sources: ["github", "gitstream"], query: "is:issue", gitstream: {} })).toBe("all");
    expect(inferCategory({})).toBe("all");
    expect(inferCategory({ sources: "github", query: 5 })).toBe("all");
  });

  it("gives the default lanes the categories they declare", () => {
    const byId = Object.fromEntries(DEFAULT_LANES.map((lane) => [lane.id, lane.category]));
    expect(byId).toEqual({ reviews: "reviews", mine: "prs", "github-mentions": "all", "github-assigned": "issues" });
    for (const lane of DEFAULT_LANES) expect(inferCategory(lane)).toBe(lane.category);
  });
});

describe("lane category migration", () => {
  // Lanes stored before categories existed.
  const stored = [
    { id: "github-reviews", title: "Reviews requested", sources: ["github", "gitstream", "delta"], query: "is:open is:pr review-requested:@me archived:false", gitstream: { reviewRequested: "@me" } },
    { id: "github-mentions", title: "Mentions", sources: ["github"], query: "is:open mentions:@me archived:false" },
    { id: "github-assigned", title: "Assigned issues", sources: ["github"], query: "is:open is:issue assignee:@me archived:false" },
    { id: "my-open-prs", title: "My open PRs", source: "gitstream", gitstream: { author: "@me" } },
  ];

  it("infers a category for lanes stored without one", () => {
    const lanes = lanesSchema.parse(stored);
    expect(lanes.map((lane) => [lane.id, lane.category])).toEqual([
      ["github-reviews", "reviews"],
      ["github-mentions", "all"],
      ["github-assigned", "issues"],
      ["my-open-prs", "prs"],
    ]);
    expect(lanes.every((lane) => lane.categoryPinned === undefined)).toBe(true);
  });

  it("keeps a pinned category and re-infers an unpinned one", () => {
    expect(laneSchema.parse({ ...stored[1], category: "issues", categoryPinned: true }).category).toBe("issues");
    expect(laneSchema.parse({ ...stored[1], category: "issues" }).category).toBe("all");
    // A pin with a junk category falls back to inference rather than failing the load.
    const junk = laneSchema.parse({ ...stored[1], category: "nope", categoryPinned: true });
    expect([junk.category, junk.categoryPinned]).toEqual(["all", undefined]);
  });
});

describe("requestedCategory", () => {
  const lane = { sources: ["github"], query: "is:open mentions:@me" };

  it("infers when absent or invalid", () => {
    expect(requestedCategory(lane)).toEqual({ category: "all" });
    expect(requestedCategory({ ...lane, category: "weird" })).toEqual({ category: "all" });
  });

  it("pins an explicit category that differs from the query", () => {
    expect(requestedCategory({ ...lane, category: "issues" })).toEqual({ category: "issues", categoryPinned: true });
    expect(requestedCategory({ ...lane, category: "all" })).toEqual({ category: "all" });
  });

  it("re-infers a round-tripped lane whose query changed", () => {
    const previous = { category: "all" as const };
    expect(requestedCategory({ sources: ["github"], query: "is:issue", category: "all" }, previous)).toEqual({ category: "issues" });
  });

  it("keeps an existing pin and honours an explicit unpin", () => {
    const previous = { category: "reviews" as const, categoryPinned: true as const };
    expect(requestedCategory({ ...lane, category: "reviews" }, previous)).toEqual({ category: "reviews", categoryPinned: true });
    expect(requestedCategory({ ...lane, category: "reviews", categoryPinned: false }, previous)).toEqual({ category: "all" });
  });
});

describe("drafted lane category", () => {
  const body = { title: "Mentions", sources: ["github"], query: "is:open mentions:@me" };

  it("uses a valid category from the model, pinned when it differs from inference", () => {
    const lane = parseDraft(JSON.stringify({ ...body, category: "issues" }));
    expect([lane.category, lane.categoryPinned]).toEqual(["issues", true]);
    const same = parseDraft(JSON.stringify({ ...body, category: "all" }));
    expect([same.category, same.categoryPinned]).toEqual(["all", undefined]);
  });

  it("falls back to inference when the category is missing or invalid", () => {
    expect(parseDraft(JSON.stringify(body)).category).toBe("all");
    const bad = parseDraft(JSON.stringify({ ...body, query: "is:pr review-requested:@me", category: "urgent" }));
    expect([bad.category, bad.categoryPinned]).toEqual(["reviews", undefined]);
    // The model cannot pin by itself either.
    const sneaky = parseDraft(JSON.stringify({ ...body, category: "nope", categoryPinned: true }));
    expect([sneaky.category, sneaky.categoryPinned]).toEqual(["all", undefined]);
  });
});

describe("views", () => {
  it("routes old and new paths", () => {
    expect(["reviews", "prs", "issues", "all", "", "issues/x", "nonsense"].map(viewFrom)).toEqual([
      "reviews", "prs", "issues", "all", "all", "issues", "all",
    ]);
  });

  it("orders the title-bar tabs All, Issues, Pull requests, Reviews", () => {
    expect(VIEWS).toEqual(["all", "issues", "prs", "reviews"]);
  });

  it("shows category lanes in their view and every lane in all", () => {
    const lane = { category: "all" as const };
    expect(laneInView(lane, "all")).toBe(true);
    expect(laneInView(lane, "prs")).toBe(false);
    expect(laneInView({ category: "prs" }, "prs")).toBe(true);
    expect(laneInView({ category: "prs" }, "reviews")).toBe(false);
  });

  it("filters items by kind only in the PR and issue views", () => {
    const pr = { kind: "pr" as const };
    const issue = { kind: "issue" as const };
    expect([itemInView(pr, "prs"), itemInView(issue, "prs")]).toEqual([true, false]);
    expect([itemInView(pr, "issues"), itemInView(issue, "issues")]).toEqual([false, true]);
    expect([itemInView(issue, "reviews"), itemInView(issue, "all")]).toEqual([true, true]);
  });
});

describe("editor category picker", () => {
  const mentions: Lane = { id: "m", title: "Mentions", sources: ["github"], query: "is:open mentions:@me", category: "all" };

  it("follows the query until a category is picked", () => {
    const draft = toDraft(mentions);
    expect(draftCategory({ ...draft, query: "is:open is:issue mentions:@me" })).toBe("issues");
    const pinned = pickCategory(draft, "reviews");
    expect(fromDraft({ ...pinned, query: "is:open is:issue" })).toMatchObject({ category: "reviews", categoryPinned: true });
  });

  it("un-pins when the inferred category is picked", () => {
    const pinned = pickCategory(toDraft(mentions), "prs");
    const back = pickCategory(pinned, "all");
    expect(back.categoryPinned).toBe(false);
    expect(fromDraft(back)).not.toHaveProperty("categoryPinned");
  });

  it("round-trips a pinned lane", () => {
    const lane: Lane = { ...mentions, category: "issues", categoryPinned: true };
    expect(laneSchema.parse(fromDraft(toDraft(lane)))).toEqual(lane);
  });

  it("infers a new manual lane from its starter query", () => {
    expect(fromDraft({ ...toDraft(), title: "t" }).category).toBe("prs");
  });
});
