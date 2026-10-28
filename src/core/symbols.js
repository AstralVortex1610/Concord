// Lightweight symbol finder: functions, classes and methods with their line ranges.
// Brace languages use brace matching (skipping strings and comments); Python-like languages use indentation.
const DEF_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,             // JS function
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,                   // class (JS/TS/Java/C#/Kotlin/Swift/PHP)
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, // arrow fn
  /^\s*(?:export\s+)?(?:interface|enum|type|struct|trait|impl|module|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/,                   // Rust
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,                                                     // Go / Swift
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,                                                          // Python / Ruby
  /^\s*(?:public|private|protected|internal|static|final|override|virtual|async|\s)+[\w<>\[\],\s]+?\s+([A-Za-z_]\w*)\s*\([^;]*$/, // Java/C# method
  /^\s*(?:static\s+|inline\s+|const\s+|unsigned\s+|signed\s+)*[A-Za-z_][\w:<>\*&\s]*?\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/, // C/C++
  /^\s*(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{.*$/,                // JS class method
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'with', 'new', 'typeof', 'function']);

function indentOf(line) { const m = /^[ \t]*/.exec(line); return m[0].replace(/\t/g, '    ').length; }

function braceEnd(lines, startIdx) {
  let depth = 0, seen = false, inStr = null, inBlock = false, paren = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const L = lines[i];
    for (let j = 0; j < L.length; j++) {
      const c = L[j], n = L[j + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; j++; } continue; }
      if (inStr) { if (c === '\\') { j++; continue; } if (c === inStr) inStr = null; continue; }
      if (c === '/' && n === '/') break;
      if (c === '#' && /^\s*#/.test(L) && !seen) break;
      if (c === '/' && n === '*') { inBlock = true; j++; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      // Braces inside the parameter list (default values like `opts = {}`, destructuring) are not the body.
      if (!seen && (c === '(' || c === ')')) { paren += c === '(' ? 1 : -1; continue; }
      if (!seen && paren > 0) continue;
      if (c === '{') { depth++; seen = true; }
      else if (c === '}') { depth--; if (seen && depth === 0) return i; }
    }
    if (inStr && inStr !== '`') inStr = null; // unterminated single-line string
    if (!seen && i > startIdx + 3) return startIdx; // no body found nearby (a declaration)
  }
  return seen ? lines.length - 1 : startIdx;
}

function indentEnd(lines, startIdx) {
  const base = indentOf(lines[startIdx]);
  let last = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const L = lines[i];
    if (L.trim() === '') continue;
    if (indentOf(L) <= base) break;
    last = i;
  }
  return last;
}

function findSymbols(text, path = '') {
  const lines = String(text).split('\n');
  const py = /\.(py|pyw|rb|nim|coffee|yaml|yml)$/i.test(path);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.length > 400) continue;
    for (const re of DEF_PATTERNS) {
      const m = re.exec(L);
      if (!m || KEYWORDS.has(m[1])) continue;
      const usesIndent = py || (/:\s*(#.*)?$/.test(L) && !/[{]/.test(L) && /\bdef\b|\bclass\b/.test(L));
      const end = usesIndent ? indentEnd(lines, i) : braceEnd(lines, i);
      const kind = /class/.test(L) ? 'class' : /interface|struct|trait|enum|type\s/.test(L) ? 'type' : 'function';
      // Pull leading decorators / doc comments into the symbol.
      let start = i;
      while (start > 0 && /^\s*(@|\/\/\/|\*|\/\*\*|#\[)/.test(lines[start - 1])) start--;
      out.push({ name: m[1], kind, start: start + 1, end: end + 1, depth: indentOf(L) });
      break;
    }
  }
  return out;
}

// Resolve "name" or "Class.method" to a 1-indexed inclusive range.
function resolveSymbol(text, path, name) {
  const syms = findSymbols(text, path);
  const parts = String(name).split(/[.:#]+/).filter(Boolean);
  let pool = syms;
  let hit = null;
  for (const p of parts) {
    hit = pool.find((s) => s.name === p);
    if (!hit) return null;
    pool = syms.filter((s) => s.start > hit.start && s.end <= hit.end);
  }
  return hit;
}

module.exports = { findSymbols, resolveSymbol };
