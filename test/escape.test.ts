import { describe, expect, it } from "vitest";
import { createEscapeStack } from "../escape";
import { moveInView } from "../lanes";

const key = (k = "Escape", handled = false) => {
  const event = { key: k, defaultPrevented: handled, preventDefault() { event.defaultPrevented = true; } };
  return event;
};

describe("escape stack", () => {
  it("closes only the most recently opened surface", () => {
    const stack = createEscapeStack();
    const closed: string[] = [];
    const offTrack = stack.push(() => closed.push("track"));
    const offFilter = stack.push(() => closed.push("filter"));
    expect(stack.handle(key())).toBe(true);
    expect(closed).toEqual(["filter"]);
    offFilter();
    stack.handle(key());
    expect(closed).toEqual(["filter", "track"]);
    offTrack();
    expect(stack.handle(key())).toBe(false);
  });
  it("leaves other keys and already-handled Escapes alone", () => {
    const stack = createEscapeStack();
    let n = 0;
    stack.push(() => n++);
    expect(stack.handle(key("Enter"))).toBe(false);
    expect(stack.handle(key("Escape", true))).toBe(false);
    expect(n).toBe(0);
    const event = key();
    stack.handle(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("moveInView", () => {
  const lanes = [
    { id: "rev-a", category: "reviews" as const },
    { id: "prs-x", category: "prs" as const },
    { id: "rev-b", category: "reviews" as const },
  ];
  it("swaps adjacent lanes in All", () => {
    expect(moveInView(lanes, "prs-x", -1, "all")).toEqual(["prs-x", "rev-a", "rev-b"]);
  });
  it("skips lanes the view doesn't show, leaving their slots alone", () => {
    expect(moveInView(lanes, "rev-b", -1, "reviews")).toEqual(["rev-b", "prs-x", "rev-a"]);
    expect(moveInView(lanes, "rev-a", 1, "reviews")).toEqual(["rev-b", "prs-x", "rev-a"]);
  });
  it("is a no-op at the ends of the view, or for unknown ids", () => {
    expect(moveInView(lanes, "rev-a", -1, "reviews")).toBeNull();
    expect(moveInView(lanes, "rev-b", 1, "reviews")).toBeNull();
    expect(moveInView(lanes, "prs-x", 1, "prs")).toBeNull();
    expect(moveInView(lanes, "nope", 1, "all")).toBeNull();
  });
});
