// Verification: no module USES a name it only RE-EXPORTS (D172).
// Run: npm run check-module-bindings
//
// `export { X as Y } from './m.js'` re-exports WITHOUT creating a local
// binding. A file that then writes `Y` in its own body has a ReferenceError
// that nothing catches until the line runs:
//
//   * esbuild/vite compile a bare unresolved identifier as a global, so
//     `npm run build` stays green;
//   * every other check script here is server-side and never renders React,
//     so none of them execute a component body.
//
// D167 shipped exactly this in AnalystNotesEditor.jsx and it reached main.
// The symptom was a BLANK PAGE - NoteSourceDatalist threw, React unmounted the
// entire root - and it took a live bug report to find. This check is cheap and
// catches the whole class.
//
// The fix is always the same: import the name, then export it.
//   import { X } from './m.js';
//   export const Y = X;

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIRS = ['client/src', 'shared', 'server', 'static/src'];

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (/\.(js|jsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const RE_REEXPORT = /^export\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/gm;
const RE_IMPORT_NAMED = /^import\s+(?:[\w*]+\s*,\s*)?\{([^}]*)\}\s*from/gm;

/** Local name of a specifier: the alias when aliased, else the name itself. */
const localName = (spec) => {
  const parts = spec.split(' as ');
  return parts[parts.length - 1].trim();
};

/**
 * Comments and string literals removed, so a name appearing in prose or in a
 * message never counts as a use. A mis-strip can only produce a REPORTED false
 * positive, never a silent pass, which is the safe direction for this check.
 */
function codeOnly(src) {
  return src
    // CRLF FIRST. This repo stores CRLF (git autocrlf), and in JS `.` does not
    // match a line terminator - \r included - so `//.*$` silently failed to
    // strip a comment, and every commented mention counted as a use. That is
    // how shared/replay.js's header comment first tripped this check.
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ' '))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"[^"\n]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

function offendersIn(src) {
  const reExported = [...src.matchAll(RE_REEXPORT)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean).map(localName));
  if (reExported.length === 0) return [];

  const imported = new Set([...src.matchAll(RE_IMPORT_NAMED)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean).map(localName)));

  const body = codeOnly(src)
    .split('\n')
    .filter((line) => !/^\s*export\s*\{[^}]*\}\s*from\s/.test(line) && !/^\s*import\s/.test(line))
    .join('\n');

  return reExported.filter((name) => {
    if (imported.has(name)) return false;
    return new RegExp(`(^|[^A-Za-z0-9_.$])${name}([^A-Za-z0-9_$]|$)`).test(body);
  });
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
console.log(`-- scanning ${files.length} modules for used-but-only-re-exported names --`);

const found = [];
for (const file of files) {
  for (const name of offendersIn(fs.readFileSync(file, 'utf8'))) {
    found.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}: '${name}'`);
  }
}
check('no module uses a name it only re-exports', found.length === 0, found.join('; '));

// A check that cannot fail proves nothing. This is the exact D167 shape.
const planted = "export { A as B } from './x.js';\nexport const use = () => B.map((v) => v);\n";
check('negative control: a planted offender IS caught',
  offendersIn(planted).includes('B'));
// And the safe direction: a re-export the file never uses is fine.
check('a re-export the file does not use is NOT reported',
  offendersIn("export { A as B } from './x.js';\nexport const other = 1;\n").length === 0);
// A name that appears only inside a comment is not a use (shared/replay.js
// re-exports maxDrawdown and mentions it in its header comment).
check('a name mentioned only in a comment is not a use',
  offendersIn("// reuses maxDrawdown directly\nexport { maxDrawdown } from './d.js';\n").length === 0);

console.log('');
console.log(failures ? `FAILED (${failures})` : 'All module-binding checks passed.');
process.exit(failures ? 1 : 0);
