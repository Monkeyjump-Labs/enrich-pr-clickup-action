'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { extractRefs, isCustomId } = require('../src/refs');

describe('isCustomId', () => {
  it('recognizes PREFIX-NUMBER only', () => {
    assert.equal(isCustomId('SMART-1234'), true);
    assert.equal(isCustomId('smart-12'), true);
    assert.equal(isCustomId('86abc123'), false);
    assert.equal(isCustomId('ABC1-2'), false);
  });
});

describe('extractRefs', () => {
  it('finds custom and internal IDs in order, from every text', () => {
    assert.deepEqual(extractRefs(['feat: login #SMART-12', 'Also #86abc123 and #HERO-4']), [
      { id: 'SMART-12', custom: true },
      { id: '86abc123', custom: false },
      { id: 'HERO-4', custom: true },
    ]);
  });

  it('prefers the custom form, as the original leftmost-longest grep did', () => {
    assert.deepEqual(extractRefs(['#ENGINEERING-12']), [{ id: 'ENGINEERING-12', custom: true }]);
    assert.deepEqual(extractRefs(['#abc123-45']), [{ id: 'abc123', custom: false }]);
  });

  it('needs a # and six characters for an internal ID', () => {
    assert.deepEqual(extractRefs(['SMART-12 86abc123 #1234 #abcde ## Heading']), []);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    assert.deepEqual(extractRefs(['#SMART-1', '#smart-1 #SMART-1']), [{ id: 'SMART-1', custom: true }]);
  });

  it('skips empty texts', () => {
    assert.deepEqual(extractRefs([null, undefined, '']), []);
  });
});
