// Types for smokeVerdict.mjs, which plain Node runs from scripts/smoke-processes.mjs.
export function lmFailures(
  inside: Record<string, unknown> | undefined,
  recordedGroups: number,
): string[];
