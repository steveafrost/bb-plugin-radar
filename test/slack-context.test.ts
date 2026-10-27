import { describe, expect, it } from "vitest";
import {
  compareTs,
  itemPath,
  focusThread,
  itemPaths,
  linksItem,
  mcpTool,
  parseRpcBody,
  parseSearchResults,
  parseSummaryReply,
  parseThreadJson,
  renderComment,
  searchArguments,
  SLACK_HEADING,
  SlackAuthError,
  SlackRateLimited,
  summaryPrompt,
  unwrapText,
} from "../slack-context";

const SEARCH = `# Search Results for: github.com/acme/issues/12

## Messages (4 results)
### Result 1 of 4
Channel: #team-dev (ID: C03BRE3CMPS)
From: Ada Lovelace <ada@example.com> (ID: U06TVC90LSV) 
Time: 2026-08-19 13:34:00 EDT
Message_ts: 1787160840.378779
Reply count: 1
Permalink: [link](https:\\/\\/acme.slack.com\\/archives\\/C03BRE3CMPS\\/p1787160840378779?thread_ts=1787160840.378779&cid=C03BRE3CMPS)
Text: 
I did a <https:\\/\\/github.com\\/acme\\/issues\\/issues\\/12|brief spike>.

---

### Result 2 of 4
Channel: #help (ID: C05N7SN9G1K)
From: Ada Lovelace <ada@example.com> (ID: U06TVC90LSV) 
Time: 2026-08-17 12:13:39 EDT
Message_ts: 1786983219.033609
Permalink: [link](https://acme.slack.com/archives/C05N7SN9G1K/p1786983219033609?thread_ts=1786983165.499339&cid=C05N7SN9G1K)
Text: 
A reply in a thread: <https://github.com/acme/issues/issues/12>

---

### Result 3 of 4
Channel: #experts-issues (ID: C0EXPERTS1)
From: GitHub
Time: 2026-08-18 11:41:49 EDT
Message_ts: 1787000000.000100
Permalink: [link](https://acme.slack.com/archives/C0EXPERTS1/p1787000000000100)
Text: 
Comment on <https://github.com/acme/issues/issues/12|#12>

---

### Result 4 of 4
Channel: #team-dev (ID: C03BRE3CMPS)
From: Grace Hopper <grace@example.com> (ID: U0GRACE)
Time: 2026-08-18 11:41:49 EDT
Message_ts: 1787000001.000200
Permalink: [link](https://acme.slack.com/archives/C03BRE3CMPS/p1787000001000200)
Text: 
See https://github.com/acme/issues/issues/123 instead

---
`;

const ISSUE = "github.com/acme/issues/issues/12";

describe("itemPath", () => {
  it("takes host and path from issue and PR URLs on any host", () => {
    expect(itemPath("https://github.com/acme/issues/issues/12")).toBe(ISSUE);
    expect(itemPath("https://github.com/acme/app/pull/7/")).toBe("github.com/acme/app/pull/7");
    expect(itemPath("https://Delta.Shopify.io/shop/world/pull/2318320")).toBe("delta.shopify.io/shop/world/pull/2318320");
  });
  it("refuses anything else", () => {
    expect(itemPath("http://github.com/acme/app/pull/7")).toBe("");
    expect(itemPath("https://github.com/acme/app/pull/7/files")).toBe("");
    expect(itemPath("https://github.com/acme/app")).toBe("");
    expect(itemPath("not a url")).toBe("");
  });
});

describe("searchArguments", () => {
  it("searches the exact path in public channels, people only", () => {
    expect(searchArguments(ISSUE, null)).toMatchObject({
      keywords: ['"github.com/acme/issues/issues/12"'],
      include_bots: false,
      response_format: "detailed",
    });
    expect(searchArguments(ISSUE, null)).not.toHaveProperty("after");
    expect(searchArguments(ISSUE, 1700000000.9)).toMatchObject({ after: "1700000000" });
  });
});

describe("linksItem", () => {
  it("matches the exact item, not a longer number, another repo or another host", () => {
    expect(linksItem("<https://github.com/acme/issues/issues/12|x>", ISSUE)).toBe(true);
    expect(linksItem("https://github.com/acme/issues/issues/12#issuecomment-1", ISSUE)).toBe(true);
    expect(linksItem("https://github.com/acme/issues/issues/123", ISSUE)).toBe(false);
    expect(linksItem("https://github.com/acme/issuesX/issues/12", ISSUE)).toBe(false);
    expect(linksItem("https://notgithub.com/acme/issues/issues/12", ISSUE)).toBe(false);
    expect(linksItem("https:\\/\\/github.com\\/acme\\/issues\\/issues\\/12", ISSUE)).toBe(true);
  });
  it("tells a PR from an issue with the same number", () => {
    const pr = "delta.shopify.io/shop/world/pull/9";
    expect(linksItem("<https://delta.shopify.io/shop/world/pull/9/files|diff>", pr)).toBe(true);
    expect(linksItem("https://github.com/shop/world/pull/9", pr)).toBe(false);
    expect(linksItem("https://delta.shopify.io/shop/world/issues/9", pr)).toBe(false);
  });
});

describe("parseSearchResults", () => {
  const hits = parseSearchResults(SEARCH, ISSUE);
  it("keeps people's messages that link this issue, one per thread", () => {
    expect(hits).toEqual([
      {
        channelId: "C03BRE3CMPS",
        channelName: "team-dev",
        threadTs: "1787160840.378779",
        permalink: "https://acme.slack.com/archives/C03BRE3CMPS/p1787160840378779",
      },
      {
        channelId: "C05N7SN9G1K",
        channelName: "help",
        threadTs: "1786983165.499339",
        permalink: "https://acme.slack.com/archives/C05N7SN9G1K/p1786983165499339",
      },
    ]);
  });
  it("drops integration posts and look-alike issue numbers", () => {
    expect(hits.some((hit) => hit.channelId === "C0EXPERTS1")).toBe(false);
    expect(hits.some((hit) => hit.threadTs === "1787000001.000200")).toBe(false);
  });
  it("returns nothing for an empty or unrelated answer", () => {
    expect(parseSearchResults("No results found.", ISSUE)).toEqual([]);
  });
});

describe("parseThreadJson", () => {
  it("returns the newest human message; bots and joins don't count", () => {
    const text = JSON.stringify({
      ok: true,
      messages: [
        { ts: "1787160840.378779", user: "U1", user_name: "Ada", text: "parent <https://x.dev/a|the doc> for <@U9> in <#C1|eng> &amp; co", reply_count: "4" },
        { ts: "1787177368.806139", user: "U2", text: "reply" },
        { ts: "1787999999.000000", bot_id: "B1", text: "GitHub bot echo" },
        { ts: "1787999998.000000", subtype: "channel_join", text: "joined" },
        { ts: "1787177369.000001", subtype: "thread_broadcast", user: "U3", text: "also sent to channel" },
      ],
    });
    expect(parseThreadJson(text)).toEqual({ latestTs: "1787177369.000001", count: 3, author: "Ada", opening: "parent the doc for @someone in #eng & co", replies: 4 });
  });
  it("throws on Slack errors and junk", () => {
    expect(() => parseThreadJson(JSON.stringify({ ok: false, error: "thread_not_found" }))).toThrow("thread_not_found");
    expect(() => parseThreadJson("not json")).toThrow();
  });
});

describe("compareTs", () => {
  it("compares numerically, empty first", () => {
    expect(compareTs("1787177368.806139", "1787177368.8")).toBe(1);
    expect(compareTs("", "1.0")).toBe(-1);
    expect(compareTs("", "")).toBe(0);
    expect(compareTs("10.000001", "9.999999")).toBe(1);
  });
});

describe("renderComment", () => {
  it("puts the text under the heading and links the threads", () => {
    const body = renderComment("- Decided to ship behind a flag\n- Owner: Ada", [
      { channelName: "team-dev", permalink: "https://acme.slack.com/archives/C1/p1" },
      { channelName: "help", permalink: "" },
    ], "2026-10-27");
    expect(body.startsWith(`${SLACK_HEADING}\n\n- Decided to ship behind a flag\n- Owner: Ada\n`)).toBe(true);
    expect(body).toContain("[#team-dev](https://acme.slack.com/archives/C1/p1)");
    expect(body).not.toContain("#help");
    expect(body).toContain("as of 2026-10-27.");
  });
});

describe("summaryPrompt", () => {
  it("includes the current summary and caps thread text", () => {
    const prompt = summaryPrompt({ kind: "issue", repo: "acme/issues", number: 12, title: "Thing" }, "", { channelName: "help", text: "x".repeat(50_000) });
    expect(prompt).toContain("acme/issues#12 — Thing");
    expect(prompt).toContain("(none yet)");
    expect(prompt).toContain("Slack thread in #help:");
    expect(prompt.length).toBeLessThan(13_000);
  });
  it("names a pull request as one", () => {
    expect(summaryPrompt({ kind: "pr", repo: "shop/world", number: 9, title: "Fix" }, "- old", { channelName: "x", text: "y" })).toContain("Pull request: shop/world#9 — Fix\n\nCurrent summary:\n- old");
  });
});

describe("parseSummaryReply", () => {
  it("reads fenced or bare JSON", () => {
    expect(parseSummaryReply('```json\n{"changed": true, "summary": "- a"}\n```')).toEqual({ changed: true, summary: "- a" });
    expect(parseSummaryReply('Sure: {"changed": false, "summary": "- a"}')).toEqual({ changed: false, summary: "- a" });
  });
  it("treats an empty summary as no change", () => {
    expect(parseSummaryReply('{"changed": true, "summary": "  "}')).toEqual({ changed: false, summary: "" });
  });
  it("rejects malformed answers", () => {
    expect(() => parseSummaryReply("nope")).toThrow();
    expect(() => parseSummaryReply('{"summary": 3}')).toThrow();
  });
});

describe("Tool Gateway transport", () => {
  const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
  const signal = new AbortController().signal;

  it("parses an SSE answer", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n';
    expect(parseRpcBody(body, "text/event-stream").result?.content?.[0]?.text).toBe("hi");
  });

  it("sends a tools/call with the bearer token", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return ok({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"results":"# md"}' }] } });
    }) as unknown as typeof fetch;
    const text = await mcpTool("https://gw.example.com/mcp", "tok", "slack_search_public", { query: "x" }, signal, fetchImpl);
    expect(unwrapText(text, "results")).toBe("# md");
    expect(seen!.url).toBe("https://gw.example.com/mcp");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ method: "tools/call", params: { name: "slack_search_public", arguments: { query: "x" } } });
  });

  it("classifies auth failures, rate limits and tool errors", async () => {
    const respond = (response: Response) => (async () => response) as unknown as typeof fetch;
    await expect(mcpTool("https://g/mcp", "t", "x", {}, signal, respond(new Response("", { status: 401 })))).rejects.toBeInstanceOf(SlackAuthError);
    await expect(
      mcpTool("https://g/mcp", "t", "x", {}, signal, respond(ok({ result: { content: [{ type: "text", text: "ratelimited" }, { type: "text", text: "wait" }] } }, { status: 429 }))),
    ).rejects.toBeInstanceOf(SlackRateLimited);
    await expect(mcpTool("https://g/mcp", "t", "x", {}, signal, respond(new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain" } })))).rejects.toBeInstanceOf(SlackRateLimited);
    await expect(mcpTool("https://g/mcp", "t", "x", {}, signal, respond(new Response("", { status: 429 })))).rejects.toBeInstanceOf(SlackRateLimited);
    await expect(
      mcpTool("https://g/mcp", "t", "x", {}, signal, respond(ok({ result: { content: [{ type: "text", text: "ratelimited" }] } }))),
    ).rejects.toBeInstanceOf(SlackRateLimited);
    await expect(
      mcpTool("https://g/mcp", "t", "x", {}, signal, respond(ok({ result: { isError: true, content: [{ type: "text", text: "channel_not_found" }] } }))),
    ).rejects.toThrow("channel_not_found");
  });
});

describe("itemPaths", () => {
  const meteorite = { gitstreamWebUrl: "https://meteorite.example.dev", gitstreamRepo: "acme/mono" };
  it("adds a Delta PR's Meteorite and GitHub URLs", () => {
    expect(itemPaths("https://delta.example.dev/acme/mono/pull/42", meteorite)).toEqual([
      "delta.example.dev/acme/mono/pull/42",
      "github.com/acme/mono/pull/42",
      "meteorite.example.dev/repos/acme/mono/pulls/42",
    ]);
  });
  it("skips Meteorite when it serves another repo or is not set", () => {
    expect(itemPaths("https://delta.example.dev/acme/other/pull/7", meteorite)).toEqual(["delta.example.dev/acme/other/pull/7", "github.com/acme/other/pull/7"]);
    expect(itemPaths("https://delta.example.dev/acme/mono/pull/7", { gitstreamWebUrl: "", gitstreamRepo: "" })).toHaveLength(2);
  });
  it("keeps GitHub items to their own URL", () => {
    expect(itemPaths("https://github.com/acme/issues/issues/3", null)).toEqual(["github.com/acme/issues/issues/3"]);
    expect(itemPaths("not a url", null)).toEqual([]);
  });
  it("matches a Meteorite link with a trailing view, not a longer number", () => {
    const path = "meteorite.example.dev/repos/acme/mono/pulls/42";
    expect(linksItem("see <https://meteorite.example.dev/repos/acme/mono/pulls/42/timeline|#42>", path)).toBe(true);
    expect(linksItem("https://meteorite.example.dev/repos/acme/mono/pulls/421", path)).toBe(false);
  });
});

describe("parseSummaryReply line breaks", () => {
  it("accepts raw newlines inside the summary string", () => {
    expect(parseSummaryReply('{"changed": true, "summary": "- one\n- two"}')).toEqual({ changed: true, summary: "- one\n- two" });
  });
});

describe("focusThread", () => {
  const message = (name: string, body: string) => `> ${name} <${name.toLowerCase()}@x.dev>: ${body}\n`;
  it("keeps the opening and the reply that links the item when a thread is too long", () => {
    const text = message("Bot", "standup") + message("Ann", "a".repeat(300)) + message("Bo", "b".repeat(300)) + message("Cy", "QA'd <https://m.dev/repos/o/r/pulls/7|#7>");
    const out = focusThread(text, ["m.dev/repos/o/r/pulls/7"], 200);
    expect(out).toContain("standup");
    expect(out).toContain("[…]");
    expect(out).toContain("QA'd");
    expect(out).not.toContain("aaaa");
  });
  it("returns short threads unchanged", () => {
    expect(focusThread("short", [], 100)).toBe("short");
  });
});
