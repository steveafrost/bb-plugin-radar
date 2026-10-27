import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_LANES, missingDefaults, parseDraft, type Lane } from "../lanes";
import { heuristicFocus } from "../scope";
import { NO_HOSTS, setHosts } from "../hosts";
import { afterEach } from "vitest";

describe("missingDefaults", () => {
  it("counts a lane with the same query on the same hosts as present, whatever its id", () => {
    const reviews = DEFAULT_LANES.find((lane) => lane.id === "reviews")!;
    const mine = DEFAULT_LANES.find((lane) => lane.id === "mine")!;
    const board: Lane[] = [
      { ...reviews, id: "reviews-requested" },
      { ...mine, id: "my-open-prs", sources: [...mine.sources, "gitstream"], query: `  ${mine.query!.toUpperCase()} ` },
    ];
    const missing = missingDefaults(board).map((lane) => lane.id);
    expect(missing).not.toContain("reviews");
    expect(missing).not.toContain("mine");
    expect(missingDefaults(DEFAULT_LANES)).toEqual([]);
    expect(missingDefaults([]).length).toBe(DEFAULT_LANES.length);
  });
});

describe("parseDraft normalizes harmless model output", () => {
  beforeEach(() => {
    setHosts({ ...NO_HOSTS, delta: { host: "delta.shopify.io", repo: "shop/world", label: "Delta", webUrl: "https://delta.shopify.io" } } as never);
  });
  it("drops null fields, extra keys and clamps the limit", () => {
    const lane = parseDraft(JSON.stringify({ title: "Mine", sources: ["github"], query: "is:open is:pr author:@me", filter: null, limit: 200, reasoning: "because" }));
    expect(lane.limit).toBe(100);
    expect(lane.filter).toBeUndefined();
    expect("reasoning" in lane).toBe(false);
  });
  it("keeps issue and mention lanes off Delta", () => {
    expect(parseDraft(JSON.stringify({ title: "Issues", sources: ["delta", "github"], query: "is:open is:issue assignee:@me" })).sources).toEqual(["github"]);
    expect(parseDraft(JSON.stringify({ title: "Mentions", sources: ["delta", "github"], query: "is:open mentions:@me" })).sources).toEqual(["github"]);
    expect(() => parseDraft(JSON.stringify({ title: "Issues", sources: ["delta"], query: "is:open is:issue" }))).toThrow(/pull requests only/);
    expect(parseDraft(JSON.stringify({ title: "PRs", sources: ["delta", "github"], query: "is:open is:pr author:@me" })).sources).toEqual(["delta", "github"]);
  });
  it("rejects a host that isn't set up", () => {
    expect(() => parseDraft(JSON.stringify({ title: "History", sources: ["gitstream"], gitstream: { everyone: true } }))).toThrow(/isn't set up/);
  });
});

describe("heuristicFocus by clause", () => {
  const known = ["acme/mobile", "acme/billing", "acme/docs", "//no-area"];
  it("splits a mixed sentence into focus and hidden", () => {
    expect(heuristicFocus("only mobile, no billing", known)).toMatchObject({ focus: ["acme/mobile"], hidden: ["acme/billing"] });
    expect(heuristicFocus("show me billing, not docs", known)).toMatchObject({ focus: ["acme/billing"], hidden: ["acme/docs"] });
  });
  it("treats no-area as a name", () => {
    expect(heuristicFocus("only no-area", known)).toMatchObject({ focus: ["//no-area"], hidden: [] });
    expect(heuristicFocus("no billing", known)).toMatchObject({ focus: [], hidden: ["acme/billing"] });
  });
  it("a negation covers the names after it until a clause focuses again", () => {
    expect(heuristicFocus("hide billing and docs", known)).toMatchObject({ focus: [], hidden: ["acme/billing", "acme/docs"] });
    expect(heuristicFocus("no billing, docs", known)).toMatchObject({ focus: [], hidden: ["acme/billing", "acme/docs"] });
    expect(heuristicFocus("not billing or docs", known)).toMatchObject({ focus: [], hidden: ["acme/billing", "acme/docs"] });
    expect(heuristicFocus("no billing, only mobile", known)).toMatchObject({ focus: ["acme/mobile"], hidden: ["acme/billing"] });
    expect(heuristicFocus("only mobile and no billing", known)).toMatchObject({ focus: ["acme/mobile"], hidden: ["acme/billing"] });
    expect(heuristicFocus("show mobile and docs", known)).toMatchObject({ focus: ["acme/mobile", "acme/docs"], hidden: [] });
  });
  it("matches repo names with a dot", () => {
    expect(heuristicFocus("only widget.js", ["acme/widget.js", "acme/billing"])).toMatchObject({ focus: ["acme/widget.js"], hidden: [] });
    expect(heuristicFocus("no billing. only widget.js.", ["acme/widget.js", "acme/billing"])).toMatchObject({ focus: ["acme/widget.js"], hidden: ["acme/billing"] });
  });
});
afterEach(() => setHosts(NO_HOSTS));
