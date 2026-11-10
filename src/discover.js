'use strict';

const { fetchCustomTaskTypes, fetchTask, fetchTaskByCustomId } = require('./clickup');

// Task types that say nothing about the work, so they never become a label.
const GENERIC_TYPES = new Set(['task', 'item']);

// The workspace's custom task types, as { types, failed }: types is empty when there is no team ID
// or the lookup fails. Types only add a label, so a failure here is a warning and never stops the
// run; `failed` lets the caller say why a ticket ended up with no labels.
async function loadTaskTypes(client, teamId, core) {
  if (!teamId) {
    core.info('⚠️ No clickup_team_id provided - task type detection disabled');
    return { types: new Map(), failed: false };
  }
  core.info(`🔍 Fetching custom task types for team ${teamId}...`);
  try {
    const types = await fetchCustomTaskTypes(client, teamId);
    for (const [id, name] of types) core.info(`   → Registered type: ${name} (id: ${id})`);
    core.info(`✅ Loaded ${types.size} custom task types`);
    return { types, failed: false };
  } catch (error) {
    core.warning(`Could not load ClickUp task types, so no type label is added: ${error.message}`);
    return { types: new Map(), failed: true };
  }
}

function typeName(task, types) {
  if (!task || task.custom_item_id == null) return '';
  const name = types.get(String(task.custom_item_id));
  if (!name) return '';
  const lower = name.toLowerCase();
  return GENERIC_TYPES.has(lower) ? '' : lower;
}

// The task's type as a lower-case label, falling back to its parent's type when the task's own
// type is unknown or generic (task/item). Empty when neither has a useful type.
function resolveType(task, parent, types) {
  return typeName(task, types) || typeName(parent, types);
}

// Finds the ClickUp tickets the refs name. Returns:
// - tickets: [{ task, parent, ref, type }] in order, one per distinct task.
// - protectedIds: internal IDs whose lookup failed; their existing comments must be kept.
// - failed: a custom ref could not be looked up, so it may name any task and no comment for an
//   unlisted task may be removed.
// - lookupFailed: any lookup failed, a parent's included, for reporting.
// A lookup that fails for any reason other than "no such task" is never read as an unlinked ticket.
async function discoverTickets(client, { refs, teamId, types = new Map(), core }) {
  const tickets = [];
  const protectedIds = new Set();
  const seen = new Set();
  const parents = new Map();
  let failed = false;
  let lookupFailed = false;

  for (const ref of refs) {
    let task;
    if (ref.custom) {
      core.info(`🚀 Custom ID detected: ${ref.id}`);
      if (!teamId) {
        core.warning(`Custom ID '${ref.id}' detected but no clickup_team_id provided. Cannot resolve.`);
        failed = true;
        lookupFailed = true;
        continue;
      }
      try {
        task = await fetchTaskByCustomId(client, ref.id, teamId);
      } catch (error) {
        core.warning(`Could not look up ClickUp ticket ${ref.id}: ${error.message}`);
        failed = true;
        lookupFailed = true;
        continue;
      }
    } else {
      try {
        task = await fetchTask(client, ref.id);
      } catch (error) {
        core.warning(`Could not look up ClickUp ticket ${ref.id}: ${error.message}`);
        // Internal IDs are lower case; the ref is as written on the PR
        protectedIds.add(ref.id.toLowerCase());
        lookupFailed = true;
        continue;
      }
    }

    if (!task) {
      core.info(`🚫 #${ref.id} is not a ClickUp ticket - ignoring it`);
      continue;
    }
    // A custom ref and a raw ref can name the same task; fetch, label and comment once
    if (seen.has(task.id)) {
      core.info(`⏭️ Ticket ${task.id} already processed - skipping duplicate ref #${ref.id}`);
      continue;
    }
    seen.add(task.id);
    // A linked ticket that is also another linked ticket's parent is fetched once
    if (!parents.get(task.id)) parents.set(task.id, task);
    core.info(
      `✅ Found ClickUp ticket ${task.custom_id || task.id}: ${task.name} (https://app.clickup.com/t/${task.id})`,
    );

    // A parent the token can't read costs the ticket its parent's labels, nothing more
    let parent = null;
    if (typeof task.parent === 'string' && task.parent) {
      if (!parents.has(task.parent)) {
        try {
          core.info(`🚀 Getting labels for parent ticket #${task.parent}`);
          parents.set(task.parent, await fetchTask(client, task.parent));
        } catch (error) {
          core.warning(`Could not look up parent ticket ${task.parent} of ${ref.id}: ${error.message}`);
          parents.set(task.parent, null);
          lookupFailed = true;
        }
      }
      parent = parents.get(task.parent);
    }

    const type = resolveType(task, parent, types);
    if (type) core.info(`✅ Detected task type: '${type}'`);
    tickets.push({ task, parent, ref: ref.id, type });
  }

  return { tickets, protectedIds, failed, lookupFailed };
}

module.exports = { discoverTickets, loadTaskTypes, resolveType };
