// Argument builders for the Claude Code and Codex CLIs.
// Flags are verified against the installed versions by `npm run cli:verify`; see docs/cli-notes.md.

/** Claude Code's `--effort` levels, and Codex's `model_reasoning_effort` levels (`ultra` is Codex only). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface ClaudeArgsOptions {
  model: string;
  systemPrompt: string;
  /** "stream-json" keeps one conversation open and reads user messages from stdin. */
  inputFormat?: 'text' | 'stream-json';
  /** Emit token deltas (needed for time-to-first-text). Default true. */
  partialMessages?: boolean;
  effort?: Effort;
  /**
   * "isolated" (default): --safe-mode + --strict-mcp-config + --setting-sources "" — no CLAUDE.md,
   * hooks, plugins, MCP servers or user settings (the latter add e.g. an `advisor` tool).
   * "without-safe-mode" is the cli-verify negative control for CLAUDE.md loading: MCP servers and
   * user settings (hence user hooks, plugins and tools) stay off; only --safe-mode is dropped.
   * There is deliberately no level that loads the user's tools, MCP servers or hooks.
   */
  isolation?: 'isolated' | 'without-safe-mode';
  /**
   * Value of --setting-sources (default "" = no user/project/local settings). cli-verify's
   * CLAUDE.md control uses "project": its temp cwd has no project settings, so this only lets the
   * planted project CLAUDE.md load. "user" is never used (it would load the user's hooks/tools).
   */
  settingSources?: '' | 'project';
  /** Only false for the cli-verify check that stream-json requires --verbose. */
  verbose?: boolean;
  debugFile?: string;
  /** Only true for the cli-verify negative control of --no-session-persistence. */
  persistSession?: boolean;
  /**
   * `--json-schema`: the answer must match this JSON Schema (tool calling, phase-4-tools.md T2).
   * The CLI then offers one internal tool, `StructuredOutput`, through which the answer arrives.
   */
  jsonSchema?: string;
  extra?: readonly string[];
}

export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args = [
    '-p',
    '--tools',
    '',
    '--model',
    options.model,
    '--system-prompt',
    options.systemPrompt,
    '--output-format',
    'stream-json',
  ];
  if (options.verbose ?? true) {
    args.push('--verbose');
  }
  if (options.partialMessages ?? true) {
    args.push('--include-partial-messages');
  }
  if (options.inputFormat === 'stream-json') {
    args.push('--input-format', 'stream-json');
  }
  if (!options.persistSession) {
    args.push('--no-session-persistence');
  }
  if ((options.isolation ?? 'isolated') === 'isolated') {
    args.push('--safe-mode');
  }
  args.push('--strict-mcp-config', '--setting-sources', options.settingSources ?? '');
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.debugFile) {
    args.push('--debug-file', options.debugFile);
  }
  if (options.jsonSchema !== undefined) {
    args.push('--json-schema', options.jsonSchema);
  }
  if (options.extra) {
    args.push(...options.extra);
  }
  return args;
}

/**
 * The Claude model probe (docs/plans/phase-4-models.md M3): the isolation set of
 * `buildClaudeArgs` (no tools, no session file, safe mode, no MCP servers, no setting sources),
 * without a system prompt, reading SDK control messages from stdin. With `model`, the window
 * probe of phase-4-context.md W1: the session's model is chosen at start, never by `set_model`.
 */
export function buildClaudeModelProbeArgs(model?: string): string[] {
  return [
    ...(model !== undefined ? ['--model', model] : []),
    '-p',
    '--tools',
    '',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--no-session-persistence',
    '--safe-mode',
    '--strict-mcp-config',
    '--setting-sources',
    '',
  ];
}

/** The SDK `initialize` control request: its answer lists the models (no model call). */
export function claudeInitializeRequest(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'initialize' },
  })}\n`;
}

/**
 * The SDK `get_context_usage` control request (phase-4-context.md W1): Claude Code's `/context`
 * view of the session, whose `rawMaxTokens` is the model's context window. Not a model call.
 */
export function claudeContextUsageRequest(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'get_context_usage' },
  })}\n`;
}

/** One user turn for `--input-format stream-json`. */
export function claudeStreamJsonUserMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

export interface CodexArgsOptions {
  model: string;
  effort: Effort;
  /** Empty private directory used as the agent's working root. */
  cwd: string;
  /** File that receives the final agent message (`-o`). */
  lastMessagePath: string;
  /**
   * "lean" drops the skills, permissions and collaboration-mode instruction blocks and the
   * tool features a completion never needs. "default" keeps the user's Codex defaults.
   */
  profile?: 'lean' | 'default';
  /**
   * Default true: skips ~/.codex/config.toml (its MCP servers, plugins and model defaults) while
   * auth still comes from CODEX_HOME. `-m` is therefore mandatory.
   */
  ignoreUserConfig?: boolean;
  /** `--output-schema`: a JSON Schema file for the final message (tool calling, T2). */
  outputSchemaPath?: string;
  /**
   * `-c model_context_window=<n>`: the model's largest catalog window, only when the user opts in
   * (`magipilot.chat.codex.maxContextWindow`, phase-4-context.md W5). Absent: Codex's default.
   */
  contextWindow?: number;
}

/** The Codex model catalog (M3): `codex debug models`, refreshed from the service (D3). */
export function buildCodexModelProbeArgs(): string[] {
  return ['debug', 'models'];
}

export const CODEX_LEAN_CONFIG = [
  'skills.include_instructions=false',
  'include_permissions_instructions=false',
  'include_collaboration_mode_instructions=false',
] as const;

export const CODEX_LEAN_DISABLED_FEATURES = [
  'plugins',
  'apps',
  'multi_agent',
  'shell_tool',
  'unified_exec',
  'view_image',
  'image_generation',
  'browser_use',
  'computer_use',
  'memories',
] as const;

export function buildCodexArgs(options: CodexArgsOptions): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '-s',
    'read-only',
    '-m',
    options.model,
    '-c',
    `model_reasoning_effort="${options.effort}"`,
    ...(options.contextWindow !== undefined
      ? ['-c', `model_context_window=${Math.trunc(options.contextWindow)}`]
      : []),
    '--skip-git-repo-check',
    '-C',
    options.cwd,
    '--ignore-rules',
  ];
  if (options.ignoreUserConfig ?? true) {
    args.push('--ignore-user-config');
  }
  const disabled =
    (options.profile ?? 'lean') === 'lean' ? CODEX_LEAN_DISABLED_FEATURES : ['plugins', 'apps'];
  for (const feature of disabled) {
    args.push('--disable', feature);
  }
  if ((options.profile ?? 'lean') === 'lean') {
    for (const entry of CODEX_LEAN_CONFIG) {
      args.push('-c', entry);
    }
  }
  if (options.outputSchemaPath !== undefined) {
    args.push('--output-schema', options.outputSchemaPath);
  }
  // The prompt is read from stdin ("-"); the caller must write it and close stdin.
  args.push('-o', options.lastMessagePath, '-');
  return args;
}
