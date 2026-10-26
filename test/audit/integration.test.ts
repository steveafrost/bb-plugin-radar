import { describe, expect, it } from "vitest";
import { boot, calls, clearCalls, deltaRow, node, setState } from "./harness";

const lane = (id: string, query: string, extra: Record<string, unknown> = {}) => ({ id, title: id, sources: ["github"], query, category: "all", ...extra });
const DELTA = { deltaHost: "delta.example.com", deltaRepo: "acme/mono" };
// Tracked mention candidates, wherever Radar keeps them.
async function trackedKeys(bb: { storage: { kv: { get: (key: string) => Promise<unknown> } } }): Promise<Record<string, unknown>> {
  return ((await bb.storage.kv.get("mentionCandidates")) ?? {}) as Record<string, unknown>;
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

  it("F1 resultsCache exceeds the 256KB kv cap with 7 full lanes and is silently not written", async () => {
    const labels = { nodes: ["//areas/platform/payments", "Slice: billing", "ZoneID: 12", "#gsd:1234", "needs-review"].map((name) => ({ name })) };
    const searches = Array.from({ length: 7 }, (_, l) => ({
      match: `lane${l}`,
      nodes: Array.from({ length: 100 }, (_, i) => node(`shop/repo${l}`, l * 1000 + i + 1, { title: `Some realistic pull request title number ${i} touching payments`, labels })),
    }));
    setState({ searches });
    const lanes = searches.map((s, l) => lane(`l${l}`, `is:open ${s.match}`, { limit: 100 }));
    const { bb, harness } = await boot({ maxAgeDays: 0 }, lanes);
    expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
    const status = await harness.runCli(["status"]);
    expect(status.stdout).toContain("100  l6");
    expect(await bb.storage.kv.get("resultsCache")).toBeUndefined();
    expect(harness.logEntries.some((e) => e.level === "warn" && /results cache write failed.*256KB/.test(e.message))).toBe(true);
    console.log("F1 warn:", harness.logEntries.find((e) => /results cache/.test(e.message))?.message.slice(0, 160));
    await harness.dispose();
  });

  it("F2 marking seen during a one-host outage re-badges every item of that host when it recovers", async () => {
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
    console.log("F2 new after recovery:", fresh.map((i) => i.key));
    expect(fresh.map((i) => i.key).sort()).toEqual(["delta:acme/mono#11", "delta:acme/mono#12", "delta:acme/mono#13"]);
    const badge = await (await harness.fetchHttp("GET", "/badge")).json();
    expect(badge.new).toBe(3);
    await harness.dispose();
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

  it("F5 a kv overflow inside syncMentions rejects refreshAll: fetchedAt, hidden reconcile and the results cache stop updating", async () => {
    const ml = lane("mentions", "is:open mentions:@me");
    setState({ login: "steve", comments: 950, searches: [{ match: "mentions:@me", nodes: [1, 2, 3].map((n) => node("o/r", n, { __typename: "Issue" })) }] });
    const { bb, harness } = await boot({}, [ml]);
    const r = await harness.runCli(["refresh"]);
    console.log("F5 refresh:", r.exitCode, (r.stderr ?? "").slice(0, 140));
    expect(r.exitCode).toBe(1);
    expect(await bb.storage.kv.get("resultsCache")).toBeUndefined();
    const status = await harness.runCli(["status"]);
    console.log("F5 status:", status.exitCode, (status.stderr ?? "").slice(0, 80));
    expect(status.exitCode).toBe(1); // status/list/scopes re-run refreshAll while fetchedAt is "" and fail the same way
    const snap = (await harness.callRpc("radar_snapshot", null)) as { fetchedAt: string };
    expect(snap.fetchedAt).toBe("");
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
  it("F5b the poll service's start() rejects (crash → restart with backoff) once syncMentions overflows kv", async () => {
    setState({ login: "steve", comments: 950, searches: [{ match: "mentions:@me", nodes: [1, 2, 3].map((n) => node("o/r", n, { __typename: "Issue" })) }] });
    const { harness } = await boot({}, [{ id: "mentions", title: "m", sources: ["github"], query: "is:open mentions:@me", category: "all" }]);
    const run = harness.runService("poll");
    const outcome = await Promise.race([run.done.then(() => "resolved", (e: unknown) => `rejected: ${String(e).slice(0, 90)}`), sleep(8000).then(() => "still running")]);
    console.log("F5b poll service:", outcome);
    expect(outcome).toMatch(/^rejected: .*mentions/);
    run.controller.abort();
    await harness.dispose();
  }, 15000);
});
