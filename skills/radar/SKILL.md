---
name: radar
description: Read or configure the Radar panel — live queues of pull requests and issues that need the user across GitHub and a Delta repo, plus optional read-only Gitstream history. Use when asked what PRs/issues need attention, what reviews are owed, what's new, or to start/stop tracking a kind of PR or issue.
---

# Radar

Radar polls a list of *lanes* (saved queries) and shows the current results in a
bb panel. Radar stores only its own state in bb: lanes, focus, seen keys and review-thread links in plugin kv, and the label index, single-item hides, mention-acknowledgement tracking and a cache of the last results in its plugin database; every refresh is a live read from `gh api graphql` search (GitHub; GraphQL budget, not the 30/min REST search limit) and, when set up in settings, `dt api search/issues` (Delta, the primary host for repos like shop/world; `author:@me` resolves server-side) and, only when the history toggle is on, `gs api repos/<repo>/pulls` (read-only Gitstream history). Delta labels are indexed weekly so the LLM picks exact label names. Lanes skip sources that are not set up.

## Commands

```sh
bb radar status [--json]                   # per-lane counts, new counts, errors
bb radar list [--lane <id>] [--new] [--json]  # items; * marks unseen
bb radar lanes [--json]                    # lane ids, titles, view (category), queries, filters
bb radar add <description…> [--dry-run] [--json]  # LLM drafts a lane from plain English and adds it
bb radar remove <lane-id>
bb radar seen [<lane-id>]                  # acknowledge current items
bb radar refresh
bb radar put '<lane json>'                 # create/replace a lane (shape below; same as lanes --json); prints the lane id
bb radar defaults                          # add any missing default lanes, keeping yours
bb radar focus "<what helps you focus>" [--json]  # e.g. "no billing stuff": AI picks repos/areas to hide or show; Focus on
bb radar focus <repo|area>…                # show only these (exact names / unique tails like billing, mobile)
bb radar focus --add <repo|area>…          # add to the focus
bb radar hide <repo|area>… / show <…> [--json]  # hide or unhide whole repos/areas everywhere (Focus; lanes, every view, badge)
bb radar hide-item <url|key> [--json]      # hide ONE PR/issue everywhere until unhidden (key: github:owner/repo#12; owner/repo#12 if unique)
bb radar unhide-item <url|key> | --all [--json]  # bring one (or every) hidden item back
bb radar hidden [--json]                   # items hidden one by one, newest first
bb radar slack [<url|key>] [--json]        # Slack context: board items linked from public Slack threads, Radar's summary and thread links
bb radar slack-check <url|key> [--json]    # check one open issue/PR (GitHub, or a Delta PR) against public Slack now; reads only, never posts
bb radar focus --off | --on                # Focus off = normal board (focus is kept); --on resumes it
bb radar scopes [--json]                   # repos + area-repo areas in results, counts, focus state
bb radar list --all                        # ignore the focus filter
bb radar list --view reviews|prs|issues|all  # what one panel view shows
bb radar rebase <PR url|owner/repo#n> [--source github|delta] --yes [--json]  # rebase YOUR open PR (GitHub server-side; Delta via git replay + leased push when deltaCheckout is set); rewrites the branch, only on explicit request; --source picks the host when owner/repo#n is ambiguous
```

## Focus

Scope keys: repos are `owner/name`; areas of the `areaRepo` setting (a monorepo) are `//<path>` keys from its `//...` labels, cut to three segments; `//no-area` is that repo with no area label. Focus = show only those; hidden = drop those (a PR touching several areas stays while any of its areas is shown). It applies to every lane, every view, the rail badge and `status`/`list`; hidden items are never counted new or marked seen. `bb radar status` prints the focus line and per-lane hidden counts.

Hidden items (`hide-item`) are separate from Focus: one PR or issue, by key, gone from every lane, view, the badge, `status` and `list` (even `list --all`), never marked seen. A hide lasts until `unhide-item`; an entry whose item has been in no lane for 30 days is pruned. Only hide or unhide when the user asks.

Slack context (on when `slackMcpUrl` and `slackTokenCommand` are set): Radar searches public Slack channels for human messages that link an open GitHub issue or PR, or an open Delta PR, on the board (in Focus), follows those threads, and keeps a short AI summary of each thread. The board shows them in a "Context from Slack" popover on the row (the row icon shows on hover, badged with a check when threads link it, a cross when none do). Use `bb radar slack <item>` to bring that context into a review or triage. Radar never writes it to GitHub or Delta by itself; "Post to issue/PR" on a thread row is a panel-only action the user takes (asked twice), which adds one new comment. Agents can read and check context but cannot post it.

`add` sends the description through BB’s configured-provider text completion API, validates the drafted lane,
runs it once, and prints how many items match. Use `--dry-run` to preview first.

## Lane shape

- `sources`: any of `"delta"`, `"github"`, `"gitstream"` (Delta and Gitstream only once set up); results are merged into one lane. Personal queues (reviews, my PRs) should use `["delta", "github"]`; add `"gitstream"` only for an explicit read-only history lane. Legacy `source: "x"` is read as `sources: ["x"]`.
- `gitstream: { reviewRequested, author, excludeAuthor, assignee, reviewedBy, everyone, labels, excludeLabels, query, draft, hasApproval, base, head, state }` — read-only history: server-side filters on Gitstream `GET /repos/<gitstreamRepo>/pulls` via `gs api` (principals are `@me` or an email; labels are exact names, all required). Without a principal it defaults to your PRs unless `everyone: true`. The Gitstream repo only. Used when `sources` has `gitstream`.
- `query` — GitHub search syntax, run on GitHub and on Delta. Required when `sources` has `github` or `delta`. Delta has pull requests only: it strips `archived:` and rejects `is:issue`, `mentions:` and `involves:`, so leave Delta out of issue and mention lanes (AI drafts drop it automatically).
- `category`: `"reviews" | "prs" | "issues" | "all"`, the panel view the lane shows in (All shows every lane). Omit it and Radar infers it from the query: review-requested:/reviewed-by:/user-review-requested: or Gitstream `reviewRequested`/`reviewedBy` → reviews; `is:pr` or Gitstream-only → prs; `is:issue` → issues; mixed or unclear → all. An explicit category that differs from the inferred one is pinned (`categoryPinned: true`) and survives query edits; `categoryPinned: false` goes back to inference.
- Optional `filter: { titleIncludes, labelsAny, excludeAuthors, excludeDrafts, updatedWithinDays }` applied client-side; `limit` 1–100 (default 30) caps the merged lane: each host fetches up to it and the newest across hosts are kept.

## Panel-only actions

- The title bar's **Filter** menu switches between the **All**, **Issues**, **Pull requests** and **Reviews** views and holds Zen (Focus). A lane shows in its category's view and in All; the Pull requests and Issues views keep only that kind of item. The lane editor's View picker sets the category.
- **Review / Triage** on a row opens bb's new-thread composer seeded with a review prompt (read-only: it tells the agent not to post) and the project whose git remote matches the repo. The thread is created in the bb thread section named by `reviewSection` (default `Reviews`, created if missing; `bb thread section list`). The row keeps a **Thread** link until that thread is archived or deleted. The thread also gets Radar's `radar-review`/`radar-triage` skill, and the opening message invokes the configured host skill, if any (`reviewSkill`, `gitstreamReviewSkill`, `triageSkill`).
- The Radar nav-rail icon shows the unseen-item count.

## Settings

Under **AI & focus** in Radar’s plugin settings, **Use BB default** leaves the provider/model override unset (`null`). Choose an override with BB’s native picker and explicitly save it, or reset to the default. The override is stored durably by typed `radar_ai_get` / `radar_ai_set` RPC, not a CLI config setting. On hosts without `experimental_ai`, an optional OpenAI-compatible fallback is used when `aiBaseUrl` (https only), `aiKeyEnv` (the name of a bb server environment variable) and `aiModel` are all set: the key from that variable is sent to that endpoint. BB's configured providers always win when available; with any of the three unset, nothing is sent.

AI execution uses a BB build exposing `experimental_ai.complete`, or the fallback above. API availability does not guarantee the chosen model supports text completion; provider failures are surfaced. With neither, drafting is unavailable with an explicit explanation. Focus retains repo/area name matching and all manual controls, including when AI execution fails. Settings labels distinguish **AI & focus**, **Sources**, **Refresh & retention**, and **Review workflows**; this SDK has no grouped setting descriptors.

`bb plugin config radar set <key> <value>`: `refreshSeconds` (min 30, default 90),
`maxAgeDays` (default 60, 0 = no limit), `ghPath`;
Delta `deltaHost`, `deltaRepo` (empty = off), `deltaLabel`, `dtPath`, `deltaCheckout` (absolute path of a checkout whose origin is Delta; turns on Rebase);
Gitstream history (read-only, off by default) `gitstreamHistory` (true to show it), `gitstreamRepo`, `gitstreamWebUrl`, `gitstreamLabel`, `gsPath`;
`areaRepo` (monorepo whose `//path` labels are Focus areas);
`draftNotes` (plain-words context for the lane drafter),
`reviewSection` (thread section for review threads, default `Reviews`; empty = none), `gitstreamReviewSkill`, `reviewSkill` and `triageSkill` (skill invoked when a review/triage thread starts; empty = none).
