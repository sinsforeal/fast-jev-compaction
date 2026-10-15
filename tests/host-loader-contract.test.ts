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
