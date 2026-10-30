// Verified layouts: QwenLM/Qwen2.5-Coder README.md and
// examples/Qwen2.5-Coder-repolevel-fim.py; deepseek-ai/DeepSeek-Coder README.md §4;
// Ollama codestral template and Mistral tokenization cookbook;
// bigcode/starcoder2-3b tokenizer_config.json.
export type FimFamily = 'qwen' | 'deepseek-coder' | 'codestral' | 'starcoder' | 'custom';

export function isFimFamily(value: unknown): value is FimFamily {
  return (
    typeof value === 'string' &&
    ['qwen', 'deepseek-coder', 'codestral', 'starcoder', 'custom'].includes(value)
  );
}

export interface CustomFimTemplate {
  template: string;
  stop: string[];
}

interface FimContext {
  prefix: string;
  suffix: string;
  snippets: { path: string; text: string }[];
  filePath: string;
}

export function buildFimPrompt(
  family: FimFamily,
  context: FimContext,
  custom?: CustomFimTemplate,
): { prompt: string; stop: string[] } {
  const { prefix, suffix, snippets, filePath } = context;
  switch (family) {
    case 'qwen': {
      const repo = snippets.length
        ? '<|repo_name|>workspace\n' +
          snippets
            .map(
              ({ path, text }) =>
                `<|file_sep|>${path}\n${text}${text.endsWith('\n') ? '\n' : '\n\n'}`,
            )
            .join('') +
          `<|file_sep|>${filePath}\n`
        : '';
      return {
        prompt: `${repo}<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
        stop: [
          '<|endoftext|>',
          '<|fim_prefix|>',
          '<|fim_suffix|>',
          '<|fim_middle|>',
          '<|fim_pad|>',
          '<|repo_name|>',
          '<|file_sep|>',
          '<|im_end|>',
        ],
      };
    }
    case 'deepseek-coder':
      return {
        prompt: `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
        stop: ['<｜end▁of▁sentence｜>', '<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>'],
      };
    case 'codestral':
      // Follow Ollama's literal space after [PREFIX], as in [PREFIX] {{ .Prompt }}.
      return {
        prompt: `[SUFFIX]${suffix}[PREFIX] ${prefix}`,
        stop: ['</s>', '[PREFIX]', '[SUFFIX]'],
      };
    case 'starcoder':
      return {
        prompt: `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
        stop: ['<|endoftext|>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>'],
      };
    case 'custom': {
      if (!custom?.template.includes('{prefix}') || !custom.template.includes('{suffix}')) {
        throw new Error('custom FIM template requires {prefix} and {suffix}');
      }
      const values = { prefix, suffix, filePath };
      return {
        prompt: custom.template.replace(
          /\{(prefix|suffix|filePath)\}/g,
          (_match, key: string) => values[key as keyof typeof values],
        ),
        stop: [...custom.stop],
      };
    }
    default:
      throw new Error('unknown FIM family');
  }
}
