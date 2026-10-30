# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.

Include the Magipilot version, your editor and OS, the steps to reproduce, and what an attacker could gain.

You will get an answer within a week. Magipilot is maintained by one person, so a fix may take longer. You will be credited in the release notes unless you prefer not to be.

## What counts

Magipilot runs AI command-line tools on your machine and handles your code and chat content. Examples of what we want to hear about:

- **Excluded files leaking.** Content of a file matched by `magipilot.exclude` that reaches a prompt.
- **CLI isolation broken.** A way for a CLI started by Magipilot to use tools, read your workspace, or load your own CLI configuration.
- **Model output executed.** Model output that Magipilot itself executes (rather than inserting as text or handing to Copilot Chat's confirmed tools).
- **Content in the logs.** Prompt or answer content written to the logs while `magipilot.log.debugContent` is off.
- **Unexpected network traffic.** Requests to an endpoint you did not configure, or any telemetry.
- **Processes left running.** A process that outlives a cancelled request, a timeout, or the extension's deactivation.
- **Credentials touched.** Magipilot reading, copying or logging a CLI's login or token files.

Copilot Chat's own tools, confirmations and services are not part of Magipilot; please report problems with them to their maintainers.

## The security model

The rules every change follows are listed in [CONTRIBUTING.md](CONTRIBUTING.md#security-rules). In short:

- the CLIs run without tools in an empty temporary folder;
- model output is never executed;
- the extension writes no files itself;
- there is no telemetry;
- excluded files never enter a prompt.
