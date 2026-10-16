import { describe, expect, it } from "vitest";
import { DEFAULT_LANES, laneSchema, type Lane } from "../lanes";
import { fromDraft, toDraft } from "../lane-draft";

describe("lane editor draft", () => {
  it("round-trips every lane field, including ones only the drafter sets", () => {
    const lane: Lane = {
      id: "x",
      title: "Everything",
      sources: ["github", "gitstream", "delta"],
      query: "is:open is:pr",
      gitstream: {
        reviewRequested: "@me", author: "a@s.com", excludeAuthor: "bot", assignee: "b", reviewedBy: "c",
        labels: ["//areas/x"], excludeLabels: ["skip"], query: "payments", draft: false, hasApproval: true,
        base: "main", head: "feature", state: "all",
      },
      filter: { titleIncludes: ["t"], labelsAny: ["l"], excludeAuthors: ["e"], excludeDrafts: true, updatedWithinDays: 7 },
      limit: 50,
      description: "d",
      collapsed: true,
      category: "reviews",
    };
    expect(fromDraft(toDraft(lane))).toEqual(lane);
  });

  it("leaves default lanes unchanged", () => {
    for (const lane of DEFAULT_LANES) expect(laneSchema.parse(fromDraft(toDraft(lane)))).toEqual(lane);
  });

  it("keeps everyone only while no principal is set", () => {
    const lane: Lane = { id: "x", title: "t", sources: ["gitstream"], gitstream: { everyone: true }, category: "prs" };
    expect(fromDraft(toDraft(lane)).gitstream).toEqual({ everyone: true });
    expect(fromDraft({ ...toDraft(lane), author: "@me" }).gitstream).toEqual({ author: "@me" });
  });
});
