// Tool parts in the CLI prompt (docs/plans/phase-4-tools.md T5, T6, T8, T13).
import { describe, expect, it } from 'vitest';
import { isExcluded } from '../../src/core/context/exclude';
import { buildExcludedContent, redactExcludedLines } from '../../src/features/chat/contentGuard';
import {
  CHAT_PREAMBLE,
  COUNTING_NONCE,
  estimateTokens,
  EXCLUDED_CONTENT,
  filterTurnText,
  newToolNonce,
  NON_TEXT_PART,
  MAX_BYTES_PER_TOKEN,
  minimumTokens,
  promptEstimate,
  renderMessage,
  renderTools,
  toCliPrompt,
  TOOL_PREAMBLE,
  toolTurns,
  type IsExcluded,
  type RequestMessage,
  type ToolSpec,
} from '../../src/features/chat/messages';
import { promptBudget } from '../../src/features/chat/models';

const EXCLUDE = ['.env*', '*.pem', 'secrets/**'];
const isExcludedPath: IsExcluded = (path) => isExcluded(path, EXCLUDE);
const NONCE = 'f'.repeat(32);
const READ: ToolSpec = {
  name: 'read_file',
  description: 'Reads a file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

const conversation = (path: string, result: string): RequestMessage[] => [
  { role: 'user', parts: [{ kind: 'text', text: 'What does it say?' }] },
  {
    role: 'assistant',
    parts: [
      { kind: 'text', text: 'Reading it.' },
      { kind: 'toolCall', callId: 'call_1', name: 'read_file', input: { path } },
    ],
  },
  { role: 'user', parts: [{ kind: 'toolResult', callId: 'call_1', texts: [result] }] },
];

describe('renderMessage (T6)', () => {
  it('frames tool calls and results with the request nonce', () => {
    const [, call, result] = conversation('README.md', '# Demo');
    expect(renderMessage(call!, NONCE)).toBe(
      `Reading it.\n<tool-call-${NONCE} id="call_1" name="read_file">\n{"path":"README.md"}\n</tool-call-${NONCE}>\n`,
    );
    expect(renderMessage(result!, NONCE)).toBe(
      `\n<tool-result-${NONCE} id="call_1">\n# Demo\n</tool-result-${NONCE}>\n`,
    );
  });

  it('keeps ids and names to a fixed character set', () => {
    const text = renderMessage(
      {
        role: 'assistant',
        parts: [{ kind: 'toolCall', callId: 'a" x="y>', name: 'n</tool-call>', input: {} }],
      },
      NONCE,
    );
    expect(text).toContain('id="a__x__y_"');
    expect(text).toContain('name="n__tool-call_"');
  });

  it('renders other parts as the placeholder', () => {
    expect(renderMessage({ role: 'user', parts: [{ kind: 'other' }] }, NONCE)).toBe(NON_TEXT_PART);
  });

  it('uses fresh hex nonces of the counting length', () => {
    const a = newToolNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newToolNonce());
    expect(COUNTING_NONCE).toHaveLength(a.length);
  });
});

describe('toolTurns (T8)', () => {
  it('replaces the result of a call whose input names an excluded file', () => {
    const turns = toolTurns(conversation('.env', 'K=1'), NONCE, (input) =>
      (input as { path: string }).path.startsWith('.env'),
    );
    expect(turns[2]!.text).toContain(EXCLUDED_CONTENT);
    expect(turns.map((turn) => turn.text).join('\n')).not.toContain('K=1');
    // The call stays with its id and name; its input is replaced too (inspection P4T-I001).
    expect(turns[1]!.text).toContain('name="read_file"');
    expect(turns[1]!.text).toContain(EXCLUDED_CONTENT);
  });

  it('keeps an allowed result and drops a result without its call', () => {
    const allowed = toolTurns(conversation('README.md', '# Demo'), NONCE, () => false);
    expect(allowed[2]!.text).toContain('# Demo');
    const orphan = toolTurns(
      [{ role: 'user', parts: [{ kind: 'toolResult', callId: 'gone', texts: ['K=1'] }] }],
      NONCE,
      () => false,
    );
    expect(orphan[0]!.text).toContain(EXCLUDED_CONTENT);
    expect(orphan[0]!.text).not.toContain('K=1');
  });
});

describe('toCliPrompt in tool mode (T5)', () => {
  it('puts the catalogue, the tag note and the conversation into stdin', () => {
    const turns = toolTurns(conversation('README.md', '# Demo'), NONCE, () => false);
    const cli = toCliPrompt(turns, isExcludedPath, undefined, {
      toolNonce: NONCE,
      tools: { specs: [READ], required: false },
    });
    expect(cli.system).toBe(TOOL_PREAMBLE);
    expect(cli.prompt).toContain(`<tools-${NONCE}>\n## read_file\nReads a file.\nInput schema: `);
    expect(cli.prompt).toContain(`<tool-result-${NONCE}> tags`);
    expect(cli.prompt).toContain('# Demo');
    expect(cli.prompt).not.toContain('You must call at least one tool');
    const required = toCliPrompt(turns, isExcludedPath, undefined, {
      toolNonce: NONCE,
      tools: { specs: [READ], required: true },
    });
    expect(required.prompt.endsWith('You must call at least one tool in this answer.')).toBe(true);
  });

  it('runs the content net over tool results', () => {
    const guard = buildExcludedContent([
      { path: 'secrets/token', text: 'super-secret-value-123\n' },
    ]);
    const turns = toolTurns(
      conversation('logs/run.txt', 'line one\nsuper-secret-value-123\nline three'),
      NONCE,
      () => false,
    );
    const cli = toCliPrompt(turns, isExcludedPath, guard, {
      toolNonce: NONCE,
      tools: { specs: [READ], required: false },
    });
    expect(cli.prompt).not.toContain('super-secret-value-123');
    expect(cli.removedLines).toBe(1);
  });

  it('is unchanged without tools and without a nonce (setting off)', () => {
    const cli = toCliPrompt([{ role: 'user', text: 'hi' }], isExcludedPath);
    expect(cli).toEqual({ system: CHAT_PREAMBLE, prompt: 'hi', removedLines: 0 });
  });
});

describe('context accounting (T13)', () => {
  it('counts a tool result in full, not as the placeholder', () => {
    const big = 'x'.repeat(50_000);
    const [, , result] = conversation('README.md', big);
    const tokens = estimateTokens(renderMessage(result!, COUNTING_NONCE), 1);
    expect(tokens).toBeGreaterThan(50_000);
    expect(tokens).toBeGreaterThanOrEqual(
      estimateTokens(renderMessage(result!, newToolNonce()), 1),
    );
  });

  it('finds a prompt with a large catalogue or tool history over the budget', () => {
    const catalogue = Array.from({ length: 400 }, (_, i) => ({
      ...READ,
      name: `tool_${i}`,
      description: 'd'.repeat(300),
    }));
    expect(renderTools(catalogue, NONCE).length).toBeGreaterThan(120_000);
    const small = toCliPrompt([{ role: 'user', text: 'hi' }], isExcludedPath, undefined, {
      toolNonce: NONCE,
      tools: { specs: [READ], required: false },
    });
    expect(promptEstimate(small)).toBeLessThan(promptBudget('codex-cli'));
    const large = toCliPrompt([{ role: 'user', text: 'hi' }], isExcludedPath, undefined, {
      toolNonce: NONCE,
      tools: { specs: catalogue, required: false },
    });
    expect(promptEstimate(large)).toBeGreaterThan(promptBudget('codex-cli'));
    const history = toolTurns(conversation('a.txt', 'y'.repeat(200_000)), NONCE, () => false);
    const long = toCliPrompt(history, isExcludedPath, undefined, {
      toolNonce: NONCE,
      tools: { specs: [READ], required: false },
    });
    expect(promptEstimate(long)).toBeGreaterThan(promptBudget('claude-cli'));
    expect(promptBudget('claude-cli')).toBe(166_000);
    // Codex's fallback window, 95 % usable (phase-4-context.md W3).
    expect(promptBudget('codex-cli')).toBe(93_600);
  });
});

describe('earlier calls and results get the content net before rendering (inspection P4T-I001)', () => {
  const guard = buildExcludedContent([
    { path: '/ws/.env', text: 'SUPER_SECRET_VALUE_ONE\nSUPER_SECRET_VALUE_TWO\n' },
  ]);
  const redact = {
    input: (text: string) => redactExcludedLines(text, guard).text,
    result: (text: string) => redactExcludedLines(text, guard, { searchPrefixes: true }).text,
  };
  const edit = (filePath: string): RequestMessage[] => [
    { role: 'user', parts: [{ kind: 'text', text: 'fix it' }] },
    {
      role: 'assistant',
      parts: [
        {
          kind: 'toolCall',
          callId: 'call_e',
          name: 'replace_string_in_file',
          input: {
            filePath,
            oldString: 'SUPER_SECRET_VALUE_ONE\nSUPER_SECRET_VALUE_TWO',
            newString: 'x',
          },
        },
      ],
    },
    { role: 'user', parts: [{ kind: 'toolResult', callId: 'call_e', texts: ['edited'] }] },
  ];

  it('replaces the whole input of a call that names an excluded file, keeping its identity', () => {
    const turns = toolTurns(edit('/ws/.env'), NONCE, (input) =>
      (input as { filePath: string }).filePath.endsWith('.env'),
    );
    const text = turns.map((turn) => turn.text).join('\n');
    expect(text).not.toContain('SUPER_SECRET');
    expect(turns[1]!.text).toContain(
      `<tool-call-${NONCE} id="call_e" name="replace_string_in_file">`,
    );
    expect(turns[1]!.text).toContain(EXCLUDED_CONTENT);
    expect(turns[2]!.text).toContain(EXCLUDED_CONTENT);
  });

  it('nets each string value of other inputs line by line, before JSON escapes them', () => {
    // A file that is not excluded (e.g. the setting changed later) whose edit quotes excluded lines.
    const turns = toolTurns(edit('/ws/notes.txt'), NONCE, () => false, redact);
    expect(turns[1]!.text).not.toContain('SUPER_SECRET');
    expect(turns[1]!.text).toContain('"filePath":"/ws/notes.txt"');
    expect(turns[1]!.text).toContain('[line removed by magipilot.exclude]');
    // Without the per-value pass, the escaped string is one line the net cannot match.
    const raw = toolTurns(edit('/ws/notes.txt'), NONCE, () => false);
    expect(redactExcludedLines(raw[1]!.text, guard).text).toContain('SUPER_SECRET');
  });

  it("removes a search tool's prefixed lines of an excluded file from results", () => {
    const search: RequestMessage[] = [
      {
        role: 'assistant',
        parts: [
          {
            kind: 'toolCall',
            callId: 'call_g',
            name: 'run_in_terminal',
            input: { command: 'grep -rn SUPER src' },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            kind: 'toolResult',
            callId: 'call_g',
            texts: [
              './.env:1:SUPER_SECRET_VALUE_ONE\n.env-2-SUPER_SECRET_VALUE_TWO\nsrc/a.ts:3:KEEP_THIS_LINE',
            ],
          },
        ],
      },
    ];
    const text = toolTurns(search, NONCE, () => false, redact)[1]!.text;
    expect(text).not.toContain('SUPER_SECRET');
    expect(text).toContain('src/a.ts:3:KEEP_THIS_LINE');
    // Ordinary prompt text keeps the whole-line rule.
    expect(redactExcludedLines('note: SUPER_SECRET_VALUE_ONE', guard).text).toContain('SUPER');
  });
});

describe('the index keeps every discovered path (security review of ef80659)', () => {
  it('holds read and unread paths and says whether discovery was complete', () => {
    const content = buildExcludedContent(
      [{ path: '/ws/.env', text: 'A=1\n' }],
      {},
      {
        paths: ['/ws/.env', '/ws/secrets/big.bin'],
        complete: false,
      },
    );
    expect([...(content.paths ?? [])].sort()).toEqual(['/ws/.env', '/ws/secrets/big.bin']);
    expect(content.pathsComplete).toBe(false);
    expect(buildExcludedContent([{ path: '/ws/.env' }]).pathsComplete).toBe(true);
  });
});

describe('the turn filters on call inputs (re-inspection P4T-RI001)', () => {
  it('removes a basename-only excerpt of an excluded file inside an earlier edit call', () => {
    const guard = buildExcludedContent([{ path: '/ws/secrets/token.txt', text: 'K=1\n' }]);
    const conversation: RequestMessage[] = [
      {
        role: 'assistant',
        parts: [
          {
            kind: 'toolCall',
            callId: 'call_x',
            name: 'replace_string_in_file',
            input: {
              filePath: 'notes.txt',
              oldString: 'Excerpt from token.txt, lines 1 to 1:\nK=1\n',
              newString: 'x',
            },
          },
        ],
      },
    ];
    const filtered = toolTurns(conversation, NONCE, () => false, {
      input: (text) => filterTurnText(text, 'assistant', isExcludedPath, guard).text,
    });
    expect(filtered[0]!.text).not.toContain('K=1');
    // The content net alone keeps the short line; JSON then hides the header from the parser.
    const netOnly = toolTurns(conversation, NONCE, () => false, {
      input: (text) => redactExcludedLines(text, guard).text,
    });
    expect(toCliPrompt(netOnly, isExcludedPath, guard).prompt).toContain('K=1');
  });
});

describe('the refusal gate uses a lower bound (smoke:agent, 2026-10-29)', () => {
  it("lets a prompt the size of Copilot's agent mode through, and refuses one that cannot fit", () => {
    // Measured: 146 494 characters of instructions and 59 365 of tool schemas.
    const agentMode = { system: TOOL_PREAMBLE, prompt: 'x'.repeat(146_494 + 59_365) };
    expect(promptEstimate(agentMode)).toBeGreaterThan(promptBudget('claude-cli'));
    expect(minimumTokens(agentMode)).toBeLessThan(promptBudget('codex-cli'));
    const impossible = { system: '', prompt: 'x'.repeat(9 * promptBudget('claude-cli') + 9) };
    expect(minimumTokens(impossible)).toBeGreaterThan(promptBudget('claude-cli'));
    expect(MAX_BYTES_PER_TOKEN).toBeGreaterThanOrEqual(2 * 4.43);
  });
});
