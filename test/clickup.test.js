'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  ClickUpApiError,
  classifyError,
  createClickUpClient,
  fetchCustomTaskTypes,
  fetchTask,
  fetchTaskByCustomId,
} = require('../src/clickup');
const { AUTH_ERROR, NOT_FOUND, fakeClickUp, jsonResponse, task } = require('./helpers');

function clientFor(response) {
  return createClickUpClient({ apiToken: 'pk_1', fetchImpl: async () => response });
}

describe('classifyError', () => {
  it('reads 404 and a non-auth "not found" as a missing task', () => {
    assert.equal(classifyError(404, {}).notFound, true);
    assert.equal(classifyError(400, NOT_FOUND).notFound, true);
  });

  it('never reads an auth error as a missing task, even one that says "not found"', () => {
    const error = classifyError(401, AUTH_ERROR);
    assert.equal(error.notFound, false);
    assert.equal(error.code, 'OAUTH_019');
    assert.match(error.message, /Oauth token not found — OAUTH_019/);
    assert.equal(classifyError(401, { err: 'Team not authorized', ECODE: 'OAUTH_027' }).notFound, false);
    assert.equal(classifyError(500, null).notFound, false);
  });
});

describe('createClickUpClient', () => {
  it('sends the token as-is and encodes the path and parameters', async () => {
    const clickup = fakeClickUp({ tasks: { abc123: task('abc123') } });
    const client = createClickUpClient({ apiToken: ' pk_token ', fetchImpl: clickup.fetchImpl });
    await client.request('task/abc123', { team_id: '9 9' });
    assert.equal(clickup.requests[0].headers.Authorization, 'pk_token');
    assert.equal(clickup.requests[0].url.searchParams.get('team_id'), '9 9');
    assert.equal(clickup.requests[0].url.origin, 'https://api.clickup.com');
  });

  it('refuses to send a request without a token', async () => {
    const clickup = fakeClickUp();
    const client = createClickUpClient({ apiToken: '', fetchImpl: clickup.fetchImpl });
    await assert.rejects(client.request('task/x'), /clickup_api_token is empty/);
    assert.equal(clickup.requests.length, 0);
  });

  it('wraps network errors and non-JSON responses as lookup failures', async () => {
    const offline = createClickUpClient({
      apiToken: 'pk',
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await assert.rejects(offline.request('task/x'), (error) => {
      assert.ok(error instanceof ClickUpApiError);
      assert.equal(error.notFound, false);
      return /Could not reach ClickUp: ECONNRESET/.test(error.message);
    });

    const html = {
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    };
    await assert.rejects(clientFor(html).request('task/x'), /non-JSON response \(HTTP 502\)/);
    await assert.rejects(clientFor({ ...html, status: 404 }).request('task/x'), { notFound: false });
  });

  it('treats an err field as a failure even on HTTP 200', async () => {
    await assert.rejects(clientFor(jsonResponse({ err: 'Rate limited', ECODE: 'RATE_001' })).request('task/x'), {
      notFound: false,
    });
  });
});

describe('fetchTask', () => {
  it('returns the task, or null when it does not exist', async () => {
    const clickup = fakeClickUp({ tasks: { abc123: task('abc123') } });
    const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
    assert.equal((await fetchTask(client, 'abc123')).name, 'Task abc123');
    assert.equal(await fetchTask(client, 'zzz999'), null);
  });

  it('throws when the lookup itself fails', async () => {
    const clickup = fakeClickUp({ failing: ['abc123'] });
    const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
    await assert.rejects(fetchTask(client, 'abc123'), { code: 'OAUTH_019' });
  });

  it('returns null for a response that is not a task', async () => {
    assert.equal(await fetchTask(clientFor(jsonResponse({})), 'abc123'), null);
  });
});

describe('fetchTaskByCustomId', () => {
  it('scopes the lookup to the workspace', async () => {
    const clickup = fakeClickUp({ tasks: { abc123: task('abc123') }, custom: { 'SMART-1': 'abc123' } });
    const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
    assert.equal((await fetchTaskByCustomId(client, 'SMART-1', '42')).id, 'abc123');
    const params = clickup.requests[0].url.searchParams;
    assert.equal(params.get('custom_task_ids'), 'true');
    assert.equal(params.get('team_id'), '42');
    assert.equal(await fetchTaskByCustomId(client, 'SMART-2', '42'), null);
  });

  it('throws when the lookup itself fails', async () => {
    const clickup = fakeClickUp({ failing: ['SMART-1'] });
    const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
    await assert.rejects(fetchTaskByCustomId(client, 'SMART-1', '42'), { notFound: false });
  });
});

describe('fetchCustomTaskTypes', () => {
  it('maps type IDs to names, skipping malformed entries', async () => {
    const clickup = fakeClickUp({ types: [{ id: 1001, name: 'Bug' }, { id: 1002 }, null] });
    const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
    assert.deepEqual([...(await fetchCustomTaskTypes(client, '42'))], [['1001', 'Bug']]);
    assert.equal(clickup.requests[0].url.pathname, '/api/v2/team/42/custom_item');
  });

  it('returns an empty map when the workspace has none', async () => {
    assert.equal((await fetchCustomTaskTypes(clientFor(jsonResponse({})), '42')).size, 0);
  });
});
