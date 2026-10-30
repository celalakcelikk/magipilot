// Sanitizes raw CLI output before it is committed as a test fixture:
// no absolute user paths, no socket paths, and no list of the user's installed plugins/skills.

const REDACTED_LIST_KEYS = new Set([
  'slash_commands',
  'terminal_slash_commands',
  'agents',
  'skills',
  'plugins',
  'capabilities',
]);

const PATH_KEYS = new Set(['cwd', 'original_cwd']);

export interface SanitizeContext {
  homeDir: string;
  /** Directories (e.g. temp cwd) whose absolute path must not appear in the fixture. */
  extraPaths?: readonly string[];
}

function replaceAll(text: string, search: string, replacement: string): string {
  return search === '' ? text : text.split(search).join(replacement);
}

export function sanitizeText(text: string, context: SanitizeContext): string {
  let out = text;
  // Longest paths first so a temp dir under $HOME is not half-replaced.
  const paths = [...(context.extraPaths ?? [])].sort((a, b) => b.length - a.length);
  for (const path of paths) {
    out = replaceAll(out, path, '/tmp/magipilot-fixture');
  }
  out = replaceAll(out, context.homeDir, '/Users/USER');
  return out;
}

function sanitizeValue(key: string, value: unknown, context: SanitizeContext): unknown {
  if (REDACTED_LIST_KEYS.has(key) && Array.isArray(value)) {
    return value.map(() => '<redacted>');
  }
  if (PATH_KEYS.has(key) && typeof value === 'string') {
    return '/tmp/magipilot-fixture';
  }
  if (key === 'additional_directories' && Array.isArray(value)) {
    return value.map(() => '/tmp/magipilot-fixture-extra');
  }
  if (key === 'messaging_socket_path' && typeof value === 'string') {
    return '/tmp/redacted.sock';
  }
  if (typeof value === 'string') {
    return sanitizeText(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue('', item, context));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = sanitizeValue(childKey, childValue, context);
    }
    return out;
  }
  return value;
}

/** Sanitizes one JSONL line; non-JSON lines are sanitized as plain text. */
export function sanitizeJsonLine(line: string, context: SanitizeContext): string {
  try {
    return JSON.stringify(sanitizeValue('', JSON.parse(line), context));
  } catch {
    return sanitizeText(line, context);
  }
}
