# Contributing to Magipilot

Thank you for helping. Bug reports, ideas and pull requests are all welcome. For a larger change, please open an issue first so we can agree on the approach.

## Setup

- **Node** `^22.13.0 || ^24.0.0 || >=26.0.0`. This is the range every dev tool supports: ESLint 10 needs 22.13 or later, vitest 5 excludes 23 and 25, and the VS Code test tools need 22 or later.
- **VS Code 1.140 or newer.**
- **Optional,** for the backends you work on: [Ollama](https://ollama.com), the Claude Code CLI, the Codex CLI.

```
npm install
npm run build
code --extensionDevelopmentPath="$PWD"   # starts VS Code with the extension loaded
```

## Commands

| Command                    | What it does                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run build` / `watch`  | Bundles `src/` into `dist/extension.js` with esbuild                                           |
| `npm run typecheck`        | `tsc --noEmit`                                                                                 |
| `npm test`                 | Unit tests (vitest, `test/unit/`)                                                              |
| `npm run test:integration` | Integration tests inside VS Code (`@vscode/test-cli`, `test/integration/`), with a fake CLI    |
| `npm run lint` / `format`  | ESLint and Prettier                                                                            |
| `npm run package`          | Builds the `.vsix`                                                                             |
| `npm run package:check`    | Checks the `.vsix`: only the allowed files, at most 1 MiB, the production bundle, a valid icon |
| `npm run smoke:vsix`       | Installs the `.vsix` into a test VS Code and checks that it activates (no CLI call)            |
| `npm run smoke:processes`  | Opens and closes VS Code with a fake `claude`, and checks that no process is left behind       |

**These commands call the real CLIs and use your quota:**

| Command              | What it does                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `npm run cli:verify` | Checks the installed Claude Code and Codex CLI flags against their `--help` and real calls |
| `npm run bench`      | Measures backend latency (`-- --only <rows> --samples N --out <file>`)                     |
| `npm run smoke:chat` | Runs Copilot Chat with the real CLIs in an isolated VS Code profile                        |

`smoke:*` and `probe:chat` start VS Code themselves and do not work while `ELECTRON_RUN_AS_NODE` is set: VS Code would take the workspace path for a script. Inside a VS Code terminal, run them as `env -u ELECTRON_RUN_AS_NODE npm run …`.

## Layout

```
src/
  extension.ts          activation, registration
  core/backends/        the Backend interface and the Ollama, OpenAI-compatible, Claude and Codex backends
  core/process/         spawning, timeouts, cancellation, the warm pool
  core/context/         prefix and suffix, snippets, the exclude list
  core/prompt/          FIM templates and completion prompts
  features/inline/      the inline completion provider
  features/chat/        the Copilot Chat model provider and message conversion
  ui/                   status bar and log
test/
  unit/                 vitest
  integration/          tests inside VS Code
  fixtures/             real CLI output, used by the parsers' tests
```

## Security rules

Every change must keep these. A pull request that breaks one will not be merged.

1. **CLIs run without tools, in an empty temporary folder.** Use `claude --tools ""` or `codex exec -s read-only`, never the user's workspace as the working directory.
2. **Model output is never executed** (no `eval`, shell or task). It is only inserted as text.
3. **The extension never writes files itself.** File changes go through Copilot Chat's own mechanism.
4. **The CLIs' auth and token files are never read, copied or logged.**
5. **Network access goes only to endpoints the user configured.** No telemetry.
6. **Files matched by `magipilot.exclude` never enter a prompt**, including while snippets are collected.
7. **Logs contain no prompt content.** Only metadata is logged (backend, duration, token or character counts). Content may be logged only while the debug setting is on.
8. **Every spawned process can be killed** by cancellation and by timeout. No process may be left behind after `deactivate`.

## Code rules

- **TypeScript in strict mode.** Code, comments, commit messages and pull request descriptions are in English.
- **Features talk to backends only through the `Backend` interface** (`src/core/backends/types.ts`). No backend-specific `if` in feature code. Explain a change to the interface in the pull request before making it.
- **Pure logic stays independent of the `vscode` module** (post-processing, context, templates, parsers), so that vitest can test it.
- **Errors:** show the user a clear notification, and write the details to the output channel.
- **CLI flags come from the installed version's `--help`,** not from memory.
- **Parsers are tested with real CLI output** in `test/fixtures/`. Update the fixture when a CLI version changes its output.
- **Codex's stdin is always written and closed;** otherwise the process waits forever.
- **Runtime dependencies stay minimal.** Explain a new one in the pull request.

## Pull requests

- `npm run lint`, `npm run typecheck` and `npm test` pass, and new logic has unit tests.
- Add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for a user-visible change.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
- For a change that affects speed, include `npm run bench` results from before and after.

## Reporting bugs

Please use the bug report form and include:

- the versions;
- the steps to reproduce;
- the output of **Magipilot: Show Log**. It contains no prompt content unless `magipilot.log.debugContent` is on.

For security issues, see [SECURITY.md](SECURITY.md).
