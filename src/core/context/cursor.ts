// Prefix/suffix extraction around the cursor (PLAN §6.3).

export interface CursorContext {
  prefix: string;
  suffix: string;
}

/**
 * Last `maxPrefix` characters before the cursor and first `maxSuffix` after it. When a limit
 * cuts into a line, the partial line at the far end is dropped so the model sees whole lines —
 * unless that would leave nothing (a single very long line is kept as raw characters).
 */
export function extractCursorContext(
  text: string,
  offset: number,
  maxPrefix: number,
  maxSuffix: number,
): CursorContext {
  const before = text.slice(0, offset);
  const after = text.slice(offset);

  let prefix = before;
  if (before.length > maxPrefix) {
    prefix = before.slice(before.length - maxPrefix);
    const firstNewline = prefix.indexOf('\n');
    if (firstNewline >= 0 && firstNewline < prefix.length - 1) {
      prefix = prefix.slice(firstNewline + 1);
    }
  }

  let suffix = after;
  if (after.length > maxSuffix) {
    suffix = after.slice(0, maxSuffix);
    const lastNewline = suffix.lastIndexOf('\n');
    if (lastNewline > 0) {
      suffix = suffix.slice(0, lastNewline);
    }
  }
  return { prefix, suffix };
}

/** Leading whitespace of the line the cursor is on, if the cursor sits right after it. */
export function lineBeforeCursor(prefix: string): string {
  return prefix.slice(prefix.lastIndexOf('\n') + 1);
}
