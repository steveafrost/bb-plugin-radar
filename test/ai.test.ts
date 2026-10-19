import { describe, expect, it, vi } from "vitest";
import { aiAvailable, aiBackend, aiDetail, aiOverrideSchema, AI_UNSUPPORTED, complete, fallbackBaseUrl } from "../ai";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type AiHost = Pick<BbPluginApi, "experimental_ai">;
const fallback = { baseUrl: "https://proxy.example.com", keyEnv: "RADAR_TEST_KEY", model: "fallback-model" };
const env = { RADAR_TEST_KEY: "secret" };

const signal = new AbortController().signal;
const result = { text: "answer", providerId: "bb-provider", model: "bb-model" };

describe("BB native completion", () => {
  it("detects an older host and never attempts a credential fallback", async () => {
    const host: AiHost = Object.create(null);
    expect(aiAvailable(host)).toBe(false);
    await expect(complete(host, null, "system", "prompt", 800, 45000, signal)).rejects.toThrow(AI_UNSUPPORTED);
  });

  it("leaves provider/model resolution to BB by default and forwards bounds and cancellation", async () => {
    const fn = vi.fn<AiHost["experimental_ai"]["complete"]>().mockResolvedValue(result);
    const host: AiHost = { experimental_ai: { complete: fn } };
    expect(aiAvailable(host)).toBe(true);
    await expect(complete(host, null, "system", "prompt", 800, 45000, signal)).resolves.toBe("answer");
    expect(fn).toHaveBeenCalledExactlyOnceWith({ prompt: "prompt", system: "system", maxTokens: 800, timeoutMs: 45000, signal });
  });

  it("forwards a saved provider/model override without other execution settings", async () => {
    const fn = vi.fn<AiHost["experimental_ai"]["complete"]>().mockResolvedValue(result);
    await complete({ experimental_ai: { complete: fn } }, { providerId: "chosen", model: "chosen-model" }, "system", "prompt", 400, 45000, signal);
    expect(fn).toHaveBeenCalledExactlyOnceWith({ prompt: "prompt", system: "system", providerId: "chosen", model: "chosen-model", maxTokens: 400, timeoutMs: 45000, signal });
  });

  it("surfaces provider failures and rejects empty responses", async () => {
    const fn = vi.fn<AiHost["experimental_ai"]["complete"]>().mockRejectedValue(new Error("Unsupported model"));
    const host = { experimental_ai: { complete: fn } };
    await expect(complete(host, null, "s", "p", 400, 45000, signal)).rejects.toThrow("Unsupported model");
    fn.mockResolvedValue({ ...result, text: "  " });
    await expect(complete(host, null, "s", "p", 400, 45000, signal)).rejects.toThrow("empty AI answer");
  });

  it("validates optional overrides and rejects incomplete or legacy credential settings", () => {
    expect(aiOverrideSchema.parse(null)).toBeNull();
    expect(aiOverrideSchema.parse({ providerId: " p ", model: " m " })).toEqual({ providerId: "p", model: "m" });
    expect(aiOverrideSchema.safeParse({ providerId: "p" }).success).toBe(false);
    expect(aiOverrideSchema.safeParse({ providerId: "p", model: "m", aiKeyEnv: "KEY" }).success).toBe(false);
  });
});

describe("fallback endpoint for hosts without experimental_ai", () => {
  const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it("is used only on an older host with endpoint, key and model all set", () => {
    const older: AiHost = Object.create(null);
    expect(aiBackend(older, fallback, env)).toBe("fallback");
    expect(aiBackend(older, fallback, {})).toBeNull();
    expect(aiBackend(older, { ...fallback, model: "" }, env)).toBeNull();
    expect(aiBackend(older, { ...fallback, baseUrl: "" }, env)).toBeNull();
    expect(aiBackend(older, null, env)).toBeNull();
    expect(aiDetail(older, fallback, {})).toContain("$RADAR_TEST_KEY is not set");
  });

  it("never uses the fallback when BB can complete", async () => {
    const fn = vi.fn<AiHost["experimental_ai"]["complete"]>().mockResolvedValue(result);
    const fetchImpl = vi.fn<typeof fetch>();
    const host: AiHost = { experimental_ai: { complete: fn } };
    expect(aiBackend(host, fallback, env)).toBe("bb");
    await expect(complete(host, null, "s", "p", 400, 45000, signal, fallback, env, fetchImpl)).resolves.toBe("answer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a chat completion with the key and model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok("drafted"));
    await expect(complete(Object.create(null), null, "sys", "prompt", 300, 45000, signal, fallback, env, fetchImpl)).resolves.toBe("drafted");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://proxy.example.com/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: "fallback-model", max_tokens: 300, messages: [{ role: "system", content: "sys" }, { role: "user", content: "prompt" }] });
  });

  it("reports HTTP errors and empty answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 }));
    await expect(complete(Object.create(null), null, "s", "p", 300, 45000, signal, fallback, env, fetchImpl)).rejects.toThrow("HTTP 400 for model fallback-model: bad model");
    fetchImpl.mockResolvedValue(ok("  "));
    await expect(complete(Object.create(null), null, "s", "p", 300, 45000, signal, fallback, env, fetchImpl)).rejects.toThrow("empty AI answer");
  });

  it("accepts only https endpoints", () => {
    expect(fallbackBaseUrl("https://proxy.example.com/")).toBe("https://proxy.example.com");
    expect(fallbackBaseUrl("http://proxy.example.com")).toBe("");
    expect(fallbackBaseUrl("not a url")).toBe("");
    expect(fallbackBaseUrl("")).toBe("");
  });
});
