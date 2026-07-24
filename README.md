# enrich-pr-clickup-action

A GitHub Action to enrich a particular PR with Clickup labels and ticket context.

It does two things with the ClickUp tickets referenced by a PR:

1. Applies the tickets' ClickUp tags and task type as GitHub labels.
2. Posts one PR comment per ticket summarizing it, so reviewers — including AI reviewers, which read
   PR comments as context — can see the ticket without leaving the PR. Disable with
   `post_ticket_comments: false`.

## Supported Ticket ID Formats

This action extracts ClickUp ticket IDs from your PR title and body. It supports:

- **Standard ClickUp IDs**: `#abc123def` (6+ alphanumeric characters)
- **Custom ClickUp IDs**: `#MY-1`, `#HERO-4`, `#DEV-123` (PREFIX-NUMBER format)

> **Note:** Custom IDs require the `clickup_team_id` input. See [Using Custom Task IDs](#using-custom-task-ids) below.

## Usage

To use this action, add a GitHub Action to your repository that is similar to the below:

```yaml
name: Sync ClickUp Labels to PR

on:
  pull_request:
    types: [opened, edited, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  enrich_pr:
    name: Enrich PR
    runs-on: ubuntu-latest
    steps:
      - uses: Monkeyjump-Labs/enrich-pr-clickup-action@v1
        id: enrich_pr_with_clickup_info
        name: Enrich PR with clickup information
        with:
          pr_number: ${{ github.event.pull_request.number }}
          clickup_api_token: ${{ secrets.CLICKUP_API_TOKEN }}
```

That will trigger enrichment of your PR upon creation, editing, or synchronization.

## Using Custom Task IDs

ClickUp's API does not support fetching tasks directly by custom ID (e.g., `ENG-123`). The direct `/api/v2/task/{task_id}` endpoint only accepts ClickUp's internal task IDs.

To support custom task IDs, this action uses ClickUp's search endpoint, which requires a team/workspace ID to scope the search.

### Setup for Custom IDs

1. **Find your ClickUp Team ID**: Look at any ClickUp URL in your workspace. The team ID is the number after `/t/` in URLs like `https://app.clickup.com/1234567/...` — in this case, `1234567` is your team ID.

2. **Add the team ID to your workflow**:

```yaml
- uses: Monkeyjump-Labs/enrich-pr-clickup-action@v1
  with:
    pr_number: ${{ github.event.pull_request.number }}
    clickup_api_token: ${{ secrets.CLICKUP_API_TOKEN }}
    clickup_team_id: '1234567' # Required for custom IDs like #ENG-123
```

### Inputs

| Input                       | Required | Description                                                       |
| --------------------------- | -------- | ----------------------------------------------------------------- |
| `clickup_api_token`         | Yes      | ClickUp API token with access to retrieve ticket information      |
| `clickup_team_id`           | No\*     | ClickUp team/workspace ID. \*Required if using custom task IDs    |
| `github_token`              | No       | GitHub token (defaults to `${{ github.token }}`)                  |
| `pr_number`                 | Yes      | The PR number to apply labels to                                  |
| `fail_on_no_ticket`         | No       | Fail if no ticket found (default: `true`)                         |
| `post_ticket_comments`      | No       | Post/refresh a PR comment per linked ticket (default: `true`)     |
| `comment_description_limit` | No       | Ticket description characters before truncation (default: `4000`) |

## Ticket Context Comments

With `post_ticket_comments` enabled (the default), the action posts one comment per linked ticket
containing its heading, ClickUp URL, status, task type, priority, assignees, due date, list, tags,
parent ticket, and description.

The comment carries a hidden marker — `<!-- clickup-ticket:<internal task id> -->` on its first line
— which makes the behavior idempotent:

- **Never duplicated.** A ticket that already has a comment gets that comment rewritten in place, so
  pushes and PR description edits refresh the context instead of stacking up comments.
- **One comment per ticket**, keyed by ClickUp's internal task ID. Referencing the same task twice
  (say `#ENG-123` and its raw ID) yields a single comment.
- **Nothing posted when no ticket is linked**, and comments for tickets that are no longer referenced
  on the PR are removed. Cleanup is skipped whenever any ref failed to resolve, so a ClickUp API
  failure can't delete a still-valid comment.

Ticket text is inserted as data only — it is never interpolated into a command — and the comment
labels itself as reference material rather than instructions, since AI reviewers ingest PR comments.

Posting comments needs `pull-requests: write`, which the usage example above already grants.

> **Note:** AI review workflows typically read PR comments once, when the review starts. If a review
> is triggered by the same `pull_request` event as this action, it may begin before the comment
> exists; the comment will be present for any subsequent review of that PR.

## Running GitHub Actions locally

You can run registered GitHub Actions locally using [act](https://github.com/nektos/act), which simulates GitHub Actions on your machine.

### Prerequisites

- Install [act](https://github.com/nektos/act#installation)
- Docker must be running

### Running the Linter

From the repository root, run:

```bash
act pull_request
```

The repository includes an `.actrc` configuration file that automatically sets the required environment variables and event payload for the linter to work correctly.
