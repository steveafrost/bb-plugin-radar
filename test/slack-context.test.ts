import { describe, expect, it } from "vitest";
import {
  compareTs,
  extractSummary,
  linksIssue,
  mcpTool,
  parseRpcBody,
  parseSearchResults,
  parseSummaryReply,
  parseThreadJson,
  renderComment,
  searchArguments,
  SLACK_MARKER,
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

describe("searchArguments", () => {
  it("searches the exact issue path in public channels, people only", () => {
    expect(searchArguments("acme/issues", 12, null)).toMatchObject({
      keywords: ['"github.com/acme/issues/issues/12"'],
      include_bots: false,
      response_format: "detailed",
    });
    expect(searchArguments("acme/issues", 12, null)).not.toHaveProperty("after");
    expect(searchArguments("acme/issues", 12, 1700000000.9)).toMatchObject({ after: "1700000000" });
  });
});

describe("linksIssue", () => {
  it("matches the exact issue, not a longer number or another repo", () => {
    expect(linksIssue("<https://github.com/acme/issues/issues/12|x>", "acme/issues", 12)).toBe(true);
    expect(linksIssue("https://github.com/acme/issues/issues/12#issuecomment-1", "acme/issues", 12)).toBe(true);
    expect(linksIssue("https://github.com/acme/issues/issues/123", "acme/issues", 12)).toBe(false);
    expect(linksIssue("https://github.com/acme/issuesX/issues/12", "acme/issues", 12)).toBe(false);
    expect(linksIssue("https:\\/\\/github.com\\/acme\\/issues\\/issues\\/12", "acme/issues", 12)).toBe(true);
  });
});

describe("parseSearchResults", () => {
  const hits = parseSearchResults(SEARCH, "acme/issues", 12);
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
    expect(parseSearchResults("No results found.", "acme/issues", 12)).toEqual([]);
  });
});

describe("parseThreadJson", () => {
  it("returns the newest human message; bots and joins don't count", () => {
    const text = JSON.stringify({
      ok: true,
      messages: [
        { ts: "1787160840.378779", user: "U1", text: "parent" },
        { ts: "1787177368.806139", user: "U2", text: "reply" },
        { ts: "1787999999.000000", bot_id: "B1", text: "GitHub bot echo" },
        { ts: "1787999998.000000", subtype: "channel_join", text: "joined" },
        { ts: "1787177369.000001", subtype: "thread_broadcast", user: "U3", text: "also sent to channel" },
      ],
    });
    expect(parseThreadJson(text)).toEqual({ latestTs: "1787177369.000001", count: 3 });
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

describe("renderComment / extractSummary", () => {
  it("round-trips the approved summary and links the threads", () => {
    const body = renderComment("- Decided to ship behind a flag\n- Owner: Ada", [
      { channelName: "team-dev", permalink: "https://acme.slack.com/archives/C1/p1" },
      { channelName: "help", permalink: "" },
    ], "2026-10-27");
    expect(body.startsWith(SLACK_MARKER)).toBe(true);
    expect(body).toContain("[#team-dev](https://acme.slack.com/archives/C1/p1)");
    expect(body).not.toContain("#help");
    expect(body).toContain("Updated 2026-10-27 with Radar.");
    expect(extractSummary(body)).toBe("- Decided to ship behind a flag\n- Owner: Ada");
  });
  it("ignores comments without the marker", () => {
    expect(extractSummary("### Slack context\nsomeone else's")).toBe("");
  });
});

describe("summaryPrompt", () => {
  it("includes the current summary and caps thread text", () => {
    const prompt = summaryPrompt({ repo: "acme/issues", number: 12, title: "Thing" }, "", [
      { channelName: "team-dev", text: "x".repeat(10_000) },
      { channelName: "help", text: "short" },
    ]);
    expect(prompt).toContain("acme/issues#12 — Thing");
    expect(prompt).toContain("(none yet)");
    expect(prompt).toContain("--- #help ---\nshort");
    expect(prompt.length).toBeLessThan(7_000);
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
    await expect(
      mcpTool("https://g/mcp", "t", "x", {}, signal, respond(ok({ result: { isError: true, content: [{ type: "text", text: "channel_not_found" }] } }))),
    ).rejects.toThrow("channel_not_found");
  });
});
