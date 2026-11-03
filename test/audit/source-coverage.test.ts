import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { laneQueryKey } from "../../lanes";
import type { Lane, RadarSnapshot } from "../../server";
import { boot, calls, clearCalls, deltaRow, node, setState } from "./harness";

const lane: Lane = {
  id: "mine",
  title: "My open PRs",
  sources: ["delta", "github"],
  query: "is:open is:pr author:@me",
  category: "prs",
};
const DELTA = { deltaHost: "delta.example.com", deltaRepo: "acme/mono" };
const here = new URL("./", import.meta.url).pathname;
type Harness = Awaited<ReturnType<typeof boot>>["harness"];
const snapshot = async (harness: Harness) => await harness.callRpc("radar_snapshot", null) as RadarSnapshot;

describe("lane source coverage", () => {
  it.each([false, true])("records only GitHub with unconfigured Delta (has items: %s)", async (hasItems) => {
    setState({ searches: [{ match: "author:@me", nodes: hasItems ? [node("o/r", 1)] : [] }] });
    clearCalls();
    const { harness } = await boot({}, [lane]);
    try {
      expect((await snapshot(harness)).results.mine).toBeUndefined();
      await harness.runCli(["refresh"]);
      const result = (await snapshot(harness)).results.mine!;
      expect(result.checkedSources).toEqual(["github"]);
      expect(result.items).toHaveLength(hasItems ? 1 : 0);
      expect(result.error).toBe("");
      expect(calls().some((call) => call.bin === "dt")).toBe(false);
      expect((await snapshot(harness)).lanes[0]!.sources).toEqual(["delta", "github"]);
    } finally {
      await harness.dispose();
    }
  });

  it("records successful zero-result reads from both configured hosts", async () => {
    setState({ searches: [], deltaItems: [] });
    const { harness } = await boot(DELTA, [lane]);
    try {
      await harness.runCli(["refresh"]);
      expect((await snapshot(harness)).results.mine).toMatchObject({
        checkedSources: ["delta", "github"], items: [], fetched: 0, error: "",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("excludes a failed host while retaining another host's results and the error", async () => {
    setState({ searches: [{ match: "author:@me", nodes: [node("o/r", 1)] }], deltaFail: true });
    const { harness } = await boot(DELTA, [lane]);
    try {
      await harness.runCli(["refresh"]);
      const result = (await snapshot(harness)).results.mine!;
      expect(result.checkedSources).toEqual(["github"]);
      expect(result.items.map((item) => item.key)).toEqual(["github:o/r#1"]);
      expect(result.error).toContain("Delta");
    } finally {
      await harness.dispose();
    }
  });

  it("records no successful checks when every host fails, keeping previous items", async () => {
    setState({ searches: [], deltaItems: [deltaRow(1)] });
    const { harness } = await boot(DELTA, [lane]);
    try {
      await harness.runCli(["refresh"]);
      const previous = (await snapshot(harness)).results.mine!;
      expect(previous.checkedSources).toEqual(["delta", "github"]);
      setState({ searchFail: true, deltaFail: true });
      await harness.runCli(["refresh"]);
      const result = (await snapshot(harness)).results.mine!;
      expect(result.checkedSources).toEqual([]);
      expect(result.items).toEqual(previous.items);
      expect(result.error).toContain("Delta");
      expect(result.error).toContain("GitHub");
    } finally {
      await harness.dispose();
    }
  });

  it("preserves the previous checks while a refresh is loading", async () => {
    setState({ searches: [] });
    const { harness } = await boot({}, [lane]);
    try {
      await harness.runCli(["refresh"]);
      setState({ searches: [], delayMs: 100 });
      const refresh = harness.runCli(["refresh"]);
      await vi.waitFor(async () => {
        expect((await snapshot(harness)).results.mine).toMatchObject({ loading: true, checkedSources: ["github"] });
      });
      await refresh;
      expect((await snapshot(harness)).results.mine).toMatchObject({ loading: false, checkedSources: ["github"] });
    } finally {
      await harness.dispose();
    }
  });

  it("restores actual checks from cache even when the next startup enables Delta", async () => {
    setState({ searches: [] });
    const first = await boot({}, [lane]);
    const file = join(mkdtempSync(join(tmpdir(), "radar-coverage-")), "data.db");
    try {
      await first.harness.runCli(["refresh"]);
      await first.bb.storage.database().backup(file);
    } finally {
      await first.harness.dispose();
    }
    const host = createFakePluginHost({
      pluginId: "radar",
      settings: { ghPath: join(here, "gh"), dtPath: join(here, "dt"), ...DELTA },
    });
    const db = host.bb.storage.database();
    const target = db.name;
    db.close();
    copyFileSync(file, target);
    const { harness } = await boot({}, [lane], { host });
    try {
      const restored = await snapshot(harness);
      expect(restored.hosts.delta).not.toBeNull();
      expect(restored.results.mine!.checkedSources).toEqual(["github"]);
      await harness.runCli(["refresh"]);
      expect((await snapshot(harness)).results.mine!.checkedSources).toEqual(["delta", "github"]);
    } finally {
      await harness.dispose();
    }
  });

  it("accepts older cached results without inventing which sources were checked", async () => {
    setState({ searches: [] });
    const host = createFakePluginHost({
      pluginId: "radar",
      settings: { ghPath: join(here, "gh"), dtPath: join(here, "dt"), ...DELTA },
    });
    await host.bb.storage.kv.set("resultsCache", {
      fetchedAt: "2026-01-01T00:00:00Z",
      lanes: { mine: { queryKey: laneQueryKey(lane), result: {
        laneId: "mine", items: [], fetched: 0, error: "", fetchedAt: "2026-01-01T00:00:00Z", loading: false,
      } } },
    });
    const { harness } = await boot({}, [lane], { host });
    try {
      const restored = (await snapshot(harness)).results.mine!;
      expect(restored.fetchedAt).toBe("2026-01-01T00:00:00Z");
      expect(restored.checkedSources).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });
});
