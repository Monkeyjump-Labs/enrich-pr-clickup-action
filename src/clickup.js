'use strict';

const CLICKUP_API_URL = 'https://api.clickup.com/api/v2/';

class ClickUpApiError extends Error {
  constructor(message, { status, code, notFound = false } = {}) {
    super(message);
    this.name = 'ClickUpApiError';
    this.status = status;
    this.code = code;
    this.notFound = notFound;
  }
}

// Only a 404, or an error saying the task itself is not found, that is not an auth error means the
// task does not exist. ClickUp reports a bad or revoked token as OAUTH_019 "Oauth token not found",
// and a workspace the token can't see as OAUTH_027, so neither may be read as a missing task; nor
// may "Team not found" from a wrong clickup_team_id.
function classifyError(status, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const code = typeof body.ECODE === 'string' ? body.ECODE : undefined;
  const text = typeof body.err === 'string' ? body.err : '';
  const authError = Boolean(code && code.startsWith('OAUTH_'));
  const notFound = !authError && (status === 404 || /\btask not found\b/i.test(text));
  const detail = [text || `HTTP ${status}`, code].filter(Boolean).join(' — ');
  return new ClickUpApiError(`ClickUp API error: ${detail}`, { status, code, notFound });
}

function createClickUpClient({ apiToken, fetchImpl = globalThis.fetch, baseUrl = CLICKUP_API_URL } = {}) {
  const token = String(apiToken || '').trim();

  async function request(path, params = {}) {
    if (!token) throw new ClickUpApiError('clickup_api_token is empty, so ClickUp cannot be queried');
    const url = new URL(path, baseUrl);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: token, Accept: 'application/json' },
      });
    } catch (error) {
      throw new ClickUpApiError(`Could not reach ClickUp: ${error.message}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      // Even a 404 here is a proxy or outage page rather than ClickUp saying the task is gone
      throw new ClickUpApiError(`ClickUp returned a non-JSON response (HTTP ${response.status})`, {
        status: response.status,
      });
    }

    if (!response.ok || (payload && typeof payload === 'object' && payload.err)) {
      throw classifyError(response.status, payload);
    }
    return payload;
  }

  return { request };
}

function taskPath(id) {
  return `task/${encodeURIComponent(id)}`;
}

// The task the response describes. A successful response that is not a task is a failed lookup,
// never a missing ticket, so it can't cost a still-linked ticket its comment.
function asTask(payload) {
  if (payload && typeof payload === 'object' && payload.id) return payload;
  throw new ClickUpApiError('ClickUp returned a response that is not a task');
}

// Returns null when ClickUp says the task does not exist; throws ClickUpApiError for anything that
// means the lookup itself failed.
async function lookupTask(client, path, params) {
  let payload;
  try {
    payload = await client.request(path, params);
  } catch (error) {
    if (error instanceof ClickUpApiError && error.notFound) return null;
    throw error;
  }
  return asTask(payload);
}

// Fetches a task by its internal ID.
function fetchTask(client, id) {
  return lookupTask(client, taskPath(id), { include_markdown_description: 'true' });
}

// Fetches a task by its custom ID (SMART-1234), which ClickUp only resolves within a workspace.
function fetchTaskByCustomId(client, customId, teamId) {
  return lookupTask(client, taskPath(customId), {
    custom_task_ids: 'true',
    team_id: teamId,
    include_closed: 'true',
    include_subtasks: 'true',
    include_markdown_description: 'true',
  });
}

// The workspace's custom task types, as a map of type ID (a string) to type name.
async function fetchCustomTaskTypes(client, teamId) {
  const payload = await client.request(`team/${encodeURIComponent(teamId)}/custom_item`);
  const types = new Map();
  for (const item of (payload && payload.custom_items) || []) {
    if (item && item.id != null && item.name) types.set(String(item.id), item.name);
  }
  return types;
}

module.exports = {
  CLICKUP_API_URL,
  ClickUpApiError,
  classifyError,
  createClickUpClient,
  fetchCustomTaskTypes,
  fetchTask,
  fetchTaskByCustomId,
};
