import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

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

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  return expression;
}

// 2.1.300 rejected loadedReceipt($) when loadedReceipt lived inside register.
// This bounded check resolves identifier callees with direct `$` arguments,
// including casts and lexical shadowing. It is not the native scanner: it does
// not model host aliases, property callees or the rest of the host grammar.
function hostHelperViolations(text: string): string[] {
  const source = ts.createSourceFile('host-loader-input.ts', text, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === source.fileName ? source : undefined;
  host.fileExists = name => name === source.fileName;
  host.readFile = name => name === source.fileName ? text : undefined;
  const checker = ts.createProgram([source.fileName], options, host).getTypeChecker();
  const allowed = (declaration: ts.Declaration): boolean => {
    if (ts.isFunctionDeclaration(declaration)) return declaration.parent === source;
    if (ts.isVariableDeclaration(declaration)) {
      const list = declaration.parent;
      return ts.isVariableDeclarationList(list) && !!(list.flags & ts.NodeFlags.Const)
        && ts.isVariableStatement(list.parent) && list.parent.parent === source
        && !!declaration.initializer && (ts.isArrowFunction(unwrap(declaration.initializer))
          || ts.isFunctionExpression(unwrap(declaration.initializer)));
    }
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
      return ts.findAncestor(declaration, ts.isImportDeclaration)?.parent === source;
    }
    return false;
  };
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.some(argument => {
      const value = unwrap(argument);
      return ts.isIdentifier(value) && value.text === '$';
    })) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        const declarations = checker.getSymbolAtLocation(callee)?.declarations ?? [];
        if (!declarations.length || !declarations.every(allowed)) {
          const at = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${at.line + 1}:${at.character + 1}: ${callee.text}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

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

  // 0.5.26 first build: `const h = $ as ...` inside a top-level helper of fast-jev.ts. The loader's message,
  // verbatim: "compiled line 561 `const h = $;`: $ itself is bound to a name". Three restarted sessions ran
  // with no plugin (2026-11-18 17:20). Cast `$` at each use, never give it a second name.
  it('never binds $ itself to a name', () => {
    for (const name of sources) {
      const text = readFileSync(join(HOOKS_DIR, name), 'utf8');
      const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
      const found: string[] = [];
      const visit = (node: ts.Node) => {
        const value = (ts.isVariableDeclaration(node) && node.initializer) ? unwrap(node.initializer)
          : (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) ? unwrap(node.right)
          : undefined;
        if (value && ts.isIdentifier(value) && value.text === '$') {
          found.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.getText(source).slice(0, 60)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(found, name).toEqual([]);
    }
  });

  it('passes $ only to top-level functions, const functions or module imports in identifier calls', () => {
    for (const name of sources) {
      expect(hostHelperViolations(readFileSync(join(HOOKS_DIR, name), 'utf8')), name).toEqual([]);
    }
  });

  it('accepts module-local helper forms and ignores comments, strings and non-host arguments', () => {
    expect(hostHelperViolations(`
      import imported from './helper.js';
      import { helper as named } from './helper.js';
      async function declared($) {}
      const arrow = async ($) => {};
      const expression = function ($) {};
      const register = () => {
        const local = value => value;
        return async ($) => {
          await declared($); await arrow(($ as Host)); expression($!);
          imported($); named($); local('ordinary');
          // local($);
          const text = 'local($)';
        };
      };
    `)).toEqual([]);
  });

  it('rejects register-local helpers and shadowing even with casts or multiline calls', () => {
    const violations = hostHelperViolations(`
      function shadowed($) {}
      const register = () => {
        const loadedReceipt = async ($) => {};
        async function ratioMiss($) {}
        const shadowed = ($) => {};
        return async ($) => {
          await loadedReceipt(
            ($ as unknown as Host)
          );
          await ratioMiss($);
          shadowed($);
        };
      };
    `);
    expect(violations.map(line => line.split(': ').at(-1))).toEqual(['loadedReceipt', 'ratioMiss', 'shadowed']);
  });
});

// 0.5.32: 0.5.31 failed to load. Its hooks/platform.ts had `if (host?.env && await host.env.get('OS') === ...)`.
// The loader follows `$` into the functions it is passed to and refuses any value use of it or its members:
// an optional chain (`host?.env`), an existence test (`host.env &&`, `if (host.env)`, `typeof host.env`) or a
// member bound or passed without a call. Members are only ever called, inside try. Names that carry the host:
// `$` and `host`. This is a bounded check like the ones above, not the native scanner.
const HOST_NAMES = new Set(['$', 'host']);

function rootIsHost(expression: ts.Expression): boolean {
  let node = unwrap(expression);
  while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = unwrap(node.expression);
  return ts.isIdentifier(node) && HOST_NAMES.has(node.text);
}

function hostMemberValueUses(text: string): string[] {
  const source = ts.createSourceFile('host-member-input.ts', text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const note = (node: ts.Node, why: string) => {
    const at = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${at.line + 1}:${at.character + 1}: ${why}: ${node.getText(source).slice(0, 70)}`);
  };
  const inType = (node: ts.Node): boolean => !!ts.findAncestor(node, n => ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n));
  const visit = (node: ts.Node) => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !inType(node) && rootIsHost(node)) {
      if (node.questionDotToken) note(node, 'optional chain on a host member');
      // A chain's outermost access is a value use unless it is the callee of a call.
      let outer: ts.Node = node;
      while (outer.parent && (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent)
        || ts.isNonNullExpression(outer.parent) || ts.isTypeAssertionExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent))) outer = outer.parent;
      const parent = outer.parent;
      const partOfChain = !!parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer;
      const called = !!parent && ts.isCallExpression(parent) && parent.expression === outer;
      if (!partOfChain && !called) note(node, 'host member used as a value');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('host loader contract: members are only called (0.5.32)', () => {
  it('no hooks file tests, chains, binds or passes a host member as a value', () => {
    for (const name of sources) {
      expect(hostMemberValueUses(readFileSync(join(HOOKS_DIR, name), 'utf8')), name).toEqual([]);
    }
  });

  it('fails on the 0.5.31 detectWindows form (host?.env && await host.env.get)', () => {
    const bad = hostMemberValueUses(`
      async function detectWindows(host) {
        try { if (host?.env && (await host.env.get('OS')) === 'Windows_NT') return true; } catch {}
        try { if (host.env && isWindowsPath(await host.env.get('SystemRoot'))) return true; } catch {}
        if (typeof host.env !== 'undefined') return true;
        const get = host.env.get;
        use(host.fs.stat);
        return false;
      }
    `);
    expect(bad.length).toBeGreaterThanOrEqual(5);
    expect(bad.some(line => line.includes('optional chain'))).toBe(true);
  });

  it('accepts a call on a host member inside try, with a non-null assertion or a cast', () => {
    expect(hostMemberValueUses(`
      async function detectWindows(host) {
        try { if ((await host.env!.get('OS')) === 'Windows_NT') return true; } catch {}
        try { size = (await host.fs!.stat!(path)).size; } catch {}
        await ($.session.messages as unknown as Rt)(1);
        log($, 'x');
        type T = Host['env'];
        return false;
      }
    `)).toEqual([]);
  });
});
