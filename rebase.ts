/**
 * "Rebase" for PRs you authored. Pure helpers (gating, argv, response checks, error
 * wording) so the server and the panel agree and tests can cover them.
 *
 * Per host:
 * - GitHub: GraphQL `updatePullRequestBranch(updateMethod: REBASE, expectedHeadOid)`, server-side.
 * - Delta: walgit has no server-side rebase (`update-branch` merges the base in), so Radar
 *   uses plain git against `origin` in a checkout set in settings, without touching its
 *   worktree: fetch base and head into private `refs/radar/*` refs, `git replay` the PR's
 *   commits onto the base (clean-only: conflicts and merge commits are refused), then push
 *   with `--force-with-lease` pinned to the head Delta reported. Off until a checkout is set.
 * - Gitstream: none. It is read-only history; its `pulls/{n}/rebase` write no longer works.
 */
import { hosts } from "./hosts";
import { SOURCE_LABEL, remoteRepo, type Item, type Source } from "./lanes";

export const REBASE_SOURCES: ReadonlySet<Source> = new Set<Source>(["github", "delta"]);

/**
 * The signed-in identity per host, as items carry it in `author`. Empty means Rebase is
 * not offered there (Delta stays empty until a rebase checkout is configured).
 */
export type Viewer = { github: string; delta: string };

export type RebaseTarget = { source: Source; repo: string; number: number };
export type RebaseResult = { status: "rebased" | "up-to-date"; message: string; headSha: string };

/** owner/name; owners start alphanumeric, names may start with "." or "_" (e.g. .github), never "-". */
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const OID = /^[0-9a-f]{40}$/i;
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;

const sameIdentity = (a: string, b: string) => a !== "" && a.toLowerCase() === b.toLowerCase();
/** Delta items carry the email's local part (`first.last`); the principal is the full email. */
const localPart = (value: string) => value.replace(/@[^@\s]+$/, "");

/** Whether the row offers Rebase: an open PR, on a host that can rebase, that you wrote. */
export function canRebase(item: Pick<Item, "source" | "kind" | "state" | "author">, viewer: Viewer): boolean {
  if (item.kind !== "pr" || !REBASE_SOURCES.has(item.source)) return false;
  const state = item.state.toLowerCase();
  if (state !== "open" && state !== "draft") return false;
  if (item.source === "github") return sameIdentity(item.author, viewer.github);
  return sameIdentity(localPart(item.author), localPart(viewer.delta));
}

export function rebaseHelp(source: Source): string {
  return source === "delta"
    ? `Rebase this PR onto the latest base with git against ${SOURCE_LABEL.delta} (clean-only; conflicts and merge commits are refused). Force-pushes the branch.`
    : "Rebase this PR onto the latest base on GitHub (server-side). Rewrites the remote branch.";
}

// ---- argv -----------------------------------------------------------------

export const GITHUB_PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id state merged viewerDidAuthor headRefOid
      author { login }
      baseRef { target { oid } }
    }
  }
}`;

export const GITHUB_REBASE_MUTATION = `mutation($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE }) {
    pullRequest { headRefOid }
  }
}`;

function assertRepo(repo: string): [string, string] {
  if (!REPO_PATTERN.test(repo) || repo.includes("..")) throw new Error(`Invalid repository "${repo.slice(0, 80)}".`);
  const [owner, name] = repo.split("/") as [string, string];
  return [owner, name];
}
function assertNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid pull request number.");
  return number;
}
function assertOid(oid: string): string {
  if (!OID.test(oid)) throw new Error("Invalid commit SHA.");
  return oid;
}

export function githubPrArgs(repo: string, number: number): string[] {
  const [owner, name] = assertRepo(repo);
  return ["api", "graphql", "-f", `query=${GITHUB_PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${assertNumber(number)}`];
}
/** `behind_by` = base commits the head lacks; 0 means already up to date. */
export function githubCompareArgs(repo: string, baseOid: string, headOid: string): string[] {
  assertRepo(repo);
  return ["api", `repos/${repo}/compare/${assertOid(baseOid)}...${assertOid(headOid)}`, "--jq", ".behind_by"];
}
export function githubRebaseArgs(prId: string, headOid: string): string[] {
  if (!NODE_ID.test(prId)) throw new Error("Invalid pull request id.");
  return ["api", "graphql", "-f", `query=${GITHUB_REBASE_MUTATION}`, "-f", `id=${prId}`, "-f", `head=${assertOid(headOid)}`];
}
export function deltaMeArgs(host: string, repo: string): string[] {
  assertRepo(repo);
  return ["--host", host, "-R", repo, "api", "/api/v1/me"];
}
export function deltaPrArgs(host: string, repo: string, number: number): string[] {
  assertRepo(repo);
  return ["--host", host, "-R", repo, "api", `repos/${repo}/pulls/${assertNumber(number)}`];
}

/** Branch names Radar will put in a refspec: git-valid, no option or refspec syntax. */
export function safeBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9._\/-]{1,250}$/.test(name) &&
    !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock") &&
    !name.includes("..") && !name.includes("//") && !name.includes("/.") && !name.startsWith(".")
  );
}
function assertBranch(name: string): string {
  if (!safeBranch(name)) throw new Error("Invalid branch name.");
  return name;
}

/** Private refs one Delta rebase works in; deleted afterwards. */
export function radarRefs(number: number): { base: string; head: string } {
  const prefix = `refs/radar/rebase/${assertNumber(number)}`;
  return { base: `${prefix}/base`, head: `${prefix}/head` };
}

/** `git remote get-url origin`, which must be the Delta repo. */
export function gitOriginArgs(): string[] {
  return ["remote", "get-url", "origin"];
}
/**
 * `git remote get-url --push --all origin`: every URL a push to origin goes to, with
 * `pushurl`, `insteadOf` and `pushInsteadOf` expanded. Each must be the Delta repo too.
 */
export function gitPushUrlsArgs(): string[] {
  return ["remote", "get-url", "--push", "--all", "origin"];
}
/** Whether every push URL (one per line, at least one) is the Delta repo. */
export function pushUrlsMatch(stdout: string, host: string, repo: string): boolean {
  const urls = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return urls.length > 0 && urls.every((url) => originMatches(url, host, repo));
}
/** Whether a remote URL is `https://<host>/<repo>(.git)` (or an ssh form of it). */
export function originMatches(url: string, host: string, repo: string): boolean {
  const value = url.trim();
  const remoteHost = value.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i)?.[1] ?? value.match(/^[^@\s]+@([^:]+):/)?.[1] ?? "";
  return remoteHost.toLowerCase() === host.toLowerCase() && remoteRepo(value) === repo.toLowerCase();
}
/**
 * Fetch exactly the base and head branches into Radar's private refs. `--refmap=` keeps
 * the fetch from also moving `origin/*` (which other tools in a shared checkout race on).
 */
export function gitFetchArgs(number: number, baseRef: string, headRef: string): string[] {
  const refs = radarRefs(number);
  return [
    "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--refmap=", "origin",
    `+refs/heads/${assertBranch(baseRef)}:${refs.base}`, `+refs/heads/${assertBranch(headRef)}:${refs.head}`,
  ];
}
export function gitRevParseArgs(ref: string): string[] {
  return ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`];
}
/** Exit 0 = the base is already in the head (nothing to do). */
export function gitIsAncestorArgs(baseOid: string, headOid: string): string[] {
  return ["merge-base", "--is-ancestor", assertOid(baseOid), assertOid(headOid)];
}
/** Merge commits the PR carries; replaying them is refused like Gitstream's clean-only button. */
export function gitMergesArgs(baseOid: string, headOid: string): string[] {
  return ["rev-list", "--merges", "--count", `${assertOid(baseOid)}..${assertOid(headOid)}`];
}
/** Replays the PR's commits onto the base in the object store only; prints the new head. */
export function gitReplayArgs(number: number, baseOid: string, headOid: string): string[] {
  return ["replay", "--ref-action=print", `--onto=${assertOid(baseOid)}`, `--ref=${radarRefs(number).head}`, `${assertOid(baseOid)}..${assertOid(headOid)}`];
}
/** `update <ref> <new> <old>` from `git replay --ref-action=print`. */
export function replayedHead(stdout: string, number: number, previousHead: string): string | null {
  const ref = radarRefs(number).head;
  for (const line of stdout.split("\n")) {
    const [verb, name, next, old] = line.trim().split(/\s+/);
    if (verb === "update" && name === ref && next !== undefined && OID.test(next) && (old === undefined || old.toLowerCase() === previousHead.toLowerCase())) {
      return next.toLowerCase();
    }
  }
  return null;
}
/** Push the replayed head, leased to the head Delta reported, so a concurrent push is never clobbered. */
export function gitPushArgs(headRef: string, newOid: string, expectedOid: string): string[] {
  const branch = `refs/heads/${assertBranch(headRef)}`;
  return ["push", "--porcelain", "--no-follow-tags", `--force-with-lease=${branch}:${assertOid(expectedOid)}`, "origin", `${assertOid(newOid)}:${branch}`];
}
/** Every ref under refs/radar/rebase/, one per line. */
export function gitListRadarRefsArgs(): string[] {
  return ["for-each-ref", "--format=%(refname)", "refs/radar/rebase/"];
}
/** Radar rebase refs left behind (e.g. by a reload mid-rebase), except those of rebases still running. */
export function staleRadarRefs(stdout: string, running: ReadonlySet<number>): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((ref) => {
      const match = /^refs\/radar\/rebase\/(\d+)\/(?:base|head)$/.exec(ref);
      return match !== null && !running.has(Number(match[1]));
    });
}

/**
 * How a failed git/gh run during a rebase is reported. A shutdown abort (ABORT_ERR, or the
 * signal already aborted) and a timeout may have happened mid-push, so they say the rebase
 * may still have landed; any other exit returns its output for classification.
 */
export function captureFailure(
  error: unknown,
  aborted: boolean,
  label: string,
  bin: string,
): { kind: "throw"; message: string } | { kind: "output"; stdout: string; output: string } {
  const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown } | null;
  if (failure?.code === "ABORT_ERR" || aborted) {
    return { kind: "throw", message: `${label} was cancelled by a plugin reload; the rebase may still have landed. Refresh to check.` };
  }
  if (failure?.code === "ENOENT") return { kind: "throw", message: `${label}: "${bin}" is not on PATH. Set the path in Radar settings.` };
  if (failure?.killed === true || failure?.code === "ETIMEDOUT") {
    return { kind: "throw", message: `${label} timed out; the rebase may still have landed. Refresh to check.` };
  }
  const stdout = typeof failure?.stdout === "string" ? failure.stdout : "";
  const stderr = typeof failure?.stderr === "string" ? failure.stderr : "";
  return { kind: "output", stdout, output: `${stderr}\n${stdout}` };
}
export function gitDeleteRefArgs(ref: string): string[] {
  if (!/^refs\/radar\/rebase\/\d+\/(base|head)$/.test(ref)) throw new Error("Invalid ref.");
  return ["update-ref", "-d", ref];
}

// ---- server-side re-verification -----------------------------------------

type Verified<T> = { ok: true; value: T } | { ok: false; reason: string };
const rec = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** GitHub's own `viewerDidAuthor` decides authorship; the client's author field is never used. */
export function verifyGithubPr(response: unknown): Verified<{ id: string; headOid: string; baseOid: string }> {
  const pr = rec(rec(rec(rec(response).data).repository).pullRequest);
  if (Object.keys(pr).length === 0) return { ok: false, reason: "GitHub could not find that pull request." };
  if (pr.viewerDidAuthor !== true) return { ok: false, reason: "Only your own pull requests can be rebased from Radar." };
  if (pr.merged === true || text(pr.state) !== "OPEN") return { ok: false, reason: "That pull request is no longer open." };
  const id = text(pr.id);
  const headOid = text(pr.headRefOid);
  const baseOid = text(rec(rec(pr.baseRef).target).oid);
  if (!NODE_ID.test(id) || !OID.test(headOid)) return { ok: false, reason: "GitHub returned an unexpected pull request." };
  if (!OID.test(baseOid)) return { ok: false, reason: "The base branch no longer exists." };
  return { ok: true, value: { id, headOid, baseOid } };
}

/** Delta's `/api/v1/me` → the principal (an email), or "". */
export function deltaPrincipal(response: unknown): string {
  const principal = text(rec(response).principal).trim();
  return rec(response).anonymous === true || !/^[^\s@]+@[^\s@]+$/.test(principal) ? "" : principal;
}

/** Delta's GitHub-shaped pull: your own, open, same-repo branch, with sane refs and SHAs. */
export function verifyDeltaPr(response: unknown, me: string, repo: string): Verified<{ headSha: string; baseSha: string; headRef: string; baseRef: string }> {
  const pr = rec(response);
  if (Object.keys(pr).length === 0) return { ok: false, reason: `${SOURCE_LABEL.delta} could not find that pull request.` };
  if (!sameIdentity(text(rec(pr.user).login), me)) return { ok: false, reason: "Only your own pull requests can be rebased from Radar." };
  if (pr.merged === true || text(pr.state).toLowerCase() !== "open") return { ok: false, reason: "That pull request is no longer open." };
  const head = rec(pr.head);
  const base = rec(pr.base);
  const headRepo = text(rec(head.repo).full_name);
  if (headRepo !== "" && headRepo.toLowerCase() !== repo.toLowerCase()) return { ok: false, reason: "Radar only rebases branches in the same repository." };
  const headSha = text(head.sha);
  const baseSha = text(base.sha);
  const headRef = text(head.ref);
  const baseRef = text(base.ref);
  if (!OID.test(headSha) || !OID.test(baseSha)) return { ok: false, reason: `${SOURCE_LABEL.delta} returned an unexpected pull request.` };
  if (!safeBranch(headRef) || !safeBranch(baseRef)) return { ok: false, reason: "That pull request's branch name can't be rebased from Radar." };
  return { ok: true, value: { headSha: headSha.toLowerCase(), baseSha: baseSha.toLowerCase(), headRef, baseRef } };
}

// ---- errors ---------------------------------------------------------------

export type RebaseFailure = { upToDate: true } | { upToDate: false; message: string };

/** Turns gh/git stdout+stderr from a failed rebase into one short, safe sentence. */
export function classifyRebaseFailure(source: Source, output: string): RebaseFailure {
  const raw = output.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  if (/no new commits|already up.to.date|is up to date with/i.test(raw)) return { upToDate: true };
  const fail = (message: string): RebaseFailure => ({ upToDate: false, message });
  if (/conflict|not clean|cannot be (rebased|updated) cleanly|merge commit/i.test(raw)) {
    return fail("Can't rebase cleanly (conflicts or merge commits). Rebase locally instead.");
  }
  if (/expected head|head (sha|oid|ref)?.*(changed|moved|mismatch|does not match)|stale info|\b409\b|fetch first|non-fast-forward/i.test(raw)) {
    return fail("The branch changed since Radar last looked. Refresh and try again.");
  }
  if (/rebas\w* (is )?(not allowed|disabled|not enabled)/i.test(raw)) return fail("This repository doesn't allow rebasing pull requests.");
  if (/\b405\b|protected|policy/i.test(raw)) return fail("Branch protection or push policy declined rewriting this branch.");
  if (/not authorized|permission|forbidden|resource not accessible|must have (push|write) access|\b403\b/i.test(raw)) {
    return fail("You don't have permission to update this branch.");
  }
  const label = SOURCE_LABEL[source];
  const first = raw.split("\n").map((line) => line.replace(/^(gh|git|fatal|error):\s*/, "").trim()).find((line) => line !== "") ?? "rebase failed";
  return fail(`${label}: ${first.slice(0, 180)}`);
}

// ---- CLI target -----------------------------------------------------------

/**
 * `https://github.com/o/r/pull/7`, `https://<delta host>/o/r/pull/7`,
 * `<gitstream web>/repos/o/r/pulls/7` (recognized so it can be refused), or `o/r#7`.
 */
export function parseRebaseTarget(input: string): { source: Source | null; repo: string; number: number } | null {
  const value = input.trim();
  const { gitstream, delta } = hosts();
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: [RegExp, Source | null][] = [
    [/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/, "github"],
    ...(gitstream === null ? [] : [[new RegExp(`^${escape(gitstream.web)}/repos/([^/]+/[^/]+)/pulls/(\\d+)(?:[/?#].*)?$`), "gitstream"] as [RegExp, Source]]),
    ...(delta === null ? [] : [[new RegExp(`^https://${escape(delta.host)}/([^/]+/[^/]+)/pull/(\\d+)(?:[/?#].*)?$`), "delta"] as [RegExp, Source]]),
    [/^([^/\s#]+\/[^/\s#]+)#(\d+)$/, null],
  ];
  for (const [pattern, source] of patterns) {
    const match = value.match(pattern);
    if (match === null) continue;
    const repo = match[1]!;
    const number = Number(match[2]);
    if (!REPO_PATTERN.test(repo) || repo.includes("..") || !Number.isSafeInteger(number) || number <= 0) return null;
    return { source, repo, number };
  }
  return null;
}
