// Concord merge engine: line diffs, 3-way merge, and line-range remapping.
// Everything works on arrays of lines. A "hunk" replaces base lines [start, end) with `lines`.
const { diffArrays } = require('diff');

const splitLines = (text) => {
  if (text === '') return [];
  const parts = String(text).split('\n');
  return parts; // keep a trailing '' when the text ends with \n, so join('\n') round-trips exactly
};
const joinLines = (lines) => lines.join('\n');

// Hunks that turn `a` into `b`, in base (a) coordinates.
function hunks(a, b) {
  const out = [];
  let i = 0; // position in a
  let cur = null;
  for (const part of diffArrays(a, b)) {
    if (!part.added && !part.removed) {
      if (cur) { out.push(cur); cur = null; }
      i += part.value.length;
    } else {
      if (!cur) cur = { start: i, end: i, lines: [] };
      if (part.removed) { cur.end += part.value.length; i += part.value.length; }
      else cur.lines.push(...part.value);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const sameHunk = (x, y) => x.start === y.start && x.end === y.end && x.lines.length === y.lines.length && x.lines.every((l, k) => l === y.lines[k]);

// Do two hunks (both in base coordinates) touch the same base text?
function overlaps(x, y) {
  if (x.start < y.end && y.start < x.end) return true;           // ranges intersect
  if (x.start === x.end && y.start === y.end && x.start === y.start) return true; // two inserts at the same spot
  return false;
}

// 3-way merge. base -> ours (already committed) and base -> theirs (incoming).
// Returns { ok: true, lines } or { ok: false, conflicts: [{ start, end, ours, theirs }] } with base line numbers (1-indexed).
function merge3(base, ours, theirs) {
  const A = hunks(base, ours);
  const B = hunks(base, theirs);
  const conflicts = [];
  const take = [];
  for (const b of B) {
    const hit = A.filter((a) => overlaps(a, b));
    if (hit.length === 0) { take.push(b); continue; }
    if (hit.length === 1 && sameHunk(hit[0], b)) continue; // identical change already applied
    conflicts.push({ start: b.start + 1, end: b.end, ours: hit.map((h) => h.lines.join('\n')).join('\n'), theirs: b.lines.join('\n') });
  }
  if (conflicts.length) return { ok: false, conflicts };
  // Apply A and the accepted B hunks together, walking base once.
  const all = [...A.map((h) => ({ ...h, src: 0 })), ...take.map((h) => ({ ...h, src: 1 }))]
    .sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start) || x.src - y.src);
  const out = [];
  let i = 0;
  for (const h of all) {
    if (h.start < i) return { ok: false, conflicts: [{ start: h.start + 1, end: h.end, ours: '', theirs: h.lines.join('\n') }] };
    while (i < h.start) out.push(base[i++]);
    out.push(...h.lines);
    i = h.end;
  }
  while (i < base.length) out.push(base[i++]);
  return { ok: true, lines: out, applied: take };
}

// Map a boundary position p (between lines, 0..n) through hunks old -> new.
// includeInsertAtP: whether a pure insertion exactly at p lands before p (true) or after it (false).
function mapPos(p, hs, includeInsertAtP, insideSide) {
  let delta = 0;
  for (const h of hs) {
    const d = h.lines.length - (h.end - h.start);
    if (h.start === h.end && h.start === p) { if (includeInsertAtP) delta += d; continue; }
    if (h.end <= p) { delta += d; continue; }
    if (h.start < p && p < h.end) return insideSide === 'start' ? h.start + delta : h.start + delta + h.lines.length;
    break;
  }
  return p + delta;
}

// Map a line range [start, end) (0-indexed) through hunks old -> new.
// grow: an insertion exactly at the range end grows the range (its owner appended to it).
function mapRange(range, hs, grow = false) {
  const s = mapPos(range.start, hs, true, 'start');
  const e = Math.max(s, mapPos(range.end, hs, grow, 'end'));
  return { start: s, end: e };
}

// Where do the incoming hunks land in current coordinates? (for lease checks)
function mapHunksToCurrent(B, A) {
  return B.map((b) => {
    const r = mapRange({ start: b.start, end: b.end }, A);
    return { start: r.start, end: Math.max(r.start, r.end), insert: b.start === b.end };
  });
}

// Apply LLM-friendly edits to a text: [{ old, new }] (exact unique match) or [{ startLine, endLine, text }] (1-indexed, inclusive; endLine = startLine - 1 inserts).
function applyEdits(text, edits) {
  let lines = splitLines(text);
  let src = text;
  const lineEdits = [];
  for (const ed of edits || []) {
    if (typeof ed.old === 'string') {
      const idx = src.indexOf(ed.old);
      if (ed.old === '' || idx < 0) throw new Error(`Edit not applied: the text to replace was not found exactly. Re-read the file and copy it exactly.\n---\n${ed.old.slice(0, 300)}`);
      if (src.indexOf(ed.old, idx + 1) >= 0) throw new Error('Edit not applied: the text to replace appears more than once. Include more surrounding lines so it is unique.');
      src = src.slice(0, idx) + String(ed.new ?? '') + src.slice(idx + ed.old.length);
    } else if (Number.isInteger(ed.startLine)) lineEdits.push(ed);
  }
  if (lineEdits.length) {
    lines = splitLines(src);
    lineEdits.sort((x, y) => y.startLine - x.startLine);
    for (const ed of lineEdits) {
      const s = ed.startLine - 1;
      const e = Number.isInteger(ed.endLine) ? ed.endLine : ed.startLine;
      if (s < 0 || s > lines.length || e < s || e > lines.length) throw new Error(`Line range ${ed.startLine}-${ed.endLine} is outside the file (it has ${lines.length} lines).`);
      lines.splice(s, e - s, ...(ed.text === '' ? [] : splitLines(String(ed.text ?? ''))));
    }
    src = joinLines(lines);
  }
  return src;
}

module.exports = { mapPos, splitLines, joinLines, hunks, merge3, mapRange, mapHunksToCurrent, applyEdits, overlaps };
