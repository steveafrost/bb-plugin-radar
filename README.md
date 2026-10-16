# Radar (bb plugin)

A live bb panel of the pull requests and issues that need you, on GitHub and,
optionally, a Gitstream repo and a Delta repo. No backing site or database: every
lane is a saved query that the bb server re-runs on an interval, and the panel
shows whatever is current.

- **Lanes**: each lane reads one or more hosts and merges the results:
  - GitHub: search query via `gh api graphql`.
  - Gitstream (optional): `gs api repos/<repo>/pulls` with server-side principals,
    exact labels, text search, draft/approval filters.
  - Delta (optional): the same GitHub-syntax query via `dt api search/issues`
    (`archived:` is stripped; Delta rejects `mentions:` and `involves:`).
  A host that fails shows its error on the lane without hiding the others' items.
  Sources that are not set up are skipped, so the default lanes work with GitHub alone.
  Optional client-side filters refine the merged list.
- **Track something**: describe what you want in plain English; an
  OpenAI-compatible model drafts a lane, Radar runs it once and shows the live
  preview, and you add, tweak, or discard it. Gitstream label names come from a
  daily label index, so the model uses exact spellings, and the `draftNotes`
  setting tells it about your repos, teams and labels.
- **New badges**: items you have not seen are dotted and floated to the top of
  their lane; "Mark seen" acknowledges them.
- **Views**: icon tabs in the title bar, left to right **All**, **Issues**,
  **Pull requests**, **Reviews** (`/plugins/radar/board/all`, `/board/issues`,
  `/board/prs`, `/board/reviews`; bare `/board` opens All). Every lane has a
  `category` naming its view, and All shows every lane. The category is inferred
  from the query (review-requested:/reviewed-by:/Gitstream reviewRequested →
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
    composer's `/` menu. Settings `gitstreamReviewSkill` (Gitstream PRs),
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
  - Gitstream: the native `POST repos/{o}/{r}/pulls/{n}/rebase` with
    `expected_head_sha` (clean-only; conflicts and merge commits are refused
    with 422 and nothing is pushed; `rebased: false` when already up to date).
  - Delta: not offered. walgit only has `update-branch`, which merges the base
    into the head rather than rebasing, and Radar never falls back to a local
    checkout.
  `bb radar rebase <PR url | owner/repo#n> [--source github|gitstream] --yes`
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
  count as new and stay unseen. While Focus is on, a banner names the focus and how
  many items it hides; "Turn off" restores the normal board and keeps the focus to
  resume. The Focus popover also lists the repos/areas in the view with counts to
  hide (eye) or "Only" one by hand. Without AI it matches repo/area names.
- **Configurable**: edit, reorder, collapse, or remove lanes in the panel, or use
  `bb radar …` (see `skills/radar/SKILL.md`).

Persisted state is configuration only: the lane list, the Focus filter, seen-item keys and
item → review-thread links live in plugin kv. The cached Gitstream label list can be too big for
kv's 256KB value cap, so it lives in the plugin database (`label_index` table).

## Develop

```sh
npm test            # vitest (lanes.ts policy)
npx tsc --noEmit
bb plugin build . && bb plugin reload radar
```

## Setup

Radar needs `gh` signed in on the bb host. Everything else is in
**Settings → Plugins → Radar** (or `bb plugin config radar set <key> <value>`):

| Setting | What it does |
| --- | --- |
| `gitstreamRepo`, `gitstreamWebUrl`, `gitstreamLabel`, `gsPath` | Turn on a Gitstream repo (`owner/name`), the https origin its PRs open at, the name shown for it, and the `gs` binary. Empty repo = off. |
| `deltaHost`, `deltaRepo`, `deltaLabel`, `dtPath` | Same for a Delta repo, read with `dt --host <deltaHost> -R <deltaRepo>`. |
| `areaRepo` | A monorepo whose `//path` labels become Focus areas. |
| `aiBaseUrl`, `aiKeyEnv`, `aiModel` | OpenAI-compatible endpoint for drafting lanes and focus (default `https://api.openai.com`, key from `$OPENAI_API_KEY` in the bb server environment, `gpt-4.1-mini`). The key is only sent to this https URL. Without a key, focus falls back to name matching and drafting is off. |
| `draftNotes` | Plain-words context for the drafter: which repos live where, team names, label conventions. |
| `maxAgeDays`, `refreshSeconds` | Hide items not updated in N days (default 60, 0 = no limit); poll interval (min 30s). |
| `reviewSection`, `reviewSkill`, `gitstreamReviewSkill`, `triageSkill` | Thread section for Radar threads, and an installed skill to invoke per kind. |

Example for a monorepo on Gitstream and Delta:

```sh
bb plugin config radar set gitstreamRepo acme/monorepo
bb plugin config radar set gitstreamWebUrl https://gitstream.acme.dev
bb plugin config radar set deltaHost delta.acme.dev
bb plugin config radar set deltaRepo acme/monorepo
bb plugin config radar set areaRepo acme/monorepo
```
