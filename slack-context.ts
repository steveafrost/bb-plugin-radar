/**
 * Slack context for issues and PRs (GitHub and Delta): pure helpers (no clock, no disk, network
 * only through an injected fetch). Radar finds public Slack messages that link an item by URL,
 * follows their threads, and keeps a short AI summary that it shows on the board. The summary is
 * Radar's own; posting it to the issue or PR is a one-off action you take, never automatic.
 */
import { z } from "zod";

export const SLACK_HEADING = "### Slack context";
/** Threads followed per issue (newest first); older links stay stored but are not re-read. */
export const MAX_THREADS_PER_ISSUE = 5;
/** Per-thread and total caps on the Slack text sent to the AI. */
const THREAD_CHARS = 12000;
export const MAX_SUMMARY = 4000;

export type SlackHit = {
  channelId: string;
  channelName: string;
  /** The thread's parent ts (a reply's own ts is not a thread). */
  threadTs: string;
  permalink: string;
};

export type SlackThreadRead = {
  /** Newest human message ts in the thread ("" if none). */
  latestTs: string;
  /** Human messages in the thread. */
  count: number;
  /** Who opened the thread and what they said (Slack markup cleaned, trimmed). */
  author: string;
  opening: string;
  /** Replies Slack reports for the parent (all of them, not just the page read). */
  replies: number;
};

const OPENING_CHARS = 400;

/** Slack mrkdwn as plain text: links show their label, mentions and channels their names. */
export function slackPlainText(text: string): string {
  return text
    .replace(/<([^<>|]+)\|([^<>]+)>/g, (_, target: string, label: string) => (target.startsWith("#C") ? `#${label}` : target.startsWith("@") ? `@${label}` : label))
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<#[A-Z0-9]+>/g, "#channel")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^<>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type SlackSource = { channelName: string; permalink: string };

/**
 * Search phrase for an issue or PR: its web URL without the scheme, which is how Slack tokenises
 * links (`github.com/o/r/issues/12`, `github.com/o/r/pull/7`, `delta.shopify.io/o/r/pull/9`).
 * "" when the URL is not a plain https issue or PR page.
 */
export function itemPath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (parsed.protocol !== "https:" || !/^\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(path)) return "";
  return `${parsed.host.toLowerCase()}${path}`;
}

/** Arguments for slack_search_public. Public channels only, so nothing private can reach an issue. */
export function searchArguments(path: string, afterUnix: number | null): Record<string, unknown> {
  return {
    query: path,
    keywords: [`"${path}"`],
    natural_language_query: "",
    limit: 20,
    sort: "timestamp",
    include_bots: false,
    include_context: false,
    response_format: "detailed",
    ...(afterUnix !== null ? { after: String(Math.max(0, Math.floor(afterUnix))) } : {}),
  };
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact link check: issues/12 must not match issues/123, and host and owner/repo must match exactly. */
export function linksItem(text: string, path: string): boolean {
  return new RegExp(`(?<![\\w.-])${escapeRegex(path)}(?![0-9])`, "i").test(text.replace(/\\\//g, "/"));
}

const TS = /^\d{6,}\.\d{1,6}$/;

/**
 * Parses slack_search_public's detailed markdown into thread hits. Keeps only messages by
 * people (a `From:` with an email; integration posts such as the GitHub app echoing the issue
 * have none) that really link this issue. Hits are de-duplicated by thread.
 */
export function parseSearchResults(markdown: string, path: string): SlackHit[] {
  const hits = new Map<string, SlackHit>();
  for (const block of markdown.replace(/\\\//g, "/").split(/^### Result \d+ of \d+\s*$/m).slice(1)) {
    const channel = /^Channel:\s*#?(.*?)\s*\(ID:\s*([A-Z0-9]+)\)/m.exec(block);
    const from = /^From:\s*(.*)$/m.exec(block)?.[1] ?? "";
    const messageTs = /^Message_ts:\s*(\S+)/m.exec(block)?.[1] ?? "";
    const permalink = /^Permalink:\s*\[[^\]]*\]\((https:\/\/[^)\s]+)\)/m.exec(block)?.[1] ?? "";
    const text = block.split(/^Text:\s*$/m)[1] ?? block;
    if (channel === null || !TS.test(messageTs) || !/<[^>\s]+@[^>\s]+>/.test(from)) continue;
    if (!linksItem(text, path)) continue;
    let threadTs = messageTs;
    try {
      const fromLink = permalink ? new URL(permalink).searchParams.get("thread_ts") : null;
      if (fromLink !== null && TS.test(fromLink)) threadTs = fromLink;
    } catch {
      // Malformed permalink: the message itself is the thread.
    }
    const channelId = channel[2]!;
    const key = `${channelId}:${threadTs}`;
    if (hits.has(key)) continue;
    hits.set(key, {
      channelId,
      channelName: channel[1]!.trim().slice(0, 80),
      threadTs,
      permalink: permalink ? threadPermalink(permalink, channelId, threadTs) : "",
    });
  }
  return [...hits.values()];
}

/** A link to the thread's parent, so the issue points at the conversation, not one reply. */
export function threadPermalink(permalink: string, channelId: string, threadTs: string): string {
  try {
    const url = new URL(permalink);
    url.pathname = `/archives/${channelId}/p${threadTs.replace(".", "")}`;
    url.search = "";
    return url.toString();
  } catch {
    return "";
  }
}

const threadJson = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  messages: z.array(z.object({
    ts: z.string(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
    text: z.string().optional(),
    user_name: z.string().optional(),
    reply_count: z.union([z.string(), z.number()]).optional(),
  }).passthrough()).optional(),
}).passthrough();

/** Newest human message in a slack_read_thread `format: "json"` answer; bots and joins don't count. */
export function parseThreadJson(text: string): SlackThreadRead {
  let parsed: z.infer<typeof threadJson>;
  try {
    parsed = threadJson.parse(JSON.parse(text));
  } catch {
    throw new Error("Slack returned an unreadable thread.");
  }
  if (parsed.ok === false) throw new Error(`Slack: ${parsed.error ?? "thread read failed"}`);
  const human = (parsed.messages ?? []).filter((message) => message.bot_id === undefined && (message.subtype === undefined || message.subtype === "thread_broadcast"));
  const latestTs = human.reduce((latest, message) => (compareTs(message.ts, latest) > 0 ? message.ts : latest), "");
  const parent = parsed.messages?.[0];
  const opening = slackPlainText(parent?.text ?? "");
  const replies = Number(parent?.reply_count ?? 0);
  return {
    latestTs,
    count: human.length,
    author: (parent?.user_name ?? "").slice(0, 80),
    opening: opening.length > OPENING_CHARS ? `${opening.slice(0, OPENING_CHARS - 1).trimEnd()}…` : opening,
    replies: Number.isFinite(replies) ? replies : 0,
  };
}

/** Slack ts strings compared numerically ("" sorts first). */
export function compareTs(a: string, b: string): number {
  const x = a === "" ? -1 : Number(a);
  const y = b === "" ? -1 : Number(b);
  return x === y ? 0 : x > y ? 1 : -1;
}

// ---- posting to the issue or PR ----------------------------------------------

/** The comment body for "Post to issue/PR": heading, the thread's context, then a link to it. */
export function renderComment(summary: string, sources: SlackSource[], date: string): string {
  const links = sources
    .filter((source) => source.permalink !== "")
    .map((source) => `[#${source.channelName.replace(/[[\]]/g, "")}](${source.permalink})`);
  return [
    SLACK_HEADING,
    "",
    summary.trim(),
    "",
    `<sub>From public Slack threads${links.length ? `: ${links.join(" · ")}` : ""}, as of ${date}.</sub>`,
  ].join("\n");
}

// ---- the AI draft ------------------------------------------------------------

export const SUMMARY_SYSTEM = [
  "You summarise one public Slack thread that links an issue or pull request, for an engineer who did not see it.",
  "Capture what changes their understanding of the work: decisions, agreed scope, open questions, blockers, owners and next steps.",
  "Leave out greetings, thanks and chatter. It is shown on the engineer's dashboard and may be posted to the issue, so write",
  "GitHub markdown: at most 4 short bullets, under 90 words. Name people only by the names shown. Never invent facts.",
  "Do not copy secrets, tokens, customer or merchant data, or anything that reads as personal.",
  "If a current summary is given, return an updated version of it: keep what still holds, fix what changed, add what is new.",
  "Answer with JSON only: {\"changed\": boolean, \"summary\": string}. changed is false when the thread adds nothing",
  "material to the current summary; then summary repeats the current one.",
].join(" ");

export function summaryPrompt(
  issue: { kind: "issue" | "pr"; repo: string; number: number; title: string },
  current: string,
  thread: { channelName: string; text: string },
): string {
  return [
    `${issue.kind === "pr" ? "Pull request" : "Issue"}: ${issue.repo}#${issue.number} — ${issue.title}`,
    "",
    "Current summary:",
    current.trim() === "" ? "(none yet)" : current.trim(),
    "",
    `Slack thread in #${thread.channelName}:`,
    thread.text.trim().slice(0, THREAD_CHARS),
  ].join("\n");
}

const replySchema = z.object({ changed: z.boolean(), summary: z.string() });

/** Parses the AI's JSON answer, tolerating a ```json fence or prose around it. */
export function parseSummaryReply(text: string): { changed: boolean; summary: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The AI answer had no JSON.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("The AI answer was not valid JSON.");
  }
  const reply = replySchema.safeParse(parsed);
  if (!reply.success) throw new Error("The AI answer did not match {changed, summary}.");
  const summary = reply.data.summary.trim().slice(0, MAX_SUMMARY);
  return { changed: reply.data.changed && summary !== "", summary };
}

// ---- Tool Gateway (MCP over HTTP) --------------------------------------------

export class SlackAuthError extends Error {}
export class SlackRateLimited extends Error {}

const rpcReply = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
    isError: z.boolean().optional(),
  }).passthrough().optional(),
  error: z.object({ message: z.string() }).passthrough().optional(),
}).passthrough();

/** Reads a JSON-RPC answer sent either as JSON or as one server-sent `data:` event. */
export function parseRpcBody(body: string, contentType: string): z.infer<typeof rpcReply> {
  let json = body;
  if (contentType.includes("text/event-stream")) {
    const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    json = data.reverse().find((line) => line.startsWith("{")) ?? "";
  }
  try {
    return rpcReply.parse(JSON.parse(json));
  } catch {
    throw new Error("Slack (Tool Gateway) returned an unreadable answer.");
  }
}

/** Calls one MCP tool and returns its text. Rate limits and auth failures get their own errors. */
export async function mcpTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch {
    if (signal.aborted) throw new Error("cancelled");
    throw new Error("Slack (Tool Gateway) could not be reached.");
  }
  if (response.status === 401 || response.status === 403) throw new SlackAuthError(`Slack (Tool Gateway) refused the token (HTTP ${response.status}).`);
  const reply = parseRpcBody(await response.text(), response.headers.get("content-type") ?? "");
  const texts = (reply.result?.content ?? []).map((part) => part.text ?? "").filter(Boolean);
  if (response.status === 429 || texts[0] === "ratelimited") throw new SlackRateLimited("Slack rate limit hit; Radar will retry next sweep.");
  if (reply.error) throw new Error(`Slack (Tool Gateway): ${reply.error.message.slice(0, 200)}`);
  if (!response.ok) throw new Error(`Slack (Tool Gateway) returned HTTP ${response.status}.`);
  if (reply.result?.isError) throw new Error(`Slack: ${(texts.join(" ") || "tool error").slice(0, 200)}`);
  return texts[0] ?? "";
}

/** The `results` / `messages` string some Slack tools wrap their markdown in. */
export function unwrapText(text: string, field: "results" | "messages"): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" ? value : text;
  } catch {
    return text;
  }
}
