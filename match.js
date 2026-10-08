/* match.js — compares sheet values with text read from Business Manager.
   Pure functions; used by worker.js (importScripts) and testable in Node. */
(function (root) {
  'use strict';
  const STATES = {
    an: 'andaman nicobar islands', ap: 'andhra pradesh', ar: 'arunachal pradesh', as: 'assam', br: 'bihar', ch: 'chandigarh',
    cg: 'chhattisgarh', dl: 'delhi', ga: 'goa', gj: 'gujarat', hr: 'haryana', hp: 'himachal pradesh', jk: 'jammu kashmir',
    jh: 'jharkhand', ka: 'karnataka', kl: 'kerala', la: 'ladakh', mp: 'madhya pradesh', mh: 'maharashtra', mn: 'manipur',
    ml: 'meghalaya', mz: 'mizoram', nl: 'nagaland', od: 'odisha', or: 'odisha', py: 'puducherry', pb: 'punjab', rj: 'rajasthan',
    sk: 'sikkim', tn: 'tamil nadu', tg: 'telangana', ts: 'telangana', tr: 'tripura', up: 'uttar pradesh', uk: 'uttarakhand',
    ut: 'uttarakhand', wb: 'west bengal'
  };
  const WORDS = { rd: 'road', st: 'street', ave: 'avenue', nr: 'near', opp: 'opposite', bldg: 'building', apt: 'apartment',
    no: 'number', sec: 'sector', hwy: 'highway', blk: 'block', flr: 'floor', orissa: 'odisha', pondicherry: 'puducherry',
    bengaluru: 'bangalore', mumbai: 'bombay', chennai: 'madras', kolkata: 'calcutta', gurugram: 'gurgaon', uttaranchal: 'uttarakhand' };
  const STOP = new Set(['the', 'of', 'and', 'in', 'at', 'a']);

  function tokens(text, opts = {}) {
    let s = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
    let t = s ? s.split(' ') : [];
    if (opts.state && t.length === 1 && STATES[t[0]]) t = STATES[t[0]].split(' ');
    t = t.map(w => WORDS[w] || w).filter(w => !STOP.has(w));
    return t.flatMap(w => w.split(' '));
  }
  // Returns 'blank' | 'match' | 'partial' | 'mismatch' for one sheet value vs the observed text.
  function compare(sheetValue, observed, opts = {}) {
    const want = tokens(sheetValue, opts);
    if (!want.length) return 'blank';
    const have = new Set(tokens(observed, { state: false }));
    // Allow observed state abbreviations too (e.g. page shows "TN" and sheet says "Tamil Nadu").
    if (opts.state) for (const w of tokens(observed).slice()) if (STATES[w]) STATES[w].split(' ').forEach(x => have.add(x));
    if (opts.digits) { // postal code: digits only, allow "600 001" style spacing
      const d = String(sheetValue).replace(/\D/g, '');
      if (!d) return 'blank';
      const re = new RegExp('(^|\\D)' + (d.length > 3 ? d.slice(0, 3) + '\\s?' + d.slice(3) : d) + '(\\D|$)');
      return re.test(String(observed)) ? 'match' : 'mismatch';
    }
    const hit = want.filter(w => have.has(w)).length, ratio = hit / want.length;
    if (ratio === 1) return 'match';
    return ratio >= (opts.partial ?? 0.6) ? 'partial' : 'mismatch';
  }
  // True when two values are the same after normalising case, punctuation, Rd/Road, TN/Tamil Nadu etc.
  function same(a, b, opts = {}) {
    if (opts.digits) return String(a ?? '').replace(/\D/g, '') === String(b ?? '').replace(/\D/g, '');
    const x = tokens(a, opts), y = tokens(b, opts);
    return x.length === y.length && x.every((w, i) => w === y[i]);
  }
  const RANK = { match: 4, partial: 3, mismatch: 2, not_found: 1, blank: 0 };
  const best = (a, b) => (RANK[a] ?? -1) >= (RANK[b] ?? -1) ? a : b;

  // sources: array of observed-text strings (list row, editor fields). Empty -> 'not_found'.
  function checkProfile(row, sources) {
    const texts = sources.filter(s => s && s.trim());
    const one = (value, opts) => {
      if (!String(value ?? '').trim()) return 'blank';
      if (!texts.length) return 'not_found';
      return texts.map(t => compare(value, t, opts)).reduce(best, 'mismatch');
    };
    return {
      name: one(row.name, { partial: 0.6 }),
      address: one(row.address, { partial: 0.6 }),
      locality: one(row.locality, { partial: 0.99 }),
      admin: one(row.admin, { state: true, partial: 0.99 }),
      postal: one(row.postal, { digits: true })
    };
  }
  // Street address lines: line 1 is used alone while it fits in `limit` characters. Only when line 1 is longer
  // does the overflow move into line 2 and then line 3 (breaking at a comma or space, never mid-word where avoidable).
  // Text already in the sheet's line 2 / line 3 is kept after the overflow. Returns {lines:[l1,l2,l3], tooLong, overflowed}.
  function splitAddress(a1, a2, a3, limit = 80) {
    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const lines = [clean(a1), clean(a2), clean(a3)];
    let overflowed = false;
    for (let i = 0; i < 2; i++) {
      const s = lines[i];
      if (s.length <= limit) continue;
      overflowed = true;
      const win = s.slice(0, limit + 1);                  // the break may fall right after the limit (a space at index `limit`)
      let cut = win.lastIndexOf(','), end = cut + 1;      // keep the comma with the head, then trim it
      if (cut < limit * 0.5) { cut = win.lastIndexOf(' '); end = cut; } // no usable comma: break at a space
      if (cut < limit * 0.3) end = limit;                 // no break point at all: hard cut
      const head = s.slice(0, end).replace(/[\s,]+$/, '');
      const tail = s.slice(head.length).replace(/^[\s,]+/, '');
      lines[i] = head;
      lines[i + 1] = lines[i + 1] ? tail + ', ' + lines[i + 1] : tail;
    }
    return { lines, tooLong: lines[2].length > limit, overflowed };
  }
  root.ProfileMatch = { compare, checkProfile, tokens, same, splitAddress };
  if (typeof module !== 'undefined') module.exports = root.ProfileMatch;
})(typeof globalThis !== 'undefined' ? globalThis : self);
