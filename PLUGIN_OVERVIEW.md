Radar is a live panel of the pull requests and issues that need you. It reads **GitHub**, a **Delta** repo, and optional read-only **Gitstream history**. Radar stores nothing remotely. It queries your own `gh` and `dt` CLIs every 90 seconds, and `gs` for history.

## Lanes

A lane is a saved query that can hit several hosts at once. The defaults are review requests, mentions, assigned items and your open PRs. The assigned lane skips parents of your sub-issues. Results merge by last update. Radar marks unseen items and shows an unseen count on the rail icon.

- **Describe what to track** in plain words, such as "PRs from my team that touch billing, not drafts". The AI configured in bb drafts a lane.
- **Edit a lane** in a form with per-host sections, a live summary chip inputs and Gitstream filters.
- **Views**: **All**, **Issues**, **Pull requests** and **Reviews**. Switch them in the panel title bar. Each lane has a category that decides its view. Radar infers it from the query, or you pick it.

## Focus

Focus hides repos across every lane. Type the request in words, such as "no billing" or "only the mobile app". Point `areaRepo` at a monorepo, and its `//path` labels become areas that you can hide or focus.

## Hide one item

The eye-off action on a row hides that PR or issue from every lane, view, count and the rail badge. A brief Undo follows. The eye-off count in the toolbar lists hidden items to unhide. A hide lasts until you undo it, or until the item has been in no lane for 30 days.

## Review and triage threads

Every row can start a bb thread through the new-thread composer. Radar picks the project from the repo. Threads land in a **Reviews** section; the row links to the thread until it is archived.

Your own open PRs also get **Rebase**. The row asks for a confirm, then rebases onto the base.

- GitHub uses its server-side rebase update.
- Delta has no server-side rebase. After you point Radar at a local checkout, Radar uses plain git against `origin`. It runs a clean-only `git replay` in private refs and pushes with a lease.
- Radar re-checks on the host that you wrote the PR before it changes anything.
- Gitstream history is read-only.

- `radar-review` and `radar-triage` describe how to read the item on each host and how to report. They never post, approve or edit until you say so.
- Radar can also invoke one installed skill, such as a code-review skill, in the opening message. Pick it per kind in settings.

## Context from Slack

Point Radar at a Slack MCP endpoint. Radar then follows the public Slack threads that link your open GitHub issues and PRs and your open Delta PRs in Focus. It counts only messages from people. When a thread changes, the bb AI refreshes a short summary of decisions, owners, open questions and next steps.

The Slack icon on a row opens a popover with one row per thread. Each row shows the channel, author, replies and summary. A check badge means threads link the item. A cross badge means a search found none.

Radar never updates issues by itself. Hover a thread and click "Post to issue/PR" twice to add one comment with its context and link. Radar never searches private channels or DMs.

## CLI and agent skill

`bb radar` lists lanes and items, adds or edits lanes, sets focus and hides single items. Agents use the `radar` skill to answer "what needs my review?".

## Requirements

- Sign in to GitHub with `gh`.
- For Delta, sign in with `dt` and set the host and repo in settings. Rebase also needs a checkout path.
- For Gitstream history, install `gs` and turn on the history toggle.
- Lane and focus drafting needs a bb build with configured-provider AI. The alternative is an optional OpenAI-compatible fallback. Settings need a base URL, the name of the server env var that holds the key, and a model.
- Without AI, Focus matches repo and area names.
