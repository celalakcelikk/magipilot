import { describe, expect, it } from 'vitest';
import { postprocess, type PostprocessContext } from '../../src/core/postprocess';

interface Case {
  name: string;
  raw: string;
  prefix: string;
  suffix?: string;
  maxLines?: number;
  /** Default typescript. */
  languageId?: string;
  /** Default chat. */
  backendKind?: 'fim' | 'chat';
  expected: string | null;
}

const FN_BODY = 'function add(a: number, b: number) {\n  ';
const IN_RETURN = 'function add(a: number, b: number) {\n  return ';
const PY_BODY = 'def f(x):\n    ';

const cases: Case[] = [
  // --- fences ---
  { name: 'plain text is kept', raw: 'a + b;', prefix: IN_RETURN, expected: 'a + b;' },
  {
    name: 'fenced block with language',
    raw: '```ts\nreturn a + b;\n```',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  {
    name: 'fenced block without language',
    raw: '```\nreturn a + b;\n```',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  {
    name: 'unterminated fence',
    raw: '```python\nreturn x',
    prefix: PY_BODY,
    languageId: 'python',
    expected: 'return x',
  },
  {
    name: 'prose around a fenced block',
    raw: 'Here you go:\n```js\nreturn 1;\n```\nThat is it.',
    prefix: FN_BODY,
    expected: 'return 1;',
  },
  // --- explanation lines ---
  {
    name: 'leading "Here is the completion:"',
    raw: 'Here is the completion:\nreturn a + b;',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  {
    name: 'leading "Sure"',
    raw: 'Sure!\nreturn a + b;',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  {
    name: 'trailing note after a blank line',
    raw: 'return a + b;\n\nNote: this adds the numbers.',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  {
    name: 'a single prose-looking line is kept (nothing else to keep)',
    raw: 'Here is',
    prefix: FN_BODY,
    expected: 'Here is',
  },
  {
    name: 'code after a blank line is not mistaken for prose',
    raw: 'const a = 1;\n\n  const b = 2;',
    prefix: FN_BODY,
    expected: 'const a = 1;\n\n  const b = 2;',
  },
  // --- echoed cursor marker ---
  {
    name: 'echoed <CURSOR> marker is removed',
    raw: '<CURSOR>return a + b;',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  // --- repeated prefix ---
  { name: 'model repeats "return "', raw: 'return a + b;', prefix: IN_RETURN, expected: 'a + b;' },
  {
    name: 'model repeats the line with its indentation',
    raw: '  return a + b;',
    prefix: IN_RETURN,
    expected: 'a + b;',
  },
  { name: 'no repetition, nothing removed', raw: 'a * b;', prefix: IN_RETURN, expected: 'a * b;' },
  {
    name: 'mid-line call: repeated opening is removed',
    raw: 'console.log(x);',
    prefix: 'function f(x) {\n  console.log(',
    suffix: '\n}',
    expected: 'x);',
  },
  // --- first-line indentation (Faz 0 haiku habit) ---
  {
    name: 'extra indent on the first line is dropped',
    raw: '  return a + b;',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  {
    name: 'extra indent: later lines keep absolute indent',
    raw: '    const value = map.get(key);\n    map.delete(key);',
    prefix: 'get(key) {\n    ',
    expected: 'const value = map.get(key);\n    map.delete(key);',
  },
  {
    name: 'leading blank line then code',
    raw: '\n  return a + b;',
    prefix: FN_BODY,
    expected: 'return a + b;',
  },
  {
    name: 'tabs before the first line are dropped',
    raw: '\treturn x',
    prefix: 'def f(x):\n\t',
    languageId: 'python',
    expected: 'return x',
  },
  {
    name: 'mid-line cursor keeps a meaningful leading space',
    raw: ' + b;',
    prefix: 'const s = a',
    suffix: '',
    expected: ' + b;',
  },
  // --- block end ---
  {
    name: 'stops before a closing brace of the outer block',
    raw: 'return a + b;\n}',
    prefix: FN_BODY,
    suffix: '\n}',
    expected: 'return a + b;',
  },
  {
    name: 'stops before less-indented code',
    raw: 'return x\n\ndef g():\n    pass',
    prefix: PY_BODY,
    languageId: 'python',
    expected: 'return x',
  },
  {
    name: 'nested block lines stay',
    raw: 'if (a) {\n    return b;\n  }\n  return c;',
    prefix: FN_BODY,
    expected: 'if (a) {\n    return b;\n  }\n  return c;',
  },
  {
    name: 'top-level cursor: no block cut',
    raw: 'export const a = 1;\nexport const b = 2;',
    prefix: '',
    expected: 'export const a = 1;\nexport const b = 2;',
  },
  // --- suffix overlap ---
  {
    name: 'repeated closing line of the suffix is dropped',
    raw: 'x += 1;\n    return x;',
    prefix: 'function f() {\n    let x = 0;\n    ',
    suffix: '\n    return x;\n}',
    expected: 'x += 1;',
  },
  {
    name: 'same-line suffix ");" already present',
    raw: 'a, b);',
    prefix: 'call(',
    suffix: ');\nnext();',
    expected: 'a, b',
  },
  {
    name: 'a completion that only repeats the next line → null (P1-I006)',
    raw: 'return x;',
    prefix: 'function f() {\n  ',
    suffix: '\n  return x;\n}',
    expected: null,
  },
  {
    name: 'repeating the next line counts the text already on the cursor line',
    raw: 'save();',
    prefix: 'function f() {\n  ',
    suffix: '\n  save();\n}',
    expected: null,
  },
  {
    name: 'a mid-line completion is not mistaken for the next line',
    raw: 'x;',
    prefix: 'function f() {\n  return ',
    suffix: '\n  x;\n}',
    expected: 'x;',
  },
  {
    name: 'a completion equal to the same-line suffix → null (P1-I006)',
    raw: ');',
    prefix: 'call(a, b',
    suffix: ');\nnext();',
    expected: null,
  },
  // --- delimiter ownership (P1-I008) and partial same-line overlap (P1-I010) ---
  {
    name: "a generated block keeps its own closing brace even if the suffix's next line is }",
    raw: 'if (a) {\n      b();\n    }',
    prefix: 'class A {\n  m() {\n    ',
    suffix: '\n  }\n}',
    expected: 'if (a) {\n      b();\n    }',
  },
  {
    name: 'a closer that only duplicates the suffix is still removed',
    raw: 'x();\n}',
    prefix: 'function f() {\n',
    suffix: '\n}',
    expected: 'x();',
  },
  {
    name: 'the model\'s ")" before an existing ");" is removed',
    raw: 'value)',
    prefix: 'call(',
    suffix: ');',
    expected: 'value',
  },
  {
    name: 'a ")" that closes the completion\'s own "(" is kept',
    raw: 'fn(x)',
    prefix: 'call(',
    suffix: ');',
    expected: 'fn(x)',
  },
  {
    name: 'only the surplus closer is removed',
    raw: 'fn(a, b))',
    prefix: 'call(',
    suffix: ');',
    expected: 'fn(a, b)',
  },
  {
    name: 'identifiers at the start of the suffix are never cut',
    raw: 'a, b',
    prefix: 'call(',
    suffix: 'b);',
    expected: 'a, b',
  },
  // --- round 3: structure, not indentation (P1-I013, P1-I014, P1-I015) ---
  {
    name: 'Go: an under-indented return inside the block is kept',
    raw: 'http.Error(w, "bad", 400)\n\t\treturn',
    prefix: 'func h() {\n\tif err != nil {\n\t\t\t',
    suffix: '\n\t}\n}\n',
    languageId: 'go',
    expected: 'http.Error(w, "bad", 400)\n\t\treturn',
  },
  {
    name: 'brace language: stops before a closer of the enclosing block when the suffix closes it too',
    raw: 'a();\n}\n\nfunction next() {\n  b();\n}',
    prefix: 'function f() {\n  ',
    suffix: '\n}\n',
    expected: 'a();',
  },
  {
    name: 'brace language: no cut when the suffix does not close the block (end of file)',
    raw: 'a();\n}',
    prefix: 'function f() {\n  ',
    suffix: '',
    expected: 'a();\n}',
  },
  {
    name: "a block's } survives when the completion first closes a ( from the prefix (P1-I014)",
    raw: 'a);\n  if (x) {\n    work();\n  }',
    prefix: 'function f() {\n  call(',
    suffix: '\n}',
    expected: 'a);\n  if (x) {\n    work();\n  }',
  },
  {
    name: 'brackets inside a regex literal do not count',
    raw: 'const re = /[(]/;\n  if (x) {\n    y();\n  }',
    prefix: 'function f() {\n  ',
    suffix: '\n}',
    expected: 'const re = /[(]/;\n  if (x) {\n    y();\n  }',
  },
  {
    name: 'brackets inside a block comment do not count',
    raw: '/* ) */\n  if (x) {\n    y();\n  }',
    prefix: 'function f() {\n  ',
    suffix: '\n}',
    expected: '/* ) */\n  if (x) {\n    y();\n  }',
  },
  {
    name: 'whitespace inside a multi-line template literal is kept (P1-I015)',
    raw: '`a  \nb`;',
    prefix: 'const value = ',
    expected: '`a  \nb`;',
  },
  // --- round 5 review (P1-I018, P1-I019, P1-I020) ---
  {
    name: 'a ) line is not cut because the suffix starts with } (P1-I018)',
    raw: 'value\n  );\n  next();',
    prefix: 'function f() {\n  consume(\n    ',
    suffix: '\n}',
    expected: 'value\n  );\n  next();',
  },
  {
    name: 'the cut needs the same bracket: closing the call ( when the suffix starts with ) (P1-I018)',
    raw: 'value\n  );\n  next();',
    prefix: 'function f() {\n  consume(\n    ',
    suffix: '\n  );\n}',
    expected: 'value',
  },
  {
    name: 'Python: a dedented line inside a triple-quoted string is not a block end (P1-I019)',
    raw: 'text = """\nhello\n    """\n    return text',
    prefix: 'def f():\n    ',
    languageId: 'python',
    expected: 'text = """\nhello\n    """\n    return text',
  },
  {
    name: 'Python: a dedented continuation inside brackets is not a block end (P1-I019)',
    raw: 'total = sum([\n  a,\n  b,\n])\n    return total',
    prefix: 'def f(a, b):\n    ',
    languageId: 'python',
    expected: 'total = sum([\n  a,\n  b,\n])\n    return total',
  },
  {
    name: 'Python: real dedented code after the block is still cut',
    raw: 'return x\n\nprint(f(1))',
    prefix: PY_BODY,
    languageId: 'python',
    expected: 'return x',
  },
  {
    name: 'trailing spaces of a string that the suffix continues are kept (P1-I020)',
    raw: 'hello  ',
    prefix: 'const s = `',
    suffix: 'world`;',
    expected: 'hello  ',
  },
  {
    name: 'a trailing newline inside a continued template literal is kept (P1-I020)',
    raw: 'line one\n',
    prefix: 'const s = `',
    suffix: 'line two`;',
    expected: 'line one\n',
  },
  {
    name: 'an escaped quote after the cursor keeps the string open, so its spaces stay (C8, C-R002)',
    raw: '"   ',
    prefix: 'const s = "a\\',
    suffix: '";',
    expected: '"   ',
  },
  // --- Loop C inspection (C-I001, C-I002, C-I003) ---
  {
    name: 'Python: continuation lines inside a bracket opened before the cursor are kept (C-I001)',
    raw: 'first,\n    second,\n    ]',
    prefix: 'def f():\n    values = [\n        ',
    suffix: '\n    return values',
    languageId: 'python',
    expected: 'first,\n    second,\n    ]',
  },
  {
    name: 'leading spaces inside a template literal at the cursor are content (C-I002)',
    raw: '    hello',
    prefix: 'const s = `\n',
    suffix: '\n`;',
    expected: '    hello',
  },
  {
    name: 'Python: leading spaces inside a triple-quoted string are content (C-I002)',
    raw: '    indented text',
    prefix: 'doc = """\n',
    suffix: '\n"""',
    languageId: 'python',
    expected: '    indented text',
  },
  {
    name: 'a FIM model never echoes: "/" + "/ TODO" stays a line comment (C-I003)',
    raw: '/ TODO',
    prefix: '/',
    suffix: '\n',
    backendKind: 'fim',
    expected: '/ TODO',
  },
  {
    name: 'a chat model\'s punctuation-only "repeat" is not stripped either (C-I003)',
    raw: '/ TODO',
    prefix: '/',
    suffix: '\n',
    expected: '/ TODO',
  },
  {
    name: "a chat model's echo of a word is still stripped",
    raw: 'return a + b;',
    prefix: IN_RETURN,
    backendKind: 'chat',
    expected: 'a + b;',
  },
  {
    name: 'a FIM middle at column 0 keeps its indentation',
    raw: '  return 1;',
    prefix: 'function f() {\n',
    suffix: '\n}',
    backendKind: 'fim',
    expected: '  return 1;',
  },
  {
    name: 'Python FIM at a partially indented cursor keeps its indentation (C-I004)',
    raw: '    return 1',
    prefix: 'def f():\n    if ready:\n    ',
    suffix: '\n',
    languageId: 'python',
    backendKind: 'fim',
    expected: '    return 1',
  },
  {
    name: 'a chat model after the indentation still loses its doubled indent',
    raw: '  return 1;',
    prefix: 'function f() {\n  ',
    suffix: '\n}',
    expected: 'return 1;',
  },
  {
    name: 'a prose-like first line inside a docstring is content (C-I005)',
    raw: 'Here is the example:\nhello',
    prefix: 'doc = """\n',
    suffix: '\n"""',
    languageId: 'python',
    expected: 'Here is the example:\nhello',
  },
  {
    name: 'a fence inside an open template literal is content (C-I005)',
    raw: '```ts\nconst x = 1;\n```',
    prefix: 'const md = `\n',
    suffix: '\n`;',
    expected: '```ts\nconst x = 1;\n```',
  },
  // --- code that looks like prose (P1-I009) ---
  {
    name: 'code starting with "this" after a blank line is kept',
    raw: 'this.start();\n\n  this.finish();',
    prefix: FN_BODY,
    expected: 'this.start();\n\n  this.finish();',
  },
  {
    name: 'a first line like "sure = true;" is code, not prose',
    raw: 'sure = true;\nnext();',
    prefix: '',
    expected: 'sure = true;\nnext();',
  },
  // --- backticks inside code (P1-I007) ---
  {
    name: 'backticks inside a string are kept',
    raw: 'const marker = "```";',
    prefix: '',
    expected: 'const marker = "```";',
  },
  {
    name: 'a fence line after code belongs to the code (template literal)',
    raw: 'const md = `\n```ts\nx\n```\n`;',
    prefix: '',
    expected: 'const md = `\n```ts\nx\n```\n`;',
  },
  {
    name: 'inline backticks in a template literal are kept',
    raw: 'return `use ```code``` here`;',
    prefix: 'function f() {\n  ',
    expected: 'return `use ```code``` here`;',
  },
  // --- max lines ---
  {
    name: 'max lines enforced',
    raw: 'a();\nb();\nc();\nd();',
    prefix: '',
    maxLines: 2,
    expected: 'a();\nb();',
  },
  { name: 'max lines 1', raw: 'a();\nb();', prefix: '', maxLines: 1, expected: 'a();' },
  // --- empty / whitespace ---
  { name: 'empty answer → null', raw: '', prefix: FN_BODY, expected: null },
  { name: 'whitespace-only answer → null', raw: '  \n\t\n', prefix: FN_BODY, expected: null },
  { name: 'only a fence → null', raw: '```\n```', prefix: FN_BODY, expected: null },
  { name: 'only the repeated prefix → null', raw: 'return ', prefix: IN_RETURN, expected: null },
  // --- line endings / trailing whitespace ---
  { name: 'CRLF normalized', raw: 'a();\r\nb();', prefix: '', expected: 'a();\nb();' },
  {
    name: 'trailing whitespace and blank lines trimmed',
    raw: 'return x;   \n\n\n',
    prefix: PY_BODY,
    languageId: 'python',
    expected: 'return x;',
  },
];

const DEFAULT: Omit<PostprocessContext, 'prefix'> = { suffix: '', maxLines: 8 };

describe('postprocess (table)', () => {
  it('has at least 30 cases (PLAN §10 Faz 1 acceptance)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of cases) {
    it(c.name, () => {
      const result = postprocess(c.raw, {
        ...DEFAULT,
        prefix: c.prefix,
        suffix: c.suffix ?? DEFAULT.suffix,
        maxLines: c.maxLines ?? DEFAULT.maxLines,
        languageId: c.languageId ?? 'typescript',
        backendKind: c.backendKind,
      });
      expect(result).toBe(c.expected);
    });
  }
});
