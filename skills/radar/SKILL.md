---
name: radar
description: Read or configure the Radar panel — live queues of pull requests and issues that need the user across GitHub and, when configured, a Gitstream repo and a Delta repo. Use when asked what PRs/issues need attention, what reviews are owed, what's new, or to start/stop tracking a kind of PR or issue.
---

# Radar

Radar polls a list of *lanes* (saved queries) and shows the current results in a
bb panel. Nothing is stored except the lane list and which items were already
seen; every refresh is a live read from `gh api graphql` search (GitHub; GraphQL budget, not the 30/min REST search limit) and, when set up in settings, `gs api repos/<repo>/pulls` (Gitstream) and `dt api search/issues` (Delta). Gitstream labels are indexed daily so the LLM picks exact label names. Lanes skip sources that are not set up.

## Commands

```sh
bb radar status [--json]                   # per-lane counts, new counts, errors
bb radar list [--lane <id>] [--new] [--json]  # items; * marks unseen
bb radar lanes [--json]                    # lane ids, titles, view (category), queries, filters
bb radar add <description…> [--dry-run]    # LLM drafts a lane from plain English and adds it
bb radar remove <lane-id>
bb radar seen [<lane-id>]                  # acknowledge current items
bb radar refresh
bb radar put '<lane json>'                 # create/replace a lane (shape below; same as lanes --json)
bb radar defaults                          # add any missing default lanes, keeping yours
bb radar focus "<what helps you focus>"    # e.g. "no billing stuff": AI picks repos/areas to hide or show; Focus on
bb radar focus <repo|area>…                # show only these (exact names / unique tails like billing, mobile)
bb radar focus --add <repo|area>…          # add to the focus
bb radar hide <repo|area>… / show <…>      # hide or unhide everywhere (lanes, every view, badge)
bb radar focus --off | --on                # Focus off = normal board (focus is kept); --on resumes it
bb radar scopes [--json]                   # repos + area-repo areas in results, counts, focus state
bb radar list --all                        # ignore the focus filter
bb radar list --view reviews|prs|issues|all  # what one panel view shows
bb radar rebase <PR url|owner/repo#n> --yes  # server-side rebase of YOUR open PR (GitHub, Gitstream); rewrites the branch, only on explicit request
```

## Focus

Scope keys: repos are `owner/name`; areas of the `areaRepo` setting (a monorepo) are `//<path>` keys from its `//...` labels, cut to three segments; `//no-area` is that repo with no area label. Focus = show only those; hidden = drop those (a PR touching several areas stays while any of its areas is shown). It applies to every lane, every view, the rail badge and `status`/`list`; hidden items are never counted new or marked seen. `bb radar status` prints the focus line and per-lane hidden counts.

`add` sends the description to the configured OpenAI-compatible endpoint, validates the drafted lane,
runs it once, and prints how many items match. Use `--dry-run` to preview first.

## Lane shape

- `sources`: any of `"github"`, `"gitstream"`, `"delta"` (the last two only once set up); results are merged into one lane. Personal queues (reviews, my PRs) should use every set-up source. Legacy `source: "x"` is read as `sources: ["x"]`.
- `gitstream: { reviewRequested, author, excludeAuthor, assignee, reviewedBy, everyone, labels, excludeLabels, query, draft, hasApproval, base, head, state }` — server-side filters on Gitstream `GET /repos/<gitstreamRepo>/pulls` via `gs api` (principals are `@me` or an email; labels are exact names, all required). Without a principal it defaults to your PRs unless `everyone: true`. The Gitstream repo only. Used when `sources` has `gitstream`.
- `query` — GitHub search syntax, run on GitHub and on Delta (`is:pr` / `is:issue` narrow it). Required when `sources` has `github` or `delta`. Delta strips `archived:` and rejects `mentions:` / `involves:`, so leave Delta out of those lanes.
- `category`: `"reviews" | "prs" | "issues" | "all"`, the panel view the lane shows in (All shows every lane). Omit it and Radar infers it from the query: review-requested:/reviewed-by:/user-review-requested: or Gitstream `reviewRequested`/`reviewedBy` → reviews; `is:pr` or Gitstream-only → prs; `is:issue` → issues; mixed or unclear → all. An explicit category that differs from the inferred one is pinned (`categoryPinned: true`) and survives query edits; `categoryPinned: false` goes back to inference.
- Optional `filter: { titleIncludes, labelsAny, excludeAuthors, excludeDrafts, updatedWithinDays }` applied client-side; `limit` 1–100 (default 30) caps the merged lane: each host fetches up to it and the newest across hosts are kept.

## Panel-only actions

- The title bar has icon tabs for the **All**, **Issues**, **Pull requests** and **Reviews** views, then Track something new (sparkle) and Focus (meditating figure). A lane shows in its category's view and in All; the Pull requests and Issues views keep only that kind of item. The lane editor's View picker sets the category.
- **Review / Triage** on a row opens bb's new-thread composer seeded with a review prompt (read-only: it tells the agent not to post) and the project whose git remote matches the repo. The thread is created in the bb thread section named by `reviewSection` (default `Reviews`, created if missing; `bb thread section list`). The row keeps a **Thread** link until that thread is archived or deleted. The thread also gets Radar's `radar-review`/`radar-triage` skill, and the opening message invokes the configured host skill, if any (`reviewSkill`, `gitstreamReviewSkill`, `triageSkill`).
- The Radar nav-rail icon shows the unseen-item count.

## Settings

`bb plugin config radar set <key> <value>`: `refreshSeconds` (min 30, default 90),
`maxAgeDays` (default 60, 0 = no limit), `ghPath`;
Gitstream `gitstreamRepo` (owner/name; empty = off), `gitstreamWebUrl` (https origin PR links open at), `gitstreamLabel`, `gsPath`;
Delta `deltaHost`, `deltaRepo` (empty = off), `deltaLabel`, `dtPath`;
`areaRepo` (monorepo whose `//path` labels are Focus areas);
`aiModel` (default `gpt-4.1-mini`), `aiBaseUrl` (default `https://api.openai.com`), `draftNotes` (plain-words context for the lane drafter),
`aiKeyEnv` (default `OPENAI_API_KEY`, read from the bb server environment),
`reviewSection` (thread section for review threads, default `Reviews`; empty = none), `gitstreamReviewSkill`, `reviewSkill` and `triageSkill` (skill invoked when a review/triage thread starts; empty = none).
