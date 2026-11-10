'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { markerFor, renderTicketComment } = require('../src/comment');
const { applyLabels, collectLabels, readInputs, run } = require('../src/enrich-pr');
const { fakeClickUp, fakeCore, tags, task } = require('./helpers');

const context = { repo: { owner: 'acme', repo: 'app' } };

function httpError(status, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

// An in-memory pull request with the slice of Octokit the action uses.
function fakeGithub({ pr = {}, comments = [], rejectLabel } = {}) {
  const state = {
    comments: comments.map((comment, index) => ({ id: index + 1, ...comment })),
    labels: [],
    calls: [],
  };
  let nextId = state.comments.length + 1;
  const record = (name, params) => state.calls.push({ name, params });
  const github = {
    paginate: async (method, params) => method(params).then((response) => response.data),
    rest: {
      pulls: {
        get: async (params) => {
          record('pulls.get', params);
          return { data: { number: params.pull_number, title: '', body: null, ...pr } };
        },
      },
      issues: {
        listComments: async (params) => {
          record('listComments', params);
          return { data: state.comments.map((comment) => ({ ...comment })) };
        },
        createComment: async (params) => {
          record('createComment', params);
          state.comments.push({ id: nextId++, body: params.body });
        },
        updateComment: async (params) => {
          record('updateComment', params);
          state.comments.find((comment) => comment.id === params.comment_id).body = params.body;
        },
        deleteComment: async (params) => {
          record('deleteComment', params);
          state.comments = state.comments.filter((comment) => comment.id !== params.comment_id);
        },
        addLabels: async (params) => {
          record('addLabels', params);
          if (rejectLabel && params.labels.some(rejectLabel)) throw httpError(422, 'Validation Failed');
          state.labels.push(...params.labels);
        },
      },
    },
  };
  return { github, state };
}

function inputs(overrides = {}) {
  return {
    clickupApiToken: 'pk_token',
    clickupTeamId: '42',
    prNumber: 7,
    failOnNoTicket: true,
    postTicketComments: true,
    descriptionLimit: 4000,
    ...overrides,
  };
}

async function enrich({ pr, comments, clickup: clickupOptions, inputs: inputOverrides, rejectLabel } = {}) {
  const { github, state } = fakeGithub({ pr, comments, rejectLabel });
  const clickup = fakeClickUp(clickupOptions);
  const core = fakeCore();
  await run({ github, context, core, inputs: inputs(inputOverrides), fetchImpl: clickup.fetchImpl });
  return { state, core, clickup };
}

const calls = (state, name) => state.calls.filter((c) => c.name === name);

describe('readInputs', () => {
  it('parses the action environment', () => {
    assert.deepEqual(
      readInputs({
        CLICKUP_API_TOKEN: ' pk_x ',
        CLICKUP_TEAM_ID: ' 42 ',
        PR_NUMBER: '12',
        FAIL_ON_NO_TICKET: 'false',
        POST_TICKET_COMMENTS: 'TRUE',
        COMMENT_DESCRIPTION_LIMIT: '100',
      }),
      {
        clickupApiToken: 'pk_x',
        clickupTeamId: '42',
        prNumber: 12,
        failOnNoTicket: false,
        postTicketComments: true,
        descriptionLimit: 100,
      },
    );
  });

  it('applies defaults for empty or invalid values and caps the description limit', () => {
    const parsed = readInputs({ COMMENT_DESCRIPTION_LIMIT: 'lots' });
    assert.equal(parsed.failOnNoTicket, true);
    assert.equal(parsed.postTicketComments, true);
    assert.equal(parsed.descriptionLimit, 4000);
    assert.equal(parsed.clickupTeamId, '');
    assert.equal(readInputs({ COMMENT_DESCRIPTION_LIMIT: '0' }).descriptionLimit, 4000);
    assert.equal(readInputs({ COMMENT_DESCRIPTION_LIMIT: '999999' }).descriptionLimit, 60000);
    assert.ok(Number.isNaN(parsed.prNumber));
  });
});

describe('collectLabels', () => {
  it('unions tags, parent tags and the type case-insensitively, dropping over-long names', () => {
    const tickets = [
      { task: task('a', { tags: tags('backend', 'Urgent') }), parent: task('p', { tags: tags('epic') }), type: 'bug' },
      { task: task('b', { tags: tags('BACKEND', 'x'.repeat(51)) }), parent: null, type: '' },
    ];
    assert.deepEqual(collectLabels(tickets), ['backend', 'Urgent', 'epic', 'bug']);
  });

  it('warns once about each over-long name it drops', () => {
    const long = 'x'.repeat(51);
    const tickets = [{ task: task('a', { tags: tags(long, long.toUpperCase()) }), parent: null, type: '' }];
    const core = fakeCore();
    assert.deepEqual(collectLabels(tickets, core), []);
    assert.equal(core.warnings.length, 1);
    assert.match(core.warnings[0], /at most 50 characters/);
  });
});

describe('applyLabels', () => {
  it('retries one label at a time when GitHub rejects the batch', async () => {
    const { github, state } = fakeGithub({ rejectLabel: (label) => label === 'bad' });
    const core = fakeCore();
    await applyLabels({ github, owner: 'acme', repo: 'app', prNumber: 7, labels: ['a', 'bad', 'b'], core });
    assert.deepEqual(state.labels, ['a', 'b']);
    assert.equal(core.warnings.length, 2);
    assert.match(core.warnings[1], /Could not apply label 'bad'/);
  });

  it('fails on anything other than a validation error', async () => {
    const { github } = fakeGithub();
    github.rest.issues.addLabels = async () => {
      throw httpError(403, 'Resource not accessible by integration');
    };
    await assert.rejects(
      applyLabels({ github, owner: 'acme', repo: 'app', prNumber: 7, labels: ['a', 'b'], core: fakeCore() }),
      { status: 403 },
    );
  });

  it('only warns when a lone label is rejected, and fails when a retry hits a non-validation error', async () => {
    const lone = fakeGithub({ rejectLabel: () => true });
    const core = fakeCore();
    await applyLabels({ github: lone.github, owner: 'o', repo: 'r', prNumber: 7, labels: ['bad'], core });
    assert.match(core.warnings[1], /Could not apply label 'bad'/);

    const { github } = fakeGithub();
    let call = 0;
    github.rest.issues.addLabels = async () => {
      call += 1;
      throw httpError(call === 1 ? 422 : 500);
    };
    await assert.rejects(
      applyLabels({ github, owner: 'o', repo: 'r', prNumber: 7, labels: ['a', 'b'], core: fakeCore() }),
      { status: 500 },
    );
  });
});

describe('run', () => {
  const linked = {
    tasks: {
      abc123: task('abc123', { custom_id: 'SMART-1', tags: tags('backend'), custom_item_id: 2 }),
      def456: task('def456', { tags: tags('frontend') }),
    },
    custom: { 'SMART-1': 'abc123' },
    types: [{ id: 2, name: 'Bug' }],
  };

  it('labels the PR and comments once per linked ticket', async () => {
    const { state, core, clickup } = await enrich({
      pr: { title: 'feat: login #SMART-1', body: 'Also #def456 and #SMART-1 again' },
      clickup: linked,
    });
    assert.deepEqual(core.failures, []);
    assert.deepEqual(state.labels, ['backend', 'bug', 'frontend']);
    assert.equal(calls(state, 'addLabels').length, 1);
    assert.equal(state.comments.length, 2);
    assert.ok(state.comments[0].body.startsWith(markerFor('abc123')));
    assert.ok(state.comments[1].body.startsWith(markerFor('def456')));
    assert.deepEqual(core.secrets, ['pk_token']);
    assert.equal(clickup.requests.filter((r) => r.url.pathname.includes('/task/')).length, 2);
  });

  it('applies labels before touching comments', async () => {
    const { state } = await enrich({ pr: { title: '#SMART-1' }, clickup: linked });
    const order = state.calls.map((c) => c.name).filter((name) => name !== 'pulls.get');
    assert.deepEqual(order, ['addLabels', 'listComments', 'createComment']);
  });

  it('keeps the labels when commenting fails', async () => {
    const { github, state } = fakeGithub({ pr: { title: '#SMART-1' } });
    github.rest.issues.createComment = async () => {
      throw httpError(500);
    };
    const clickup = fakeClickUp(linked);
    await assert.rejects(run({ github, context, core: fakeCore(), inputs: inputs(), fetchImpl: clickup.fetchImpl }), {
      status: 500,
    });
    assert.deepEqual(state.labels, ['backend', 'bug']);
  });

  it('rewrites an existing comment in place and leaves a current one alone', async () => {
    const current = renderTicketComment({
      task: linked.tasks.abc123,
      parent: null,
      ref: 'SMART-1',
      type: 'bug',
    });
    const { state } = await enrich({
      pr: { title: '#SMART-1 #def456' },
      comments: [{ body: current }, { body: `${markerFor('def456')}\nold text` }],
      clickup: linked,
    });
    assert.equal(calls(state, 'createComment').length, 0);
    assert.deepEqual(
      calls(state, 'updateComment').map((c) => c.params.comment_id),
      [2],
    );
  });

  it('removes comments for tickets that are no longer linked, and duplicates', async () => {
    const { state } = await enrich({
      pr: { title: '#def456' },
      comments: [
        { body: 'unrelated comment' },
        { body: `${markerFor('def456')}\nfirst` },
        { body: `${markerFor('def456')}\nduplicate` },
        { body: `${markerFor('zzz999')}\nstale` },
      ],
      clickup: linked,
    });
    assert.deepEqual(
      calls(state, 'deleteComment').map((c) => c.params.comment_id),
      [3, 4],
    );
  });

  it('keeps every unlinked comment when a custom ref could not be looked up', async () => {
    const { state, core } = await enrich({
      pr: { title: '#def456 #SMART-9' },
      comments: [{ body: `${markerFor('zzz999')}\nmaybe SMART-9` }, { body: `${markerFor('def456')}\ndup` }],
      clickup: { ...linked, failing: ['SMART-9'] },
    });
    assert.equal(calls(state, 'deleteComment').length, 0);
    assert.match(core.warnings[0], /Could not look up ClickUp ticket SMART-9/);
    assert.deepEqual(core.failures, []);
  });

  it('keeps the comment of an internal ref whose lookup failed, and cleans up the rest', async () => {
    const { state } = await enrich({
      pr: { title: '#def456 #aaa111' },
      comments: [{ body: `${markerFor('aaa111')}\nkeep me` }, { body: `${markerFor('zzz999')}\nstale` }],
      clickup: { ...linked, failing: ['aaa111'] },
    });
    assert.deepEqual(
      calls(state, 'deleteComment').map((c) => c.params.comment_id),
      [2],
    );
  });

  it('fails when no ticket is linked, after cleaning up stale comments', async () => {
    const { state, core, clickup } = await enrich({
      pr: { title: 'No ticket here', body: 'see #1234' },
      comments: [{ body: `${markerFor('zzz999')}\nstale` }],
    });
    assert.deepEqual(core.failures, ['❌ No ClickUp Ticket Linked']);
    assert.equal(state.comments.length, 0);
    assert.equal(calls(state, 'addLabels').length, 0);
    assert.equal(clickup.requests.length, 0);
  });

  it('only warns when no ticket is linked and fail_on_no_ticket is false', async () => {
    const { core } = await enrich({ inputs: { failOnNoTicket: false } });
    assert.deepEqual(core.failures, []);
    assert.deepEqual(core.warnings, ['No ClickUp ticket is linked to this PR']);
  });

  it('fails when the linked tickets carry no labels, after commenting', async () => {
    const { state, core } = await enrich({
      pr: { title: '#ghi789' },
      clickup: { tasks: { ghi789: task('ghi789') } },
    });
    assert.deepEqual(core.failures, ['❌ No ClickUp Labels Found']);
    assert.equal(state.comments.length, 1);
  });

  it('does not fail on missing labels when fail_on_no_ticket is false', async () => {
    const { core } = await enrich({
      pr: { title: '#ghi789' },
      clickup: { tasks: { ghi789: task('ghi789') } },
      inputs: { failOnNoTicket: false },
    });
    assert.deepEqual(core.failures, []);
  });

  it('says a lookup failed when ClickUp rejects the token', async () => {
    const { state, core } = await enrich({
      pr: { title: '#SMART-1' },
      comments: [{ body: `${markerFor('abc123')}\nkeep me` }],
      clickup: { failing: ['SMART-1', 'types'] },
    });
    assert.match(core.failures[0], /No ClickUp Labels Found - a ClickUp lookup failed/);
    assert.equal(state.comments.length, 1);
  });

  it('says a lookup failed when only the task types could not be loaded', async () => {
    const { core } = await enrich({
      pr: { title: '#abc123' },
      clickup: { tasks: { abc123: task('abc123', { custom_item_id: 2 }) }, failing: ['types'] },
    });
    assert.match(core.failures[0], /No ClickUp Labels Found - a ClickUp lookup failed/);
  });

  it('keeps the comment of an upper-case internal ref whose lookup failed', async () => {
    const { state } = await enrich({
      pr: { title: '#ABC123' },
      comments: [{ body: `${markerFor('abc123')}\nkeep me` }],
      clickup: { failing: ['ABC123'] },
      inputs: { failOnNoTicket: false },
    });
    assert.equal(state.comments.length, 1);
  });

  it('warns about an empty token and treats every lookup as failed', async () => {
    const { core, clickup, state } = await enrich({
      pr: { title: '#abc123' },
      comments: [{ body: `${markerFor('abc123')}\nkeep me` }],
      clickup: linked,
      inputs: { clickupApiToken: '', failOnNoTicket: false },
    });
    assert.match(core.warnings[0], /clickup_api_token is empty/);
    assert.equal(clickup.requests.length, 0);
    assert.deepEqual(core.secrets, []);
    assert.deepEqual(core.failures, []);
    assert.equal(state.comments.length, 1);
  });

  it('does not touch comments when post_ticket_comments is false', async () => {
    const { state } = await enrich({
      pr: { title: '#SMART-1' },
      clickup: linked,
      inputs: { postTicketComments: false },
    });
    assert.equal(calls(state, 'listComments').length, 0);
    assert.deepEqual(state.labels, ['backend', 'bug']);
  });

  it('rejects a missing PR number before calling anything', async () => {
    const { core, state } = await enrich({ inputs: { prNumber: Number.NaN } });
    assert.match(core.failures[0], /pr_number/);
    assert.equal(state.calls.length, 0);
  });
});
