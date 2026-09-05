// Point git at this repo's tracked hooks (D100).
//
// Git does not version .git/hooks, so a hook committed to the repo does
// nothing until someone opts in. Rather than COPYING hooks into .git/hooks -
// where they immediately drift from the tracked copy and no one notices -
// this sets core.hooksPath to the tracked directory, so the hook that runs is
// literally the file under review.
//
// Idempotent, and prints what it changed. Run: npm run install-hooks
// Undo: git config --unset core.hooksPath

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOOKS = path.join(ROOT, 'scripts', 'git-hooks');
const git = (args) => execFileSync('git', args, { encoding: 'utf8', cwd: ROOT }).trim();
const tryGit = (args) => { try { return git(args); } catch { return null; } };

if (!fs.existsSync(path.join(HOOKS, 'pre-push'))) {
  console.error(`No hooks found at ${HOOKS}`);
  process.exit(1);
}

// Relative, so the setting survives the repo being moved or re-cloned to
// another path - and so it reads sensibly in `git config --list`.
const rel = path.relative(ROOT, HOOKS).split(path.sep).join('/');
const current = tryGit(['config', '--get', 'core.hooksPath']);

if (current === rel) {
  console.log(`core.hooksPath already set to ${rel} - nothing to do.`);
} else {
  git(['config', 'core.hooksPath', rel]);
  console.log(`core.hooksPath ${current ? `changed from ${current} ` : ''}-> ${rel}`);
}

// On Windows the executable bit is not what decides whether a hook runs (git
// runs it through sh), but on a POSIX checkout it is - so make sure it is set
// in the index, where it actually travels between clones.
const mode = tryGit(['ls-files', '-s', 'scripts/git-hooks/pre-push']);
if (mode && !mode.startsWith('100755')) {
  console.log('note: pre-push is not marked executable in the index.');
  console.log('      On a POSIX clone it would not run. Fix with:');
  console.log('      git update-index --chmod=+x scripts/git-hooks/pre-push');
}

console.log('\nActive hooks:');
for (const f of fs.readdirSync(HOOKS)) console.log(`  ${f}`);
console.log('\nTo undo: git config --unset core.hooksPath');
