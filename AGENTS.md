# Instructions for coding agents

Magipilot is a VS Code extension: inline completions and a Copilot Chat model provider, backed by local fill-in-the-middle models and the Claude Code and Codex CLIs.

Before changing anything, read [CONTRIBUTING.md](CONTRIBUTING.md). In particular:

- **The eight security rules** in [CONTRIBUTING.md](CONTRIBUTING.md#security-rules) are not negotiable. The CLIs run without tools in an empty temporary folder, model output is never executed, the extension writes no files, there is no telemetry, excluded files never enter a prompt, logs hold no prompt content, and every spawned process can be killed.
- **Features talk to backends only through the `Backend` interface** (`src/core/backends/types.ts`).
- **Verify CLI flags** against the installed version's `--help`; do not write them from memory.
- **Before you finish:** `npm run lint`, `npm run typecheck` and `npm test` must pass, and new logic needs unit tests.
- **Commands that call the real CLIs use the user's quota:** `cli:verify`, `bench`, `smoke:chat`, `smoke:agent`, `bench:tools`. Run them only when asked.
