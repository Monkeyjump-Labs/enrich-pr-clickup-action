# enrich-pr-clickup-action
A github action to enrich a particular PR with Clickup labels.

## Supported Ticket ID Formats

This action extracts ClickUp ticket IDs from your PR title and body. It supports:

- **Standard ClickUp IDs**: `#abc123def` (6+ alphanumeric characters)
- **Custom ClickUp IDs**: `#MY-1`, `#HERO-4`, `#DEV-123` (PREFIX-NUMBER format)

> **Note:** Custom IDs require the `clickup_team_id` input. See [Using Custom Task IDs](#using-custom-task-ids) below.

## Usage

To use this action, add a github action to your repository that is similar to the below:

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
    clickup_team_id: '1234567'  # Required for custom IDs like #ENG-123
```

### Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `clickup_api_token` | Yes | ClickUp API token with access to retrieve ticket information |
| `clickup_team_id` | No* | ClickUp team/workspace ID. *Required if using custom task IDs |
| `github_token` | No | GitHub token (defaults to `${{ github.token }}`) |
| `pr_number` | Yes | The PR number to apply labels to |
| `fail_on_no_ticket` | No | Fail if no ticket found (default: `true`) |
