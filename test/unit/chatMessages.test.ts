import { describe, expect, it } from 'vitest';
import {
  CHAT_PREAMBLE,
  estimateTokens,
  allIdOnlyNames,
  EXCLUDED_CONTENT,
  idOnlyAttachmentIds,
  idOnlyNamesForRequest,
  redactExcludedDiffs,
  redactExcludedEvidence,
  TOKENS_PER_MESSAGE,
  toCliPrompt,
  type ChatTurn,
  type IsExcluded,
  type PathKind,
} from '../../src/features/chat/messages';
import { isExcluded } from '../../src/core/context/exclude';
import { buildExcludedContent } from '../../src/features/chat/contentGuard';

const EXCLUDE = ['.env*', '*.pem', 'secrets/**'];
const excluded = (path: string): boolean => isExcluded(path, EXCLUDE);

// A pure stand-in for the extension's oracle: the patterns, plus the existence rule (an absolute
// attachment path that names no file counts as excluded, P2-I011) over a fake workspace at /ws.
const WS = '/ws';
function workspaceOracle(
  files: readonly string[],
  patterns: readonly string[] = EXCLUDE,
): IsExcluded {
  const existing = new Set(files.map((file) => `${WS}/${file}`));
  return (path, kind) => {
    const relative = path.startsWith(`${WS}/`) ? path.slice(WS.length + 1) : path;
    if (isExcluded(relative, patterns) || isExcluded(path, patterns)) return true;
    return kind === 'attachment' && path.startsWith('/') && !existing.has(path);
  };
}

const fence = '```';

// The format observed with VS Code 1.143.1 / Copilot Chat 0.71.0 (docs/plans/phase-2.md §3 A3).
const COPILOT_USER_MESSAGE = [
  '<attachments>',
  '<attachment id="a.ts">',
  '// filepath: /home/u/ws/src/a.ts',
  'export const a = 1; // KEEP_MARK',
  '</attachment>',
  '<attachment id=".env">',
  '// filepath: /home/u/ws/.env',
  'API_KEY=SECRET_ENV_MARK',
  '</attachment>',
  '',
  '</attachments>',
  '<prompt>',
  'explain these files',
  '</prompt>',
].join('\n');

describe('redactExcludedEvidence (D4, AGENTS rule 6)', () => {
  it('redacts an excluded file in the observed Copilot format and keeps the others', () => {
    const result = redactExcludedEvidence(COPILOT_USER_MESSAGE, excluded);
    expect(result).not.toContain('SECRET_ENV_MARK');
    expect(result).toContain(EXCLUDED_CONTENT);
    expect(result).toContain(`<attachment id=".env">\n${EXCLUDED_CONTENT}\n</attachment>`);
    expect(result).toContain('KEEP_MARK');
    expect(result).toContain('<prompt>\nexplain these files\n</prompt>');
  });

  it('uses the filePath attribute of instruction attachments', () => {
    const text = '<attachment filePath="/w/secrets/notes.md">\nSECRET_NOTE\n</attachment>';
    const result = redactExcludedEvidence(text, excluded);
    expect(result).not.toContain('SECRET_NOTE');
    expect(result).toContain('filePath="/w/secrets/notes.md"');
  });

  it('keeps a non-matching attachment unchanged', () => {
    const text = '<attachment id="a.ts">\n// filepath: /w/src/a.ts\nconst a = 1;\n</attachment>';
    expect(redactExcludedEvidence(text, excluded)).toBe(text);
  });

  it('leaves a block without a matching path unchanged', () => {
    const noPath = '<attachment id="notes.txt">\nplain text\n</attachment>';
    expect(redactExcludedEvidence(noPath, excluded)).toBe(noPath);
  });

  it('uses the id (file name) when there is no filepath marker', () => {
    const text = '<attachment id=".env">\nSECRET_ID_ONLY\n</attachment>';
    expect(redactExcludedEvidence(text, excluded)).not.toContain('SECRET_ID_ONLY');
  });

  it('keeps no body line of a filePath attachment, even one that looks like a marker (P2-I003)', () => {
    const withClaude = (path: string): boolean => isExcluded(path, [...EXCLUDE, 'CLAUDE.md']);
    const text =
      '<attachment filePath="/w/CLAUDE.md">\n# filepath: API_KEY=SECRET\nprivate notes\n</attachment>';
    expect(redactExcludedEvidence(text, withClaude)).toBe(
      `<attachment filePath="/w/CLAUDE.md">\n${EXCLUDED_CONTENT}\n</attachment>`,
    );
  });

  it.each([
    [
      '> in the id',
      '<attachment id=".env>prod">\n// filepath: /w/.env>prod\nSECRET_GT\n</attachment>',
    ],
    ['> in filePath', '<attachment filePath="/w/secrets/a>b.md">\nSECRET_GT\n</attachment>'],
    ['" in the name', '<attachment id=".env"x">\n// filepath: /w/.env"x\nSECRET_GT\n</attachment>'],
    [
      'a line break in the name',
      '<attachment id=".env\nx">\n// filepath: /w/.env\nx\nSECRET_GT\n</attachment>',
    ],
  ])('recognises a tag with %s (P2-I004)', (_label, text) => {
    const result = redactExcludedEvidence(text, excluded);
    expect(result).not.toContain('SECRET_GT');
    expect(result).toContain(EXCLUDED_CONTENT);
  });

  it('redacts an unclosed excluded block up to the end of the message', () => {
    const unclosed = 'see <attachment id=".env">\n// filepath: /w/.env\nSECRET';
    expect(redactExcludedEvidence(unclosed, excluded)).toBe(
      `see <attachment id=".env">\n${EXCLUDED_CONTENT}\n</attachment>`,
    );
  });

  it('a closing tag inside the excluded file does not end the redaction early (P2-I001)', () => {
    const text = [
      '<attachments>',
      '<attachment id=".env">',
      '// filepath: /w/.env',
      'TEMPLATE=</attachment>',
      'API_KEY=SECRET_AFTER_CLOSE',
      '</attachment>',
      '</attachments>',
      '<prompt>',
      'why does it fail?',
      '</prompt>',
    ].join('\n');
    const result = redactExcludedEvidence(text, excluded);
    expect(result).not.toContain('SECRET_AFTER_CLOSE');
    expect(result).toContain(EXCLUDED_CONTENT);
    expect(result).toContain('</attachments>\n<prompt>\nwhy does it fail?\n</prompt>');
  });

  it('attachment-like text inside the excluded file cannot carry content out (P2-I001)', () => {
    const text = [
      '<attachment id=".env">',
      '// filepath: /w/.env',
      'A=1',
      '</attachment>',
      '<attachment id="fake.ts">',
      '// filepath: /w/src/fake.ts',
      'SECRET_IN_FAKE_BLOCK',
      '</attachment>',
    ].join('\n');
    expect(redactExcludedEvidence(text, excluded)).not.toContain('SECRET_IN_FAKE_BLOCK');
  });

  it('removes the attachments that follow an excluded one in the same message (cost)', () => {
    const text = [
      '<attachments>',
      '<attachment id=".env">',
      '// filepath: /w/.env',
      'API_KEY=SECRET',
      '</attachment>',
      '<attachment id="b.ts">',
      '// filepath: /w/src/b.ts',
      'AFTER_MARK',
      '</attachment>',
      '</attachments>',
      '<prompt>question</prompt>',
    ].join('\n');
    const result = redactExcludedEvidence(text, excluded);
    expect(result).not.toContain('SECRET');
    expect(result).not.toContain('AFTER_MARK');
    expect(result).toContain('</attachments>\n<prompt>question</prompt>');
  });

  it('handles several blocks, including inside <instructions>', () => {
    const text =
      '<instructions>\n<attachment filePath="/w/.env">\nSECRET_A\n</attachment>\n</instructions>\n' +
      '<attachments>\n<attachment id="k.pem">\n// filepath: /w/k.pem\nSECRET_B\n</attachment>\n</attachments>';
    const result = redactExcludedEvidence(text, excluded);
    expect(result).not.toContain('SECRET_A');
    expect(result).not.toContain('SECRET_B');
  });

  it('an unreadable Copilot-style tag counts as excluded; prose mentioning <attachment does not (P2-I010)', () => {
    const newlineName =
      '<attachment id="key\nprod.pem">\n// filepath: /w/key\nprod.pem\nPRIVATE_KEY_MARK\n</attachment>';
    expect(redactExcludedEvidence(newlineName, excluded)).not.toContain('PRIVATE_KEY_MARK');
    const prose = 'What is an <attachment tag for?\nIt wraps files.';
    expect(redactExcludedEvidence(prose, excluded)).toBe(prose);
  });

  it('leaves a text without evidence of an excluded file unchanged', () => {
    const text = [
      'Look at <errors path="/w/src/a.ts"> and `x`:',
      `${fence}ts`,
      '// filepath: /w/src/a.ts',
      'const a = 1;',
      fence,
      'Excerpt from src/b.ts, lines 1 to 2:',
      'Here is a potentially relevant text excerpt in `/w/src/c.ts` starting at line 3:',
    ].join('\n');
    expect(redactExcludedEvidence(text, excluded)).toBe(text);
  });

  it('checks attachment evidence as attachment paths', () => {
    const kinds: [string, PathKind][] = [];
    const record: IsExcluded = (path, kind) => {
      kinds.push([path, kind]);
      return false;
    };
    redactExcludedEvidence(
      '<attachment id="a.ts">\n// filepath: /w/src/a.ts\nx\n</attachment>',
      record,
    );
    expect(kinds).toEqual([
      ['a.ts', 'attachment'],
      ['/w/src/a.ts', 'attachment'],
    ]);
  });
});

describe('filepath markers (H1)', () => {
  const oracle = workspaceOracle(['src/page.html', 'secrets/deploy.bat']);

  // Copilot's comment openers per language: bat, vb/abap, erb, haml, handlebars, slim and the
  // C-like, hash, SQL, Lisp, TeX, HTML and block-comment families (cases 08 and 16).
  it.each([
    ['REM', 'REM filepath: /ws/secrets/deploy.bat'],
    ["'", "' filepath: /ws/secrets/deploy.bat"],
    ['<%# %>', '<%# filepath: /ws/secrets/deploy.bat %>'],
    ['-#', '-# filepath: /ws/secrets/deploy.bat'],
    ['{{! }}', '{{! filepath: /ws/secrets/deploy.bat }}'],
    ['/', '/ filepath: /ws/secrets/deploy.bat'],
    ['//', '// filepath: /ws/secrets/deploy.bat'],
    ['#', '# filepath: /ws/secrets/deploy.bat'],
    ['--', '-- filepath: /ws/secrets/deploy.bat'],
    [';', '; filepath: /ws/secrets/deploy.bat'],
    ['%', '% filepath: /ws/secrets/deploy.bat'],
    ['<!-- -->', '<!-- filepath: /ws/secrets/deploy.bat -->'],
    ['/* */', '/* filepath: /ws/secrets/deploy.bat */'],
    ['no opener', 'filepath: /ws/secrets/deploy.bat'],
    ['indentation', '    # filepath: /ws/secrets/deploy.bat'],
  ])('recognises a %s marker', (_label, marker) => {
    const text = `<attachment id="deploy.bat">\n${marker}\nset PASSWORD=SECRET_MARKER\n</attachment>`;
    expect(redactExcludedEvidence(text, oracle)).toBe(
      `<attachment id="deploy.bat">\n${EXCLUDED_CONTENT}\n</attachment>`,
    );
  });

  it.each([
    ['<!-- -->', '<!-- filepath: /ws/src/page.html -->'],
    ['<%# %>', '<%# filepath: /ws/src/page.html %>'],
    ['{{! }}', '{{! filepath: /ws/src/page.html }}'],
    ['/* */', '/* filepath: /ws/src/page.html */'],
    ['a trailing CR', '<!-- filepath: /ws/src/page.html -->\r'],
  ])('a %s closer is not part of the path, so an existing file stays', (_label, marker) => {
    const text = `<attachment id="page.html">\n${marker}\n<p>KEEP</p>\n</attachment>`;
    expect(redactExcludedEvidence(text, oracle)).toBe(text);
  });

  it.each([
    ['CR', '\r'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ])('a %s in the path does not hide the marker (case 14)', (_label, terminator) => {
    const atEnd = `<attachment id="t">\n// filepath: /ws/secrets/api_token${terminator}\nSECRET_TERM\n</attachment>`;
    expect(redactExcludedEvidence(atEnd, oracle)).not.toContain('SECRET_TERM');
    const inside = `<attachment id="t">\n// filepath: /ws/secrets/a${terminator}b\nSECRET_TERM\n</attachment>`;
    expect(redactExcludedEvidence(inside, oracle)).not.toContain('SECRET_TERM');
    // A trailing terminator is not part of the path, so a name pattern matches (cases 03, 13).
    const name = `<attachment id="t">\n// filepath: /w/certs/server.pem${terminator}\nSECRET_TERM\n</attachment>`;
    expect(redactExcludedEvidence(name, excluded)).not.toContain('SECRET_TERM');
  });
});

describe('attribute values (H4)', () => {
  const oracle = workspaceOracle(['notes/12" vinyl.txt', 'img/photo.png']);

  it('decodes JSON escapes in values', () => {
    const escapedDot = '<attachment id="\\u002eenv">\nSECRET_ESCAPED\n</attachment>';
    expect(redactExcludedEvidence(escapedDot, oracle)).toBe(
      `<attachment id=".env">\n${EXCLUDED_CONTENT}\n</attachment>`,
    );
    const quote =
      '<attachment id="12\\" vinyl.txt">\n// filepath: /ws/notes/12" vinyl.txt\nKEEP\n</attachment>';
    expect(redactExcludedEvidence(quote, oracle)).toBe(quote);
  });

  it('allows bare numbers and booleans', () => {
    const text =
      '<attachment id="photo.png" startByte=0 endByte=4 totalSize=4 truncated=true>\n00000000  89 50 4e 47\n</attachment>';
    expect(redactExcludedEvidence(text, oracle)).toBe(text);
  });

  it('a value that does not decode makes the tag unreadable, and it counts as excluded', () => {
    const text =
      '<attachment id="a\\x41.ts">\nSECRET_UNDECODABLE\n</attachment>\n<prompt>q</prompt>';
    expect(redactExcludedEvidence(text, oracle)).toBe(
      `<attachment>\n${EXCLUDED_CONTENT}\n</attachment>\n<prompt>q</prompt>`,
    );
  });

  it('a path-bearing tag that does not parse on its line counts as excluded', () => {
    const text = '<errors path="/ws/src/a\nb.ts">\nSECRET_BROKEN_TAG\n</errors>\nafter';
    expect(redactExcludedEvidence(text, oracle)).toBe(`${EXCLUDED_CONTENT}\nafter`);
    const pathAfterFailure =
      '<notebook-cell-output data={"a":1} notebookPath="/ws/img/photo.png">\nSECRET_BROKEN_TAG\n</notebook-cell-output>\nafter';
    expect(redactExcludedEvidence(pathAfterFailure, oracle)).toBe(`${EXCLUDED_CONTENT}\nafter`);
    const ltBeforeFailure =
      '<notebook-cell-output mimeType="a<b" data={"a":1} notebookPath="/ws/img/photo.png">\nSECRET_BROKEN_TAG\n</notebook-cell-output>\nafter';
    expect(redactExcludedEvidence(ltBeforeFailure, oracle)).toBe(`${EXCLUDED_CONTENT}\nafter`);
  });

  it('a path attribute of a later tag on the line does not make a broken tag unreadable', () => {
    const text = '<Item onClick={() => go()} /> <errors path="/ws/img/photo.png">KEEP</errors>';
    expect(redactExcludedEvidence(text, oracle)).toBe(text);
  });
});

describe('path-bearing elements and URIs (H3, H3a)', () => {
  const oracle = workspaceOracle(['src/a.ts', 'src/ok.ipynb']);
  const wrap = (tag: string): string => `${tag}\nSECRET_URI\n</reference>\nafter`;

  it.each([
    ['a percent-encoded file: URI', '<reference uri="file:///ws/%73ecrets/key.txt">'],
    ['a file: URI with an encoded name', '<reference uri="file:///ws/src/k%2Epem">'],
    ['a file: URI with an encoded slash', '<reference uri="file:///ws/src/a%2Fb.ts">'],
    ['a file: URI with a host', '<reference uri="file://server/ws/src/a.ts">'],
    ['a malformed escape', '<reference uri="file:///ws/src/%E0%A4%A.ts">'],
    [
      'a notebook cell URI',
      '<reference uri="vscode-notebook-cell:/ws/secrets/an%20alysis.ipynb#W0sZmlsZQ%3D%3D">',
    ],
    [
      'a notebook output URI',
      '<reference uri="vscode-notebook-cell-output:/ws/secrets/a.ipynb#W1sZmlsZQ%3D%3D">',
    ],
    [
      'a remote URI under an excluded folder',
      '<reference uri="vscode-remote://h/u/secrets/a.txt">',
    ],
    ['filePath on any tag', '<reference filePath="/ws/secrets/a.txt">'],
    ['notebookPath', '<reference notebookPath="/ws/secrets/a.ipynb">'],
  ])('removes %s that names an excluded or unknown file', (_label, tag) => {
    expect(redactExcludedEvidence(wrap(tag), oracle)).toBe(`${EXCLUDED_CONTENT}\nafter`);
  });

  it.each([
    ['a file: URI of an existing file', '<reference uri="file:///ws/src/%61.ts">'],
    [
      'a notebook cell URI of an existing file',
      '<reference uri="vscode-notebook-cell:/ws/src/ok.ipynb#W0">',
    ],
    ['an untitled: URI (not a filesystem path)', '<reference uri="untitled:Untitled-1">'],
    ['a remote URI elsewhere', '<reference uri="vscode-remote://ssh-remote%2Bbox/home/u/a.txt">'],
  ])('keeps %s', (_label, tag) => {
    expect(redactExcludedEvidence(wrap(tag), oracle)).toBe(wrap(tag));
  });

  it('decodes a file: URI in a marker too', () => {
    const text =
      '<attachment id="x">\n// filepath: file:///ws/.%65nv\nSECRET_MARKER_URI\n</attachment>';
    expect(redactExcludedEvidence(text, oracle)).not.toContain('SECRET_MARKER_URI');
  });
});

describe('removal ranges (H2)', () => {
  const files = ['src/a.ts', 'src/app.ts', 'docs/notes.md', 'src/b.ts'];
  const oracle = workspaceOracle(files);

  it('attachments: an allowed attachment before an excluded one keeps its content (HARD-R004)', () => {
    const kept = [
      '<attachments>',
      '<attachment id="a.ts">',
      '// filepath: /ws/src/a.ts',
      'export const a = 1; // KEEP_FIRST',
      '</attachment>',
    ];
    const text = [
      ...kept,
      '<attachment id=".env">',
      '// filepath: /ws/.env',
      'API_KEY=SECRET_SECOND',
      '</attachment>',
      '</attachments>',
      '<prompt>',
      'explain',
      '</prompt>',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(
      [
        ...kept,
        '<attachment id=".env">',
        EXCLUDED_CONTENT,
        '</attachment>',
        '</attachments>',
        '<prompt>',
        'explain',
        '</prompt>',
      ].join('\n'),
    );
  });

  it('tool results: an excluded <errors> runs to the tool attachment close (case 10 format)', () => {
    const allowed = [
      '<attachment tool="#problems">',
      '<errors path="/ws/src/app.ts">',
      'This code at line 1',
      fence,
      "export const port: number = 'KEEP_APP_LINE';",
      fence,
      '</errors>',
    ];
    const text = [
      ...allowed,
      '<errors path="/ws/secrets/config.ts">',
      'This code at line 1',
      fence,
      'export const KEY = "SECRET_ERRORS";',
      fence,
      '</errors>',
      '</attachment>',
      '<prompt>',
      '#problems why?',
      '</prompt>',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(
      [...allowed, EXCLUDED_CONTENT, '<prompt>', '#problems why?', '</prompt>'].join('\n'),
    );
  });

  it('notebook outputs: removed from the fence with the marker to the output close (case 06 format)', () => {
    const text = [
      '<attachments>',
      '<attachment id="nb.ipynb">',
      'Excerpt from nb.ipynb, lines 1 to 2:',
      `${fence}python`,
      '# filepath: /ws/secrets/nb.ipynb',
      'print(TOKEN)  # SECRET_SOURCE',
      fence,
      '</attachment>',
      '<notebook-cell-output mimeType="text/plain" outputIndex=0 cellIndex=0 notebookPath="/ws/secrets/nb.ipynb">',
      'SECRET_OUTPUT',
      '</notebook-cell-output>',
      '</attachments>',
      '<prompt>',
      'why?',
      '</prompt>',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(
      [
        '<attachments>',
        '<attachment id="nb.ipynb">',
        'Excerpt from nb.ipynb, lines 1 to 2:',
        EXCLUDED_CONTENT,
        '</attachments>',
        '<prompt>',
        'why?',
        '</prompt>',
      ].join('\n'),
    );
  });

  it('excerpts: an excerpt description names the file of its attachment', () => {
    const text = [
      '<attachment id="x">',
      'Excerpt from secrets/key.txt, lines 1 to 1:',
      'SECRET_EXCERPT',
      '</attachment>',
      'after',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(
      `<attachment id="x">\n${EXCLUDED_CONTENT}\n</attachment>\nafter`,
    );
  });

  it('fenced history: a fence whose first line is a marker is removed to its close (H6)', () => {
    const text = [
      'Here is the updated file:',
      '',
      '````properties',
      '# filepath: /ws/.env',
      'STRIPE_KEY=SECRET_HISTORY',
      '````',
      '',
      'KEEP_PROSE',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(
      ['Here is the updated file:', '', EXCLUDED_CONTENT, '', 'KEEP_PROSE'].join('\n'),
    );
  });

  it('fenced history: a fence line inside the file does not end the removal early', () => {
    const text = [
      `${fence}properties`,
      '# filepath: /ws/.env',
      'A=1',
      fence,
      'SECRET_AFTER_FAKE_FENCE',
      fence,
      'KEEP_PROSE',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(`${EXCLUDED_CONTENT}\nKEEP_PROSE`);
  });

  it('an indented fence (list item) bounds the removal as well', () => {
    const text = [
      '1. Update the file:',
      `   ${fence}properties`,
      '   # filepath: /ws/.env',
      '   KEY=SECRET_INDENTED',
      `   ${fence}`,
      '2. KEEP_STEP',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(
      `1. Update the file:\n${EXCLUDED_CONTENT}\n2. KEEP_STEP`,
    );
  });

  it('a marker typed into the question removes from the nearest preceding opening tag (cost)', () => {
    const text = [
      '<attachments>',
      '<attachment id="a.ts">',
      '// filepath: /ws/src/a.ts',
      'LOST_A',
      '</attachment>',
      '</attachments>',
      '<prompt>',
      '// filepath: /ws/.env',
      'what does this mean?',
      '</prompt>',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(
      `<attachments>\n<attachment id="a.ts">\n${EXCLUDED_CONTENT}\n</attachment>`,
    );
  });

  describe('a literal </attachment> in an allowed excerpt of a tool attachment (HARD-R005)', () => {
    const header = (path: string): string =>
      `Here is a potentially relevant text excerpt in \`${path}\` starting at line 1:`;
    const allowedExcerpt = [
      '<attachment tool="#codebase">',
      header('/ws/docs/notes.md'),
      `${fence}markdown`,
      '// filepath: /ws/docs/notes.md',
      'A literal </attachment> in the docs.',
    ];
    const fakeErrors = ['<errors path="/ws/src/b.ts">', 'fake', '</errors>'];
    const question = ['<prompt>', 'KEEP_QUESTION', '</prompt>'];

    it.each([
      ['a search header', header('/ws/secrets/pin.txt')],
      ['an excerpt description', 'Excerpt from /ws/secrets/pin.txt, lines 1 to 1:'],
    ])('alone, then %s and PIN=123', (_label, excludedHeader) => {
      const text = [
        ...allowedExcerpt,
        fence,
        '',
        excludedHeader,
        'PIN=123',
        '',
        '</attachment>',
        ...question,
      ].join('\n');
      // S is the allowed excerpt's closing fence; T the tool attachment's real close.
      const result = redactExcludedEvidence(text, oracle);
      expect(result).not.toContain('PIN=123');
      expect(result).toBe([...allowedExcerpt, EXCLUDED_CONTENT, ...question].join('\n'));
    });

    it.each([
      ['a search header', header('/ws/secrets/pin.txt')],
      ['an excerpt description', 'Excerpt from /ws/secrets/pin.txt, lines 1 to 1:'],
    ])(
      'followed by a fake <errors path=…>…</errors>, then %s and PIN=123',
      (_label, excludedHeader) => {
        const text = [
          ...allowedExcerpt,
          ...fakeErrors,
          fence,
          '',
          excludedHeader,
          'PIN=123',
          '',
          '</attachment>',
          ...question,
        ].join('\n');
        // The fake element belongs to the allowed excerpt and stays; PIN=123 does not.
        const result = redactExcludedEvidence(text, oracle);
        expect(result).not.toContain('PIN=123');
        expect(result).toBe(
          [...allowedExcerpt, ...fakeErrors, EXCLUDED_CONTENT, ...question].join('\n'),
        );
      },
    );
  });
});

interface RedTeamCase {
  files: string[];
  turns: ChatTurn[];
  secrets: string[];
  keeps: string[];
  /** Allowed content the plan accepts losing (documented costs, H2 and H9). */
  lost?: string[];
}

const ask = (attachments: string[], question: string): ChatTurn => ({
  role: 'user',
  text: ['<attachments>', ...attachments, '</attachments>', '<prompt>', question, '</prompt>'].join(
    '\n',
  ),
});

// The parser-level red-team cases (docs/plans/phase-2-review.md, "Red-team pass"), with the
// workspace at /ws. Case 07 needs the content net's names and is tested on its own below.
const RED_TEAM: Record<string, RedTeamCase> = {
  '03 file name ending in CR: JSON-escaped id, raw CR in the marker': {
    files: ['src/a.ts', 'certs/server.pem\r'],
    turns: [
      {
        role: 'user',
        text: '<attachment id="server.pem\\r">\n// filepath: /ws/certs/server.pem\r\nSECRET_CR\n</attachment>\n<prompt>explain</prompt>',
      },
    ],
    secrets: ['SECRET_CR'],
    keeps: ['explain'],
  },
  '06 notebook cell output in a sibling <notebook-cell-output>': {
    files: ['src/app.ts', 'secrets/analysis.ipynb'],
    turns: [
      ask(
        [
          '<attachment id="analysis.ipynb">',
          'Excerpt from analysis.ipynb, lines 1 to 3:',
          `${fence}python`,
          '# filepath: /ws/secrets/analysis.ipynb',
          '#%% vscode.cell [id=#VSC-1] [language=python]',
          'import os',
          "print(os.environ['API_TOKEN'])  # NB_SOURCE_SECRET",
          fence,
          '</attachment>',
          '<attachment>',
          "User's active file for additional context:",
          '# filepath: /ws/secrets/analysis.ipynb',
          '#%% vscode.cell [id=#VSC-1] [language=python]',
          'import os',
          "print(os.environ['API_TOKEN'])  # NB_SOURCE_SECRET",
          '</attachment>',
          '',
          '<notebook-cell-output mimeType="text/plain" outputIndex=0 cellIndex=0 notebookPath="/ws/secrets/analysis.ipynb">',
          'tok_SECRET_NB_OUTPUT_9f3a',
          '</notebook-cell-output>',
        ],
        'Why is this token printed?',
      ),
    ],
    secrets: ['NB_SOURCE_SECRET', 'tok_SECRET_NB_OUTPUT_9f3a'],
    keeps: ['Why is this token printed?'],
  },
  '08 bat file: REM marker': {
    files: ['src/app.ts', 'secrets/deploy.bat'],
    turns: [
      ask(
        [
          '<attachment id="app.ts">',
          '// filepath: /ws/src/app.ts',
          'export const x = 1; // KEEP_APP',
          '</attachment>',
          '<attachment id="deploy.bat">',
          'REM filepath: /ws/secrets/deploy.bat',
          '@echo off',
          'set DB_PASSWORD=SECRET_BAT_PW',
          '</attachment>',
        ],
        'Explain the deploy script',
      ),
    ],
    secrets: ['SECRET_BAT_PW'],
    keeps: ['KEEP_APP', 'Explain the deploy script'],
  },
  // A documented cost since the module review of H5: the range ends at the last </attachment>,
  // because file content can fake an </attachment></attachments> pair before the real end.
  '09 (over) a literal </attachment> in the question': {
    files: ['.env', 'src/parser.ts'],
    turns: [
      ask(
        [
          '<attachment id=".env">',
          '// filepath: /ws/.env',
          'API_KEY=SECRET_ENV_VALUE',
          '</attachment>',
        ],
        'KEEP_QUERY_START: my parser stops at the first </attachment> tag; how do I make it find the real end? KEEP_QUERY_END',
      ),
    ],
    secrets: ['SECRET_ENV_VALUE'],
    keeps: ['KEEP_QUERY_END'],
    lost: ['KEEP_QUERY_START'],
  },
  '10 #problems: code lines under <errors path>': {
    files: ['src/app.ts', 'secrets/config.ts'],
    turns: [
      {
        role: 'system',
        text: 'You are an AI programming assistant.\nWhen asked for your name, you must respond with "GitHub Copilot".',
      },
      {
        role: 'user',
        text: [
          "These attachments may have useful context for the user's query. The user may refer to these attachments directly using a term that starts with #.",
          '<attachment tool="#problems">',
          '<errors path="/ws/src/app.ts">',
          'This code at line 1',
          fence,
          "export const port: number = 'KEEP_APP_LINE';",
          fence,
          'has the problem reported:',
          '<compileError>',
          "Type 'string' is not assignable to type 'number'.",
          '</compileError>',
          '</errors>',
          '<errors path="/ws/secrets/config.ts">',
          'This code at line 1',
          fence,
          'export const STRIPE_KEY: number = "sk_live_SECRET_CH1";',
          fence,
          'has the problem reported:',
          '<compileError>',
          "Type 'string' is not assignable to type 'number'.",
          '</compileError>',
          '</errors>',
          '</attachment>',
          '<prompt>',
          '#problems why do these fail?',
          '</prompt>',
        ].join('\n'),
      },
    ],
    secrets: ['sk_live_SECRET_CH1'],
    keeps: ['KEEP_APP_LINE', 'why do these fail?'],
  },
  '11 #codebase: the excluded chunk is not the first one': {
    files: ['src/billing.ts', 'secrets/config.ts'],
    turns: [
      {
        role: 'user',
        text: [
          "These attachments may have useful context for the user's query. The user may refer to these attachments directly using a term that starts with #.",
          '<attachment tool="#codebase">',
          'Here is a potentially relevant text excerpt in `/ws/src/billing.ts` starting at line 1:',
          `${fence}typescript`,
          '// filepath: /ws/src/billing.ts',
          "import { STRIPE_KEY } from '../secrets/config';",
          'export const client = new Stripe(STRIPE_KEY); // KEEP_BILLING',
          fence,
          '',
          'Here is a potentially relevant text excerpt in `/ws/secrets/config.ts` starting at line 1:',
          `${fence}typescript`,
          '// filepath: /ws/secrets/config.ts',
          'export const STRIPE_KEY = "sk_live_SECRET_CH2";',
          fence,
          '',
          '</attachment>',
          '<prompt>',
          '#codebase where is the Stripe client configured?',
          '</prompt>',
        ].join('\n'),
      },
    ],
    secrets: ['sk_live_SECRET_CH2'],
    // The allowed chunk before the excluded one survives: S is the closing fence before it.
    keeps: ['where is the Stripe client configured?', 'KEEP_BILLING'],
  },
  '12 history: an assistant turn quotes the file in a filepath code block': {
    files: ['.env'],
    turns: [
      { role: 'system', text: 'You are an AI programming assistant.' },
      {
        role: 'user',
        text: '<attachment id=".env">\n# filepath: /ws/.env\nAPI_KEY=sk-live-SECRET_CH3\n</attachment>',
      },
      { role: 'user', text: 'rename API_KEY to STRIPE_KEY' },
      {
        role: 'assistant',
        text: 'Here is the updated file:\n\n````properties\n# filepath: /ws/.env\nSTRIPE_KEY=sk-live-SECRET_CH3\n````\n\nKEEP_ASSISTANT_PROSE',
      },
      { role: 'user', text: '<prompt>\nnow update the code that reads it\n</prompt>' },
    ],
    secrets: ['SECRET_CH3'],
    keeps: ['KEEP_ASSISTANT_PROSE', 'now update the code that reads it'],
  },
  '13 .env<CR>: JSON-escaped id, raw CR in the marker': {
    files: ['src/a.ts', '.env\r'],
    turns: [
      ask(
        [
          '<attachment id="a.ts">',
          '// filepath: /ws/src/a.ts',
          'KEEP_A',
          '</attachment>',
          '<attachment id=".env\\r">',
          '// filepath: /ws/.env\r',
          'API_KEY=SECRET_CR',
          '</attachment>',
        ],
        'explain',
      ),
    ],
    secrets: ['SECRET_CR'],
    keeps: ['KEEP_A', 'explain'],
  },
  '14 secrets/api_token<CR>: only the marker names the directory': {
    files: ['src/a.ts', 'secrets/api_token\r'],
    turns: [
      ask(
        [
          '<attachment id="a.ts">',
          '// filepath: /ws/src/a.ts',
          'KEEP_A',
          '</attachment>',
          '<attachment id="api_token\\r">',
          '// filepath: /ws/secrets/api_token\r',
          'ghp_SECRET_CR_DIR',
          '</attachment>',
        ],
        'explain',
      ),
    ],
    secrets: ['SECRET_CR_DIR'],
    keeps: ['KEEP_A', 'explain'],
  },
  '16 deploy.cmd: REM marker, id is only the basename': {
    files: ['src/a.ts', 'secrets/deploy.cmd'],
    turns: [
      ask(
        [
          '<attachment id="a.ts">',
          '// filepath: /ws/src/a.ts',
          'KEEP_A',
          '</attachment>',
          '<attachment id="deploy.cmd">',
          'REM filepath: /ws/secrets/deploy.cmd',
          'set DB_PASSWORD=SECRET_REM',
          '</attachment>',
        ],
        'explain',
      ),
    ],
    secrets: ['SECRET_REM'],
    keeps: ['KEEP_A', 'explain'],
  },
  '17 (over) a kept file with an escaped quote in its name': {
    files: ['notes/12" vinyl.txt', 'src/b.ts'],
    turns: [
      ask(
        [
          '<attachment id="12\\" vinyl.txt">',
          '// filepath: /ws/notes/12" vinyl.txt',
          'KEEP_VINYL',
          '</attachment>',
          '<attachment id="b.ts">',
          '// filepath: /ws/src/b.ts',
          'KEEP_B',
          '</attachment>',
        ],
        'KEEP_QUERY summarise both files',
      ),
    ],
    secrets: [],
    keeps: ['KEEP_VINYL', 'KEEP_B', 'KEEP_QUERY'],
  },
  '18 (accepted over-redaction) an attachment-like text inside a kept file': {
    files: ['test/unit/chatMessages.test.ts', 'src/b.ts'],
    turns: [
      ask(
        [
          '<attachment id="chatMessages.test.ts">',
          '// filepath: /ws/test/unit/chatMessages.test.ts',
          "import { describe } from 'vitest';",
          'const text = [',
          `  '<attachment id=".env">',`,
          "  'SECRET',",
          "].join('\\n');",
          'KEEP_TEST_TAIL',
          '</attachment>',
          '<attachment id="b.ts">',
          '// filepath: /ws/src/b.ts',
          'KEEP_B',
          '</attachment>',
        ],
        'KEEP_QUERY why does this test fail?',
      ),
    ],
    secrets: [],
    keeps: ["import { describe } from 'vitest';", 'KEEP_QUERY'],
    lost: ['KEEP_TEST_TAIL', 'KEEP_B'],
  },
};

describe('red-team cases (docs/plans/phase-2-review.md, AC1, AC2)', () => {
  it.each(Object.entries(RED_TEAM))('%s', (_name, spec) => {
    const { system, prompt } = toCliPrompt(spec.turns, workspaceOracle(spec.files));
    const sent = `${system}\n${prompt}`;
    expect(spec.secrets.filter((secret) => sent.includes(secret))).toEqual([]);
    expect(spec.keeps.filter((keep) => !sent.includes(keep))).toEqual([]);
    expect((spec.lost ?? []).filter((lost) => sent.includes(lost))).toEqual([]);
  });

  // A binary attachment (Copilot's hex dump) carries only `id=<basename>`, which a directory
  // pattern cannot match. The content net's basenames of excluded files close it.
  const binary = ask(
    [
      '<attachment id="prod.p12" startByte=0 endByte=49 totalSize=49 truncated=true>',
      '00000000  30 82 04 a2 02 01 03 30  82 04 5c 06 09 00 00 01  |0......0..\\.....|',
      '00000010  53 45 43 52 45 54 5f 50  31 32 5f 4d 41 52 4b 21  |SECRET_P12_MARK!|',
      '00000020  00 01 02 03 70 61 73 73  3d 68 75 6e 74 65 72 32  |....pass=hunter2|',
      '00000030  00                                                |.|',
      '</attachment>',
    ],
    'What kind of file is this?',
  ).text;
  const binaryOracle = workspaceOracle(['src/app.ts', 'secrets/prod.p12']);

  it('07 binary attachment: removed when its id is an excluded basename', () => {
    const result = redactExcludedEvidence(binary, binaryOracle, new Set(['prod.p12']));
    for (const secret of ['SECRET_P12_MARK!', 'pass=hunter2', '53 45 43 52 45 54 5f 50']) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain(`<attachment id="prod.p12">\n${EXCLUDED_CONTENT}\n</attachment>`);
    expect(result).toContain('What kind of file is this?');
  });

  it('07 binary attachment: without the names the parser cannot see it (content net needed)', () => {
    expect(redactExcludedEvidence(binary, binaryOracle)).toBe(binary);
  });

  it('07 binary attachment: an NFC id matches an NFD name from disk, and the reverse', () => {
    const nfc = 'şifre.p12'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    for (const [id, name] of [
      [nfc, nfd],
      [nfd, nfc],
    ] as const) {
      const text = binary.replace('id="prod.p12"', `id="${id}"`);
      const { names } = buildExcludedContent([{ path: `/w/secrets/${name}` }]);
      expect(redactExcludedEvidence(text, binaryOracle, names)).not.toContain('SECRET_P12_MARK!');
    }
  });

  it('07 binary attachment: a name in mixed normalisation on disk matches any id (HARD-I005)', () => {
    const nfc = 'café'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    const { names } = buildExcludedContent([{ path: `/w/secrets/${nfc}-${nfd}.bin` }]);
    for (const id of [`${nfc}-${nfc}.bin`, `${nfd}-${nfd}.bin`, `${nfd}-${nfc}.bin`]) {
      const text = binary.replace('id="prod.p12"', `id="${encodeURIComponent(id)}"`);
      expect(redactExcludedEvidence(text, binaryOracle, names)).not.toContain('SECRET_P12_MARK!');
    }
  });
});

// A commit-message request as Copilot Chat 0.71.0 builds it (`hft` in its bundle): per changed
// file, "# ORIGINAL CODE:" with the file as an excerpt attachment, then "# CODE CHANGES:" with
// the staged diff in a code block outside any attachment.
const commitFile = (name: string, language: string, original: string, change: string): string[] => [
  '# ORIGINAL CODE:',
  `<attachment id="${name.replace(/^\./, '')}">`,
  `Excerpt from ${name}, lines 1 to 1:`,
  `${fence}${language}`,
  `${language === 'typescript' ? '//' : '#'} filepath: /w/${name}`,
  original,
  fence,
  '</attachment>',
  '# CODE CHANGES:',
  `${fence}diff`,
  `diff --git a/${name} b/${name}`,
  `--- a/${name}`,
  `+++ b/${name}`,
  '@@ -1 +1 @@',
  `-${original}`,
  `+${change}`,
  fence,
];
const COMMIT_HEAD = ['# REPOSITORY DETAILS:', 'Repository name: ws', 'Branch name: main'];
const COMMIT_ASK = 'Now generate a commit messages that describe the CODE CHANGES.';

describe('commit-message requests (staged diff, AGENTS rule 6)', () => {
  it('removes the original code and the diff of an excluded file, keeps the ones before it', () => {
    const kept = commitFile('src/a.ts', 'typescript', 'const a = 1;', 'const a = 2; // KEEP_DIFF');
    const text = [
      ...COMMIT_HEAD,
      ...kept,
      ...commitFile('.env', 'dotenv', 'API_KEY=ORIGINAL_SECRET', 'API_KEY=NEW_SECRET'),
      COMMIT_ASK,
    ].join('\n');
    const { prompt } = toCliPrompt([{ role: 'user', text }], excluded);
    expect(prompt).toBe(
      [
        ...COMMIT_HEAD,
        ...kept,
        '# ORIGINAL CODE:',
        '<attachment id="env">',
        EXCLUDED_CONTENT,
        '</attachment>',
        COMMIT_ASK,
      ].join('\n'),
    );
  });

  it('an excluded file first: its content goes, and the next file keeps its diff', () => {
    const next = commitFile('src/a.ts', 'typescript', 'const a = 1;', 'const a = 2; // KEPT_DIFF');
    const text = [
      ...COMMIT_HEAD,
      ...commitFile('.env', 'dotenv', 'API_KEY=ORIGINAL_SECRET', 'API_KEY=NEW_SECRET'),
      ...next,
      COMMIT_ASK,
    ].join('\n');
    const { prompt } = toCliPrompt([{ role: 'user', text }], excluded);
    // The cost: the next file's original-code attachment goes too (T is the last </attachment>);
    // its diff, after the last attachment, stays.
    expect(prompt).toBe(
      [
        ...COMMIT_HEAD,
        '# ORIGINAL CODE:',
        '<attachment id="env">',
        EXCLUDED_CONTENT,
        '</attachment>',
        ...next.slice(next.indexOf('# CODE CHANGES:')),
        COMMIT_ASK,
      ].join('\n'),
    );
  });

  it('finds the path of an excerpt attachment after its description and fence', () => {
    const text = `<attachment id="x">\nExcerpt from .env:\n${fence}\n# filepath: /w/.env\nSECRET_X\n${fence}\n</attachment>`;
    expect(redactExcludedEvidence(text, excluded)).not.toContain('SECRET_X');
  });

  it('checks diff paths as diff paths', () => {
    const kinds: PathKind[] = [];
    const record: IsExcluded = (_path, kind) => {
      kinds.push(kind);
      return false;
    };
    redactExcludedDiffs(
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b',
      record,
    );
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(['diff']));
  });

  it('removes a diff section that has only ---/+++ headers', () => {
    const text =
      '--- a/k.pem\n+++ b/k.pem\n@@ -1 +1 @@\n-OLD_KEY\n+NEW_KEY\n--- a/b.ts\n+++ b/b.ts';
    const result = redactExcludedDiffs(text, excluded);
    expect(result).not.toContain('OLD_KEY');
    expect(result).not.toContain('NEW_KEY');
    expect(result).toContain('--- a/b.ts\n+++ b/b.ts');
  });

  it('keeps allowed files before and after an excluded one in a ---/+++ patch (P2-I006)', () => {
    const file = (name: string, body: string): string =>
      `--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+${body}`;
    const text = [
      file('src/a.ts', 'KEEP_A'),
      file('k.pem', 'SECRET_PEM'),
      file('src/c.ts', 'KEEP_C'),
    ].join('\n');
    const result = redactExcludedDiffs(text, excluded);
    expect(result).toContain('+KEEP_A');
    expect(result).toContain('+KEEP_C');
    expect(result).not.toContain('SECRET_PEM');
  });

  it('header-like lines inside a hunk stay in the excluded section (P2-I006)', () => {
    const text = [
      '--- a/k.pem',
      '+++ b/k.pem',
      '@@ -1,2 +1,2 @@',
      '--- a/innocent.ts',
      '+++ b/innocent.ts',
      '-SECRET_ONE',
      '+SECRET_TWO',
    ].join('\n');
    const result = redactExcludedDiffs(text, excluded);
    expect(result).not.toContain('SECRET_ONE');
    expect(result).not.toContain('SECRET_TWO');
  });

  it.each(['```', '~~~'])(
    'a %s context line inside an excluded hunk does not end the section (P2-I008)',
    (marker) => {
      const text = [
        `${fence}diff`,
        'diff --git a/secrets/key.md b/secrets/key.md',
        '--- a/secrets/key.md',
        '+++ b/secrets/key.md',
        '@@ -1,3 +1,3 @@',
        ' title',
        ` ${marker}`,
        '-OLD_FENCE_SECRET',
        '+NEW_FENCE_SECRET',
        fence,
        'after',
      ].join('\n');
      const result = redactExcludedDiffs(text, excluded);
      expect(result).not.toContain('FENCE_SECRET');
      expect(result).toContain(`${fence}\nafter`);
    },
  );

  it('decodes Git-quoted paths with octal UTF-8 and escapes (P2-I005)', () => {
    const named = (path: string): boolean => isExcluded(path, ['özel.txt', 'tab\tname.txt']);
    const unicode = [
      'diff --git "a/\\303\\266zel.txt" "b/\\303\\266zel.txt"',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ "b/\\303\\266zel.txt"',
      '@@ -0,0 +1 @@',
      '+UNICODE_SECRET',
    ].join('\n');
    expect(redactExcludedDiffs(unicode, named)).not.toContain('UNICODE_SECRET');
    const tab = '--- /dev/null\n+++ "b/tab\\tname.txt"\n@@ -0,0 +1 @@\n+TAB_SECRET';
    expect(redactExcludedDiffs(tab, named)).not.toContain('TAB_SECRET');
  });

  it('removes a rename into an excluded name', () => {
    const text = [
      'diff --git a/notes.txt b/.env.local',
      'similarity index 90%',
      'rename from notes.txt',
      'rename to .env.local',
      '@@ -1 +1 @@',
      '+TOKEN=RENAMED_SECRET',
    ].join('\n');
    expect(redactExcludedDiffs(text, excluded)).not.toContain('RENAMED_SECRET');
  });

  it('a section ends at the next diff --git line or a fence; other text is kept', () => {
    const text = [
      'diff --git a/secrets/k.txt b/secrets/k.txt',
      '+SECRET_K',
      'diff --git a/src/b.ts b/src/b.ts',
      '+KEPT_B',
      fence,
      'after the block',
    ].join('\n');
    const result = redactExcludedDiffs(text, excluded);
    expect(result).not.toContain('SECRET_K');
    expect(result).toContain('+KEPT_B');
    expect(result).toContain(`${fence}\nafter the block`);
  });

  it('leaves text without excluded diffs unchanged', () => {
    const text = 'diff --git a/src/b.ts b/src/b.ts\n+x\n--- not a header\nplain';
    expect(redactExcludedDiffs(text, excluded)).toBe(text);
  });

  describe('diff --git names (red-team case 04, diffs)', () => {
    const asked = (header: string): string[] => {
      const paths: string[] = [];
      redactExcludedDiffs(`${header}\n@@ -1 +1 @@\n-x\n+y`, (path) => {
        paths.push(path);
        return false;
      });
      return paths;
    };

    it('two equal names give that one name, also with " b/" inside it or Git quotes', () => {
      expect(asked('diff --git a/src/a.ts b/src/a.ts')).toEqual(['src/a.ts']);
      expect(asked('diff --git a/x b/y b/x b/y')).toEqual(['x b/y']);
      expect(asked('diff --git "a/\\303\\266 y" "b/\\303\\266 y"')).toEqual(['ö y']);
    });

    it('different names (a rename) keep every split as a candidate', () => {
      expect(asked('diff --git a/x b/y b/z')).toEqual(['x b/y b/z', 'x', 'y b/z', 'x b/y', 'z']);
    });

    it('a mnemonic prefix (c/ i/) keeps the whole value as a candidate', () => {
      expect(asked('diff --git c/.env i/.env')).toEqual(['c/.env i/.env']);
    });
  });
});

describe('toCliPrompt (D8)', () => {
  const system: ChatTurn = { role: 'system', text: 'Copilot system prompt' };

  it('sends a single user turn as its own text, with Copilot system text in stdin', () => {
    const result = toCliPrompt([system, { role: 'user', text: 'hello' }], excluded);
    expect(result).toEqual({
      system: CHAT_PREAMBLE,
      prompt: '<copilot-system>\nCopilot system prompt\n</copilot-system>\n\nhello',
      removedLines: 0,
    });
  });

  it('builds a transcript for several turns and ends with the instruction', () => {
    const result = toCliPrompt(
      [
        { role: 'user', text: 'one' },
        { role: 'assistant', text: 'two' },
        { role: 'user', text: 'three' },
      ],
      excluded,
    );
    expect(result.prompt).toBe(
      '<turn role="user">\none\n</turn>\n\n<turn role="assistant">\ntwo\n</turn>\n\n<turn role="user">\nthree\n</turn>\n\nReply to the last user turn.',
    );
  });

  it('keeps a 300 KiB system message out of the CLI argument (P2-R002)', () => {
    const big = 'x'.repeat(300 * 1024);
    const result = toCliPrompt(
      [
        { role: 'system', text: big },
        { role: 'user', text: 'q' },
      ],
      excluded,
    );
    expect(result.system).toBe(CHAT_PREAMBLE);
    expect(result.system.length).toBeLessThan(1024);
    expect(result.prompt).toContain(big);
  });

  it('redacts excluded attachments in every turn', () => {
    const result = toCliPrompt(
      [
        { role: 'system', text: '<attachment filePath="/w/.env">\nSYS_SECRET\n</attachment>' },
        { role: 'user', text: COPILOT_USER_MESSAGE },
      ],
      excluded,
    );
    expect(result.prompt).not.toContain('SYS_SECRET');
    expect(result.prompt).not.toContain('SECRET_ENV_MARK');
  });
});

describe('estimateTokens (D7, P2-R001)', () => {
  it.each([
    ['English', 'The quick brown fox jumps over the lazy dog.'],
    ['Turkish', 'Çağrı şöyle dedi: ıspanaklı börek güzeldir.'],
    ['Chinese', '这是一个用于测试分词器的中文句子。'],
    ['emoji', '🚀✨🧪👩‍💻🇹🇷'],
    ['base64', 'QmFzZTY0IGVuY29kZWQgcmFuZG9tIGRhdGE6IHE5WjRrTDJtUDh2TjNiWDdj'],
    ['minified', 'function a(b,c){return b.map(d=>d*c).filter(Boolean)}'],
  ])('%s: equals the UTF-8 byte count', (_label, text) => {
    expect(estimateTokens(text)).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('adds the per-message overhead', () => {
    expect(estimateTokens('abc', 2)).toBe(3 + 2 * TOKENS_PER_MESSAGE);
  });
});

// Findings of the independent module review of the parser (docs/plans/phase-2-hardening-review.md).
describe('module review of the parser', () => {
  const oracle = workspaceOracle(['src/app.tsx', 'src/a.ts', 'secrets/key.txt', '.env']);
  const question = ['<prompt>', 'KEEP_QUESTION', '</prompt>'];

  it("an 'Excerpt from active file' line names its file", () => {
    const text = [
      'Excerpt from active file .env, lines 1 to 2:',
      `${fence}dotenv`,
      'API_KEY=ACTIVE_FILE_SECRET',
      fence,
      ...question,
    ].join('\n');
    const result = redactExcludedEvidence(text, oracle);
    expect(result).not.toContain('ACTIVE_FILE_SECRET');
    expect(result).toContain('KEEP_QUESTION');
  });

  it('a fake </attachment></attachments> pair inside the file does not end the range', () => {
    const text = [
      '<attachment id="key.txt">',
      '// filepath: /ws/secrets/key.txt',
      'line one',
      '</attachment>',
      '</attachments>',
      'AFTER_FAKE_PAIR_SECRET',
      '</attachment>',
      '<attachment id="a.ts">',
      '// filepath: /ws/src/a.ts',
      'KEEP_LATER_ATTACHMENT',
    ].join('\n');
    const result = redactExcludedEvidence(text, oracle);
    expect(result).not.toContain('AFTER_FAKE_PAIR_SECRET');
    // A documented cost: nothing after the last </attachment> is lost.
    expect(result).toContain('KEEP_LATER_ATTACHMENT');
  });

  it('a <Route path="/dashboard"> in a kept file is not evidence of an excluded file', () => {
    const text = [
      '<attachments>',
      '<attachment id="app.tsx">',
      '// filepath: /ws/src/app.tsx',
      '<Route path="/dashboard" element={<Dashboard />} />',
      'KEEP_APP',
      '</attachment>',
      '<attachment id="a.ts">',
      '// filepath: /ws/src/a.ts',
      'KEEP_A',
      '</attachment>',
      '</attachments>',
      ...question,
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(text);
  });

  it('an unparseable path attribute of a non-Copilot element is not evidence', () => {
    const text = ['<Route path={`/x/${id}`}>', 'KEEP_JSX', '</Route>'].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(text);
  });

  it("a selection 'From the file: <name>' names its file, by pattern or by excluded name", () => {
    const selection = (name: string, line: string): string =>
      [
        'Active selection:',
        '',
        '',
        `From the file: ${name}`,
        fence,
        line,
        fence,
        '',
        ...question,
      ].join('\n');
    const byPattern = redactExcludedEvidence(selection('.env', 'API_KEY=SELECTION_SECRET'), oracle);
    expect(byPattern).not.toContain('SELECTION_SECRET');
    expect(byPattern).toContain('KEEP_QUESTION');
    const names = new Set(['config.ts']);
    const byName = redactExcludedEvidence(
      selection('config.ts', 'export const KEY = "NAMED_SECRET";'),
      oracle,
      names,
    );
    expect(byName).not.toContain('NAMED_SECRET');
  });

  it('a percent-encoded attachment id matches an excluded name', () => {
    const text = '<attachment id="caf%C3%A9.bin">\nBINARY_DUMP_SECRET\n</attachment>';
    expect(redactExcludedEvidence(text, oracle, new Set(['café.bin']))).not.toContain(
      'BINARY_DUMP_SECRET',
    );
  });

  it('a stray ~~~ before the marker fence does not shorten the range', () => {
    const text = [
      '~~~',
      'stray tilde fence in an earlier answer',
      `${fence}properties`,
      '# filepath: /ws/.env',
      'API_KEY=FIRST_SECRET',
      'SECOND_SECRET_LINE',
      fence,
      'KEEP_AFTER',
    ].join('\n');
    const result = redactExcludedEvidence(text, oracle);
    expect(result).not.toContain('FIRST_SECRET');
    expect(result).not.toContain('SECOND_SECRET_LINE');
    expect(result).toContain('KEEP_AFTER');
  });

  it("a full-file chunk 'Here is the full text of `<path>`:' names its file", () => {
    const text = [
      '<attachment tool="#codebase">',
      'Here is the full text of `/ws/secrets/key.txt`:',
      fence,
      'FULL_TEXT_SECRET',
      fence,
      '</attachment>',
      ...question,
    ].join('\n');
    const result = redactExcludedEvidence(text, oracle);
    expect(result).not.toContain('FULL_TEXT_SECRET');
    expect(result).toContain('KEEP_QUESTION');
  });
});

describe('inspection findings (phase-2-hardening-review.md)', () => {
  it('HARD-I001: outside attachments a quoted file runs to the last closer of its fence', () => {
    const answer = [
      'Here is the file:',
      `${fence}text`,
      '# filepath: /outside/secrets/key.txt',
      'A=1',
      fence,
      'B=2',
      fence,
      'PIN=123',
      fence,
      'KEEP_AFTER',
    ].join('\n');
    const { prompt } = toCliPrompt(
      [
        { role: 'user', text: 'show it' },
        { role: 'assistant', text: answer },
        { role: 'user', text: 'thanks' },
      ],
      excluded,
    );
    expect(prompt).not.toMatch(/A=1|B=2|PIN=123/);
    expect(prompt).toContain('KEEP_AFTER');
  });

  it('HARD-I001: inside an attachment the first closer still ends the file (commit requests)', () => {
    const text = [
      ...COMMIT_HEAD,
      ...commitFile('.env', 'dotenv', 'API_KEY=ORIGINAL_SECRET', 'API_KEY=NEW_SECRET'),
      COMMIT_ASK,
      `${fence}text`,
      'commit message goes here',
      fence,
    ].join('\n');
    const { prompt } = toCliPrompt([{ role: 'user', text }], excluded);
    expect(prompt).not.toMatch(/SECRET/);
    expect(prompt).toContain(COMMIT_ASK);
    expect(prompt).toContain('commit message goes here');
  });

  it('HARD-I006: attachment-shaped text in an answer or in a code block is quoted text', () => {
    // The tag itself is the evidence (no marker line, whose next fence would also count).
    const quoted = [
      `${fence}text`,
      '<attachment filePath="/outside/secrets/key.txt">',
      'A=1',
      fence,
      '</attachment>',
      'PIN=123',
      fence,
      'KEEP_AFTER',
    ].join('\n');
    for (const turns of [
      [
        { role: 'user', text: 'show it' },
        { role: 'assistant', text: quoted },
        { role: 'user', text: 'thanks' },
      ],
      [{ role: 'user', text: `pasted:\n${quoted}` }],
    ] as const) {
      const { prompt } = toCliPrompt([...turns], excluded);
      expect(prompt).not.toMatch(/A=1|PIN=123/);
      expect(prompt).toContain('KEEP_AFTER');
    }
    // The same attachment-shaped text, unfenced, in an answer: the last closer as well.
    const answer = [`${fence}text`, 'x', fence, ...quoted.split('\n').slice(1)].join('\n');
    const { prompt } = toCliPrompt(
      [
        { role: 'user', text: 'show it' },
        { role: 'assistant', text: answer },
      ],
      excluded,
    );
    expect(prompt).not.toMatch(/A=1|PIN=123/);
  });

  it('HARD-I007: a binary file named with "\\" on POSIX is matched by its encoded id', () => {
    const { names } = buildExcludedContent([{ path: '/w/secrets/a\\b.p12' }]);
    const text = [
      '<attachment id="a%5Cb.p12" startByte=0 endByte=16 totalSize=16 truncated=true>',
      '00000000  53 45 43 52 45 54 5f 50  31 32 5f 4d 41 52 4b 21  |SECRET_P12_MARK!|',
      '</attachment>',
      'What kind of file is this?',
    ].join('\n');
    const result = redactExcludedEvidence(text, (path) => isExcluded(path, ['secrets/**']), names);
    expect(result).not.toContain('SECRET_P12_MARK!');
    expect(result).toContain('What kind of file is this?');
  });

  it("HARD-I009: attachment-like text in Copilot's wrapper of the user's text is quoted text", () => {
    const pasted = [
      `${fence}text`,
      'x',
      fence,
      '<attachment filePath="/outside/secrets/key.txt">',
      'A=1',
      fence,
      '</attachment>',
      'PIN=123',
      fence,
      'KEEP_AFTER',
    ].join('\n');
    for (const tag of ['prompt', 'userRequest', 'user_query']) {
      const text = `<attachments>\n</attachments>\n<${tag}>\n${pasted}\n</${tag}>`;
      const { prompt } = toCliPrompt([{ role: 'user', text }], excluded);
      expect(prompt).not.toMatch(/A=1|PIN=123/);
      expect(prompt).toContain('KEEP_AFTER');
    }
  });

  it('HARD-I010: on darwin and win32 a binary name matches its id in any letter case', () => {
    const binary = [
      '<attachment id="prod.p12" startByte=0 endByte=16 totalSize=16 truncated=true>',
      '00000000  53 45 43 52 45 54 5f 50  31 32 5f 4d 41 52 4b 21  |SECRET_P12_MARK!|',
      '</attachment>',
    ].join('\n');
    const oracle = (path: string): boolean => isExcluded(path, ['secrets/**']);
    // The file was renamed to Prod.p12; the replayed attachment still says prod.p12.
    const folded = buildExcludedContent([{ path: '/w/secrets/Prod.p12' }], {
      caseInsensitive: true,
    });
    expect(
      redactExcludedEvidence(binary, oracle, folded.names, { caseInsensitive: true }),
    ).not.toContain('SECRET_P12_MARK!');
    // A case-sensitive file system: prod.p12 is another file.
    const exact = buildExcludedContent([{ path: '/w/secrets/Prod.p12' }]);
    expect(redactExcludedEvidence(binary, oracle, exact.names)).toContain('SECRET_P12_MARK!');
  });
});

describe('id-only attachments (phase-2-followup.md, HARD-I013)', () => {
  const hexDump = (id: string, mark: string): string =>
    [
      `<attachment id="${id}" startByte=0 endByte=16 totalSize=16 truncated=true>`,
      `00000000  4d 41 52 4b 4d 41 52 4b  4d 41 52 4b 4d 41 52 4b  |${mark}|`,
      '</attachment>',
    ].join('\n');
  const nothingExcluded: IsExcluded = () => false;

  it('collects the decoded names of id-only attachments, one per name', () => {
    const text = [
      hexDump('certificate.bin', 'A'),
      hexDump('a%20b.bin', 'B'),
      hexDump('certificate.bin', 'C'),
      '<attachment id="app.ts" filePath="/w/src/app.ts">\nexport {};\n</attachment>',
      '<attachment id="util.ts">\n// filepath: /w/src/util.ts\nexport {};\n</attachment>',
      '<attachment id="notes.md">\nExcerpt from notes.md, lines 1 to 2:\nx\n</attachment>',
    ].join('\n');
    expect(idOnlyAttachmentIds(text)).toEqual(['certificate.bin', 'a%20b.bin', 'a b.bin']);
  });

  it('idOnlyNames removes an id-only attachment only, not a kept one with a path and the same name (FOLLOWUP-R004)', () => {
    const text = [
      '<attachment id="certificate.bin" filePath="/w/docs/certificate.bin">',
      'KEEP_PATH_BEARING',
      '</attachment>',
      hexDump('certificate.bin', 'I013_SECRET_MARK'),
      '<prompt>What are these?</prompt>',
    ].join('\n');
    const { prompt } = toCliPrompt([{ role: 'user', text }], nothingExcluded, undefined, {
      idOnlyNames: new Set(['certificate.bin']),
    });
    expect(prompt).toContain('KEEP_PATH_BEARING');
    expect(prompt).not.toContain('I013_SECRET_MARK');
    expect(prompt).toContain('What are these?');
    // Without the resolved names, the hex dump is kept: the index holds only key.bin.
    expect(toCliPrompt([{ role: 'user', text }], nothingExcluded).prompt).toContain(
      'I013_SECRET_MARK',
    );
  });

  it('a percent-encoded id and a case-only difference match when the matcher folds case', () => {
    const text = hexDump('My%20Cert.BIN', 'ENCODED_MARK');
    const remove = (caseInsensitive: boolean): string =>
      toCliPrompt([{ role: 'user', text }], nothingExcluded, undefined, {
        idOnlyNames: new Set(['my cert.bin']),
        caseInsensitive,
      }).prompt;
    expect(remove(true)).not.toContain('ENCODED_MARK');
    expect(remove(false)).toContain('ENCODED_MARK');
  });

  it('asks only for the names the index does not hold, across turns', async () => {
    const asked: string[][] = [];
    const result = await idOnlyNamesForRequest(
      [hexDump('key.bin', 'A'), hexDump('certificate.bin', 'B'), hexDump('Key.bin', 'C')],
      new Set(['key.bin']),
      (names) => {
        asked.push([...names]);
        return Promise.resolve(new Set(['certificate.bin']));
      },
      { caseInsensitive: true },
    );
    expect(asked).toEqual([['certificate.bin']]);
    expect(result).toEqual({ names: new Set(['certificate.bin']), asked: 1, failed: false });
  });

  it('a literal percent escape in a file name is searched as written too (FOLLOWUP-I004)', () => {
    // public/cert%41.bin links to secrets/key.bin; the id carries the name unchanged.
    expect(idOnlyAttachmentIds(hexDump('cert%41.bin', 'A'))).toEqual(['cert%41.bin', 'certA.bin']);
    const { prompt } = toCliPrompt(
      [{ role: 'user', text: hexDump('cert%41.bin', 'LITERAL_ESCAPE_MARK') }],
      nothingExcluded,
      undefined,
      { idOnlyNames: new Set(['cert%41.bin']) },
    );
    expect(prompt).not.toContain('LITERAL_ESCAPE_MARK');
  });

  it("Copilot's repeated-name suffix: certificate.bin-1 also stands for certificate.bin (FOLLOWUP-I001)", () => {
    const text = [
      '<attachment id="certificate.bin">',
      '// filepath: /w/a/certificate.bin',
      'KEEP_TEXT_NAMESAKE',
      '</attachment>',
      hexDump('certificate.bin-1', 'REPEATED_ALIAS_MARK'),
      '<prompt>compare them</prompt>',
    ].join('\n');
    expect(idOnlyAttachmentIds(text)).toEqual(['certificate.bin-1', 'certificate.bin']);
    const { prompt } = toCliPrompt([{ role: 'user', text }], nothingExcluded, undefined, {
      idOnlyNames: new Set(['certificate.bin']),
    });
    expect(prompt).toContain('KEEP_TEXT_NAMESAKE');
    expect(prompt).not.toContain('REPEATED_ALIAS_MARK');
    // The index's names count for every candidate too: key.bin-1 is a repeated key.bin.
    const guard = buildExcludedContent([{ path: '/w/secrets/key.bin' }]);
    const indexed = toCliPrompt(
      [{ role: 'user', text: hexDump('key.bin-1', 'INDEXED_REPEAT_MARK') }],
      nothingExcluded,
      guard,
    );
    expect(indexed.prompt).not.toContain('INDEXED_REPEAT_MARK');
  });

  it('an id that contains search-header text is still id-only: only the body is evidence (FOLLOWUP-I002)', () => {
    const name = 'the full text of `notes.txt`.bin';
    expect(idOnlyAttachmentIds(hexDump(name, 'HEADER_IN_ID'))).toEqual([name]);
    expect(
      allIdOnlyNames([hexDump(name, 'A'), hexDump('Other.BIN', 'B')], { caseInsensitive: true }),
    ).toEqual(new Set([name, 'other.bin']));
  });

  it('a failed resolution removes every unresolved id-only attachment (FOLLOWUP-R002)', async () => {
    const turns: ChatTurn[] = [
      { role: 'user', text: hexDump('certificate.bin', 'FAILED_A') },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: `${hexDump('other.bin', 'FAILED_B')}\n<prompt>and this?</prompt>` },
    ];
    const resolved = await idOnlyNamesForRequest(
      turns.map((turn) => turn.text),
      undefined,
      () => Promise.reject(new Error('findFiles failed')),
    );
    expect(resolved.failed).toBe(true);
    const { prompt } = toCliPrompt(turns, nothingExcluded, undefined, {
      idOnlyNames: resolved.names,
    });
    expect(prompt).not.toMatch(/FAILED_A|FAILED_B/);
    expect(prompt).toContain('and this?');
  });
});

// VS Code 1.144 names the implicit context attachment (the active file) `file:<basename>`: a
// label, not a URI. Read as a URI it named `/<basename>`, a file that does not exist, and the
// active file never reached the model (seen in the demo recording on 2026-10-30).
describe('file: label ids (VS Code 1.144 implicit context)', () => {
  const oracle = workspaceOracle(['src/cart.ts', '.env', 'docs/certificate.bin']);
  const hexDump = (id: string, mark: string): string =>
    [
      `<attachment id="${id}" startByte=0 endByte=16 totalSize=16 truncated=true>`,
      `00000000  4d 41 52 4b 4d 41 52 4b  4d 41 52 4b 4d 41 52 4b  |${mark}|`,
      '</attachment>',
    ].join('\n');

  it('keeps the active file of a file: label id', () => {
    const text = [
      '<attachments>',
      '<attachment id="file:cart.ts">',
      `${fence}typescript`,
      `// filepath: ${WS}/src/cart.ts`,
      'export const total = 1; // KEEP_IMPLICIT_MARK',
      fence,
      '</attachment>',
      '',
      '</attachments>',
      '<prompt>',
      'what does total return?',
      '</prompt>',
    ].join('\n');
    expect(redactExcludedEvidence(text, oracle)).toBe(text);
    expect(toCliPrompt([{ role: 'user', text }], oracle).prompt).toContain('KEEP_IMPLICIT_MARK');
  });

  it('keeps a file: label id whose body names no path', () => {
    const text = '<attachment id="file:notes.txt">\nplain text KEEP_LABEL_MARK\n</attachment>';
    expect(redactExcludedEvidence(text, oracle)).toBe(text);
  });

  it('still removes an excluded file behind a file: label id, with and without a path', () => {
    const withPath = `<attachment id="file:.env">\n// filepath: ${WS}/.env\nSECRET_LABEL_PATH\n</attachment>`;
    expect(redactExcludedEvidence(withPath, oracle)).not.toContain('SECRET_LABEL_PATH');
    const idOnly = '<attachment id="file:.env">\nSECRET_LABEL_ID\n</attachment>';
    expect(redactExcludedEvidence(idOnly, oracle)).not.toContain('SECRET_LABEL_ID');
    const named = buildExcludedContent([{ path: `${WS}/secrets/key.bin` }]);
    const byName = '<attachment id="file:key.bin">\nSECRET_LABEL_NAME\n</attachment>';
    expect(redactExcludedEvidence(byName, oracle, named.names)).not.toContain('SECRET_LABEL_NAME');
    // With a kept path in the body the attachment is not id-only: the label itself is judged.
    const labelAndPath = `<attachment id="file:key.bin">\n// filepath: ${WS}/src/cart.ts\nSECRET_LABEL_INDEX\n</attachment>`;
    expect(redactExcludedEvidence(labelAndPath, oracle, named.names)).not.toContain(
      'SECRET_LABEL_INDEX',
    );
    // The patterns see the percent-decoded name too.
    const encoded = `<attachment id="file:%2Eenv">\n// filepath: ${WS}/src/cart.ts\nSECRET_LABEL_ENCODED\n</attachment>`;
    expect(redactExcludedEvidence(encoded, oracle)).not.toContain('SECRET_LABEL_ENCODED');
  });

  it('an id-only file: label stands for its file name, and for the raw id too', () => {
    expect(idOnlyAttachmentIds(hexDump('file:certificate.bin', 'A'))).toEqual([
      'certificate.bin',
      'file:certificate.bin',
    ]);
    const { prompt } = toCliPrompt(
      [{ role: 'user', text: hexDump('file:certificate.bin', 'LABEL_HEX_MARK') }],
      oracle,
      undefined,
      { idOnlyNames: new Set(['certificate.bin']) },
    );
    expect(prompt).not.toContain('LABEL_HEX_MARK');
  });

  it('a file: URI id is still a URI', () => {
    const secret = `<attachment id="file://${WS}/.env">\nSECRET_URI_ID\n</attachment>`;
    expect(redactExcludedEvidence(secret, oracle)).not.toContain('SECRET_URI_ID');
    const kept = `<attachment id="file://${WS}/src/cart.ts">\nKEEP_URI_ID\n</attachment>`;
    expect(redactExcludedEvidence(kept, oracle)).toBe(kept);
    const missing = '<attachment id="file:/nowhere/a.ts">\nGONE_URI_ID\n</attachment>';
    expect(redactExcludedEvidence(missing, oracle)).not.toContain('GONE_URI_ID');
  });
});
