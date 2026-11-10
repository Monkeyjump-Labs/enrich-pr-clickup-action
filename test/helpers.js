'use strict';

function fakeCore() {
  const core = {
    logs: [],
    warnings: [],
    failures: [],
    secrets: [],
    info: (message) => core.logs.push(message),
    warning: (message) => core.warnings.push(message),
    setFailed: (message) => core.failures.push(message),
    setSecret: (value) => core.secrets.push(value),
  };
  return core;
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

const NOT_FOUND = { err: 'Task not found, deleted', ECODE: 'ITEM_013' };
const AUTH_ERROR = { err: 'Oauth token not found', ECODE: 'OAUTH_019' };

// A stand-in for api.clickup.com that routes on the request path and records every request.
// `tasks` maps internal ID -> task; `custom` maps custom ID -> internal ID; `types` is the
// workspace's custom task types; `failing` holds IDs (or 'types') whose lookup fails with an auth
// error.
function fakeClickUp({ tasks = {}, custom = {}, types = [], failing = [] } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, headers: init.headers });
    const typeMatch = parsed.pathname.match(/\/team\/([^/]+)\/custom_item$/);
    if (typeMatch) {
      if (failing.includes('types')) return jsonResponse(AUTH_ERROR, 401);
      return jsonResponse({ custom_items: types });
    }
    const taskMatch = parsed.pathname.match(/\/task\/([^/]+)$/);
    if (taskMatch) {
      const ref = decodeURIComponent(taskMatch[1]);
      if (failing.includes(ref)) return jsonResponse(AUTH_ERROR, 401);
      const id = parsed.searchParams.get('custom_task_ids') === 'true' ? custom[ref] : ref;
      const task = id && tasks[id];
      return task ? jsonResponse(task) : jsonResponse(NOT_FOUND, 404);
    }
    throw new Error(`Unexpected ClickUp request: ${url}`);
  };
  return { fetchImpl, requests };
}

function task(id, overrides = {}) {
  return {
    id,
    custom_id: null,
    name: `Task ${id}`,
    url: `https://app.clickup.com/t/${id}`,
    description: `Description of ${id}`,
    status: { status: 'in progress' },
    priority: { priority: 'high' },
    assignees: [{ username: 'jane' }],
    due_date: null,
    list: { name: 'Sprint 1' },
    tags: [],
    parent: null,
    custom_item_id: null,
    ...overrides,
  };
}

function tags(...names) {
  return names.map((name) => ({ name }));
}

module.exports = { AUTH_ERROR, NOT_FOUND, fakeClickUp, fakeCore, jsonResponse, tags, task };
