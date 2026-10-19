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
  deltaMeArgs,
  deltaPrArgs,
  deltaPrincipal,
  gitDeleteRefArgs,
  gitFetchArgs,
  gitPushArgs,
  gitReplayArgs,
  originMatches,
  parseRebaseTarget,
  REBASE_SOURCES,
  replayedHead,
  safeBranch,
  verifyDeltaPr,
  verifyGithubPr,
} from "../rebase";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const viewer = { github: "medev", delta: "me.dev@example.com" };
const item = (over: Partial<Item>): Item => ({
  key: "k", source: "github", kind: "pr", repo: "o/r", number: 1, title: "T", url: "",
  author: "medev", draft: false, state: "open", labels: [], createdAt: "", updatedAt: "", ...over,
});

describe("canRebase (row gating)", () => {
  it("offers Rebase on your own open GitHub and Delta PRs, case-insensitively", () => {
    expect(canRebase(item({}), viewer)).toBe(true);
    expect(canRebase(item({ author: "MeDev" }), viewer)).toBe(true);
    // Delta rows carry the email's local part; the viewer is the full principal.
    expect(canRebase(item({ source: "delta", author: "Me.Dev" }), viewer)).toBe(true);
    expect(canRebase(item({ draft: true, state: "open" }), viewer)).toBe(true);
    expect(canRebase(item({ source: "delta", author: "me.dev", state: "draft" }), viewer)).toBe(true);
  });
  it("hides it on other people's PRs, issues, closed or merged PRs", () => {
    expect(canRebase(item({ author: "alice" }), viewer)).toBe(false);
    expect(canRebase(item({ kind: "issue" }), viewer)).toBe(false);
    expect(canRebase(item({ state: "closed" }), viewer)).toBe(false);
    expect(canRebase(item({ state: "merged" }), viewer)).toBe(false);
    // The GitHub login must not match a Delta author, and vice versa.
    expect(canRebase(item({ source: "delta", author: "medev" }), viewer)).toBe(false);
    expect(canRebase(item({ author: "me.dev@example.com" }), viewer)).toBe(false);
  });
  it("never offers it on read-only Gitstream history, or while identity is unknown / no checkout is set", () => {
    expect(REBASE_SOURCES.has("gitstream")).toBe(false);
    expect(canRebase(item({ source: "gitstream", author: "me.dev@example.com" }), viewer)).toBe(false);
    expect(canRebase(item({ source: "delta", author: "me.dev" }), { ...viewer, delta: "" })).toBe(false);
    expect(canRebase(item({ author: "" }), { github: "", delta: "" })).toBe(false);
    expect(canRebase(item({}), { github: "", delta: "" })).toBe(false);
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
  it("reads Delta identity and PRs with an explicit host and repo", () => {
    expect(deltaMeArgs("delta.example.com", "acme/monorepo")).toEqual(["--host", "delta.example.com", "-R", "acme/monorepo", "api", "/api/v1/me"]);
    expect(deltaPrArgs("delta.example.com", "acme/monorepo", 2261664)).toEqual(["--host", "delta.example.com", "-R", "acme/monorepo", "api", "repos/acme/monorepo/pulls/2261664"]);
  });
  it("rebases on Delta with plain git in private refs and a leased push", () => {
    expect(gitFetchArgs(7, "main", "frost/x")).toEqual([
      "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", "origin",
      "+refs/heads/main:refs/radar/rebase/7/base", "+refs/heads/frost/x:refs/radar/rebase/7/head",
    ]);
    expect(gitReplayArgs(7, BASE, SHA)).toEqual(["replay", "--ref-action=print", `--onto=${BASE}`, "--ref=refs/radar/rebase/7/head", `${BASE}..${SHA}`]);
    const next = "c".repeat(40);
    expect(gitPushArgs("frost/x", next, SHA)).toEqual([
      "push", "--porcelain", "--no-follow-tags", `--force-with-lease=refs/heads/frost/x:${SHA}`, "origin", `${next}:refs/heads/frost/x`,
    ]);
    expect(gitDeleteRefArgs("refs/radar/rebase/7/head")).toEqual(["update-ref", "-d", "refs/radar/rebase/7/head"]);
    expect(() => gitDeleteRefArgs("refs/heads/main")).toThrow();
  });
  it("reads the replayed head only for Radar's ref and the expected old head", () => {
    const next = "c".repeat(40);
    expect(replayedHead(`update refs/radar/rebase/7/head ${next} ${SHA}\n`, 7, SHA)).toBe(next);
    expect(replayedHead(`update refs/heads/main ${next} ${SHA}`, 7, SHA)).toBeNull();
    expect(replayedHead(`update refs/radar/rebase/7/head ${next} ${BASE}`, 7, SHA)).toBeNull();
    expect(replayedHead("", 7, SHA)).toBeNull();
  });
  it("accepts only branch names that cannot become options or refspec syntax", () => {
    for (const name of ["main", "frost/finance-web-date-range-picker", "issue-1030_x.y"]) expect(safeBranch(name), name).toBe(true);
    for (const name of ["", "-f", "--upload-pack=x", "a..b", "a:b", "+main", "a b", "a/", "/a", "a.lock", ".a", "a//b", "a/.b", "a^", "a~1", "a@{1}", "x\ny"]) {
      expect(safeBranch(name), name).toBe(false);
    }
    expect(() => gitFetchArgs(1, "main", "a:b")).toThrow();
    expect(() => gitPushArgs("-f", SHA, SHA)).toThrow();
  });
  it("matches the checkout's origin to the Delta host and repo", () => {
    expect(originMatches("https://delta.example.com/acme/monorepo.git\n", "delta.example.com", "acme/monorepo")).toBe(true);
    expect(originMatches("git@delta.example.com:acme/monorepo.git", "delta.example.com", "acme/monorepo")).toBe(true);
    expect(originMatches("https://gitstream.example.com/acme/monorepo.git", "delta.example.com", "acme/monorepo")).toBe(false);
    expect(originMatches("https://delta.example.com.evil.dev/acme/monorepo.git", "delta.example.com", "acme/monorepo")).toBe(false);
    expect(originMatches("https://delta.example.com/acme/other.git", "delta.example.com", "acme/monorepo")).toBe(false);
  });
  it("rejects untrusted repo, number, SHA and node id shapes", () => {
    for (const repo of ["o/r/x", "../etc", "o/..", "o r/x", "-X/POST", "o/r?x=1", "", "o/-r"]) {
      expect(() => deltaPrArgs("d.example.com", repo, 1), repo).toThrow();
    }
    expect(() => deltaPrArgs("d.example.com", "o/r", 0)).toThrow();
    expect(() => deltaPrArgs("d.example.com", "o/r", 1.5)).toThrow();
    expect(() => gitReplayArgs(1, "main", SHA)).toThrow();
    expect(() => gitPushArgs("x", "abc", SHA)).toThrow();
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
  const dtPr = (over: Record<string, unknown>) => ({
    state: "open", merged: false, user: { login: "Me.Dev@example.com" },
    head: { sha: SHA, ref: "frost/x", repo: { full_name: "acme/monorepo" } }, base: { sha: BASE, ref: "main" }, ...over,
  });
  const me = "me.dev@example.com";
  it("reads the Delta principal from /api/v1/me", () => {
    expect(deltaPrincipal({ principal: "me.dev@example.com", anonymous: false })).toBe("me.dev@example.com");
    expect(deltaPrincipal({ principal: "me.dev@example.com", anonymous: true })).toBe("");
    expect(deltaPrincipal({ principal: "not an email" })).toBe("");
    expect(deltaPrincipal(null)).toBe("");
  });
  it("checks Delta authorship, state, repo, refs and SHAs", () => {
    expect(verifyDeltaPr(dtPr({}), me, "acme/monorepo")).toEqual({ ok: true, value: { headSha: SHA, baseSha: BASE, headRef: "frost/x", baseRef: "main" } });
    expect(verifyDeltaPr(dtPr({ user: { login: "other@example.com" } }), me, "acme/monorepo").ok).toBe(false);
    expect(verifyDeltaPr(dtPr({}), "", "acme/monorepo").ok).toBe(false);
    expect(verifyDeltaPr(dtPr({ state: "closed" }), me, "acme/monorepo").ok).toBe(false);
    expect(verifyDeltaPr(dtPr({ merged: true }), me, "acme/monorepo").ok).toBe(false);
    expect(verifyDeltaPr(dtPr({ head: { sha: "zz", ref: "frost/x" } }), me, "acme/monorepo").ok).toBe(false);
    expect(verifyDeltaPr(dtPr({ head: { sha: SHA, ref: "frost/x", repo: { full_name: "fork/monorepo" } } }), me, "acme/monorepo").ok).toBe(false);
    expect(verifyDeltaPr(dtPr({ head: { sha: SHA, ref: "--upload-pack=x" } }), me, "acme/monorepo").ok).toBe(false);
    expect(verifyDeltaPr(dtPr({ base: { sha: BASE, ref: "a..b" } }), me, "acme/monorepo").ok).toBe(false);
  });
});

describe("classifyRebaseFailure", () => {
  it("treats up-to-date answers as success", () => {
    expect(classifyRebaseFailure("github", "There are no new commits on the base branch.")).toEqual({ upToDate: true });
  });
  it("words conflicts, head races, policy and permission failures", () => {
    const message = (source: "github" | "delta", text: string) => {
      const out = classifyRebaseFailure(source, text);
      return out.upToDate ? "up-to-date" : out.message;
    };
    expect(message("github", "gh: merge conflict between base and head")).toMatch(/conflicts/);
    expect(message("delta", "CONFLICT (content): Merge conflict in a.ts")).toMatch(/conflicts/);
    expect(message("delta", "! [rejected] frost/x (stale info)")).toMatch(/changed/);
    expect(message("delta", "! [rejected] frost/x (fetch first)")).toMatch(/changed/);
    expect(message("github", "Expected head oid did not match")).toMatch(/changed/);
    expect(message("delta", "remote: push declined by policy")).toMatch(/policy/);
    expect(message("delta", "fatal: something odd")).toBe("Delta: something odd");
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
