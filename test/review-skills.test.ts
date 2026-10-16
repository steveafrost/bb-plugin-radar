import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_SETTINGS, hostSkillFor, selectedSkills, threadSkills, withSkillMention } from "../review-skills";

describe("hostSkillFor", () => {
  it("invokes no host skill by default, and the Gitstream one only for Gitstream PRs", () => {
    expect(hostSkillFor({ kind: "pr", source: "gitstream" }, DEFAULT_SKILL_SETTINGS)).toBeNull();
    expect(hostSkillFor({ kind: "pr", source: "gitstream" }, { ...DEFAULT_SKILL_SETTINGS, gitstreamReviewSkill: "gitstream-pr" })).toBe("gitstream-pr");
    expect(hostSkillFor({ kind: "pr", source: "github" }, { ...DEFAULT_SKILL_SETTINGS, gitstreamReviewSkill: "gitstream-pr" })).toBeNull();
    expect(hostSkillFor({ kind: "pr", source: "github" }, DEFAULT_SKILL_SETTINGS)).toBeNull();
    expect(hostSkillFor({ kind: "issue", source: "delta" }, DEFAULT_SKILL_SETTINGS)).toBeNull();
  });
  it("strips a typed trigger and rejects junk", () => {
    const s = { ...DEFAULT_SKILL_SETTINGS, reviewSkill: "/comprehensive-review", triageSkill: "two words" };
    expect(hostSkillFor({ kind: "pr", source: "github" }, s)).toBe("comprehensive-review");
    expect(hostSkillFor({ kind: "issue", source: "github" }, s)).toBeNull();
  });
});

describe("selectedSkills", () => {
  it("always keeps the radar skill and adds the action skill from metadata", () => {
    expect(selectedSkills({})).toEqual(["radar"]);
    expect(selectedSkills({ action: "review" })).toEqual(["radar", "radar-review"]);
    expect(selectedSkills({ action: "triage" })).toEqual(["radar", "radar-triage"]);
    expect(selectedSkills({ action: "rm -rf" })).toEqual(["radar"]);
  });
});

describe("withSkillMention", () => {
  const skillMention = { kind: "command", source: "skill", origin: "user", trigger: "/", name: "gitstream-pr", label: "gitstream-pr", argumentHint: null };
  it("prefixes the first text chunk and shifts existing mentions", () => {
    const pill = { start: 7, end: 12, resource: { kind: "thread", id: "x" } };
    const out = withSkillMention({ input: [{ type: "text", text: "Review @this", mentions: [pill] }] }, "gitstream-pr");
    const first = (out.input as { text: string; mentions: { start: number; end: number; resource: unknown }[] }[])[0]!;
    expect(first.text).toBe("/gitstream-pr Review @this");
    expect(first.text.slice(first.mentions[0]!.start, first.mentions[0]!.end)).toBe("/gitstream-pr");
    expect(first.mentions[0]!.resource).toEqual(skillMention);
    expect(first.text.slice(first.mentions[1]!.start, first.mentions[1]!.end)).toBe("@this");
  });
  it("converts a plain prompt into input", () => {
    const out = withSkillMention({ prompt: "Review it", projectId: "p" }, "gitstream-pr") as Record<string, unknown>;
    expect(out.prompt).toBeUndefined();
    expect(out.projectId).toBe("p");
    expect((out.input as { text: string }[])[0]!.text).toBe("/gitstream-pr Review it");
  });
  it("leaves a request that already invokes a skill alone", () => {
    const req = { input: [{ type: "text", text: "/simplify x", mentions: [{ start: 0, end: 9, resource: { ...skillMention, name: "simplify" } }] }] };
    expect(withSkillMention(req, "gitstream-pr")).toBe(req);
  });
});

describe("threadSkills", () => {
  it("lists Radar's pair plus the host skill the thread will invoke", () => {
    expect(threadSkills({ kind: "pr", source: "gitstream" }, { ...DEFAULT_SKILL_SETTINGS, gitstreamReviewSkill: "gitstream-pr" })).toEqual(["radar", "radar-review", "gitstream-pr"]);
    expect(threadSkills({ kind: "pr", source: "github" }, DEFAULT_SKILL_SETTINGS)).toEqual(["radar", "radar-review"]);
    expect(threadSkills({ kind: "issue", source: "github" }, { ...DEFAULT_SKILL_SETTINGS, triageSkill: "/triage" })).toEqual(["radar", "radar-triage", "triage"]);
  });
});
