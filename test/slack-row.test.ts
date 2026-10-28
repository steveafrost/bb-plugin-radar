import { describe, expect, it } from "vitest";
import { slackBoardState, slackRowMode } from "../slack-row";

describe("slackBoardState", () => {
  const threads: Record<string, number> = { linked: 2, fresh: 1, searched: 0, unsearched: 0 };
  const state = slackBoardState(
    Object.keys(threads),
    (key) => threads[key]!,
    new Set(["linked", "fresh", "searched"]),
    (key) => key === "fresh",
  );

  it("lists linked items with their thread count and new flag", () => {
    expect(state.items).toEqual({ linked: { threads: 2, isNew: false }, fresh: { threads: 1, isNew: true } });
  });

  it("marks only searched, unlinked items as none found", () => {
    expect(state.none).toEqual(["searched"]);
  });

  it("leaves unsearched items out of both (a failed search never records the item as searched)", () => {
    expect(state.items.unsearched).toBeUndefined();
    expect(state.none).not.toContain("unsearched");
  });
});

describe("slackRowMode", () => {
  it("is context or new when threads link the item", () => {
    expect(slackRowMode({ threads: 3, isNew: false }, true)).toEqual({ mode: "context", threads: 3 });
    expect(slackRowMode({ threads: 1, isNew: true }, true)).toEqual({ mode: "new", threads: 1 });
  });

  it("is none only once a search found nothing", () => {
    expect(slackRowMode(undefined, true)).toEqual({ mode: "none", threads: 0 });
  });

  it("is unchecked before the sweep has searched the item", () => {
    expect(slackRowMode(undefined, false)).toEqual({ mode: "unchecked", threads: 0 });
  });

  it("does not show a check for a stale entry with no threads", () => {
    expect(slackRowMode({ threads: 0, isNew: false }, false)).toEqual({ mode: "unchecked", threads: 0 });
  });
});
