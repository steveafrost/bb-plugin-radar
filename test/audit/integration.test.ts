import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boot, calls, clearCalls, deltaRow, node, setState } from "./harness";

const lane = (id: string, query: string, extra: Record<string, unknown> = {}) => ({ id, title: id, sources: ["github"], query, category: "all", ...extra });
const DELTA = { deltaHost: "delta.example.com", deltaRepo: "acme/mono" };
type Bb = Awaited<ReturnType<typeof boot>>["bb"];
const db = (bb: Bb) => bb.storage.database();
// Tracked mention candidates (SQLite since 0.4.10).
async function trackedKeys(bb: Bb): Promise<Record<string, unknown>> {
  const rows = db(bb).prepare("SELECT key, candidate FROM mention_candidates").all() as { key: string; candidate: string }[];
  return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.candidate)]));
}
const here = new URL("./", import.meta.url).pathname;
/** Boots Radar on a fresh fake host whose database is a copy of `file` (a restart). */
async function restartOn(file: string, settings: Record<string, unknown>, lanes: unknown, kv: Record<string, unknown> = {}) {
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const host = createFakePluginHost({ pluginId: "radar", settings: { ghPath: join(here, "gh"), dtPath: join(here, "dt"), ...settings } as never });
  for (const [key, value] of Object.entries(kv)) await host.bb.storage.kv.set(key, value);
  const handle = host.bb.storage.database();
  const target = handle.name;
  handle.close();
  copyFileSync(file, target);
  return boot({}, lanes, { host });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("audit: integration", () => {
  it("smoke: refresh + status", async () => {
    setState({ searches: [{ match: "alpha", nodes: [node("o/r", 1), node("o/r", 2)] }] });
    const { harness } = await boot({}, [lane("a", "is:open alpha")]);
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    expect((await harness.runCli(["status"])).stdout).toContain("2  a [a]");
    await harness.dispose();
  });

  it("F1 a large results cache is kept in SQLite and shown again after a restart", async () => {
    const labels = { nodes: ["//areas/platform/payments", "Slice: billing", "ZoneID: 12", "#gsd:1234", "needs-review"].map((name) => ({ name })) };
    const searches = Array.from({ length: 7 }, (_, l) => ({
      match: `lane${l}`,
      nodes: Array.from({ length: 100 }, (_, i) => node(`shop/repo${l}`, l * 1000 + i + 1, { title: `Some realistic pull request title number ${i} touching payments`, labels })),
    }));
    setState({ searches });
    const lanes = searches.map((s, l) => lane(`l${l}`, `is:open ${s.match}`, { limit: 100 }));
    const { bb, harness } = await boot({ maxAgeDays: 0 }, lanes);
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    expect((await harness.runCli(["status"])).stdout).toContain("100  l6");
    expect(await bb.storage.kv.get("resultsCache")).toBeUndefined();
    expect(harness.logEntries.some((e) => /results cache write failed/.test(e.message))).toBe(false);
    const fetchedAt = ((await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string }).fetchedAt;
    // Restart: a fresh host on a copy of the same database, with every host call failing.
    const file = join(mkdtempSync(join(tmpdir(), "radar-restart-")), "data.db");
    await db(bb).backup(file);
    await harness.dispose();
    setState({ searches: [] });
    const second = await restartOn(file, { maxAgeDays: 0 }, lanes);
    const snap = (await second.harness.callRpc("radar_snapshot", null)) as { fetchedAt: string; results: Record<string, { items: unknown[] }> };
    expect(snap.fetchedAt).toBe(fetchedAt);
    expect(lanes.map((l) => snap.results[l.id]?.items.length)).toEqual([100, 100, 100, 100, 100, 100, 100]);
    await second.harness.dispose();
  });

  it("F1b a kv resultsCache moves to SQLite on load", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const host = createFakePluginHost({ pluginId: "radar", settings: { ghPath: join(here, "gh"), dtPath: join(here, "dt") } as never });
    const a = lane("a", "is:open alpha");
    const { laneQueryKey } = await import("../../lanes");
    const result = { laneId: "a", items: [{ key: "github:o/r#1", source: "github", kind: "pr", repo: "o/r", number: 1, title: "t", url: "https://github.com/o/r/pull/1", author: "x", draft: false, state: "OPEN", labels: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", isNew: false }], fetched: 1, error: "", fetchedAt: "2026-01-01T00:00:00Z", loading: false };
    await host.bb.storage.kv.set("resultsCache", { fetchedAt: "2026-01-01T00:00:01Z", lanes: { a: { queryKey: laneQueryKey(a as never), result } } });
    setState({ searches: [] });
    const { bb, harness } = await boot({}, [a], { host });
    expect(await bb.storage.kv.get("resultsCache")).toBeUndefined();
    const snap = (await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string; results: Record<string, { items: unknown[] }> };
    expect(snap.fetchedAt).toBe("2026-01-01T00:00:01Z");
    expect(snap.results.a!.items).toHaveLength(1);
    expect((db(bb).prepare("SELECT COUNT(*) AS n FROM results_cache").get() as { n: number }).n).toBe(1);
    await harness.dispose();
  });

  it("F2 marking seen during a one-host outage does not re-badge that host's items when it recovers", async () => {
    const gh = [node("o/r", 1), node("o/r", 2)];
    const delta = [deltaRow(11), deltaRow(12), deltaRow(13)];
    setState({ searches: [{ match: "mine", nodes: gh }], deltaItems: delta });
    const { harness } = await boot(DELTA, [{ ...lane("m", "is:open mine"), sources: ["delta", "github"] }]);
    await harness.runCli(["refresh"]);
    expect(JSON.parse((await harness.runCli(["list", "--new", "--json"])).stdout)).toHaveLength(0); // seeded, nothing new
    setState({ searches: [{ match: "mine", nodes: gh }], deltaItems: delta, deltaFail: true });
    await harness.runCli(["refresh"]);
    expect((await harness.runCli(["status"])).stdout).toMatch(/ERROR: Delta/);
    await harness.runCli(["seen"]); // user clears the badge during the Delta blip
    setState({ searches: [{ match: "mine", nodes: gh }], deltaItems: delta });
    await harness.runCli(["refresh"]);
    const fresh = JSON.parse((await harness.runCli(["list", "--new", "--json"])).stdout) as { key: string }[];
    expect(fresh).toEqual([]);
    const badge = await (await harness.fetchHttp("GET", "/badge")).json();
    expect(badge.new).toBe(0);
    await harness.dispose();
  });

  it("F2b carried seen keys are capped at 4 x the lane limit", async () => {
    setState({ searches: [{ match: "cap", nodes: [node("o/r", 1)] }] });
    const { bb, harness } = await boot({}, [lane("c", "is:open cap", { limit: 2 })]);
    await harness.runCli(["refresh"]);
    const old = Array.from({ length: 20 }, (_, i) => `github:o/r#${100 + i}`);
    await bb.storage.kv.set("seen", { c: [...old, "github:o/r#1"] });
    // Reload the seen map through a lane edit-free path: a second boot on a copy of the store.
    const file = join(mkdtempSync(join(tmpdir(), "radar-restart-")), "data.db");
    await db(bb).backup(file);
    const seenValue = await bb.storage.kv.get("seen");
    await harness.dispose();
    const second = await restartOn(file, {}, [lane("c", "is:open cap", { limit: 2 })], { seen: seenValue });
    await second.harness.runCli(["refresh"]);
    await second.harness.runCli(["seen", "c"]);
    const stored = (await second.bb.storage.kv.get("seen")) as Record<string, string[]>;
    expect(stored.c).toEqual([...old.slice(-8), "github:o/r#1"]);
    await second.harness.dispose();
  });

  it("F3 mention candidates come only from the current Mentions lane; unchanged items are not re-scanned", async () => {
    const ml = lane("mentions", "is:open mentions:@me");
    setState({ searches: [{ match: "mentions:@me", nodes: [1, 2, 3, 4, 5].map((n) => node("o/r", n)) }] });
    const { bb, harness } = await boot({}, [ml, lane("other", "is:open other")]);
    const scanned = () => [...new Set(calls().filter((c) => c.argv[0] === "api" && c.argv[1] === "--method").map((c) => c.argv[3]!.match(/issues\/(\d+)$/)?.[1]).filter(Boolean))].sort();
    await harness.runCli(["refresh"]);
    expect(scanned()).toEqual(["1", "2", "3", "4", "5"]);
    // Nothing moved: no item is scanned again.
    clearCalls();
    await harness.runCli(["refresh"]);
    expect(scanned()).toEqual([]);
    // The lane now returns a single, different item: only it is scanned, the rest are pruned.
    setState({ searches: [{ match: "mentions:@me", nodes: [node("o/r", 6)] }] });
    clearCalls();
    await harness.runCli(["refresh"]);
    expect(scanned()).toEqual(["6"]);
    expect(Object.keys(await trackedKeys(bb))).toEqual(["github:o/r#6"]);
    // Delete the Mentions lane: no mention calls at all, and nothing stays tracked.
    await harness.runCli(["remove", "mentions"]);
    clearCalls();
    await harness.runCli(["refresh"]);
    expect(calls().filter((c) => c.argv[1] === "--method")).toHaveLength(0);
    expect(Object.keys(await trackedKeys(bb))).toEqual([]);
    await harness.dispose();
  });

  it("F4 CLI list/status show acknowledged mentions that the panel and badge hide", async () => {
    const ml = lane("mentions", "is:open mentions:@me");
    setState({ login: "steve", issueBody: "hey @steve please look", searches: [{ match: "mentions:@me", nodes: [node("o/r", 1, { __typename: "Issue" })] }] });
    const { harness } = await boot({}, [ml]);
    await harness.runCli(["refresh"]);
    await harness.callRpc("radar_acknowledge", { key: "github:o/r#1" });
    await harness.runCli(["refresh"]);
    const snap = (await harness.callRpc("radar_snapshot", null)) as { results: Record<string, { items: unknown[] }> };
    const cli = JSON.parse((await harness.runCli(["list", "--lane", "mentions", "--json"])).stdout);
    const status = (await harness.runCli(["status"])).stdout;
    console.log("F4 panel items:", snap.results.mentions!.items.length, "CLI list items:", cli.length, "| status:", status.split("\n").at(-1));
    expect(snap.results.mentions!.items).toHaveLength(0);
    expect(cli).toHaveLength(1);
    expect(status).toMatch(/\s1\s+mentions \[mentions\]/);
    await harness.dispose();
  });

  it("F5 large mention state lives in SQLite, and a failing mention sync does not stop the board", async () => {
    const ml = lane("mentions", "is:open mentions:@me");
    setState({ login: "steve", comments: 950, searches: [{ match: "mentions:@me", nodes: [1, 2, 3].map((n) => node("o/r", n, { __typename: "Issue" })) }] });
    const { bb, harness } = await boot({}, [ml]);
    const r = await harness.runCli(["refresh"]);
    expect(r.exitCode).toBe(0);
    expect(await bb.storage.kv.get("mentions")).toBeUndefined();
    expect(await bb.storage.kv.get("mentionCandidates")).toBeUndefined();
    const rows = db(bb).prepare("SELECT COUNT(*) AS n FROM mention_items").get() as { n: number };
    expect(rows.n).toBe(3);
    expect(((await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string }).fetchedAt).not.toBe("");
    // Break mention storage: the sync fails, the refresh still lands and the CLI keeps working.
    db(bb).exec("DROP TABLE mention_candidates");
    setState({ login: "steve", searches: [{ match: "mentions:@me", nodes: [4].map((n) => node("o/r", n, { __typename: "Issue" })) }] });
    const before = ((await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string }).fetchedAt;
    await sleep(5);
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    const snap = (await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string; results: Record<string, { items: { number: number }[] }> };
    expect(snap.fetchedAt > before).toBe(true);
    expect(snap.results.mentions!.items.map((i) => i.number)).toEqual([4]);
    expect(harness.logEntries.some((e) => e.level === "warn" && /mention sync failed/.test(e.message))).toBe(true);
    expect((await harness.runCli(["status"])).exitCode).toBe(0);
    await harness.dispose();
  });

  it("F5c mention state and candidates in kv move to SQLite on load", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const host = createFakePluginHost({ pluginId: "radar", settings: { ghPath: join(here, "gh"), dtPath: join(here, "dt") } as never });
    const entry = { generation: 2, acknowledged: 1, content: { body: { fingerprint: "f", mentioned: true } }, pending: null, readBarrier: false };
    await host.bb.storage.kv.set("mentions", { version: 1, accounts: { '["github.com","steve"]': { scope: "github.com", login: "steve", error: null, items: { "github:o/r#1": entry } } } });
    await host.bb.storage.kv.set("mentionCandidates", { "github:o/r#1": { key: "github:o/r#1", repo: "o/r", number: 1, kind: "issue" } });
    setState({ searches: [] });
    const { bb, harness } = await boot({}, [lane("a", "is:open alpha")], { host });
    expect(await bb.storage.kv.get("mentions")).toBeUndefined();
    expect(await bb.storage.kv.get("mentionCandidates")).toBeUndefined();
    const item = db(bb).prepare("SELECT entry FROM mention_items WHERE key = ?").get("github:o/r#1") as { entry: string };
    expect(JSON.parse(item.entry)).toEqual(entry);
    expect(await trackedKeys(bb)).toEqual({ "github:o/r#1": { key: "github:o/r#1", repo: "o/r", number: 1, kind: "issue", updatedAt: "" } });
    await harness.dispose();
  });

  it("F6 one GraphQL partial error (e.g. a SAML-protected node) drops every GitHub item of the lane", async () => {
    setState({ partialError: true, searches: [{ match: "alpha", nodes: [node("o/r", 1), node("o/r", 2)] }] });
    const { harness } = await boot({}, [lane("a", "is:open alpha")]);
    await harness.runCli(["refresh"]);
    const status = (await harness.runCli(["status"])).stdout;
    console.log("F6 status:", status.split("\n").at(-1));
    expect(status).toMatch(/0\s+a \[a\]\s+ERROR: GitHub: gh: Resource protected/);
    await harness.dispose();
  });

  it("F7 editing a lane while refreshAll is queued leaves it stuck loading:true until the next cycle", async () => {
    setState({ searches: [
      { match: "slow0", delayMs: 600, nodes: [node("o/r", 1)] },
      { match: "slow1", delayMs: 600, nodes: [node("o/r", 2)] },
      { match: "slow2", delayMs: 600, nodes: [node("o/r", 3)] },
      { match: "old-d", delayMs: 50, nodes: [node("o/r", 4)] },
      { match: "new-d", delayMs: 50, nodes: [node("o/r", 5)] },
    ] });
    const { harness } = await boot({}, [lane("a", "slow0"), lane("b", "slow1"), lane("c", "slow2"), lane("d", "old-d")]);
    const all = harness.runCli(["refresh"]);
    await sleep(100);
    await harness.runCli(["put", JSON.stringify(lane("d", "new-d"))]);
    await all;
    await sleep(200);
    const snap = (await harness.callRpc("radar_snapshot", null)) as { refreshing: boolean; results: Record<string, { loading: boolean; items: { number: number }[] }> };
    console.log("F7 refreshing:", snap.refreshing, "lane d:", JSON.stringify({ loading: snap.results.d!.loading, items: snap.results.d!.items.map((i) => i.number) }));
    expect(snap.refreshing).toBe(false);
    expect(snap.results.d!.loading).toBe(true);
    await harness.dispose();
  });

  it("F8 CLI rejects unknown lane ids and a missing --lane value", async () => {
    setState({ searches: [{ match: "alpha", nodes: [node("o/r", 1)] }] });
    const { harness } = await boot({}, [lane("a", "is:open alpha")]);
    await harness.runCli(["refresh"]);
    const seen = await harness.runCli(["seen", "typo"]);
    const list = await harness.runCli(["list", "--lane", "typo"]);
    const listMissing = await harness.runCli(["list", "--lane"]);
    expect([seen.exitCode, list.exitCode, listMissing.exitCode]).toEqual([1, 1, 1]);
    await harness.dispose();
  });
});

describe("audit: poll service", () => {
  it("F5b the poll service keeps running when mention sync fails", async () => {
    setState({ login: "steve", searches: [{ match: "mentions:@me", nodes: [1].map((n) => node("o/r", n, { __typename: "Issue" })) }] });
    const { bb, harness } = await boot({}, [{ id: "mentions", title: "m", sources: ["github"], query: "is:open mentions:@me", category: "all" }]);
    db(bb).exec("DROP TABLE mention_candidates");
    const run = harness.runService("poll");
    let outcome = "still running";
    run.done.then(() => { outcome = "resolved"; }, (e: unknown) => { outcome = `rejected: ${String(e).slice(0, 90)}`; });
    for (let i = 0; i < 100 && ((await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string }).fetchedAt === ""; i++) await sleep(50);
    await sleep(100);
    expect(((await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string }).fetchedAt).not.toBe("");
    expect(outcome).toBe("still running");
    run.controller.abort();
    await harness.dispose();
  }, 15000);
});
