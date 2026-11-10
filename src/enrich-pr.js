'use strict';

const { renderTicketComment, tagNames, taskIdFromComment } = require('./comment');
const { createClickUpClient } = require('./clickup');
const { discoverTickets, loadTaskTypes } = require('./discover');
const { extractRefs } = require('./refs');

// GitHub rejects label names longer than this, and one bad name fails the whole addLabels call.
const MAX_LABEL_LENGTH = 50;
const MAX_DESCRIPTION_LIMIT = 60000;

function readBoolean(value, fallback) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === '') return fallback;
  return text === 'true';
}

function readInputs(env) {
  const limit = Number.parseInt(env.COMMENT_DESCRIPTION_LIMIT, 10);
  return {
    clickupApiToken: (env.CLICKUP_API_TOKEN || '').trim(),
    clickupTeamId: (env.CLICKUP_TEAM_ID || '').trim(),
    prNumber: Number(env.PR_NUMBER),
    failOnNoTicket: readBoolean(env.FAIL_ON_NO_TICKET, true),
    postTicketComments: readBoolean(env.POST_TICKET_COMMENTS, true),
    // GitHub rejects comment bodies over 65,536 characters; leave room for the rest of the comment
    descriptionLimit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_DESCRIPTION_LIMIT) : 4000,
  };
}

// Each ticket's tags, its parent's tags and its task type, de-duplicated the way GitHub compares
// label names (case-insensitively), keeping the first spelling seen.
function collectLabels(tickets) {
  const seen = new Set();
  const labels = [];
  for (const { task, parent, type } of tickets) {
    for (const name of [...tagNames(task), ...tagNames(parent), type]) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key) || name.length > MAX_LABEL_LENGTH) continue;
      seen.add(key);
      labels.push(name);
    }
  }
  return labels;
}

// One call for every label. If GitHub rejects the batch as invalid, each label is retried alone
// so one bad name can't cost the PR the others.
async function applyLabels({ github, owner, repo, prNumber, labels, core }) {
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels });
    return;
  } catch (error) {
    if (error.status !== 422 || labels.length === 1) throw error;
    core.warning(`GitHub rejected the labels as a batch (${error.message}); applying them one at a time`);
  }
  for (const label of labels) {
    try {
      await github.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [label] });
    } catch (error) {
      if (error.status !== 422) throw error;
      core.warning(`Could not apply label '${label}': ${error.message}`);
    }
  }
}

// One comment per linked ticket, keyed by the task's internal ID in a hidden marker: rewritten in
// place on every run, never duplicated, and removed once the ticket is no longer linked. A comment
// is never removed on the strength of a failed lookup.
async function syncTicketComments({
  github,
  owner,
  repo,
  prNumber,
  tickets,
  protectedIds = new Set(),
  failed,
  descriptionLimit,
  core,
}) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const ours = comments
    .map((comment) => ({ id: comment.id, body: comment.body, taskId: taskIdFromComment(comment.body) }))
    .filter((comment) => comment.taskId);

  if (tickets.length === 0) core.info('⚠️ No ClickUp tickets linked - nothing to comment');

  const linkedIds = new Set(tickets.map((ticket) => ticket.task.id));
  const kept = new Set();

  for (const ticket of tickets) {
    const body = renderTicketComment(ticket, { descriptionLimit });
    const existing = ours.find((comment) => comment.taskId === ticket.task.id);
    if (!existing) {
      core.info(`   → Creating comment for ticket ${ticket.task.id}`);
      await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
      continue;
    }
    kept.add(existing.id);
    if (existing.body === body) {
      core.info(`   → Comment ${existing.id} for ticket ${ticket.task.id} is already current`);
    } else {
      core.info(`   → Updating comment ${existing.id} for ticket ${ticket.task.id}`);
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    }
  }

  for (const comment of ours) {
    if (kept.has(comment.id)) continue;
    const duplicate = linkedIds.has(comment.taskId);
    if (!duplicate && (failed || protectedIds.has(comment.taskId))) {
      core.info(`   → Keeping comment ${comment.id}: a ClickUp lookup failed, so it may still be linked`);
      continue;
    }
    core.info(`   → Removing ${duplicate ? 'duplicate' : 'stale'} comment ${comment.id} for ticket ${comment.taskId}`);
    await github.rest.issues.deleteComment({ owner, repo, comment_id: comment.id });
  }
}

async function run({ github, context, core, inputs, fetchImpl }) {
  const { owner, repo } = context.repo;
  const { prNumber } = inputs;

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    core.setFailed('❌ pr_number must be a pull request number, e.g. ${{ github.event.pull_request.number }}');
    return;
  }
  if (inputs.clickupApiToken) {
    core.setSecret(inputs.clickupApiToken);
  } else {
    core.warning('clickup_api_token is empty, so no ClickUp ticket can be looked up');
  }

  core.info(`🔎 Fetching metadata for PR #${prNumber}...`);
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });

  core.info('🔎 Extracting ClickUp ticket IDs from PR...');
  const refs = extractRefs([pr.title, pr.body]);
  if (refs.length === 0) {
    core.info('❌ No ticket numbers found');
  } else {
    core.info(`🚀 Found tickets: ${refs.map((ref) => `#${ref.id}`).join(',')}`);
  }

  const client = createClickUpClient({ apiToken: inputs.clickupApiToken, fetchImpl });
  const types = refs.length > 0 ? await loadTaskTypes(client, inputs.clickupTeamId, core) : new Map();
  const { tickets, protectedIds, failed, lookupFailed } = await discoverTickets(client, {
    refs,
    teamId: inputs.clickupTeamId,
    types,
    core,
  });

  // Labels first, so a failed comment call can't also cost the PR its labels
  const labels = collectLabels(tickets);
  if (labels.length > 0) {
    core.info(`🏷️ Applying labels to PR #${prNumber}: ${labels.join(', ')}`);
    await applyLabels({ github, owner, repo, prNumber, labels, core });
  } else if (tickets.length > 0) {
    core.info('🏷️ The linked tickets carry no labels - nothing to apply');
  }

  if (inputs.postTicketComments) {
    core.info(`💬 Syncing ClickUp ticket comments on PR #${prNumber}...`);
    await syncTicketComments({
      github,
      owner,
      repo,
      prNumber,
      tickets,
      protectedIds,
      failed,
      descriptionLimit: inputs.descriptionLimit,
      core,
    });
  }

  if (refs.length === 0) {
    if (inputs.failOnNoTicket) core.setFailed('❌ No ClickUp Ticket Linked');
    else core.warning('No ClickUp ticket is linked to this PR');
  } else if (labels.length === 0 && inputs.failOnNoTicket) {
    const hint = lookupFailed ? ' - a ClickUp lookup failed, see the warnings above' : '';
    core.setFailed(`❌ No ClickUp Labels Found${hint}`);
  }
}

module.exports = { applyLabels, collectLabels, readInputs, run, syncTicketComments };
