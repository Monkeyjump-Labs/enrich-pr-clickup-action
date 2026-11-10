'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createClickUpClient } = require('../src/clickup');
const { discoverTickets, loadTaskTypes, resolveType } = require('../src/discover');
const { extractRefs } = require('../src/refs');
const { fakeClickUp, fakeCore, task } = require('./helpers');

const TYPES = new Map([
  ['1', 'Task'],
  ['2', 'Bug'],
  ['3', 'Feature'],
]);

async function discover(text, clickupOptions, { teamId = '42', types = TYPES } = {}) {
  const clickup = fakeClickUp(clickupOptions);
  const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
  const core = fakeCore();
  const result = await discoverTickets(client, { refs: extractRefs([text]), teamId, types, core });
  return { ...result, core, clickup };
}

describe('resolveType', () => {
  it('uses the task type, falling back to the parent when it is generic or unknown', () => {
    assert.equal(resolveType(task('a', { custom_item_id: 2 }), null, TYPES), 'bug');
    assert.equal(resolveType(task('a', { custom_item_id: 1 }), task('p', { custom_item_id: 3 }), TYPES), 'feature');
    assert.equal(resolveType(task('a', { custom_item_id: 99 }), task('p', { custom_item_id: 2 }), TYPES), 'bug');
    assert.equal(resolveType(task('a', { custom_item_id: 1 }), task('p', { custom_item_id: 1 }), TYPES), '');
    assert.equal(resolveType(task('a'), null, TYPES), '');
  });
});

describe('loadTaskTypes', () => {
  it('skips the lookup without a team ID', async () => {
    const core = fakeCore();
    assert.deepEqual(await loadTaskTypes({}, '', core), { types: new Map(), failed: false });
    assert.match(core.logs[0], /task type detection disabled/);
  });

  it('warns and carries on when the lookup fails', async () => {
    const clickup = fakeClickUp({ failing: ['types'] });
    const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
    const core = fakeCore();
    assert.deepEqual(await loadTaskTypes(client, '42', core), { types: new Map(), failed: true });
    assert.match(core.warnings[0], /Could not load ClickUp task types/);
  });

  it('loads the types', async () => {
    const clickup = fakeClickUp({ types: [{ id: 2, name: 'Bug' }] });
    const client = createClickUpClient({ apiToken: 'pk', fetchImpl: clickup.fetchImpl });
    const { types, failed } = await loadTaskTypes(client, '42', fakeCore());
    assert.equal(types.get('2'), 'Bug');
    assert.equal(failed, false);
  });
});

describe('discoverTickets', () => {
  it('resolves custom and internal refs, with parents and types', async () => {
    const { tickets, failed, lookupFailed } = await discover('#SMART-1 #def456', {
      tasks: {
        abc123: task('abc123', { custom_id: 'SMART-1', parent: 'par999', custom_item_id: 1 }),
        def456: task('def456', { custom_item_id: 2 }),
        par999: task('par999', { custom_item_id: 3 }),
      },
      custom: { 'SMART-1': 'abc123' },
    });
    assert.deepEqual(
      tickets.map((t) => [t.task.id, t.ref, t.parent && t.parent.id, t.type]),
      [
        ['abc123', 'SMART-1', 'par999', 'feature'],
        ['def456', 'def456', null, 'bug'],
      ],
    );
    assert.equal(failed, false);
    assert.equal(lookupFailed, false);
  });

  it('looks a task up once when a custom and an internal ref name it', async () => {
    const { tickets, core } = await discover('#SMART-1 #abc123', {
      tasks: { abc123: task('abc123') },
      custom: { 'SMART-1': 'abc123' },
    });
    assert.equal(tickets.length, 1);
    assert.ok(core.logs.some((line) => /skipping duplicate ref #abc123/.test(line)));
  });

  it('ignores refs that are not tickets without marking anything failed', async () => {
    const { tickets, failed, lookupFailed, protectedIds } = await discover('#UTF-8 #ffffff', {});
    assert.deepEqual(tickets, []);
    assert.equal(failed, false);
    assert.equal(lookupFailed, false);
    assert.equal(protectedIds.size, 0);
  });

  it('marks the run failed when a custom ref cannot be looked up', async () => {
    const { tickets, failed, core } = await discover('#SMART-1', { failing: ['SMART-1'] });
    assert.deepEqual(tickets, []);
    assert.equal(failed, true);
    assert.match(core.warnings[0], /Could not look up ClickUp ticket SMART-1/);
  });

  it('marks the run failed when a custom ref has no team ID to resolve it', async () => {
    const { failed, clickup, core } = await discover('#SMART-1', {}, { teamId: '' });
    assert.equal(failed, true);
    assert.equal(clickup.requests.length, 0);
    assert.match(core.warnings[0], /no clickup_team_id provided/);
  });

  it('protects only the internal ID whose lookup failed', async () => {
    const { tickets, failed, lookupFailed, protectedIds } = await discover('#abc123 #def456', {
      tasks: { def456: task('def456') },
      failing: ['abc123'],
    });
    assert.deepEqual(
      tickets.map((t) => t.task.id),
      ['def456'],
    );
    assert.equal(failed, false);
    assert.equal(lookupFailed, true);
    assert.deepEqual([...protectedIds], ['abc123']);
  });

  it('keeps a ticket whose parent cannot be read, without the parent', async () => {
    const { tickets, failed, lookupFailed, core } = await discover('#abc123', {
      tasks: { abc123: task('abc123', { parent: 'par999', custom_item_id: 2 }) },
      failing: ['par999'],
    });
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].parent, null);
    assert.equal(tickets[0].type, 'bug');
    assert.equal(failed, false);
    assert.equal(lookupFailed, true);
    assert.match(core.warnings[0], /Could not look up parent ticket par999/);
  });

  it('fetches a shared parent once', async () => {
    const { clickup } = await discover('#aaa111 #bbb222', {
      tasks: {
        aaa111: task('aaa111', { parent: 'par999' }),
        bbb222: task('bbb222', { parent: 'par999' }),
        par999: task('par999'),
      },
    });
    assert.equal(clickup.requests.filter((r) => r.url.pathname.endsWith('/par999')).length, 1);
  });
});
