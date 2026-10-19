---
name: radar-review
description: How to review a pull request that was opened from the Radar panel (GitHub, Delta, or read-only Gitstream history). Use in Radar review threads to gather the PR, review it, and report findings without acting on the PR.
---

# Reviewing a PR from Radar

The opening message names the PR (`owner/repo#number`), its URL, and the CLI to use
for its host:

| Host | CLI |
| --- | --- |
| GitHub | `gh pr view N -R owner/repo`, `gh pr diff`, `gh pr checks`, `gh api .../comments` |
| Delta | `dt --host <host> -R owner/repo pr view N`, `pr diff`, `pr checks` (the host is in the message) |
| Gitstream history | `gs` reads only. Gitstream no longer accepts PR writes; if the work moved to Delta, find the matching Delta PR (`dt pr list --head <branch>`) and review that |

## Steps

1. Read the description, the full diff, CI checks and the existing review threads.
   Note what earlier reviewers already raised so you do not repeat it.
2. For large diffs, read the changed files around each hunk, not only the hunk.
   Trace callers of changed public functions before calling a change safe.
3. Check: correctness and edge cases, data safety and reversibility, missing or weak
   tests, security, performance, and whether the description matches the code.
4. If CI is red, say whether the failure is caused by this PR or is unrelated.

## Report

Lead with a one-line verdict (ready / needs changes / blocked) and why. Then list
findings, most severe first, each with `path:line`, what is wrong, and a concrete fix.
Mark each as blocking, suggestion or question. Skip praise and style nits a linter
would catch. End with what you did not check.

## Hard rules

- Do not post comments, approve, request changes, push, or merge until the user says so.
- When the user asks you to post, show the exact text and destination first.
