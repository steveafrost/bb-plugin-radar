# Radar (bb plugin)

A live bb panel of the pull requests and issues that need you, on GitHub and a
Delta repo (the primary host for repos that moved off GitHub/Gitstream), plus
optional read-only Gitstream history. No backing site or remote database: every
lane is a saved query that the bb server re-runs on an interval, and the panel
shows whatever is current.

- **Lanes**: each lane reads one or more hosts and merges the results:
  - Delta: the GitHub-syntax query via `dt api search/issues` (`author:@me` and
    `review-requested:@me` resolve server-side; `archived:` is stripped; Delta
    has pull requests only, rejecting `is:issue`, `mentions:` and `involves:`). Radar never uses `dt pr list --author`.
  - GitHub: search query via `gh api graphql`.
  - Gitstream history (off by default): `gs api repos/<repo>/pulls` reads only.
    Gitstream no longer accepts PR writes, so it is labelled "<name> history",
    the default lanes leave it out, and Radar never writes to it.
  A host that fails shows its error on the lane without hiding the others' items.
  Sources that are not set up are skipped, so the default lanes work with GitHub alone.
  Optional client-side filters refine the merged list.
- **Track something**: describe what you want in plain English; a
  BB-configured model drafts a lane, Radar runs it once and shows the live
  preview, and you add, tweak, or discard it. Label names come from a
  label index of the Delta repo (about 60 sequential page reads, at most once a week), so the model uses exact spellings, and the `draftNotes`
  setting tells it about your repos, teams and labels.
- **New badges**: items you have not seen are dotted and floated to the top of
  their lane; "Mark seen" acknowledges them.
- **Views**: icon tabs in the title bar, left to right **All**, **Issues**,
  **Pull requests**, **Reviews** (`/plugins/radar/board/all`, `/board/issues`,
  `/board/prs`, `/board/reviews`; bare `/board` opens All). Every lane has a
  `category` naming its view, and All shows every lane. The category is inferred
  from the query (review-requested:/reviewed-by:/Gitstream-history reviewRequested →
  reviews, `is:pr` or Gitstream-only → prs, `is:issue` → issues, mixed → all)
  until you pick one in the lane editor, which pins it. The Pull requests and
  Issues views keep only that kind of item. Tab tooltips carry per-view counts,
  and "Mark all seen" acts on the current view only.
- **Review / Triage**: each row can start a bb thread. bb's own new-thread
  composer opens with a review prompt and the project picked from the repo
  (matched on project git remote, then remembered per repo). The thread is
  created in the sidebar's **Reviews** thread section (setting `reviewSection`;
  created if missing, empty disables it). The row then links to that thread
  until you archive it. Review threads started before this were moved into the
  section once, unless they were already in another section.
- **Review skills**: Radar threads get skills attached two ways.
  - Radar's own `radar-review` (PRs) or `radar-triage` (issues) skill is selected
    for the thread through `bb.agents.configure`, keyed off the thread's Radar
    metadata (`action`). Other threads only see the `radar` CLI skill.
  - One installed skill is invoked in the opening message, as if picked from the
    composer's `/` menu. Settings `gitstreamReviewSkill` (Gitstream history PRs),
    `reviewSkill` (GitHub/Delta PRs) and `triageSkill` (issues) choose it; empty
    (the default) means none. It is skipped when the target project
    cannot see that skill, or when you already picked a skill in the composer.
- **Rebase**: your own open PRs get a **Rebase** hover action. It asks
  "Rebase onto base?" inline (Confirm/Cancel), then shows busy, "Rebased",
  "Up to date" or the error on the row, and refreshes the lanes showing that PR.
  The `radar_rebase` RPC re-checks authorship and open state on the host before
  writing (client-sent author is never used), and leases the current head:
  - GitHub: GraphQL `updatePullRequestBranch(updateMethod: REBASE,
    expectedHeadOid)`, gated by GitHub's `viewerDidAuthor`. A head with
    `behind_by == 0` is reported up to date without any write.
  - Delta: walgit has no server-side rebase (`update-branch` merges), so Radar
    uses plain git against `origin` in the checkout set in `deltaCheckout`
    (off when empty). It re-reads the PR with `dt` (yours, open, same repo),
    fetches only the base and head into private `refs/radar/rebase/<n>/*` refs
    (`--refmap=`, so `origin/*`, HEAD, branches and the worktree are untouched),
    refuses merge commits, runs `git replay` (clean-only: a conflict pushes
    nothing), then `git push --force-with-lease=<branch>:<head Delta reported>`.
    The private refs are deleted afterwards. Needs git with
    `git replay --ref-action` (2.52+).
  - Gitstream history: not offered; Gitstream no longer accepts PR writes.
  `bb radar rebase <PR url | owner/repo#n> [--source github|delta] --yes`
  does the same from the CLI (without `--yes` it only says what it would do).
- **Rail badge**: the unseen count sits on Radar's nav-rail icon. bb does not
  mount navPanel sidebar accessories yet, so a content script decorates the rail
  and polls the plugin's local `/badge` route.
- **Focus**: the meditating-figure icon in the title bar, next to the view tabs, takes a plain-English request ("I don't want to
  see any billing stuff", "only the mobile app"). The model maps it onto the
  repositories on the board, plus the areas of a monorepo if you set `areaRepo`
  (areas come from its `//<group>/<name>` path labels; items without one fall in
  "<repo> (no area)"), and every lane,
  every view, the view counts and the rail badge drop the rest. Hidden items do not
  count as new and stay unseen. While Focus is on, the Filter button shows a dot and its
  menu names the focus and how many items it filters out; "Turn off" restores the
  normal board and keeps the focus to resume. The Focus popover also lists the repos/areas in the view with counts to
  hide (eye) or "Only" one by hand. Without AI it matches repo/area names.
- **Hide one item**: the eye-off row action ("Hide from Radar") takes one PR or
  issue off every lane, view, view count and the rail badge at once (optimistic),
  with a few-second Undo in the toolbar. The muted eye-off count next to Filter
  opens the hidden list: each item with Unhide, plus Unhide all. This is separate
  from Focus (whole repos/areas). Hidden items are never marked seen, so an
  unhidden item comes back as new if it was. A hide lasts until undone; an entry
  whose item has been in no lane result for 30 days is pruned (pruning is skipped
  when every lane failed). At most 1000 hides; the oldest go first. CLI:
  `bb radar hide-item <url|key>`, `bb radar unhide-item <url|key> | --all`,
  `bb radar hidden`.
- **Configurable**: edit, reorder, collapse, or remove lanes in the panel, or use
  `bb radar …` (see `skills/radar/SKILL.md`).

Persisted state: the lane list, the Focus filter, seen-item keys and item → review-thread
links are small and live in plugin kv. Anything that can outgrow kv's 256KB value cap lives
in the plugin database: the cached label list (`label_index`), hidden items (`hidden_items`,
one row per item: lowercased key → JSON
`{ key, source, kind, repo, number, title, url, hiddenAt, lastSeenAt }`, validated on load,
bad rows dropped), mention-acknowledgement tracking (`mention_accounts`, `mention_items`,
`mention_candidates`; a mention that leaves the Mentions lane keeps its acknowledgement for
30 days, pruned only after every Mentions lane read cleanly) and the last refresh's results (`results_cache`, one row per lane, and
`results_meta`), so a restart shows what Radar last knew. Slack context keeps the threads
linked to each item with the newest human message seen (`slack_threads`), when each item was last
searched (`slack_issues`), with each thread's opening message, AI summary and last post, and per-item seen marks (`slack_context`). Older kv copies of the mention
state and results cache are moved into the database on load and their kv keys deleted.

AI execution uses a BB build exposing `experimental_ai.complete`. On other hosts, the AI fallback (`aiBaseUrl` https only, `aiKeyEnv`, `aiModel`; all three required) sends the key from that bb server environment variable to that endpoint; with neither, Radar reports that AI is unavailable, disables AI drafting, and keeps heuristic repo/area matching and manual focus controls. API availability is not a claim that every selectable model supports text completion. Provider failures are surfaced. Focus also falls back to name matching after a provider error.

Settings use an **AI & focus** section for model selection and label prefixes for **AI & focus**, **Sources**, **Refresh & retention**, and **Review workflows**. The current SDK has neither grouped nor provider/model setting descriptors. Its picker currently requires a concrete value, so Radar wraps it in an optional, explicitly saved override editor rather than passing `null` to the host component.

## Develop

```sh
npm test            # vitest (lanes.ts policy)
npx tsc --noEmit
bb plugin build . && bb plugin reload radar
```

The installed SDK is 0.6.37. `types/bb-ai-preview.d.ts` narrowly augments it with the new completion interfaces generated from the local BB SDK source; remove this shim when the published SDK includes the contract. No SDK lockfile bump is needed. Runtime support is feature-detected; a successful plugin build does not add host support.

## Setup

Radar needs `gh` signed in on the bb host. Everything else is in
**Settings → Plugins → Radar** (or `bb plugin config radar set <key> <value>`):

| Setting | What it does |
| --- | --- |
| `deltaHost`, `deltaRepo`, `deltaLabel`, `dtPath` | Turn on a Delta repo, read with `dt --host <deltaHost> -R <deltaRepo>`. Empty repo = off. |
| `deltaCheckout` | Absolute path to a local checkout whose `origin` is the Delta repo; turns on Rebase for your Delta PRs. Empty = off. |
| `gitstreamHistory`, `gitstreamRepo`, `gitstreamWebUrl`, `gitstreamLabel`, `gsPath` | Read-only Gitstream history: off unless `gitstreamHistory` is true and the repo and https web origin are set. Shown as "<label> history". |
| `areaRepo` | A monorepo whose `//path` labels become Focus areas. |
| AI provider/model | In **AI & focus**, use BB’s default (no override, stored as `null`) or choose a provider/model with BB’s native picker and save the override. Stored via typed RPC and durable plugin storage, not CLI config. |
| AI fallback | `aiBaseUrl` (https, OpenAI-compatible; `/v1/chat/completions` is appended), `aiKeyEnv` and `aiModel`. Used only when the BB host has no `experimental_ai` completion (release builds up to at least 0.46.1). Empty by default; BB’s own providers always win when available. |
| `draftNotes` | Plain-words context for the drafter: which repos live where, team names, label conventions. |
| `maxAgeDays`, `refreshSeconds` | Hide items not updated in N days (default 60, 0 = no limit); poll interval (min 30s). |
| `reviewSection`, `reviewSkill`, `gitstreamReviewSkill`, `triageSkill` | Thread section for Radar threads, and an installed skill to invoke per kind. |
| `slackMcpUrl`, `slackTokenCommand`, `slackSweepMinutes` | Slack context: an MCP endpoint exposing `slack_search_public` and `slack_read_thread` (https), a command that prints its bearer token (run without a shell; last line wins), and the sweep interval (default 30, min 10). Both of the first two set = on. At Shopify: `https://tool-gateway.shopify.io/mcp` and `dev tokens get tool_gateway/personal`. |

Example for a monorepo on Delta:

```sh
bb plugin config radar set deltaHost delta.acme.dev
bb plugin config radar set deltaRepo acme/monorepo
bb plugin config radar set deltaCheckout ~/src/monorepo   # optional: Rebase
bb plugin config radar set areaRepo acme/monorepo
# optional, read-only: old PRs from before the move
bb plugin config radar set gitstreamHistory true
```
