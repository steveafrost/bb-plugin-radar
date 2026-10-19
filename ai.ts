import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const aiOverrideSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(300),
}).strict().nullable();
export type AiOverride = z.infer<typeof aiOverrideSchema>;
export const AI_UNSUPPORTED = "This BB host does not support configured-provider text completion. A development build with experimental_ai.complete is required, or set the AI fallback endpoint, key variable and model. Focus still supports repo/area name matching and manual controls.";

/**
 * An OpenAI-compatible endpoint used only on BB hosts without experimental_ai.
 * Off unless baseUrl, keyEnv and model are all set; BB's own providers always win.
 */
export type AiFallback = { baseUrl: string; keyEnv: string; model: string };
export type AiHost = Pick<BbPluginApi, "experimental_ai">;
export type AiBackend = "bb" | "fallback" | null;
type Env = Record<string, string | undefined>;

export function aiAvailable(bb: AiHost): boolean {
  return typeof bb.experimental_ai?.complete === "function";
}

/** Only https URLs are accepted because the key is sent there; anything else switches the fallback off. */
export function fallbackBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    if (trimmed !== "" && new URL(trimmed).protocol === "https:") return trimmed;
  } catch {
    // Not a URL.
  }
  return "";
}

export function aiBackend(bb: AiHost, fallback: AiFallback | null, env: Env = process.env): AiBackend {
  if (aiAvailable(bb)) return "bb";
  if (fallback && fallback.baseUrl && fallback.model && fallback.keyEnv && env[fallback.keyEnv]) return "fallback";
  return null;
}

export function aiDetail(bb: AiHost, fallback: AiFallback | null, env: Env = process.env): string {
  switch (aiBackend(bb, fallback, env)) {
    case "bb":
      return "BB completion API available; the selected provider/model must support text completion.";
    case "fallback":
      return `This BB host has no experimental_ai; using the fallback endpoint ${fallback!.baseUrl} with model ${fallback!.model}.`;
    default:
      return fallback?.baseUrl && fallback.keyEnv && !env[fallback.keyEnv]
        ? `${AI_UNSUPPORTED} ($${fallback.keyEnv} is not set in the bb server environment.)`
        : AI_UNSUPPORTED;
  }
}

export async function complete(
  bb: AiHost,
  override: AiOverride,
  system: string,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
  signal: AbortSignal,
  fallback: AiFallback | null = null,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const backend = aiBackend(bb, fallback, env);
  if (backend === null) throw new Error(aiDetail(bb, fallback, env));
  const text = backend === "bb"
    ? (await bb.experimental_ai.complete({ prompt, system, ...(override ?? {}), maxTokens, timeoutMs, signal })).text
    : await completeFallback(fallback!, env[fallback!.keyEnv]!, system, prompt, maxTokens, timeoutMs, signal, fetchImpl);
  if (!text.trim()) throw new Error("BB returned an empty AI answer.");
  return text;
}

async function completeFallback(
  fallback: AiFallback,
  key: string,
  system: string,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${fallback.baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.any([timeout, signal]),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: fallback.model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
  } catch {
    throw new Error(timeout.aborted ? "The AI request timed out." : "The AI fallback endpoint could not be reached.");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    let reason = "";
    try {
      const parsed = JSON.parse(detail) as { reason?: unknown; error?: { message?: unknown } };
      reason = typeof parsed.reason === "string" ? parsed.reason : typeof parsed.error?.message === "string" ? parsed.error.message : "";
    } catch {
      // Not JSON.
    }
    throw new Error(`The AI fallback endpoint returned HTTP ${response.status} for model ${fallback.model}${reason ? `: ${reason.slice(0, 200)}` : "."}`);
  }
  const body = (await response.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}
