# Security Policy

## Supported versions

Security fixes are applied to the latest published `0.1.x` release while the plugin remains pre-1.0.

## Reporting

Report a vulnerability privately through [GitHub Security Advisories](https://github.com/Palaiologos1453/dsh-worktree-studio/security/advisories/new). Do not include credentials, private repository content, or a destructive proof of concept in a public issue.

Include the plugin version, DSH version, operating system, Git version, affected operation, and the smallest safe reproduction. Maintainers will acknowledge a report after the repository is published and will coordinate disclosure before publishing a fix.

## Trust assumptions

Worktree Studio runs as third-party Host code with the DSH process user's filesystem and Git permissions. Installing it is equivalent to trusting it to create branches, linked worktrees, validation processes, and merge commits in repositories selected through the Web profile.

Validation commands are user-authored executable argv and run with the user's permissions inside the managed worktree. DSH's subprocess provider removes credential-shaped and `DSH_*` ambient variables, but validation can still read files and ordinary environment variables available to that operating-system user. Only run commands and repositories you trust.

The Web API is restricted to loopback same-origin requests to reduce DNS-rebinding and cross-site browser attacks. It does not authenticate local processes running as the same user.

Discard permanently removes uncommitted files from the managed worktree. The Web client presents a risk acknowledgement and the Host requires the exact task ID, but users remain responsible for reviewing the selected task.

The plugin never sends repository data over the network and contains no telemetry. Git hooks and configured Git filters belong to the selected repository and may execute during ordinary Git operations.
