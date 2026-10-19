import { describe, expect, it } from "vitest";
import { applyFilter, findSection, threadsToSection, fromGithub, fromGitstream, gitstreamArgs, laneSchema, parseDraft, slugify, type Item } from "../lanes";

const item = (over: Partial<Item>): Item => ({
  key: "k", source: "github", kind: "pr", repo: "a/b", number: 1, title: "Fix payments offer",
  url: "", author: "alice", draft: false, state: "open", labels: ["mobile"],
  createdAt: "", updatedAt: new Date().toISOString(), ...over,
});

describe("lanes", () => {
  it("maps gitstream rows to gitstream urls", () => {
    const out = fromGitstream({ number: 5, title: "T", url: "https://api.gitstream.example.com/repos/acme/monorepo/pulls/5", author: { login: "x@example.com" }, labels: [{ name: "Slice: y" }], draft: true });
    expect(out?.url).toBe("https://gitstream.example.com/repos/acme/monorepo/pulls/5");
    expect(out?.draft).toBe(true);
    expect(out?.labels).toEqual(["Slice: y"]);
  });
  it("maps github search items and detects issues", () => {
    const out = fromGithub({ number: 9, title: "I", html_url: "u", repository_url: "https://api.github.com/repos/o/r", user: { login: "bob" } });
    expect(out).toMatchObject({ repo: "o/r", kind: "issue", author: "bob" });
  });
  it("filters by title, label, drafts, authors and age", () => {
    const old = item({ key: "old", updatedAt: "2020-01-01T00:00:00Z" });
    const items = [item({ key: "a" }), item({ key: "d", draft: true }), item({ key: "x", title: "Other", labels: [] }), item({ key: "bot", author: "Bot" }), old];
    const kept = applyFilter(items, { titleIncludes: ["payments"], labelsAny: ["mobile"], excludeDrafts: true, excludeAuthors: ["bot"], updatedWithinDays: 7 });
    expect(kept.map((i) => i.key)).toEqual(["a"]);
  });
  it("builds gs api argv with @me resolved and labels repeated", () => {
    const args = gitstreamArgs({ id: "x", title: "t", sources: ["gitstream"], category: "prs", gitstream: { reviewRequested: "@me", labels: ["//areas/clients/mobile", "Component: Payments"] }, limit: 50 }, "me@example.com");
    expect(args.slice(0, 4)).toEqual(["api", "-X", "GET", "repos/acme/monorepo/pulls"]);
    expect(args).toContain("review_requested_principal_id=me@example.com");
    expect(args.filter((a) => a.startsWith("labels="))).toEqual(["labels=//areas/clients/mobile", "labels=Component: Payments"]);
    expect(args).toContain("per_page=50");
    expect(args.some((a) => a.startsWith("author_principal_id"))).toBe(false);
  });
  it("defaults an unscoped gitstream lane to my PRs unless everyone", () => {
    expect(gitstreamArgs({ id: "x", title: "t", sources: ["gitstream"], category: "prs", gitstream: {} }, "me@s.com")).toContain("author_principal_id=me@s.com");
    expect(gitstreamArgs({ id: "x", title: "t", sources: ["gitstream"], category: "prs", gitstream: { everyone: true, labels: ["a"] } }, "me@s.com").some((a) => a.startsWith("author_"))).toBe(false);
  });
  it("pushes updatedWithinDays and excludeDrafts server-side", () => {
    const args = gitstreamArgs({ id: "x", title: "t", sources: ["gitstream"], category: "prs", gitstream: { everyone: true }, filter: { updatedWithinDays: 1, excludeDrafts: true } }, "m", Date.parse("2026-01-02T00:00:00Z"));
    expect(args).toContain("updated_after=2026-01-01T00:00:00.000Z");
    expect(args).toContain("draft=false");
  });
  it("requires a query for github lanes and accepts the default lanes", async () => {
    expect(laneSchema.safeParse({ id: "x", title: "t", sources: ["github"], query: "" }).success).toBe(false);
    const { DEFAULT_LANES, lanesSchema } = await import("../lanes");
    expect(lanesSchema.safeParse(DEFAULT_LANES).success).toBe(true);
  });
  it("parses fenced model output and drops the inapplicable scope", () => {
    const lane = parseDraft('Sure:\n```json\n{"title":"Billing reviews","source":"github","query":"is:open is:pr repo:acme/billing review-requested:@me","gitstream":{}}\n```');
    expect(lane.sources).toEqual(["github"]);
    expect(lane.gitstream).toBeUndefined();
  });
  it("slugifies uniquely", () => {
    expect(slugify("My Lane!", new Set(["my-lane"]))).toBe("my-lane-2");
  });
});

describe("github graphql", () => {
  it("maps search nodes and appends a sort", async () => {
    const { fromGithubNode, githubSearchQuery } = await import("../lanes");
    expect(fromGithubNode({ __typename: "PullRequest", number: 3, title: "T", url: "u", isDraft: true, state: "OPEN", author: { login: "a" }, repository: { nameWithOwner: "o/r" }, labels: { nodes: [{ name: "x" }] } }))
      .toMatchObject({ kind: "pr", repo: "o/r", draft: true, state: "open", labels: ["x"] });
    expect(githubSearchQuery("is:pr")).toBe("is:pr sort:updated-desc");
    expect(githubSearchQuery("is:pr sort:created-asc")).toBe("is:pr sort:created-asc");
  });
});

describe("review threads", () => {
  it("maps remotes to repos and writes a no-posting review prompt", async () => {
    const { remoteRepo, reviewPrompt } = await import("../lanes");
    expect(remoteRepo("https://delta.example.com/acme/monorepo.git")).toBe("acme/monorepo");
    expect(remoteRepo("git@github.com:acme/billing.git")).toBe("acme/billing");
    expect(remoteRepo("https://github.com/acme/billing")).toBe("acme/billing");
    const base = { key: "k", repo: "acme/monorepo", number: 7, title: "T", url: "u", author: "a", draft: false, state: "open", labels: [], createdAt: "", updatedAt: "" };
    const pr = reviewPrompt({ ...base, source: "gitstream", kind: "pr" });
    expect(pr).toContain("gs");
    expect(pr).toContain("Do not post comments");
    expect(reviewPrompt({ ...base, source: "github", kind: "issue" })).toContain("gh");
  });
});

describe("delta", () => {
  it("builds a dt search argv and maps results", async () => {
    const { deltaArgs, fromDelta, laneSchema } = await import("../lanes");
    const lane = laneSchema.parse({ id: "d", title: "D", sources: ["delta"], query: "is:open is:pr review-requested:@me" });
    const argv = deltaArgs(lane);
    expect(argv.slice(0, 5)).toEqual(["--host", "delta.example.com", "-R", "acme/monorepo", "api"]);
    expect(decodeURIComponent(argv[5]!.replace(/\+/g, " "))).toContain("q=is:open is:pr review-requested:@me");
    expect(argv[5]).toContain("sort=updated");
    const item = fromDelta({
      number: 1234, title: "T", html_url: "https://delta.example.com/acme/monorepo/pull/1234",
      repository_url: "https://delta.example.com/api/v3/repos/acme/monorepo", user: { login: "a.dev@example.com" },
      pull_request: {}, labels: [{ name: "//areas/x" }], state: "open", draft: false, created_at: "a", updated_at: "b",
    });
    expect(item).toMatchObject({ key: "delta:acme/monorepo#1234", source: "delta", kind: "pr", repo: "acme/monorepo", author: "a.dev" });
    expect(laneSchema.safeParse({ id: "e", title: "E", sources: ["delta"] }).success).toBe(false);
  });
});

describe("multi-source lanes", () => {
  it("reads legacy single-source lanes and validates sources", async () => {
    const { laneSchema, deltaQuery, DEFAULT_LANES, parseDraft } = await import("../lanes");
    expect(laneSchema.parse({ id: "a", title: "A", source: "gitstream", gitstream: {} }).sources).toEqual(["gitstream"]);
    expect(laneSchema.safeParse({ id: "a", title: "A", sources: [] }).success).toBe(false);
    expect(laneSchema.safeParse({ id: "a", title: "A", sources: ["github", "github"], query: "x" }).success).toBe(false);
    expect(laneSchema.safeParse({ id: "a", title: "A", sources: ["gitstream", "delta"] }).success).toBe(false);
    // Delta is primary; read-only Gitstream history is never in a default lane.
    expect(DEFAULT_LANES[0]!.sources).toEqual(["delta", "github"]);
    expect(DEFAULT_LANES.some((lane) => lane.sources.includes("gitstream") || lane.gitstream !== undefined)).toBe(false);
    expect(deltaQuery("is:open is:pr author:@me archived:false")).toBe("is:open is:pr author:@me");
    const drafted = parseDraft(JSON.stringify({ title: "Mine", sources: ["github", "delta"], query: "is:pr author:@me", gitstream: { author: "@me" } }));
    expect(drafted.gitstream).toBeUndefined();
    expect(parseDraft(JSON.stringify({ title: "Old", source: "github", query: "is:pr" })).sources).toEqual(["github"]);
  });
  it("finds the review section by trimmed, case-insensitive name", () => {
    const sections = [{ id: "sec_a", name: "Pinned stuff" }, { id: "sec_r", name: " Reviews " }];
    expect(findSection(sections, "reviews")).toBe("sec_r");
    expect(findSection(sections, "Triage")).toBeNull();
    expect(findSection(sections, "  ")).toBeNull();
  });
  it("only backfills review threads that are still unsectioned", () => {
    const threads = [{ id: "t1", sectionId: null }, { id: "t2", sectionId: "sec_other" }, { id: "t3" }];
    expect(threadsToSection(threads)).toEqual(["t1", "t3"]);
  });
});

describe("60-day age cap", () => {
  it("drops items untouched for more than 60 days, even when a lane asks for longer", async () => {
    const { applyFilter, withWindow, gitstreamArgs, DEFAULT_MAX_AGE_DAYS, maxAgeDays } = await import("../lanes");
    const now = Date.parse("2026-10-16T00:00:00Z");
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const base = { key: "k", source: "github" as const, kind: "pr" as const, repo: "a/b", number: 1, title: "t", url: "u", author: "x", draft: false, state: "open", labels: [], createdAt: at(200) };
    const items = [{ ...base, key: "fresh", updatedAt: at(59) }, { ...base, key: "old", updatedAt: at(136) }];
    expect(DEFAULT_MAX_AGE_DAYS).toBe(60);
    expect(applyFilter(items, undefined, now).map((i) => i.key)).toEqual(["fresh"]);
    expect(applyFilter(items, { updatedWithinDays: 365 }, now).map((i) => i.key)).toEqual(["fresh"]);
    expect(applyFilter(items, { updatedWithinDays: 7 }, now)).toEqual([]);
    expect(withWindow("is:pr", undefined, now)).toBe("is:pr updated:>=2026-08-17");
    expect(withWindow("is:pr updated:>=2026-01-01", undefined, now)).toBe("is:pr updated:>=2026-01-01");
  });

  it("follows the Max age setting; 0 means no limit", async () => {
    const { applyFilter, withWindow, gitstreamArgs, maxAgeDays } = await import("../lanes");
    const now = Date.parse("2026-10-16T00:00:00Z");
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const base = { key: "k", source: "github" as const, kind: "pr" as const, repo: "a/b", number: 1, title: "t", url: "u", author: "x", draft: false, state: "open", labels: [], createdAt: at(400) };
    const items = [{ ...base, key: "fresh", updatedAt: at(10) }, { ...base, key: "old", updatedAt: at(136) }];
    expect(applyFilter(items, undefined, now, 200).map((i) => i.key)).toEqual(["fresh", "old"]);
    expect(applyFilter(items, undefined, now, 0).map((i) => i.key)).toEqual(["fresh", "old"]);
    expect(applyFilter(items, { updatedWithinDays: 7 }, now, 0)).toEqual([]);
    expect(withWindow("is:pr", undefined, now, 0)).toBe("is:pr");
    expect(withWindow("is:pr", undefined, now, 30)).toBe("is:pr updated:>=2026-09-16");
    const lane = { id: "x", title: "t", sources: ["gitstream" as const], category: "prs" as const, gitstream: { everyone: true } };
    expect(gitstreamArgs(lane, "m", now, 0).some((a) => a.startsWith("updated_after"))).toBe(false);
    expect(maxAgeDays(-5)).toBe(0);
    expect(maxAgeDays(45.7)).toBe(45);
  });
});
