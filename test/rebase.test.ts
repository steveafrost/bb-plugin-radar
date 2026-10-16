import { describe, expect, it } from "vitest";
import type { Item } from "../lanes";
import {
  canRebase,
  classifyRebaseFailure,
  GITHUB_PR_QUERY,
  GITHUB_REBASE_MUTATION,
  githubCompareArgs,
  githubPrArgs,
  githubRebaseArgs,
  gitstreamPrArgs,
  gitstreamRebaseArgs,
  gitstreamRebaseResult,
  parseRebaseTarget,
  verifyGithubPr,
  verifyGitstreamPr,
} from "../rebase";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const viewer = { github: "medev", gitstream: "me.dev@example.com" };
const item = (over: Partial<Item>): Item => ({
  key: "k", source: "github", kind: "pr", repo: "o/r", number: 1, title: "T", url: "",
  author: "medev", draft: false, state: "open", labels: [], createdAt: "", updatedAt: "", ...over,
});

describe("canRebase (row gating)", () => {
  it("offers Rebase on your own open GitHub and Gitstream PRs, case-insensitively", () => {
    expect(canRebase(item({}), viewer)).toBe(true);
    expect(canRebase(item({ author: "MeDev" }), viewer)).toBe(true);
    expect(canRebase(item({ source: "gitstream", author: "me.dev@example.com" }), viewer)).toBe(true);
    expect(canRebase(item({ draft: true, state: "open" }), viewer)).toBe(true);
    expect(canRebase(item({ source: "gitstream", author: "me.dev@example.com", state: "draft" }), viewer)).toBe(true);
  });
  it("hides it on other people's PRs, issues, closed or merged PRs", () => {
    expect(canRebase(item({ author: "alice" }), viewer)).toBe(false);
    expect(canRebase(item({ kind: "issue" }), viewer)).toBe(false);
    expect(canRebase(item({ state: "closed" }), viewer)).toBe(false);
    expect(canRebase(item({ state: "merged" }), viewer)).toBe(false);
    // The GitHub login must not match a Gitstream author, and vice versa.
    expect(canRebase(item({ source: "gitstream", author: "medev" }), viewer)).toBe(false);
    expect(canRebase(item({ author: "me.dev@example.com" }), viewer)).toBe(false);
  });
  it("hides it on Delta (no server-side rebase) and while identity is unknown", () => {
    expect(canRebase(item({ source: "delta", author: "me.dev" }), { ...viewer, github: "me.dev" })).toBe(false);
    expect(canRebase(item({ author: "" }), { github: "", gitstream: "" })).toBe(false);
    expect(canRebase(item({}), { github: "", gitstream: "" })).toBe(false);
  });
});

describe("argv construction", () => {
  it("reads a GitHub PR with typed GraphQL variables, never interpolating into the query", () => {
    expect(githubPrArgs("o/r", 7)).toEqual(["api", "graphql", "-f", `query=${GITHUB_PR_QUERY}`, "-f", "owner=o", "-f", "name=r", "-F", "number=7"]);
    expect(GITHUB_PR_QUERY).toContain("viewerDidAuthor");
  });
  it("rebases on GitHub with REBASE and a head lease", () => {
    expect(githubRebaseArgs("PR_kwDOabc", SHA)).toEqual(["api", "graphql", "-f", `query=${GITHUB_REBASE_MUTATION}`, "-f", "id=PR_kwDOabc", "-f", `head=${SHA}`]);
    expect(GITHUB_REBASE_MUTATION).toMatch(/updateMethod: REBASE/);
    expect(GITHUB_REBASE_MUTATION).toMatch(/expectedHeadOid: \$head/);
  });
  it("compares by commit SHA only", () => {
    expect(githubCompareArgs("o/r", BASE, SHA)).toEqual(["api", `repos/o/r/compare/${BASE}...${SHA}`, "--jq", ".behind_by"]);
    expect(() => githubCompareArgs("o/r", "main", SHA)).toThrow();
  });
  it("uses Gitstream's native rebase endpoint with expected_head_sha", () => {
    expect(gitstreamPrArgs("acme/monorepo", 2151771)).toEqual(["api", "repos/acme/monorepo/pulls/2151771"]);
    expect(gitstreamRebaseArgs("acme/monorepo", 2151771, SHA)).toEqual([
      "api", "-X", "POST", "repos/acme/monorepo/pulls/2151771/rebase", "-f", `expected_head_sha=${SHA}`,
    ]);
  });
  it("rejects untrusted repo, number, SHA and node id shapes", () => {
    for (const repo of ["o/r/x", "../etc", "o/..", "o r/x", "-X/POST", "o/r?x=1", "", "o/-r"]) {
      expect(() => gitstreamPrArgs(repo, 1), repo).toThrow();
    }
    expect(() => gitstreamPrArgs("o/r", 0)).toThrow();
    expect(() => gitstreamPrArgs("o/r", 1.5)).toThrow();
    expect(() => gitstreamRebaseArgs("o/r", 1, "abc")).toThrow();
    expect(() => githubRebaseArgs("id with space", SHA)).toThrow();
    expect(() => githubRebaseArgs("x\nquery=", SHA)).toThrow();
  });
});

describe("server-side re-verification", () => {
  const ghPr = (over: Record<string, unknown>) => ({
    data: { repository: { pullRequest: { id: "PR_1", state: "OPEN", merged: false, viewerDidAuthor: true, headRefOid: SHA, baseRef: { target: { oid: BASE } }, ...over } } },
  });
  it("trusts GitHub's viewerDidAuthor, not the author login", () => {
    expect(verifyGithubPr(ghPr({}))).toEqual({ ok: true, value: { id: "PR_1", headOid: SHA, baseOid: BASE } });
    expect(verifyGithubPr(ghPr({ viewerDidAuthor: false, author: { login: "medev" } })).ok).toBe(false);
    expect(verifyGithubPr(ghPr({ state: "CLOSED" })).ok).toBe(false);
    expect(verifyGithubPr(ghPr({ state: "MERGED", merged: true })).ok).toBe(false);
    expect(verifyGithubPr(ghPr({ baseRef: null })).ok).toBe(false);
    expect(verifyGithubPr({ data: { repository: { pullRequest: null } } }).ok).toBe(false);
  });
  const gsPr = (over: Record<string, unknown>) => ({ state: "open", merged: false, user: { login: "Me.Dev@example.com" }, head: { sha: SHA }, ...over });
  it("checks Gitstream authorship against the resolved principal", () => {
    expect(verifyGitstreamPr(gsPr({}), "me.dev@example.com")).toEqual({ ok: true, value: { headSha: SHA } });
    expect(verifyGitstreamPr(gsPr({ user: { login: "other@example.com" } }), "me.dev@example.com").ok).toBe(false);
    expect(verifyGitstreamPr(gsPr({}), "").ok).toBe(false);
    expect(verifyGitstreamPr(gsPr({ state: "closed" }), "me.dev@example.com").ok).toBe(false);
    expect(verifyGitstreamPr(gsPr({ merged: true }), "me.dev@example.com").ok).toBe(false);
    expect(verifyGitstreamPr(gsPr({ head: { sha: "zz" } }), "me.dev@example.com").ok).toBe(false);
  });
  it("reads Gitstream's rebased flag", () => {
    expect(gitstreamRebaseResult({ rebased: true, head_sha: BASE }, SHA)).toMatchObject({ status: "rebased", headSha: BASE });
    expect(gitstreamRebaseResult({ rebased: false, head_sha: SHA }, SHA)).toMatchObject({ status: "up-to-date" });
  });
});

describe("classifyRebaseFailure", () => {
  it("treats up-to-date answers as success", () => {
    expect(classifyRebaseFailure("github", "There are no new commits on the base branch.")).toEqual({ upToDate: true });
  });
  it("words conflicts, head races, policy and permission failures", () => {
    const message = (source: "github" | "gitstream", text: string) => {
      const out = classifyRebaseFailure(source, text);
      return out.upToDate ? "up-to-date" : out.message;
    };
    expect(message("github", "gh: merge conflict between base and head")).toMatch(/conflicts/);
    expect(message("gitstream", "HTTP 422: commit abc does not apply cleanly; not clean")).toMatch(/conflicts/);
    expect(message("gitstream", "HTTP 422: unprocessable")).toMatch(/not clean/);
    expect(message("gitstream", "HTTP 409: head moved")).toMatch(/changed/);
    expect(message("github", "Expected head oid did not match")).toMatch(/changed/);
    expect(message("gitstream", "HTTP 405: history policy declined")).toMatch(/policy/);
    expect(message("github", "Resource not accessible by integration")).toMatch(/permission/);
    expect(message("github", "Rebasing is not allowed for this repository")).toMatch(/doesn't allow/);
    expect(message("github", "gh: something odd\nmore")).toBe("GitHub: something odd");
  });
  it("strips control characters from echoed output", () => {
    const out = classifyRebaseFailure("github", "gh: \u001b[31mweird\u0007");
    expect(out.upToDate ? "" : out.message).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe("parseRebaseTarget", () => {
  it("parses host URLs and owner/repo#n", () => {
    expect(parseRebaseTarget("acme-org/.github#3")).toEqual({ source: null, repo: "acme-org/.github", number: 3 });
    expect(parseRebaseTarget("https://github.com/o/r/pull/7")).toEqual({ source: "github", repo: "o/r", number: 7 });
    expect(parseRebaseTarget("https://github.com/o/r/pull/7/files")).toEqual({ source: "github", repo: "o/r", number: 7 });
    expect(parseRebaseTarget("https://gitstream.example.com/repos/acme/monorepo/pulls/2151771")).toEqual({ source: "gitstream", repo: "acme/monorepo", number: 2151771 });
    expect(parseRebaseTarget("https://delta.example.com/acme/monorepo/pull/9")).toEqual({ source: "delta", repo: "acme/monorepo", number: 9 });
    expect(parseRebaseTarget("o/r#12")).toEqual({ source: null, repo: "o/r", number: 12 });
  });
  it("rejects anything else", () => {
    for (const input of ["", "o/r", "#5", "https://evil.example/o/r/pull/1", "o/../r#1", "o/r#0", "http://github.com/o/r/pull/1"]) {
      expect(parseRebaseTarget(input), input).toBeNull();
    }
  });
});
