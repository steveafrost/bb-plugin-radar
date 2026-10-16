/**
 * Which skills a Radar-started thread gets.
 *
 * Two mechanisms, both first-class in bb:
 *  1. Radar's own skills (skills/radar-review, skills/radar-triage) are selected per thread by
 *     `bb.agents.configure` from the thread's Radar plugin metadata.
 *  2. One installed host skill (e.g. a code-review skill) is invoked through a skill mention at the
 *     start of the opening message, exactly what picking it from the composer's `/` menu does.
 *     Pi turns a single leading skill mention into `/skill:<name>`, so only one is sent.
 */
import type { Source } from "./lanes";

export type RadarAction = "review" | "triage";

/** Skill names shipped in this plugin's skills/ root. `radar` must always stay selected. */
export const BASE_SKILL = "radar";
export const ACTION_SKILLS: Record<RadarAction, string> = { review: "radar-review", triage: "radar-triage" };

export type SkillSettings = {
  /** Host skill for PR reviews on GitHub/Delta ("" = none). */
  reviewSkill: string;
  /** Host skill for Gitstream PR reviews ("" = none). */
  gitstreamReviewSkill: string;
  /** Host skill for issue triage ("" = none). */
  triageSkill: string;
};

export const DEFAULT_SKILL_SETTINGS: SkillSettings = { reviewSkill: "", gitstreamReviewSkill: "", triageSkill: "" };

export function actionFor(kind: "pr" | "issue"): RadarAction {
  return kind === "pr" ? "review" : "triage";
}

/** The installed skill to invoke for this item, or null. */
export function hostSkillFor(item: { kind: "pr" | "issue"; source: Source }, settings: SkillSettings): string | null {
  const name = item.kind === "issue" ? settings.triageSkill : item.source === "gitstream" ? settings.gitstreamReviewSkill : settings.reviewSkill;
  const trimmed = name.trim().replace(/^[/$]/, "");
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed) ? trimmed : null;
}

/** Plugin skills to select for a thread, from its (untrusted) Radar metadata. */
export function selectedSkills(metadata: { readonly [key: string]: unknown }): string[] {
  const action = metadata.action;
  return action === "review" || action === "triage" ? [BASE_SKILL, ACTION_SKILLS[action]] : [BASE_SKILL];
}

type Mention = { start: number; end: number; resource: Record<string, unknown> };
type InputItem = { type: string; text?: string; mentions?: Mention[] } & Record<string, unknown>;

/**
 * Prefix the opening message with a `/name` skill mention. Works on either spawn shape:
 * `input` (what the composer submits) or plain `prompt`. Leaves the request alone when it
 * already invokes a skill, so a skill the user picked in the composer wins.
 */
export function withSkillMention<R extends { input?: unknown; prompt?: unknown }>(request: R, name: string): R {
  const token = `/${name}`;
  const mention = (offset: number): Mention => ({
    start: offset,
    end: offset + token.length,
    resource: { kind: "command", source: "skill", origin: "user", trigger: "/", name, label: name, argumentHint: null },
  });
  if (Array.isArray(request.input)) {
    const input = request.input as InputItem[];
    const hasSkill = input.some((item) => item.mentions?.some((m) => m.resource.kind === "command" && m.resource.source === "skill"));
    if (hasSkill) return request;
    const first = input[0];
    if (first?.type === "text" && typeof first.text === "string") {
      const shift = token.length + 1;
      const shifted = { ...first, text: `${token} ${first.text}`, mentions: [mention(0), ...(first.mentions ?? []).map((m) => ({ ...m, start: m.start + shift, end: m.end + shift }))] };
      return { ...request, input: [shifted, ...input.slice(1)] };
    }
    return { ...request, input: [{ type: "text", text: token, mentions: [mention(0)] }, ...input] };
  }
  if (typeof request.prompt === "string") {
    const { prompt, ...rest } = request;
    return { ...rest, input: [{ type: "text", text: `${token} ${prompt}`, mentions: [mention(0)] }] } as unknown as R;
  }
  return request;
}

/** Every skill a Radar thread for this item loads: Radar's own pair plus the host skill, if set. */
export function threadSkills(item: { kind: "pr" | "issue"; source: Source }, settings: SkillSettings): string[] {
  const host = hostSkillFor(item, settings);
  return [BASE_SKILL, ACTION_SKILLS[actionFor(item.kind)], ...(host === null ? [] : [host])];
}
