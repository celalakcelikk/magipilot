import { describe, expect, it } from 'vitest';
import { delimiterBalance, ownership } from '../../src/core/delimiters';

describe('delimiterBalance', () => {
  it.each([
    ['plain code', 'f(a[0], { b: 1 })', 'typescript', 0],
    ['an open block', 'if (x) {', 'typescript', 1],
    ['a surplus closer', 'a);', 'typescript', -1],
    ['brackets in strings', `const s = "(" + '[' + \`{\`;`, 'typescript', 0],
    ['an escaped quote inside a string', 'const s = "a\\"(";', 'typescript', 0],
    ['a line comment', 'x(); // ) ] }', 'typescript', 0],
    ['a block comment', 'x(/* ) */);', 'typescript', 0],
    ['a regex literal', 'const re = /[(]/g;', 'typescript', 0],
    ['a division is not a regex', 'const r = (a / b) / (c);', 'typescript', 0],
    ['Rust lifetimes', "fn f<'a>(x: &'a str) -> &'a str { x }", 'rust', 0],
    ['a Rust char literal', "let c = '(';", 'rust', 0],
    ['a Python comment', 'x = 1  # )', 'python', 0],
    ['a Python triple-quoted string', 'doc = """ ( [ { """', 'python', 0],
    ['a Go raw string', 'var s = `(\n[`', 'go', 0],
  ])('%s', (_name, text, languageId, expected) => {
    expect(delimiterBalance(text, languageId)).toBe(expected);
  });
});

describe('ownership', () => {
  it('attributes closers to the context or to the completion', () => {
    const result = ownership('function f() {\n  call(', 'a);\n  if (x) {\n  }\n}', 'typescript');
    expect(result.uncertain).toBe(false);
    // ")" of call(, ")" of (x), "}" of the if block, "}" of the function.
    expect(result.closers.map((c) => c.closes)).toEqual([
      'context',
      'completion',
      'completion',
      'context',
    ]);
    // The if block's } points back at the { the completion opened.
    const ifClose = result.closers[2]!;
    expect('a);\n  if (x) {\n  }\n}'[ifClose.openerIndex]).toBe('{');
  });

  it('counts brackets the completion leaves open', () => {
    expect(ownership('', 'if (x) {', 'typescript').openedByCompletion).toBe(1);
  });

  it('is uncertain about a closer of the wrong type', () => {
    expect(ownership('f(', ']', 'typescript').uncertain).toBe(true);
  });

  it('is uncertain about a closer with nothing open (e.g. a truncated prefix)', () => {
    expect(ownership('', '}', 'typescript').uncertain).toBe(true);
  });

  it("an escape at the end of the prefix escapes the completion's first character (C8, C-R002)", () => {
    // prefix: const s = "a\   completion: "   → the quote is escaped, the string continues
    expect(ownership('const s = "a\\', '"   ', 'typescript').endsInLiteral).toBe(true);
    // control: without the backslash the quote closes the string
    expect(ownership('const s = "a', '"   ', 'typescript').endsInLiteral).toBe(false);
    // a regex literal too
    expect(ownership('const r = /a\\', '/b', 'typescript').endsInLiteral).toBe(true);
  });

  it('a block-comment end split by the cursor still ends the comment (C8)', () => {
    const result = ownership('x(); /* note *', '/ y(', 'typescript');
    expect(result.endsInLiteral).toBe(false);
    expect(result.openedByCompletion).toBe(1);
  });

  it('carries the lexer state from the prefix into the completion', () => {
    // The cursor is inside a string: the ")" typed there is not a bracket.
    expect(ownership('f("abc', ')")', 'typescript').closers).toHaveLength(1);
  });
});
