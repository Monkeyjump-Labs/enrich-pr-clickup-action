'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { markerFor, renderTicketComment, taskIdFromComment } = require('../src/comment');
const { tags, task } = require('./helpers');

describe('markers', () => {
  it('keeps the v2 marker format', () => {
    assert.equal(markerFor('86abc123'), '<!-- clickup-ticket:86abc123 -->');
  });

  it('reads the task ID back from a comment', () => {
    assert.equal(taskIdFromComment(`${markerFor('86abc123')}\n### body`), '86abc123');
    assert.equal(taskIdFromComment('a normal comment'), null);
    assert.equal(taskIdFromComment('<!-- clickup-ticket: -->'), null);
    assert.equal(taskIdFromComment(undefined), null);
  });
});

describe('renderTicketComment', () => {
  it('renders every field the ticket has', () => {
    const body = renderTicketComment({
      task: task('abc123', {
        custom_id: 'SMART-12',
        tags: tags('backend', 'urgent'),
        due_date: '1767225600000',
        assignees: [{ username: 'jane' }, { email: 'bob@example.com' }, {}],
      }),
      parent: task('par999', { name: 'Epic' }),
      ref: 'SMART-12',
      type: 'bug',
    });
    assert.ok(body.startsWith('<!-- clickup-ticket:abc123 -->\n### 🎟️ SMART-12 — Task abc123\n\n'));
    for (const line of [
      '- **Ticket**: [SMART-12](https://app.clickup.com/t/abc123)',
      '- **Status**: in progress',
      '- **Type**: bug',
      '- **Priority**: high',
      '- **Assignees**: jane, bob@example.com',
      '- **Due**: 2026-01-01',
      '- **List**: Sprint 1',
      '- **Tags**: `backend`, `urgent`',
      '- **Parent**: [Epic](https://app.clickup.com/t/par999)',
      'Description of abc123',
    ]) {
      assert.ok(body.includes(`${line}\n`), `missing: ${line}`);
    }
    assert.ok(body.endsWith('rather than this comment.</sub>\n'));
  });

  it('falls back to the ref, then the internal ID, for the heading, and omits empty fields', () => {
    const bare = task('abc123', {
      url: '',
      status: null,
      priority: null,
      assignees: [],
      list: null,
      description: '',
      due_date: 'soon',
    });
    const byRef = renderTicketComment({ task: bare, parent: { name: 'Epic' }, ref: 'abc123', type: '' });
    assert.match(byRef, /### 🎟️ abc123 — Task abc123/);
    assert.match(byRef, /- \*\*Parent\*\*: Epic\n/);
    assert.match(byRef, /_No description on the ticket._/);
    for (const name of ['Ticket', 'Status', 'Type', 'Priority', 'Assignees', 'Due', 'List', 'Tags']) {
      assert.ok(!byRef.includes(`**${name}**`), `unexpected ${name}`);
    }
    const byId = renderTicketComment({ task: { id: 'abc123' }, parent: null, ref: '', type: '' });
    assert.match(byId, /### 🎟️ abc123 — \n/);
  });

  it('prefers the markdown description and skips empty ones', () => {
    const body = renderTicketComment({
      task: task('abc123', { markdown_description: '  ', description: '', text_content: 'plain text' }),
      parent: null,
      ref: 'abc123',
      type: '',
    });
    assert.match(body, /\nplain text\n/);
    const markdown = renderTicketComment({
      task: task('abc123', { markdown_description: '**bold**' }),
      parent: null,
      ref: 'abc123',
      type: '',
    });
    assert.match(markdown, /\n\*\*bold\*\*\n/);
  });

  it('truncates long descriptions on code points', () => {
    const body = renderTicketComment(
      { task: task('abc123', { description: '😀😀😀😀' }), parent: null, ref: 'abc123', type: '' },
      { descriptionLimit: 3 },
    );
    assert.match(body, /\n😀😀😀\n\n_Truncated — open the ticket for the full description._\n/);
  });
});
