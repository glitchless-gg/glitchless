// Runs the SDK's GML in Node, so its logic can be checked without GameMaker: the sketch and fingerprint against the
// JavaScript originals, and whole sessions against a real Glitchless server (core.test.mjs).
//
// It is not a GML interpreter. It turns the subset of GML the SDK is written in into JavaScript, token by token, and
// refuses anything outside that subset, so the SDK can't drift into JavaScript-only syntax without the tests saying so:
//   - #macro NAME value           -> const NAME = value;
//   - == and !=                   -> === and !== (GML compares without JavaScript's coercions)
//   - s[$ key], m[? key]          -> lenient reads and writes (a missing field is undefined)
//   - s.name on a missing field   -> throws, as it stops a GameMaker game ("variable not set before reading it")
//   - struct literals             -> structs with that check
//   - argument_count              -> arguments.length (the arguments the caller passed, an explicit undefined too)
// Anything with `with`, `self`, `other`, `new`, `static`, `repeat`, `div`, `mod`, template strings, $ hex numbers or
// JavaScript's ===, =>, let, const is refused. __glitchless_engine.gml (surfaces, drawing, `with (all)`) is never
// translated: the tests stand in for it.
//
// builtins() lists every GameMaker function, variable and constant a file uses, for the check in core.test.mjs that
// each is a real one (gml-builtins.txt).

const PUNCT = ['===', '!==', '<<=', '>>=', '==', '!=', '<=', '>=', '&&', '||', '^^', '++', '--', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<', '>>', '??', '=>', '[$', '[?', '[@', '[|', '[#'];
const JS_ONLY = new Set(['let', 'const', 'class', 'this', 'typeof', 'instanceof', 'async', 'await', 'yield', 'of', 'in', 'delete', 'void']);
const GML_ONLY = new Set(['with', 'self', 'other', 'new', 'static', 'repeat', 'div', 'mod', 'and', 'or', 'not', 'xor', 'begin', 'end', 'exit', 'until', 'globalvar', 'enum', 'constructor']);
const KEYWORDS = new Set(['var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw', 'true', 'false', 'undefined', 'global']);
const STRUCT_BEFORE = new Set(['=', '(', ',', '[', ':', '?', 'return', '&&', '||', '+=']);

// `lenient`: read all of GML (with, repeat, accessors...) for builtins(); translate() never is.
export function tokenize(src, file = 'gml', { lenient = false } = {}) {
  const out = [];
  let i = 0;
  let line = 1;
  const at = () => `${file}:${line}`;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      out.push({ t: 'ws', v: c });
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j]) && src[j] !== '\n') j++;
      out.push({ t: 'ws', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('//', i)) {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      out.push({ t: 'comment', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new Error(`${at()}: unclosed comment`);
      const v = src.slice(i, j + 2);
      line += v.split('\n').length - 1;
      out.push({ t: 'comment', v });
      i = j + 2;
      continue;
    }
    if (c === '#') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      const v = src.slice(i, j);
      const m = /^#macro\s+(\w+)\s+(.*)$/.exec(v);
      if (!m) throw new Error(`${at()}: only #macro is supported: ${v}`);
      out.push({ t: 'macro', name: m[1], value: m[2].trim(), line });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++;
        if (src[j] === '\n') throw new Error(`${at()}: newline in a string`);
        j++;
      }
      out.push({ t: 'str', v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === "'" || c === '`' || (c === '@' && src[i + 1] === '"')) throw new Error(`${at()}: only "double-quoted" strings are supported`);
    if (c === '$' && !lenient) {
      if (src[i + 1] === '"') throw new Error(`${at()}: template strings are not supported`);
      throw new Error(`${at()}: $ hex numbers are not supported; write 0x`);
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = /^(0x[0-9a-fA-F]+|[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?)/.exec(src.slice(i));
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const v = m[0];
      if (JS_ONLY.has(v)) throw new Error(`${at()}: "${v}" is JavaScript, not GML`);
      if (GML_ONLY.has(v) && !lenient) throw new Error(`${at()}: "${v}" is outside the GML subset the tests can run`);
      out.push({ t: GML_ONLY.has(v) ? 'kw' : 'id', v, line });
      i += v.length;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (p) {
      if (p === '===' || p === '!==' || p === '=>' || p === '??' || p === '^^') throw new Error(`${at()}: "${p}" is not GML`);
      if ((p === '[@' || p === '[|' || p === '[#') && !lenient) throw new Error(`${at()}: the ${p} accessor is not supported`);
      out.push({ t: 'p', v: p, line });
      i += p.length;
      continue;
    }
    out.push({ t: 'p', v: c, line });
    i++;
  }
  return out;
}

// GML source -> JavaScript source (sloppy mode: function declarations become the sandbox's globals).
export function translate(src, file = 'gml') {
  const toks = tokenize(src, file);
  const out = [];
  const stack = []; // what each open bracket or brace closes with
  let prev = null; // the last significant token
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'ws' || tk.t === 'comment') {
      out.push(tk.v);
      continue;
    }
    if (tk.t === 'macro') {
      out.push(`const ${tk.name} = ${translate(tk.value, file)};`);
      prev = null;
      continue;
    }
    let v = tk.v;
    if (tk.t === 'id' && v === 'argument_count') v = 'arguments.length';
    if (tk.t === 'p') {
      if (v === '==') v = '===';
      else if (v === '!=') v = '!==';
      else if (v === '[$' || v === '[?') {
        stack.push([']', ')]']);
        out.push('[__q(');
        prev = tk;
        continue;
      } else if (v === '[' || v === '(') stack.push(v === '[' ? [']', ']'] : [')', ')']);
      else if (v === '{') {
        const struct = prev && (STRUCT_BEFORE.has(prev.v) || (prev.t === 'id' && prev.v === 'return'));
        stack.push(struct ? ['}', '})'] : ['}', '}']);
        out.push(struct ? '__struct({' : '{');
        prev = tk;
        continue;
      } else if (v === ']' || v === ')' || v === '}') {
        const close = stack.pop();
        if (!close || close[0] !== v) throw new Error(`${file}:${tk.line}: unbalanced ${v}`);
        out.push(close[1]);
        prev = tk;
        continue;
      }
    }
    out.push(v);
    prev = tk;
  }
  if (stack.length) throw new Error(`${file}: unclosed ${stack.map((c) => c[0]).join(' ')}`);
  return out.join('');
}

// The GameMaker names a file uses: identifiers that are called, or read, without being its own functions, locals,
// arguments, macros or struct fields.
export function builtins(src, file = 'gml', own = new Set()) {
  const toks = tokenize(src, file, { lenient: true }).filter((t) => t.t !== 'ws' && t.t !== 'comment');
  const declared = new Set(own);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'macro') declared.add(t.name);
    if (t.t === 'id' && (t.v === 'function' || t.v === 'var') && toks[i + 1]?.t === 'id') declared.add(toks[i + 1].v);
    if (t.t === 'id' && t.v === 'catch') declared.add(toks[i + 2]?.v);
  }
  // Function parameters: identifiers between "function name(" (or "function(") and its ")".
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].v !== 'function') continue;
    let j = i + 1;
    if (toks[j]?.t === 'id') j++;
    if (toks[j]?.v !== '(') continue;
    let depth = 0;
    for (; j < toks.length; j++) {
      if (toks[j].v === '(') depth++;
      else if (toks[j].v === ')' && --depth === 0) break;
      else if (depth === 1 && toks[j].t === 'id' && (toks[j - 1].v === '(' || toks[j - 1].v === ',')) declared.add(toks[j].v);
    }
  }
  const used = new Set();
  const macroValues = toks.filter((t) => t.t === 'macro').flatMap((t) => tokenize(t.value, file, { lenient: true }).filter((x) => x.t === 'id'));
  // An object's own variables (set with `name = ...` at the start of a statement in its events) and the instance
  // variables every instance has are not GameMaker functions; neither are the names after `with (` that are objects.
  const all = [...toks, ...macroValues];
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t.t !== 'id' || KEYWORDS.has(t.v) || declared.has(t.v)) continue;
    const before = all[i - 1];
    const after = all[i + 1];
    if (before?.v === '.') continue; // a field
    if (after?.v === ':' && (before?.v === '{' || before?.v === ',')) continue; // a struct literal's key
    used.add(t.v);
  }
  return used;
}
