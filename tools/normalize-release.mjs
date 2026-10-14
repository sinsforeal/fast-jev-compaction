/** Normalize only explicitly changed/new release files; never traverse tmp/. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const tracked = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACM'], { encoding: 'utf8' }).trim().split('\n');
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n');
let changed = 0;
for (const path of new Set([...tracked, ...untracked])) {
  if (!path || path.startsWith('tmp/') || !/\.(ts|json|md|mjs)$/.test(path)) continue;
  const text = fs.readFileSync(path, 'utf8');
  const lf = text.replace(/\r\n/g, '\n');
  if (lf !== text) { fs.writeFileSync(path, lf, 'utf8'); changed++; }
}
console.log(`Normalized ${changed} release files to LF`);
