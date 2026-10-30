// Leaving the oldest exchanges out for a context size the user chose (docs/plans/phase-4-sizes.md
// S3). vscode-free.
import { estimateTokens, type ChatTurn } from './messages';
import { windowLabel } from './models';

export interface TrimResult {
  /** Per turn, whether it is sent. System turns always are. */
  keep: boolean[];
  /** Non-system turns left out. */
  dropped: number;
  /** The current exchange alone is larger than the tier; everything older was left out (D4). */
  overTier: boolean;
}

/**
 * Where exchanges start (S3): at a user turn that carries no tool result and is either the first
 * non-system turn or comes right after an assistant turn. Consecutive user turns, such as agent
 * mode's note, summary and question, stay in one exchange; a tool result stays with its call.
 */
export function exchangeStarts(
  turns: readonly ChatTurn[],
  toolResult: readonly boolean[],
): boolean[] {
  let previous: ChatTurn['role'] | undefined;
  return turns.map((turn, i) => {
    if (turn.role === 'system') return false;
    const start =
      turn.role === 'user' &&
      toolResult[i] !== true &&
      (previous === undefined || previous === 'assistant');
    previous = turn.role;
    return start;
  });
}

/**
 * Leaves out the fewest whole exchanges, oldest first, so that the conversation fits in `tier`.
 * Only non-system turns count, each as Copilot Chat counts a message (`estimateTokens(text, 1)`);
 * turns before the first start form the oldest group (an answer Copilot left without its
 * question). The current exchange, from the last start, is always kept: when it alone is larger
 * than the tier, everything older goes and `overTier` says so.
 */
export function trimToTier(
  turns: readonly ChatTurn[],
  starts: readonly boolean[],
  tier: number,
): TrimResult {
  const keep = turns.map(() => true);
  const groups: { turns: number[]; size: number }[] = [];
  let total = 0;
  turns.forEach((turn, i) => {
    if (turn.role === 'system') return;
    const size = estimateTokens(turn.text, 1);
    total += size;
    if (starts[i] === true || groups.length === 0) groups.push({ turns: [], size: 0 });
    const group = groups[groups.length - 1]!;
    group.turns.push(i);
    group.size += size;
  });
  if (total <= tier) return { keep, dropped: 0, overTier: false };
  // The fewest leading groups whose removal makes the rest fit; the last group always stays.
  let rest = total;
  let leave = 0;
  while (leave < groups.length - 1 && rest > tier) {
    rest -= groups[leave]!.size;
    leave++;
  }
  let dropped = 0;
  for (const group of groups.slice(0, leave)) {
    for (const i of group.turns) keep[i] = false;
    dropped += group.turns.length;
  }
  return { keep, dropped, overTier: rest > tier };
}

/** The notice for messages left out (phase-4-sizes.md S9): counts and sizes only. */
export function trimNotice(dropped: number, overTier: boolean, tier: number): string {
  const size = windowLabel(tier);
  const older = `${dropped} older message${dropped === 1 ? '' : 's'}`;
  if (!overTier) return `Magipilot: ${older} left out to fit ${size}`;
  return dropped > 0
    ? `Magipilot: sent without the ${older}; this message alone is larger than ${size}`
    : `Magipilot: this message alone is larger than ${size}; sent as it is`;
}
