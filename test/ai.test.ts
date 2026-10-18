import { describe, expect, it, vi } from "vitest";
import { aiAvailable, aiOverrideSchema, AI_UNSUPPORTED, complete } from "../ai";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type AiHost = Pick<BbPluginApi, "experimental_ai">;

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
