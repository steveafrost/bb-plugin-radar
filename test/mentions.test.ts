import { describe, expect, it } from "vitest";
import { createMentionStore, MentionTracker, mentionStoreSchema, type MentionApi, type MentionItem } from "../mentions";

const item: MentionItem = { key: "github:a/b#1", repo: "a/b", number: 1, kind: "issue" };
function fixture() {
  const data = {
    body: "@alice hello", comments: [] as { id: number; body: string }[],
    reviews: [] as { id: number; body: string }[], reviewComments: [] as { id: number; body: string }[],
    notifications: [{ id: "7", unread: true, subject: { url: "https://api.github.com/repos/a/b/issues/1" } }],
    failPatch: false, failScan: false, failNotifications: false, badPreflight: false,
  };
  const calls: string[] = [];
  const api: MentionApi = async (path, method = "GET") => {
    calls.push(`${method} ${path}`);
    const u = new URL(path, "https://api.github.com");
    if (u.pathname === "/notifications/threads/7") {
      if (method === "PATCH") {
        if (data.failPatch) throw new Error("offline");
        data.notifications[0]!.unread = false;
        return null;
      }
      return { ...data.notifications[0], id: data.badPreflight ? "wrong" : "7" };
    }
    if (u.pathname === "/notifications") {
      if (data.failNotifications) throw new Error("notifications unavailable");
      expect(u.searchParams.get("all")).toBe("true");
      return data.notifications;
    }
    if (data.failScan) throw new Error("scan unavailable");
    if (u.pathname.endsWith("/issues/1")) return { body: data.body };
    let rows: unknown[];
    if (u.pathname.endsWith("/pulls/1/comments")) rows = data.reviewComments;
    else if (u.pathname.endsWith("/reviews")) rows = data.reviews;
    else rows = data.comments;
    const page = Number(u.searchParams.get("page"));
    expect(u.searchParams.get("per_page")).toBe("100");
    return rows.slice((page - 1) * 100, page * 100);
  };
  const state = createMentionStore();
  const tracker = new MentionTracker(state, api);
  const refresh = () => tracker.reconcile([item], "alice");
  const patches = () => calls.filter(c => c.startsWith("PATCH"));
  return { data, calls, api, state, tracker, refresh, patches };
}

describe("mention acknowledgements", () => {
  it("persists the write barrier before a PATCH and aborts writes on storage failure", async () => {
    const f = fixture();
    const tracker = new MentionTracker(f.state, f.api, "github.com", async () => {
      expect(Object.values(f.state.accounts)[0]!.items[item.key]!.readBarrier).toBe(true);
      throw new Error("disk unavailable");
    });
    await tracker.reconcile([item], "alice");
    tracker.acknowledge(item.key);
    expect((await tracker.reconcile([item], "alice")).error).toContain("disk unavailable");
    expect(f.patches()).toHaveLength(0);
    expect(tracker.metadata(item.key).pending).toBe(true);
  });

  it("does not disable reconciliation after 100 historical candidates", async () => {
    const f = fixture();
    const items = Array.from({ length: 101 }, (_, n) => ({ ...item, key: `${item.key}:${n}` }));
    const result = await f.tracker.reconcile(items, "alice");
    expect(result.error).toBeNull();
    expect(result.visibleKeys).toHaveLength(101);
  });
  it("acknowledges durably without network and retries errors after reload", async () => {
    const f = fixture();
    expect((await f.refresh()).visibleKeys).toEqual([item.key]);
    const count = f.calls.length;
    expect(f.tracker.acknowledge(item.key)).toBe(true);
    expect(f.calls).toHaveLength(count);
    expect(f.tracker.metadata(item.key)).toMatchObject({ canAck: false, pending: true });
    f.data.failPatch = true;
    expect((await f.refresh()).error).toContain("offline");
    expect(f.tracker.metadata(item.key).pending).toBe(true);
    f.data.failPatch = false;
    const restored = new MentionTracker(mentionStoreSchema.parse(JSON.parse(JSON.stringify(f.state))), f.api);
    expect((await restored.reconcile([item], "alice")).error).toBeNull();
    expect(restored.metadata(item.key)).toMatchObject({ pending: false, canAck: false });
    const patch = f.calls.findIndex(c => c.startsWith("PATCH"));
    expect(f.calls[patch - 1]).toBe("GET /notifications/threads/7");
  });

  it("does not treat unrelated edits as fresh; detects observed removal/readdition", async () => {
    const f = fixture();
    await f.refresh();
    f.tracker.acknowledge(item.key);
    f.data.body += " unrelated edit";
    await f.refresh();
    expect(f.tracker.metadata(item.key).generation).toBe(1);
    f.data.body = "removed";
    await f.refresh();
    f.data.body = "@ALICE again";
    expect((await f.refresh()).visibleKeys).toEqual([item.key]);
    expect(f.tracker.metadata(item.key).generation).toBe(2);
    // Read status produced by our old PATCH cannot consume this generation.
    expect((await f.refresh()).visibleKeys).toEqual([item.key]);
  });

  it("discards stale pending retries before any write when a new comment mentions", async () => {
    const f = fixture();
    await f.refresh();
    f.tracker.acknowledge(item.key);
    f.data.failPatch = true;
    await f.refresh();
    f.data.failPatch = false;
    f.data.notifications[0]!.unread = false; // failed response may still have applied
    f.data.comments.push({ id: 1, body: "@alice new" });
    const count = f.patches().length;
    expect((await f.refresh()).visibleKeys).toEqual([item.key]);
    expect(f.patches()).toHaveLength(count);
    expect(f.tracker.metadata(item.key)).toMatchObject({ generation: 2, pending: false });
  });

  it("syncs explicit external reads, but not missing or unspecified notifications", async () => {
    const f = fixture();
    f.data.notifications[0]!.unread = false;
    expect((await f.refresh()).visibleKeys).toEqual([]);
    f.data.comments.push({ id: 1, body: "@alice" });
    f.data.notifications = [];
    expect((await f.refresh()).visibleKeys).toEqual([item.key]);
    f.data.notifications = [{ id: "7", subject: { url: "https://api.github.com/repos/a/b/issues/1" } } as any];
    expect((await f.refresh()).visibleKeys).toEqual([item.key]);
    f.data.notifications[0]!.unread = false;
    expect((await f.refresh()).visibleKeys).toEqual([]);
  });

  it("scans every PR content stream and all pages, recording nonmentions too", async () => {
    const f = fixture();
    f.data.body = "none";
    f.data.comments = Array.from({ length: 101 }, (_, id) => ({ id, body: id === 100 ? "@alice" : "none" }));
    f.data.reviews = [{ id: 1, body: "@alice review" }];
    f.data.reviewComments = [{ id: 1, body: "@alice inline" }];
    await f.tracker.reconcile([{ ...item, kind: "pr" }], "alice");
    const e = Object.values(f.state.accounts)[0]!.items[item.key]!;
    expect(Object.keys(e.content)).toHaveLength(104);
    expect(e.content["comment:0"]!.mentioned).toBe(false);
    expect(e.content["review:1"]!.mentioned).toBe(true);
    expect(f.calls).toContain("GET /repos/a/b/issues/1/comments?per_page=100&page=2");
  });

  it("ignores notifications without a subject URL", async () => {
    const f = fixture();
    f.data.notifications.push({ id: "8", unread: true, subject: { url: null } } as any);
    expect((await f.refresh()).error).toBeNull();
    expect(f.tracker.metadata(item.key).canAck).toBe(true);
  });

  it("paginates all notifications, including read threads", async () => {
    const f = fixture();
    const api: MentionApi = async (path, method) => {
      if (path.startsWith("/notifications?")) {
        if (path.endsWith("page=1")) return Array.from({ length: 100 }, (_, n) => ({
          id: String(n), unread: false, subject: { url: "https://api.github.com/repos/other/repo/issues/1" },
        }));
        return [{ id: "7", unread: false, subject: { url: "https://api.github.com/repos/a/b/pulls/1" } }];
      }
      return f.api(path, method);
    };
    expect((await new MentionTracker(createMentionStore(), api).reconcile([item], "alice")).visibleKeys).toEqual([]);
  });

  it("retains state and pending work on scan, notification and preflight errors", async () => {
    const f = fixture();
    await f.refresh();
    f.tracker.acknowledge(item.key);
    f.data.failScan = true;
    expect((await f.refresh()).error).toContain("scan unavailable");
    expect(f.patches()).toHaveLength(0);
    f.data.failScan = false;
    f.data.failNotifications = true;
    expect((await f.refresh()).error).toContain("notifications unavailable");
    expect(f.tracker.metadata(item.key).pending).toBe(true);
    f.data.failNotifications = false;
    f.data.badPreflight = true;
    expect((await f.refresh()).error).toContain("identity changed");
    expect(f.patches()).toHaveLength(0);
    f.data.badPreflight = false;
    expect((await f.refresh()).error).toBeNull();
    expect(f.patches()).toHaveLength(1);
  });

  it("isolates logins and host/account scopes and matches direct logins exactly", async () => {
    const f = fixture();
    await f.refresh();
    f.tracker.acknowledge(item.key);
    expect((await f.tracker.reconcile([item], "bob")).visibleKeys).toEqual([]);
    expect((await new MentionTracker(f.state, f.api, "another-account").reconcile([item], "alice")).visibleKeys).toEqual([item.key]);
    expect(Object.keys(f.state.accounts)).toHaveLength(3);
    f.data.body = "x@alice @alice-team @alice/team @alice_extra @@alice";
    const clean = new MentionTracker(createMentionStore(), f.api);
    expect((await clean.reconcile([item], "Alice")).visibleKeys).toEqual([]);
    expect(mentionStoreSchema.safeParse({ accounts: [] }).success).toBe(false);
  });

  it("accepts flattened getPages adapters and rejects malformed collections conservatively", async () => {
    const f = fixture();
    f.api.getPages = async path => path.startsWith("/notifications") ? f.data.notifications : [{ id: 1, body: "@alice" }];
    await f.refresh();
    f.tracker.acknowledge(item.key);
    f.api.getPages = async () => ({ bad: true });
    expect((await f.refresh()).error).not.toBeNull();
    expect(f.tracker.metadata(item.key).pending).toBe(true);
    expect(f.patches()).toHaveLength(0);
  });
});
