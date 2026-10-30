// Completion prompts used by the bench. Real prompt templates are a Faz 1 concern.
import type { BenchSample } from './samples';

export const CURSOR = '<CURSOR>';

// The prompt carries no output-length instruction: the recorded CLI rows ran without a requested
// limit (docs/bench.md). Changing this text changes what the CLI rows measure — re-run them.
export const COMPLETION_SYSTEM_PROMPT = [
  'You are a code completion engine.',
  `You receive one source file that contains a single ${CURSOR} marker.`,
  `Reply with only the exact text to insert at ${CURSOR} so the file is correct and complete.`,
  'Do not repeat code that is already before or after the marker.',
  'No explanations, no markdown fences. Keep the original indentation.',
  'If nothing should be inserted, reply with an empty message.',
].join(' ');

export function completionUserPrompt(sample: BenchSample): string {
  return [
    `File: ${sample.filePath}`,
    `Language: ${sample.languageId}`,
    '',
    `${sample.prefix}${CURSOR}${sample.suffix}`,
  ].join('\n');
}

/** Codex has no system-prompt flag: the instruction is prepended to the stdin prompt. */
export function codexCompletionPrompt(sample: BenchSample): string {
  return `${COMPLETION_SYSTEM_PROMPT}\n\n${completionUserPrompt(sample)}`;
}

/** Qwen-family FIM tokens for raw (template-less) generation. */
export function qwenFimPrompt(sample: BenchSample): string {
  return `<|fim_prefix|>${sample.prefix}<|fim_suffix|>${sample.suffix}<|fim_middle|>`;
}
