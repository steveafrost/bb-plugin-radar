/**
 * Server-side "Rebase" for PRs you authored. Pure helpers (gating, argv, response
 * checks, error wording) so the server and the panel agree and tests can cover them.
 *
 * Per host, only first-class server-side rebases are used — never a local checkout:
 * - GitHub: GraphQL `updatePullRequestBranch(updateMethod: REBASE, expectedHeadOid)`.
 * - Gitstream: `POST repos/{o}/{r}/pulls/{n}/rebase` with `expected_head_sha`,
 *   Gitstream's clean-only "Rebase button" (refuses conflicts and merge commits with 422,
 *   returns `rebased: false` when already up to date).
 * - Delta: unsupported. walgit only offers `update-branch`, which merges the base into the
 *   head instead of rebasing, so the action is hidden there.
 */
import { hosts } from "./hosts";
import { SOURCE_LABEL, type Item, type Source } from "./lanes";

export const REBASE_SOURCES: ReadonlySet<Source> = new Set<Source>(["github", "gitstream"]);

/** The signed-in identity per host, as items carry it in `author`. */
export type Viewer = { github: string; gitstream: string };

export type RebaseTarget = { source: Source; repo: string; number: number };
export type RebaseResult = { status: "rebased" | "up-to-date"; message: string; headSha: string };

/** owner/name; owners start alphanumeric, names may start with "." or "_" (e.g. .github), never "-". */
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const OID = /^[0-9a-f]{40}$/i;
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;

const sameIdentity = (a: string, b: string) => a !== "" && a.toLowerCase() === b.toLowerCase();

/** Whether the row offers Rebase: an open PR, on a host that can rebase, that you wrote. */
export function canRebase(item: Pick<Item, "source" | "kind" | "state" | "author">, viewer: Viewer): boolean {
  if (item.kind !== "pr" || !REBASE_SOURCES.has(item.source)) return false;
  const state = item.state.toLowerCase();
  if (state !== "open" && state !== "draft") return false;
  const me = item.source === "github" ? viewer.github : viewer.gitstream;
  return sameIdentity(item.author, me);
}

export function rebaseHelp(source: Source): string {
  return source === "gitstream"
    ? `Rebase this PR onto the latest base on ${SOURCE_LABEL.gitstream} (server-side, clean-only; conflicts are refused). Rewrites the remote branch.`
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
export function gitstreamPrArgs(repo: string, number: number): string[] {
  assertRepo(repo);
  return ["api", `repos/${repo}/pulls/${assertNumber(number)}`];
}
export function gitstreamRebaseArgs(repo: string, number: number, headSha: string): string[] {
  assertRepo(repo);
  return ["api", "-X", "POST", `repos/${repo}/pulls/${assertNumber(number)}/rebase`, "-f", `expected_head_sha=${assertOid(headSha)}`];
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

export function verifyGitstreamPr(response: unknown, me: string): Verified<{ headSha: string }> {
  const pr = rec(response);
  if (Object.keys(pr).length === 0) return { ok: false, reason: `${SOURCE_LABEL.gitstream} could not find that pull request.` };
  if (!sameIdentity(text(rec(pr.user).login), me)) return { ok: false, reason: "Only your own pull requests can be rebased from Radar." };
  if (pr.merged === true || text(pr.state).toLowerCase() !== "open") return { ok: false, reason: "That pull request is no longer open." };
  const headSha = text(rec(pr.head).sha);
  if (!OID.test(headSha)) return { ok: false, reason: `${SOURCE_LABEL.gitstream} returned an unexpected pull request.` };
  return { ok: true, value: { headSha } };
}

/** Gitstream's `{ rebased, head_sha, base_sha }`. */
export function gitstreamRebaseResult(response: unknown, previousHead: string): RebaseResult {
  const body = rec(response);
  const headSha = OID.test(text(body.head_sha)) ? text(body.head_sha) : previousHead;
  return body.rebased === true
    ? { status: "rebased", message: "Rebased onto the latest base.", headSha }
    : { status: "up-to-date", message: "Already up to date.", headSha };
}

// ---- errors ---------------------------------------------------------------

export type RebaseFailure = { upToDate: true } | { upToDate: false; message: string };

/** Turns gh/gs stdout+stderr from a failed rebase into one short, safe sentence. */
export function classifyRebaseFailure(source: Source, output: string): RebaseFailure {
  const raw = output.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  if (/no new commits|already up.to.date|is up to date with/i.test(raw)) return { upToDate: true };
  const fail = (message: string): RebaseFailure => ({ upToDate: false, message });
  if (/conflict|not clean|cannot be (rebased|updated) cleanly|merge commit/i.test(raw)) {
    return fail("Can't rebase cleanly (conflicts or merge commits). Rebase locally instead.");
  }
  if (/expected head|head (sha|oid|ref)?.*(changed|moved|mismatch|does not match)|stale info|\b409\b/i.test(raw)) {
    return fail("The branch changed since Radar last looked. Refresh and try again.");
  }
  if (/rebas\w* (is )?(not allowed|disabled|not enabled)/i.test(raw)) return fail("This repository doesn't allow rebasing pull requests.");
  if (/\b405\b|protected|policy/i.test(raw)) return fail("Branch protection or push policy declined rewriting this branch.");
  if (/not authorized|permission|forbidden|resource not accessible|must have (push|write) access|\b403\b/i.test(raw)) {
    return fail("You don't have permission to update this branch.");
  }
  if (source === "gitstream" && /\b422\b/.test(raw)) return fail(`${SOURCE_LABEL.gitstream} refused the rebase as not clean. Rebase locally instead.`);
  const label = SOURCE_LABEL[source];
  const first = raw.split("\n").map((line) => line.replace(/^(gh|gs):\s*/, "").trim()).find((line) => line !== "") ?? "rebase failed";
  return fail(`${label}: ${first.slice(0, 180)}`);
}

// ---- CLI target -----------------------------------------------------------

/**
 * `https://github.com/o/r/pull/7`, `<gitstream web>/repos/o/r/pulls/7`,
 * `https://<delta host>/o/r/pull/7`, or `o/r#7` (source left to the caller).
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
