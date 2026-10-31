// The pass/fail rules of `smoke-processes.mjs --lm` (docs/plans/phase-5-linux.md D3), apart from
// the process checks, so they can be unit tested (inspection LINUX-I003).

/**
 * Failures of the in-VS Code `--lm` results: each answer must carry the token and finish without
 * an error; Claude must list at least 3 models and Codex at least 1; and more groups than the 2
 * requests must be recorded, since discovery and probes run too.
 * @param {Record<string, any> | undefined} inside the results file of test/smoke/index.ts
 * @param {number} recordedGroups
 * @returns {string[]}
 */
export function lmFailures(inside, recordedGroups) {
  if (!inside) return ['the in-VS Code smoke step produced no results'];
  const failures = [];
  for (const name of ['claude', 'codex']) {
    const answer = inside[name];
    if (!answer) {
      failures.push(`no ${name} model was asked`);
      continue;
    }
    if (!answer.tokenFound) failures.push(`the ${name} answer (${answer.id}) lacks the token`);
    // A stream can deliver the token and still fail afterwards (exit status, timeout).
    if (answer.error) failures.push(`the ${name} request (${answer.id}) failed: ${answer.error}`);
  }
  if (!(inside.claudeModels >= 3))
    failures.push(`only ${inside.claudeModels} Claude models listed`);
  if (!(inside.codexModels >= 1)) failures.push('no Codex model listed');
  if (recordedGroups <= 2) {
    failures.push(`only ${recordedGroups} process groups recorded (discovery missing?)`);
  }
  return failures;
}
