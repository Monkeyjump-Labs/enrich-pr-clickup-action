'use strict';

// A ticket reference is a # followed by either a custom task ID (PREFIX-NUMBER, like #SMART-1234)
// or a ClickUp internal task ID (6+ letters and digits, like #86abc123). The custom form is tried
// first so #ENG-12 is read as ENG-12 rather than ENG; this matches the leftmost-longest match the
// action's original `grep -oE` made.
const REF_PATTERN = /#([A-Za-z]+-[0-9]+|[A-Za-z0-9]{6,})/g;
const CUSTOM_ID_PATTERN = /^[A-Za-z]+-[0-9]+$/;

function isCustomId(id) {
  return CUSTOM_ID_PATTERN.test(id);
}

// Returns the refs found in `texts` in order of first appearance, de-duplicated
// case-insensitively, so a ticket named in both the title and the body is looked up once.
function extractRefs(texts) {
  const seen = new Set();
  const refs = [];
  for (const text of texts) {
    if (!text) continue;
    for (const match of String(text).matchAll(REF_PATTERN)) {
      const id = match[1];
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ id, custom: isCustomId(id) });
    }
  }
  return refs;
}

module.exports = { extractRefs, isCustomId };
