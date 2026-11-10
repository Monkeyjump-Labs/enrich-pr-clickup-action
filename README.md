# enrich-pr-clickup-action

A GitHub Action that enriches a pull request with the ClickUp tickets it refers to. Its Linear
counterpart is [`enrich-pr-linear-action`](https://github.com/Monkeyjump-Labs/enrich-pr-linear-action).

For every ClickUp ticket a PR refers to, it:

1. Applies the ticket's ClickUp tags, its parent ticket's tags and its task type as GitHub labels.
2. Posts one PR comment summarizing the ticket, so reviewers, including AI reviewers that read PR
   comments as context, can see it without leaving the PR. Disable with `post_ticket_comments: false`.

## How tickets are found

The action reads the PR title and body for a `#` followed by a ticket ID:

- **Standard ClickUp IDs**: `#86abc123` (6 or more letters and digits).
- **Custom task IDs**: `#SMART-1234`, `#HERO-4` (PREFIX-NUMBER). These need the `clickup_team_id`
  input. See [Custom task IDs](#custom-task-ids).

A ticket named more than once, or by both its custom ID and its internal ID, is handled once.

## Usage

```yaml
name: Sync ClickUp Labels to PR

on:
  pull_request:
    types: [opened, edited, synchronize]

permissions: {}

concurrency:
  group: clickup-sync-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  enrich_pr:
    name: Enrich PR
    # Fork and Dependabot PRs get no repository secrets, so there is no ClickUp token to use
    if: github.actor != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: Monkeyjump-Labs/enrich-pr-clickup-action@v2
        with:
          pr_number: ${{ github.event.pull_request.number }}
          clickup_api_token: ${{ secrets.CLICKUP_API_TOKEN }}
          clickup_team_id: ${{ vars.CLICKUP_TEAM_ID }}
```

### Fork and Dependabot PRs

Skip them, as the example does. GitHub gives neither a fork PR nor a Dependabot PR the repository's
Actions secrets, so `clickup_api_token` arrives empty. The action then can't look up any ticket. It
warns, and with `fail_on_no_ticket` on (the default) the run fails with `No ClickUp Labels Found`.

### Custom task IDs

ClickUp only resolves a custom task ID such as `SMART-1234` within a workspace, so custom IDs need
`clickup_team_id`. The team ID is the number at the start of a ClickUp URL: in
`https://app.clickup.com/1234567/...` it is `1234567`. The team ID also turns on task type labels.

### Inputs

| Input                       | Required | Default               | Description                                                              |
| --------------------------- | -------- | --------------------- | ------------------------------------------------------------------------ |
| `clickup_api_token`         | Yes      |                       | ClickUp API token that can read the linked tickets                       |
| `clickup_team_id`           | No\*     |                       | ClickUp workspace ID. \*Needed for custom task IDs and task type labels  |
| `github_token`              | No       | `${{ github.token }}` | Token used to read the PR and write labels and comments                  |
| `pr_number`                 | Yes      |                       | The PR to enrich                                                         |
| `fail_on_no_ticket`         | No       | `true`                | Fail when the PR names no ticket, or its tickets give no labels          |
| `post_ticket_comments`      | No       | `true`                | Post and refresh one PR comment per linked ticket                        |
| `comment_description_limit` | No       | `4000`                | Ticket description characters to include before truncating (max `60000`) |

The action has no outputs.

### Labels

Each linked ticket contributes its ClickUp tags, its parent ticket's tags, and its task type in lower
case (for example `bug`). A generic type (`Task` or `Item`) falls back to the parent's type and is
otherwise left out. Labels that don't exist yet are created by GitHub. A name longer than GitHub's
50-character limit is skipped.

With `fail_on_no_ticket` on, the step fails when the PR names no ticket (`No ClickUp Ticket Linked`)
or when its tickets give no labels (`No ClickUp Labels Found`). Labels and comments are applied before
the step fails.

## Ticket context comments

With `post_ticket_comments` on (the default), each linked ticket gets one comment with its heading,
link, status, task type, priority, assignees, due date, list, tags, parent ticket and description.

The comment begins with a hidden marker, `<!-- clickup-ticket:<internal task id> -->`. The marker
keeps the comments idempotent:

- **No duplicates.** A ticket that already has a comment gets that comment rewritten in place, so
  pushes and PR description edits refresh the context instead of adding more comments.
- **One comment per ticket**, keyed by ClickUp's internal task ID. `#SMART-123` and the same task's
  internal ID produce one comment.
- **Unlinked tickets are cleaned up.** A comment for a ticket the PR no longer refers to is removed.
  A failed ClickUp lookup never removes a comment: a failed internal-ID lookup keeps that ticket's
  comment, and a failed custom-ID lookup keeps every comment, because it could name any task.

Ticket text is inserted as data only and is never interpolated into a command. The comment also
labels itself as reference material rather than instructions, because AI reviewers read PR comments.

> **Note:** AI review workflows usually read PR comments once, when the review starts. A review
> triggered by the same `pull_request` event as this action may start before the comment exists.
> The comment is there for any later review of that PR.

## Releasing

Releases are cut by the **Release** workflow, never by pushing tags by hand:

```bash
gh workflow run release.yml -f version=2.1.0
```

The workflow runs the full CI suite against `main`, then:

1. Tags that commit as `v2.1.0`.
2. Publishes a GitHub release with generated notes.
3. Moves the floating `v2` tag to it, so consumers pinned to `@v2` get the release. The tag only moves
   forward: it stays put when a newer `v2.x.y` exists, and the run stops before tagging when the
   release commit doesn't contain the commit `v2` points at now.

A pre-release version such as `2.2.0-rc.1` is published as a pre-release and leaves `v2` alone. If a
run fails after creating the tag, it deletes the tag and release so the same version can be retried.
Bump the major version for any breaking change to an input, the label set or the comment marker.

## Development

```bash
npm ci
npm test              # node:test unit suite with coverage
npm run format:check  # prettier
```

The action is a composite action that runs [`src/enrich-pr.js`](src/enrich-pr.js) inside
`actions/github-script`. It has no runtime dependencies, so there is no build step and no `dist/` to
commit. CI runs the unit suite, Prettier, `actionlint` and `zizmor`, and a smoke test workflow runs the
action from the PR's own checkout against that PR.
