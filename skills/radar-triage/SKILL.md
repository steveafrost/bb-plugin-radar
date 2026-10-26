---
name: radar-triage
description: How to triage an issue opened from the Radar panel (GitHub or Delta). Use in Radar triage threads to understand the issue, find related code and history, and propose next steps without changing the issue.
---

# Triaging an issue from Radar

The opening message names the issue (`owner/repo#number`) and its URL.

- GitHub: `gh issue view N -R owner/repo --comments`
- Delta has pull requests only, so Radar never opens Delta issues; for a Delta PR use the radar-review skill.

## Steps

1. Read the issue, every comment, labels, assignees and linked PRs or issues.
2. Work out what is actually being asked, and whether it is a bug, a feature request,
   a question or a duplicate. Search for duplicates and related open PRs.
3. If a project checkout is available, find the code the issue concerns and cite
   `path:line`. For bugs, say whether you could confirm the behaviour and how.

## Report

- **Ask:** one or two sentences in plain words.
- **Status:** what already exists (related PRs, prior fixes, duplicates).
- **Unclear:** the questions the reporter or owner must answer.
- **Proposal:** next steps, rough size, and who likely owns it.

## Hard rules

- Do not comment on, label, assign, close or edit the issue until the user says so.
- When the user asks you to post, show the exact text and destination first.
