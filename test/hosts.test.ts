import { afterEach, describe, expect, it } from "vitest";
import { hosts, NO_HOSTS, readHosts, setHosts } from "../hosts";
import { DEFAULT_LANES, draftPrompt, enabledSources, fromDelta, fromGitstream, SOURCE_LABEL } from "../lanes";
import { parseRebaseTarget } from "../rebase";
import { itemAreas } from "../scope";
import { TEST_HOSTS } from "./setup";

afterEach(() => setHosts(TEST_HOSTS));

describe("readHosts", () => {
  it("is GitHub-only when nothing is set", () => {
    expect(readHosts({})).toEqual({ hosts: NO_HOSTS, problems: [] });
  });
  it("turns hosts on from settings and keeps custom names", () => {
    const { hosts: next, problems } = readHosts({
      gitstreamRepo: "acme/mono", gitstreamWebUrl: "https://gs.acme.dev/", gitstreamLabel: "Review UI",
      deltaHost: "Delta.Acme.dev", deltaRepo: "acme/mono", areaRepo: "acme/mono",
    });
    expect(problems).toEqual([]);
    expect(next).toEqual({
      gitstream: { repo: "acme/mono", web: "https://gs.acme.dev", label: "Review UI" },
      delta: { host: "delta.acme.dev", repo: "acme/mono", label: "Delta" },
      areaRepo: "acme/mono",
    });
  });
  it("switches a host off, with a reason, when a value is malformed", () => {
    const { hosts: next, problems } = readHosts({
      gitstreamRepo: "acme/mono", gitstreamWebUrl: "http://gs.acme.dev",
      deltaHost: "delta.acme.dev/x", deltaRepo: "acme/mono",
      areaRepo: "../etc",
    });
    expect(next).toEqual(NO_HOSTS);
    expect(problems).toHaveLength(3);
  });
  it("rejects a web URL with a path, query or credentials-looking parts", () => {
    for (const web of ["https://gs.acme.dev/x", "https://gs.acme.dev/?a=1", "javascript:alert(1)"]) {
      expect(readHosts({ gitstreamRepo: "a/b", gitstreamWebUrl: web }).hosts.gitstream).toBeNull();
    }
  });
});

describe("GitHub-only (no hosts configured)", () => {
  it("only offers GitHub, and labels fall back to generic names", () => {
    setHosts(NO_HOSTS);
    expect(enabledSources()).toEqual(["github"]);
    expect(SOURCE_LABEL.gitstream).toBe("Gitstream");
    setHosts({ ...TEST_HOSTS, gitstream: { ...TEST_HOSTS.gitstream, label: "Review UI" } });
    expect(SOURCE_LABEL.gitstream).toBe("Review UI");
  });
  it("drafts with GitHub alone and passes notes through as context", () => {
    setHosts(NO_HOSTS);
    const { system } = draftPrompt("my reviews", { githubLogin: "me", email: "", existing: DEFAULT_LANES, candidateLabels: [], notes: "Billing lives in acme/billing." });
    expect(system).toContain('Available sources: "github".');
    expect(system).not.toMatch(/"gitstream"\?:|delta \(/);
    expect(system).toContain("Billing lives in acme/billing.");
  });
  it("names the configured hosts in the draft prompt", () => {
    const { system } = draftPrompt("x", { githubLogin: "me", email: "a@b.co", existing: [], candidateLabels: [] });
    expect(system).toContain("acme/monorepo");
    expect(system).toContain("delta.example.com");
  });
  it("only parses rebase URLs of configured hosts", () => {
    expect(parseRebaseTarget("https://gitstream.example.com/repos/acme/monorepo/pulls/7")).toEqual({ source: "gitstream", repo: "acme/monorepo", number: 7 });
    expect(parseRebaseTarget("https://delta.example.com/acme/monorepo/pull/8")).toEqual({ source: "delta", repo: "acme/monorepo", number: 8 });
    expect(parseRebaseTarget("https://gitstream.example.com.evil.dev/repos/a/b/pulls/7")).toBeNull();
    setHosts(NO_HOSTS);
    expect(parseRebaseTarget("https://gitstream.example.com/repos/acme/monorepo/pulls/7")).toBeNull();
    expect(parseRebaseTarget("https://github.com/a/b/pull/3")).toEqual({ source: "github", repo: "a/b", number: 3 });
  });
  it("has no areas without an area repo", () => {
    expect(itemAreas({ repo: "acme/monorepo", labels: ["//areas/x/y"] })).toEqual(["//areas/x/y"]);
    setHosts(NO_HOSTS);
    expect(itemAreas({ repo: "acme/monorepo", labels: ["//areas/x/y"] })).toEqual([]);
  });
  it("links items to the configured web URL and strips any email domain", () => {
    expect(fromGitstream({ number: 5, title: "T", url: "https://api.x/repos/acme/monorepo/pulls/5" })?.url).toBe("https://gitstream.example.com/repos/acme/monorepo/pulls/5");
    const delta = fromDelta({ number: 9, title: "T", repository_url: "https://delta.example.com/api/v3/repos/acme/monorepo", user: { login: "a.dev@acme.dev" } });
    expect(delta).toMatchObject({ author: "a.dev", url: "https://delta.example.com/acme/monorepo/pull/9" });
    expect(hosts()).toEqual(TEST_HOSTS);
  });
});
