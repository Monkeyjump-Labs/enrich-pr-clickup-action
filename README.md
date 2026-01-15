# enrich-pr-clickup-action
A github action to enrich a particular PR with Clickup labels.

## Supported Ticket ID Formats

This action extracts ClickUp ticket IDs from your PR title and body. It supports:

- **Standard ClickUp IDs**: `#abc123def` (6+ alphanumeric characters)
- **Custom ClickUp IDs**: `#MY-1`, `#HERO-4`, `#DEV-123` (PREFIX-NUMBER format)

## Usage

To use this action, add a github action to your repository that is similar to the below:

```
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
