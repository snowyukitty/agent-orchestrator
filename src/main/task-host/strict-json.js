// Strict JSON for the task ingress.
//
// JSON.parse silently keeps the last of duplicate keys, so two readers of the
// same bytes can disagree about a request. This parser rejects duplicates,
// bounds nesting, and otherwise follows RFC 8259.

const MAX_DEPTH = 16;

class StrictJsonError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseStrictJson(text, { maxDepth = MAX_DEPTH } = {}) {
  if (typeof text !== 'string') throw new StrictJsonError('invalid-json');
  let i = 0;

  const fail = (code = 'invalid-json') => { throw new StrictJsonError(code); };
  const skipWs = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i += 1;
      else break;
    }
  };

  const parseString = () => {
    // Delegate escape handling to JSON.parse once the closing quote is found.
    const start = i;
    i += 1;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        try { return JSON.parse(text.slice(start, i)); } catch (_error) { return fail(); }
      }
      if (c === 0x5c) { i += 2; continue; }
      if (c < 0x20) fail();
      i += 1;
    }
    return fail();
  };

  const parseNumber = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) fail();
    i += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  };

  const parseValue = (depth) => {
    if (depth > maxDepth) fail('too-deep');
    skipWs();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const out = {};
      const seen = new Set();
      skipWs();
      if (text[i] === '}') { i += 1; return out; }
      for (;;) {
        skipWs();
        if (text[i] !== '"') fail();
        const key = parseString();
        if (seen.has(key)) fail('duplicate-key');
        seen.add(key);
        skipWs();
        if (text[i] !== ':') fail();
        i += 1;
        const value = parseValue(depth + 1);
        Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
        skipWs();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return out; }
        fail();
      }
    }
    if (c === '[') {
      i += 1;
      const out = [];
      skipWs();
      if (text[i] === ']') { i += 1; return out; }
      for (;;) {
        out.push(parseValue(depth + 1));
        skipWs();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return out; }
        fail();
      }
    }
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, i)) { i += literal.length; return value; }
    }
    return fail();
  };

  const value = parseValue(0);
  skipWs();
  if (i !== text.length) fail();
  return value;
}

/** Canonical JSON: sorted object keys, no whitespace. Used for digests. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = { MAX_DEPTH, StrictJsonError, canonicalJson, parseStrictJson };
