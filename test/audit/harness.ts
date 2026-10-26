import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

const dir = mkdtempSync(join(tmpdir(), "radar-audit-"));
export const STATE = join(dir, "state.json");
export const LOG = join(dir, "calls.log");
process.env.FAKE_STATE = STATE;
process.env.FAKE_LOG = LOG;
const here = new URL(".", import.meta.url).pathname;

export function setState(state: Record<string, unknown>) { writeFileSync(STATE, JSON.stringify(state)); }
export function calls(): { bin: string; argv: string[] }[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function clearCalls() { writeFileSync(LOG, ""); }

export const node = (repo: string, number: number, extra: Record<string, unknown> = {}) => ({
  __typename: "PullRequest", number, title: `PR ${number}`, url: `https://github.com/${repo}/pull/${number}`,
  isDraft: false, state: "OPEN", createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() - number * 1000).toISOString(),
  author: { login: "someone" }, repository: { nameWithOwner: repo }, labels: { nodes: [] }, ...extra,
});
export const deltaRow = (number: number) => ({
  number, title: `Delta ${number}`, html_url: `https://delta.example.com/acme/mono/pull/${number}`,
  repository_url: "https://delta.example.com/api/v3/repos/acme/mono", user: { login: "x@example.com" },
  state: "open", pull_request: {}, labels: [], created_at: new Date().toISOString(), updated_at: new Date(Date.now() - number * 1000).toISOString(),
});

export async function boot(settings: Record<string, unknown> = {}, lanes?: unknown, shared?: { host: ReturnType<typeof createFakePluginHost> }) {
  const host = shared?.host ?? createFakePluginHost({
    pluginId: "radar",
    settings: { ghPath: join(here, "gh"), dtPath: join(here, "dt"), ...settings } as never,
  });
  if (lanes !== undefined) await host.bb.storage.kv.set("lanes", lanes);
  const { default: plugin } = await import("../../server");
  await plugin(host.bb);
  return host;
}
