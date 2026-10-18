import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const aiOverrideSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(300),
}).strict().nullable();
export type AiOverride = z.infer<typeof aiOverrideSchema>;
export const AI_UNSUPPORTED = "This BB host does not support configured-provider text completion. A development build with experimental_ai.complete is required. Focus still supports repo/area name matching and manual controls.";

export function aiAvailable(bb: Pick<BbPluginApi, "experimental_ai">): boolean {
  return typeof bb.experimental_ai?.complete === "function";
}

export async function complete(
  bb: Pick<BbPluginApi, "experimental_ai">,
  override: AiOverride,
  system: string,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  if (!aiAvailable(bb)) throw new Error(AI_UNSUPPORTED);
  const result = await bb.experimental_ai.complete({
    prompt, system, ...(override ?? {}), maxTokens, timeoutMs, signal,
  });
  if (!result.text.trim()) throw new Error("BB returned an empty AI answer.");
  return result.text;
}
