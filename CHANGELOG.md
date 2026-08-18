# Changelog

All notable changes to this project are documented in this file.

## 0.1.1 - 2026-08-19

### Fixed

- Confirm existing worktree paths through Git identity during recovery when Windows path formatting differs from `git worktree list` output.
- Serialize Windows fixture files in CI to avoid subprocess and worktree metadata contention.

## 0.1.0 - 2026-08-19

### Added

- Session-linked Web task board and `/worktree-studio` human command.
- Branch-backed linked worktree creation with native DSH Workspace and Session opening.
- Content-level change tokens covering tracked diffs and non-ignored untracked file bytes.
- Validation results bound to exact change tokens, with bounded stdout and stderr.
- Checkout-safe `git merge-tree` preview and guarded non-fast-forward delivery.
- Explicit archive and discard flows, atomic state, cross-process mutation locking, and restart recovery.
- Loopback same-origin Web request checks and managed subprocess execution with ambient credential scrubbing.
- English and Chinese product copy and documentation.
