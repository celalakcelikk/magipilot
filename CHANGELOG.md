# Changelog

All notable changes to Magipilot are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - author links

### Documentation

- The README's Author section links to the author's LinkedIn profile.

## [0.1.1] - on the Visual Studio Marketplace

### Documentation

- Magipilot is on the Visual Studio Marketplace: search for **Magipilot** in the Extensions view.
- A note in the README that your Claude or ChatGPT plan's terms apply when you use the CLI backends, with links to Anthropic's and OpenAI's guidance.
- The author's name is spelled Celal Akcelik.

## [0.1.0] - first public release

### Inline completions

- Ghost-text suggestions while you type, from Ollama (default), OpenAI-compatible servers (llama.cpp, LM Studio), the Claude Code CLI or the Codex CLI, with a fallback backend.
- Fill-in-the-middle templates for Qwen, DeepSeek Coder, Codestral and StarCoder, and a custom template.
- Signatures of locally imported TypeScript, JavaScript and Python files in the prompt (`magipilot.inline.importSignatures`).
- A completion cache, `Alt+\` to ask for a suggestion, and a status bar switch.

### Chat models in Copilot Chat

- **Claude (CLI)** and **Codex (CLI)** in Copilot Chat's model picker, discovered from the installed CLIs without a model call (`magipilot.chat.discoverModels`).
- An **Effort Level** for every model that reports one (Claude: Auto, Low … Max; Codex: Low … Max, Ultra).
- An honest **Context Size** per model: the part of the CLI's window Magipilot can use. You can choose a smaller size (128K or 200K); older exchanges are then left out, and the status bar says how many.
- `magipilot.chat.contextWindowLimit` caps every model's window; `magipilot.chat.codex.maxContextWindow` gives Codex models their largest window.
- Commit messages through a Magipilot model: **Magipilot: Use for Commit Messages**.

### Agent mode and inline chat (opt-in)

- With `magipilot.chat.toolCalling`, the Claude (CLI) models work in agent mode and inline chat (`Ctrl+I`/`Cmd+I`).
- Copilot Chat runs the tools, with its own confirmations. The CLIs still have no tools of their own.

### Privacy and security

- **The CLIs run isolated:** without tools, in an empty temporary folder, and without your own CLI configuration.
- **`magipilot.exclude` keeps files out of every prompt:** inline completions, chat attachments, tool calls and results, and commit-message diffs.
- **No telemetry.** The logs contain no prompt content unless `magipilot.log.debugContent` is on.
- **In untrusted workspaces and on Windows,** only local backends are used.

### Other

- Clear notifications when a CLI is missing, not logged in, at its usage limit, or past its context window.
- **Magipilot: Show Stats** and **Magipilot: Reset Stats**: local statistics, kept in memory only.

[Unreleased]: https://github.com/celalakcelikk/magipilot/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/celalakcelikk/magipilot/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/celalakcelikk/magipilot/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/celalakcelikk/magipilot/releases/tag/v0.1.0
