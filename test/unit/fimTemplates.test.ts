import { describe, expect, it } from 'vitest';
import { buildFimPrompt, type FimFamily } from '../../src/core/prompt/fimTemplates';

const context = { prefix: 'before', suffix: 'after', snippets: [], filePath: 'main.ts' };
describe('FIM golden layouts', () => {
  it('rejects an unknown family with a fixed message', () => {
    expect(() => buildFimPrompt('PREFIX_SECRET' as FimFamily, context)).toThrow(
      'unknown FIM family',
    );
  });
  it.each([
    [
      'qwen',
      '<|fim_prefix|>before<|fim_suffix|>after<|fim_middle|>',
      [
        '<|endoftext|>',
        '<|fim_prefix|>',
        '<|fim_suffix|>',
        '<|fim_middle|>',
        '<|fim_pad|>',
        '<|repo_name|>',
        '<|file_sep|>',
        '<|im_end|>',
      ],
    ],
    [
      'deepseek-coder',
      '<｜fim▁begin｜>before<｜fim▁hole｜>after<｜fim▁end｜>',
      ['<｜end▁of▁sentence｜>', '<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>'],
    ],
    ['codestral', '[SUFFIX]after[PREFIX] before', ['</s>', '[PREFIX]', '[SUFFIX]']],
    [
      'starcoder',
      '<fim_prefix>before<fim_suffix>after<fim_middle>',
      ['<|endoftext|>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>'],
    ],
  ] as const)('%s matches the verified layout and stops', (family, prompt, stop) => {
    expect(buildFimPrompt(family, context)).toEqual({ prompt, stop });
    if (family !== 'qwen')
      expect(
        buildFimPrompt(family, { ...context, snippets: [{ path: 'a', text: 'DROP' }] }),
      ).toEqual({ prompt, stop });
  });

  it('Qwen repository layout separates snippets with one blank line', () => {
    expect(
      buildFimPrompt('qwen', {
        ...context,
        snippets: [
          { path: 'a.ts', text: 'first' },
          { path: 'b.ts', text: 'second\n' },
        ],
      }).prompt,
    ).toBe(
      '<|repo_name|>workspace\n<|file_sep|>a.ts\nfirst\n\n<|file_sep|>b.ts\nsecond\n\n<|file_sep|>main.ts\n<|fim_prefix|>before<|fim_suffix|>after<|fim_middle|>',
    );
  });

  it('custom golden layout and user stops', () => {
    expect(
      buildFimPrompt('custom', context, {
        template: '{filePath}:{suffix}:{prefix}',
        stop: ['END'],
      }),
    ).toEqual({ prompt: 'main.ts:after:before', stop: ['END'] });
  });

  it.each([undefined, { template: '{prefix}', stop: [] }, { template: '{suffix}', stop: [] }])(
    'custom validates required placeholders: %j',
    (custom) => {
      expect(() => buildFimPrompt('custom', context, custom)).toThrow(
        'requires {prefix} and {suffix}',
      );
    },
  );

  it('replacement is literal and never expands inserted placeholders', () => {
    expect(
      buildFimPrompt(
        'custom',
        { ...context, prefix: '$&$1$` {suffix}', suffix: '{prefix}', filePath: '{suffix}' },
        { template: '{prefix}|{suffix}|{filePath}|{prefix}', stop: [] },
      ).prompt,
    ).toBe('$&$1$` {suffix}|{prefix}|{suffix}|$&$1$` {suffix}');
  });

  it('returned stop arrays do not mutate later results or custom configuration', () => {
    const custom = { template: '{prefix}{suffix}', stop: ['END'] };
    buildFimPrompt('custom', context, custom).stop.push('other');
    expect(custom.stop).toEqual(['END']);
    buildFimPrompt('qwen', context).stop.length = 0;
    expect(buildFimPrompt('qwen', context).stop).toHaveLength(8);
  });
});
