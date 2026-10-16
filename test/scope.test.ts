import { describe, expect, it } from "vitest";
import {
  applyScopeOp,
  areaKey,
  describeScope,
  EMPTY_SCOPE,
  itemAreas,
  NO_AREA,
  resolveScope,
  scopeCatalog,
  scopeVisible,
  type ScopeFilter,
} from "../scope";

const FM = "//areas/clients/mobile";
const AW = "//areas/clients/admin-web";
const world = (key: string, labels: string[], isNew = false) => ({ key, repo: "acme/monorepo", labels, isNew });
const billing = (key: string, isNew = false) => ({ key, repo: "acme/billing", labels: ["Component: Payments"], isNew });

const items = [
  billing("b1", true),
  billing("b2"),
  world("w1", [FM, "Slice: Banking Mobile"], true),
  world("w2", ["//areas/clients/mobile/src/x", AW]),
  world("w3", ["ZoneID: W-1"]),
];
const visibleKeys = (filter: ScopeFilter) => items.filter((item) => scopeVisible(item, filter)).map((item) => item.key);

describe("scope", () => {
  it("derives acme/monorepo areas at three segments with a no-area bucket", () => {
    expect(areaKey("//areas/clients/mobile/app")).toBe(FM);
    expect(areaKey("Slice: x")).toBeNull();
    expect(itemAreas(items[3]!)).toEqual([AW, FM]);
    expect(itemAreas(items[4]!)).toEqual([NO_AREA]);
    expect(itemAreas(items[0]!)).toEqual([]);
  });

  it("hides repos and areas; a multi-area item stays while any area shows", () => {
    expect(visibleKeys(EMPTY_SCOPE)).toHaveLength(5);
    expect(visibleKeys({ focus: [], hidden: ["ACME/BILLING"] })).toEqual(["w1", "w2", "w3"]);
    expect(visibleKeys({ focus: [], hidden: [FM] })).toEqual(["b1", "b2", "w2", "w3"]);
    expect(visibleKeys({ focus: [], hidden: [FM, AW, NO_AREA] })).toEqual(["b1", "b2"]);
  });

  it("focuses on repos or areas, and hides within a focus", () => {
    expect(visibleKeys({ focus: [FM], hidden: [] })).toEqual(["w1", "w2"]);
    expect(visibleKeys({ focus: ["acme/monorepo"], hidden: [NO_AREA] })).toEqual(["w1", "w2"]);
    expect(visibleKeys({ focus: [NO_AREA, "acme/billing"], hidden: [] })).toEqual(["b1", "b2", "w3"]);
  });

  it("catalogs repos with nested areas, counts, and hidden counts", () => {
    const catalog = scopeCatalog(items, { focus: [FM], hidden: ["gone/repo"] });
    expect(catalog.map((entry) => [entry.key, entry.total, entry.hiddenItems, entry.state])).toEqual([
      ["acme/monorepo", 3, 1, "unfocused"],
      ["acme/billing", 2, 2, "unfocused"],
      ["gone/repo", 0, 0, "hidden"],
    ]);
    const areas = catalog[0]!.children!;
    expect(areas.map((entry) => [entry.key, entry.total, entry.fresh, entry.state])).toEqual([
      [FM, 2, 1, "focused"],
      [AW, 1, 0, "unfocused"],
      [NO_AREA, 1, 0, "unfocused"],
    ]);
  });

  it("applies focus/hide/show/clear ops", () => {
    let filter = applyScopeOp(EMPTY_SCOPE, "hide", ["acme/billing"]);
    expect(filter).toEqual({ focus: [], hidden: ["acme/billing"] });
    filter = applyScopeOp(filter, "focus", [FM]);
    expect(filter).toEqual({ focus: [FM], hidden: ["acme/billing"] });
    filter = applyScopeOp(filter, "show", ["acme/billing"]);
    expect(filter).toEqual({ focus: [FM, "acme/billing"], hidden: [] });
    filter = applyScopeOp(filter, "hide", [FM]);
    expect(filter.focus).toEqual(["acme/billing"]);
    expect(applyScopeOp(filter, "clear", [])).toEqual(EMPTY_SCOPE);
  });

  it("showing one area of a hidden acme/monorepo keeps its siblings hidden", () => {
    const filter = applyScopeOp({ focus: [], hidden: ["acme/monorepo"] }, "show", [FM], [FM, AW, NO_AREA]);
    expect(filter.hidden).toEqual([AW, NO_AREA]);
    expect(visibleKeys(filter)).toEqual(["b1", "b2", "w1", "w2"]);
  });

  it("resolves typed scopes", () => {
    const known = ["acme/billing", "acme/monorepo", "acme/issues", FM, AW];
    expect(resolveScope("billing", known)).toBe("acme/billing");
    expect(resolveScope("mobile", known)).toBe(FM);
    expect(resolveScope("areas/clients/admin-web/", known)).toBe(AW);
    expect(resolveScope("//areas/clients/mobile/src", known)).toBe(FM);
    expect(resolveScope("no-area", known)).toBe(NO_AREA);
    expect(resolveScope("other/repo", known)).toBe("other/repo");
    expect(resolveScope("clients", [FM, "//areas/core/clients"])).toBe("//areas/core/clients");
    expect(() => resolveScope("x", ["a/x", "b/x"])).toThrow(/ambiguous/);
    expect(() => resolveScope("nope", known)).toThrow(/Unknown/);
  });

  it("describes the filter", () => {
    expect(describeScope(EMPTY_SCOPE)).toBe("all repos");
    expect(describeScope({ focus: [FM], hidden: ["acme/billing"] })).toBe(
      "only clients/mobile; hiding acme/billing",
    );
  });
});

import { effectiveScope, FOCUS_OFF, focusPrompt, heuristicFocus, parseFocusReply } from "../scope";

describe("focus mode", () => {
  const known = ["acme/billing", "acme/monorepo", "acme/issues", FM, AW, NO_AREA];
  it("parses the model reply, resolving names and dropping unknowns", () => {
    const choice = parseFocusReply('```json\n{"focus":[],"hidden":["billing","made/up-thing","x"],"summary":"No billing"}\n```', known);
    expect(choice).toEqual({ focus: [], hidden: ["acme/billing", "made/up-thing"], summary: "No billing" });
    expect(parseFocusReply('{"focus":["mobile"],"hidden":["mobile"]}', known)).toEqual({
      focus: [FM], hidden: [], summary: "only clients/mobile",
    });
    expect(() => parseFocusReply('{"focus":[],"hidden":["zzz"]}', known)).toThrow(/did not match/);
    expect(() => parseFocusReply("sorry", known)).toThrow();
  });
  it("falls back to keyword matching without AI", () => {
    expect(heuristicFocus("i don't want to see any billing stuff", known).hidden).toEqual(["acme/billing"]);
    expect(heuristicFocus("only mobile please", known).focus).toEqual([FM]);
    expect(() => heuristicFocus("calm down", known)).toThrow();
  });
  it("is a no-op while off and lists scopes in the prompt", () => {
    expect(effectiveScope({ ...FOCUS_OFF, hidden: [FM] })).toEqual(EMPTY_SCOPE);
    expect(effectiveScope({ ...FOCUS_OFF, enabled: true, hidden: [FM] })).toEqual({ focus: [], hidden: [FM] });
    const prompt = focusPrompt("no billing", scopeCatalog(items, EMPTY_SCOPE));
    expect(prompt.system).toContain("acme/billing  (2 items)");
    expect(prompt.system).toContain(`  ${FM}  (2 items; acme/monorepo area)`);
  });
});
