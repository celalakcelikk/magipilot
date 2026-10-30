// Completion prompts for chat-model backends (Claude CLI, Codex CLI). FIM token templates for local
// models live in fimTemplates.ts (Codex-owned, PLAN §12). Without snippets the user prompt is
// byte-identical to the Faz 0 bench prompt (scripts/bench/prompt.ts), so results stay comparable.
import type { CompletionRequest } from '../backends/types';

export const CURSOR = '<CURSOR>';

export const COMPLETION_SYSTEM_PROMPT = [
  'You are a code completion engine.',
  `You receive one source file that contains a single ${CURSOR} marker.`,
  `Reply with only the exact text to insert at ${CURSOR} so the file is correct and complete.`,
  'Do not repeat code that is already before or after the marker.',
  'No explanations, no markdown fences. Keep the original indentation.',
  'If nothing should be inserted, reply with an empty message.',
].join(' ');

type PromptInput = Pick<
  CompletionRequest,
  'prefix' | 'suffix' | 'languageId' | 'filePath' | 'snippets'
>;

export function completionUserPrompt(req: PromptInput): string {
  const lines = [`File: ${req.filePath}`, `Language: ${req.languageId}`, ''];
  if (req.snippets.length > 0) {
    lines.push('Related code from other files (for reference only, do not complete it):');
    for (const snippet of req.snippets) {
      lines.push(`--- ${snippet.path}`, snippet.text, '---');
    }
    lines.push('');
  }
  lines.push(`${req.prefix}${CURSOR}${req.suffix}`);
  return lines.join('\n');
}

/** Codex has no system-prompt flag: the instruction is prepended to the stdin prompt. */
export function codexCompletionPrompt(req: PromptInput): string {
  return `${COMPLETION_SYSTEM_PROMPT}\n\n${completionUserPrompt(req)}`;
}
