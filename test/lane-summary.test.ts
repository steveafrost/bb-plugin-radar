import { describe, expect, it } from "vitest";
import { DEFAULT_LANES } from "../lanes";
import { summarizeLane } from "../lane-summary";

const lane = (id: string) => DEFAULT_LANES.find((entry) => entry.id === id)!;

describe("summarizeLane", () => {
  it("describes the default lanes", () => {
    expect(summarizeLane(lane("reviews"))).toBe("Open PRs requesting your review · 3 sources");
    expect(summarizeLane(lane("mine"))).toBe("Open PRs by you · 3 sources");
    expect(summarizeLane(lane("github-mentions"))).toBe("Open PRs and issues mentioning you · GitHub only · updated in 14d");
    expect(summarizeLane(lane("github-assigned"))).toBe("Open issues assigned to you · GitHub only");
  });

  it("covers Gitstream-only area lanes", () => {
    expect(
      summarizeLane({
        sources: ["gitstream"],
        gitstream: { everyone: true, labels: ["//areas/clients/mobile"] },
        filter: { excludeDrafts: true },
      }),
    ).toBe("Open PRs from everyone in mobile · Gitstream only · no drafts");
    expect(summarizeLane({ sources: ["gitstream"], gitstream: {} })).toBe("Open PRs by you · Gitstream only");
  });

  it("ignores the query when only Gitstream is on", () => {
    expect(summarizeLane({ sources: ["gitstream"], query: "is:issue mentions:@me", gitstream: { reviewRequested: "alice@s.com" } })).toBe(
      "Open PRs requesting alice@s.com's review · Gitstream only",
    );
  });
});
