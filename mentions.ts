import { createHash } from "node:crypto";
import { z } from "zod";

const contentSchema = z.object({ fingerprint: z.string(), mentioned: z.boolean() });
const entrySchema = z.object({
  generation: z.number().int().nonnegative(),
  acknowledged: z.number().int().nonnegative(),
  content: z.record(z.string(), contentSchema),
  pending: z.number().int().nonnegative().nullable(),
  // An attempted PATCH can affect a later generation even if its response was lost.
  readBarrier: z.boolean(),
});
export const mentionStoreSchema = z.object({
  version: z.literal(1),
  accounts: z.record(z.string(), z.object({
    scope: z.string(), login: z.string(),
    items: z.record(z.string(), entrySchema),
    error: z.string().nullable(),
  })),
});
export type MentionStore = z.infer<typeof mentionStoreSchema>;
export const createMentionStore = (): MentionStore => ({ version: 1, accounts: {} });
export type MentionItem = { key: string; repo: string; number: number; kind: "issue" | "pr" };
export type MentionApi = ((path: string, method?: "GET" | "PATCH") => Promise<unknown>) & {
  /** Optional adapter returning one flattened, fully paginated collection. */
  getPages?: (path: string) => Promise<unknown>;
};
type Entry = z.infer<typeof entrySchema>;
const id = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
const body = z.object({ body: z.string().nullable() });
const comment = body.extend({ id });
const thread = z.object({ id, unread: z.boolean().optional(), subject: z.object({ url: z.string().nullable() }) });
type Thread = z.infer<typeof thread>;
const LIMIT = 1000;

/** Pure state machine apart from the injected API. No clock, timers, disk, or network client.
 * Persist tracker.state after acknowledge AND reconcile (including error results).
 * reason=mention is sticky; updated_at is not a fresh-mention identity. Polling cannot
 * detect an absent→present edit that happens entirely between two observations.
 */
export class MentionTracker {
  readonly state: MentionStore;
  private account?: MentionStore["accounts"][string];
  private running = false;
  private current = new Set<string>();
  constructor(state: MentionStore, private api: MentionApi, private scope = "github.com", private persist: () => Promise<unknown> = async () => {}) {
    // Validate without replacing the caller's durable object reference.
    mentionStoreSchema.parse(state);
    this.state = state;
  }

  get error(): string | null { return this.account?.error ?? null; }
  visible(key: string): boolean { return this.metadata(key).canAck; }
  metadata(key: string) {
    const e = this.account?.items[key];
    return { canAck: !!e && this.current.has(key) && e.generation > e.acknowledged,
      generation: e?.generation ?? 0, acknowledged: e?.acknowledged ?? 0,
      pending: e?.pending != null };
  }

  /** Local and synchronous: never waits for a notification or remote write. */
  acknowledge(key: string): boolean {
    if (!this.metadata(key).canAck) return false;
    const e = this.account!.items[key]!;
    e.acknowledged = e.generation;
    e.pending = e.generation;
    return true;
  }

  private async pages(path: string): Promise<unknown[]> {
    if (this.api.getPages) {
      const rows = z.array(z.unknown()).max(LIMIT).parse(await this.api.getPages(path));
      return rows;
    }
    const rows: unknown[] = [];
    for (let page = 1; page <= LIMIT / 100; page++) {
      const batch = z.array(z.unknown()).max(100).parse(await this.api(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, "GET"));
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new Error(`Pagination limit exceeded: ${path}`);
  }

  private async scan(item: MentionItem, login: string): Promise<Entry["content"]> {
    const base = `/repos/${item.repo}`;
    const issue = `${base}/issues/${item.number}`;
    const result: Entry["content"] = {};
    // Exact, case-insensitive direct login only: not email, team, or longer login.
    const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^a-z0-9_@/\\-])@${escaped}(?![a-z0-9_\\-/])`, "i");
    const add = (key: string, text: string | null) => {
      if (Object.hasOwn(result, key)) throw new Error(`Duplicate content ID: ${key}`);
      result[key] = { fingerprint: createHash("sha256").update(text ?? "").digest("hex"),
        mentioned: pattern.test(text ?? "") };
    };
    add("body", body.parse(await this.api(issue, "GET")).body);
    const paths = [["comment", `${issue}/comments`]];
    if (item.kind === "pr") paths.push(
      ["review-comment", `${base}/pulls/${item.number}/comments`],
      ["review", `${base}/pulls/${item.number}/reviews`]);
    for (const [prefix, path] of paths) {
      for (const row of await this.pages(path!)) {
        const c = comment.parse(row);
        add(`${prefix}:${c.id}`, c.body);
      }
    }
    return result;
  }

  private subject(t: Thread): string | null {
    const match = /^https?:\/\/[^/]+\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/.exec(t.subject.url ?? "");
    return match ? `${match[1]!.toLowerCase()}#${Number(match[2])}` : null;
  }

  async reconcile(items: MentionItem[], login: string): Promise<{
    visibleKeys: string[]; error: string | null;
  }> {
    if (this.running) throw new Error("Mention reconciliation already running");
    this.running = true;
    const errors: string[] = [];
    try {
      login = login.toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login)) throw new Error("Invalid GitHub login");
      const accountKey = JSON.stringify([this.scope, login]);
      this.account = this.state.accounts[accountKey] ??= { scope: this.scope, login, items: {}, error: null };
      const account = this.account;
      this.current = new Set(items.map(i => i.key));
      const scanned = new Map<string, MentionItem>();
      for (const item of items) {
        try {
          if (!/^[\w.-]+\/[\w.-]+$/.test(item.repo) || !Number.isSafeInteger(item.number) || item.number < 1
            || !["pr", "issue"].includes(item.kind) || !item.key) throw new Error("Invalid candidate");
          const content = await this.scan(item, login);
          const e = account.items[item.key] ??= { generation: 0, acknowledged: 0,
            content: {}, pending: null, readBarrier: false };
          const fresh = Object.entries(content).some(([key, c]) => c.mentioned && !e.content[key]?.mentioned);
          if (fresh) { e.generation++; e.pending = null; }
          // Preserve tombstones: a temporarily missing/deleted ID is not a new ID.
          Object.assign(e.content, content);
          scanned.set(item.key, item);
        } catch (error) { errors.push(`${item.key}: ${String(error)}`); }
      }
      let notifications: Thread[];
      try {
        notifications = (await this.pages("/notifications?all=true")).map(row => thread.parse(row));
      } catch (error) {
        errors.push(`Notifications: ${String(error)}`);
        notifications = [];
      }
      for (const [key, item] of scanned) {
        const e = account.items[key]!;
        const matches = notifications.filter(t => this.subject(t) === `${item.repo.toLowerCase()}#${item.number}`);
        if (!matches.length) continue; // Missing is unknown, never read.
        if (matches.some(t => t.unread === true)) e.readBarrier = false;
        else if (matches.every(t => t.unread === false) && !e.readBarrier) e.acknowledged = e.generation;
        const generation = e.pending;
        if (generation == null || generation !== e.generation) continue;
        let complete = true;
        for (const t of matches) {
          try {
            const path = `/notifications/threads/${encodeURIComponent(t.id)}`;
            const before = thread.parse(await this.api(path, "GET"));
            if (before.id !== t.id || this.subject(before) !== this.subject(t)) throw new Error("Thread identity changed");
            if (e.generation !== generation || e.pending !== generation) { complete = false; break; }
            // Set BEFORE the await: even an errored PATCH may have been applied remotely.
            e.readBarrier = true;
            await this.persist();
            if (before.unread !== false) await this.api(path, "PATCH");
          } catch (error) { complete = false; errors.push(`${key}: ${String(error)}`); }
        }
        if (complete && e.pending === generation && e.generation === generation) e.pending = null;
      }
      account.error = errors.length ? errors.join("\n") : null;
      return { visibleKeys: items.filter(i => this.metadata(i.key).canAck).map(i => i.key), error: account.error };
    } catch (error) {
      const message = String(error);
      if (this.account) this.account.error = message;
      return { visibleKeys: items.filter(i => this.metadata(i.key).canAck).map(i => i.key), error: message };
    } finally { this.running = false; }
  }
}
