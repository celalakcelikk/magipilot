// Arguments of `npm run cli:verify` (docs/plans/phase-3-errors.md, inspection P3E-I003). The full
// run logs in and spends quota, so it runs only without any argument; anything else must be a
// known selector, or the script stops before a CLI starts.

export interface VerifyArgs {
  /**
   * `auth`: only check A1 (credential-isolated, no quota). `structured`: only check S1, the
   * structured output of tool calling (docs/plans/phase-4-tools.md AC8; 2 real calls). `models`:
   * only check M1, the model lists of both CLIs (docs/plans/phase-4-models.md M6; no model call).
   */
  only?: 'auth' | 'structured' | 'models';
}

const ONLY_VALUES = new Set(['auth', 'structured', 'models']);

/** Parses the arguments after the script name; throws on anything it does not know. */
export function parseVerifyArgs(args: readonly string[]): VerifyArgs {
  const result: VerifyArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === '--only') value = args[++i];
    else if (arg.startsWith('--only=')) value = arg.slice('--only='.length);
    else throw new Error(`unknown argument "${arg}" (supported: --only auth|structured|models)`);
    if (value === undefined || !ONLY_VALUES.has(value)) {
      throw new Error(
        `unknown --only value "${value ?? ''}" (supported: auth, structured, models)`,
      );
    }
    result.only = value as VerifyArgs['only'];
  }
  return result;
}
