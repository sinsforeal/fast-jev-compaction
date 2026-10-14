import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 0.4.3: the Claude Code hooks loader (2.1.299) refuses a module whose source uses
// an event of `$` as a value. Its message on 0.4.2, verbatim:
//   "$.ui.toast is used as a value (an event of $ bound, passed or read) instead of
//    called; $ is always spelled $.noun.event(...) at the call site, on is always
//    on("<event>", hook), and next.to always next.to(e, "<tier>")"
// A refused module is no plugin at all: no toast, no log line, built-in summary on
// every compaction, nothing on screen. This test fails before the install does.
const HOOKS_DIR = join(__dirname, '..', 'hooks');
const sources = readdirSync(HOOKS_DIR).filter(name => name.endsWith('.ts'));

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const OPTIONAL_CALL =/\$\.[A-Za-z_]+\.[A-Za-z_]+\?\.\(/;
const BARE_READ = /(?:^|[^A-Za-z_.])(?:!|typeof |await )?\$\.[A-Za-z_]+\.[A-Za-z_]+(?![A-Za-z_.(])/;

describe('host loader contract', () => {
  it('never optional-chains a call on an event of $', () => {
    for (const name of sources) {
      const lines = readFileSync(join(HOOKS_DIR, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (COMMENT_LINE.test(line)) return;
        expect(OPTIONAL_CALL.test(line), `${name}:${i + 1}: ${line.trim()}`).toBe(false);
      });
    }
  });

  it('never reads an event of $ as a value outside a cast-then-call', () => {
    for (const name of sources) {
      const lines = readFileSync(join(HOOKS_DIR, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (COMMENT_LINE.test(line)) return;
        // `($.session.messages as unknown as RuntimeMessages)(...)` loaded on 0.4.1; keep it.
        const stripped = line.replace(/\(\$\.[A-Za-z_]+\.[A-Za-z_]+ as [^)]*\)\(/g, 'CAST_CALL(');
        expect(BARE_READ.test(stripped), `${name}:${i + 1}: ${line.trim()}`).toBe(false);
      });
    }
  });
});
