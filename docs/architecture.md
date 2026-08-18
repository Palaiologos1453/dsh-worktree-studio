# Architecture

This reference describes Worktree Studio's composition, persisted state, optimistic mutation token, delivery checks, and recovery behavior.

## Composition

The npm package is a DSH bundle whose `cordis.patch.yml` inserts two Host entries:

- `dsh-worktree-studio` owns task state, Git operations, the loopback Web route, and the `ctx.worktreeStudio` service.
- `dsh-worktree-studio/commands` exposes the human `/worktree-studio` command through the existing command registry.

The package's `dsh.client` declaration loads `lib/client.cjs` in the Web surface. The client registers a localized sidebar footer action through public DSH Client Slots and calls the Host's `/api/dsh-worktree-studio` route. It uses the native Workspace service to register a created worktree and start a Session in that path.

The plugin does not register a model tool, prompt section, provider, or loop middleware.

## Task state

`TaskStore` owns a versioned JSON document with one `TaskRecord` per task. Writes use DSH atomic-write publication with owner-only file permissions. A second file lock covers each complete Git-plus-state mutation, so separate DSH processes cannot mutate the same task registry concurrently.

A mutation writes `pendingOperation` before the external Git action and clears it only after the stable result is persisted. Startup recovery compares non-archived task paths with `git worktree list --porcelain`. It converts interrupted create and validate operations to reviewable states, recognizes a completed archive or discard when the checkout is absent, and marks uncertain delivery state as `recovery-needed`.

Recovery never removes a path or retries a merge. It reports state requiring a person to inspect.

## Change token

Every fresh `TaskView` contains a SHA-256 `changeToken`. The token covers:

1. task identity and managed path;
2. the exact HEAD commit;
3. `git status --porcelain=v2 -z --untracked-files=all` bytes;
4. a streaming hash of `git diff --binary --full-index <HEAD> --`;
5. sorted non-ignored untracked paths, file modes, symlink targets, and regular-file bytes.

The diff and untracked file streams feed hashes without retaining their full content in memory. Ignored files are intentionally outside the token.

Every mutation receives the token shown to its caller and recomputes current Git state. A mismatch returns `state-conflict`. A validation result stores the token it tested; a later content change makes the view leave `validated`, even when the porcelain status line remains textually identical.

## Validation process

Validation commands are stored as explicit argv. POSIX systems execute that argv directly. Windows uses a fixed encoded PowerShell program that reads `{program,args}` JSON from stdin, resolves only an `Application`, and invokes it with PowerShell's argument splatting; this supports `.cmd` package-manager shims without evaluating user text as PowerShell source.

All Git and validation processes run through `ctx.subprocess`. The configured timeout aborts the managed process tree, the provider escalates termination after `terminationGraceMs`, and the caller waits for complete tree exit. The provider supplies its credential-scrubbed parent environment; the plugin explicitly adds only Git non-interactive variables or `CI` for validation.

## Delivery

Delivery is one serialized mutation with these checks:

1. recompute and match the supplied task token;
2. reject uncommitted task changes and an empty commit range;
3. require a passing validation result with the same token when `requireValidation` is enabled;
4. identify the target as another checkout of the same Git common directory;
5. require a clean target and preview `target HEAD + source HEAD` with `git merge-tree --write-tree`;
6. persist the exact target path and target HEAD in `pendingOperation`;
7. re-identify the target, require the previewed HEAD and a clean checkout, and run `git merge --no-ff --no-edit <source HEAD>`.

A failed merge runs `git merge --abort` and then verifies both target HEAD and cleanliness. Verified restoration produces `merge-conflict`. Any restoration uncertainty produces `recovery-required`, retains a pending delivery marker, and moves the task to `recovery-needed`.

## Web request trust

The Host handler accepts only requests whose socket is loopback and whose `Host` hostname is `localhost`, `127.0.0.1`, or `[::1]`. An explicit cross-site Fetch Metadata marker is rejected. An attached `Origin` must match the `Host` authority exactly.

The route accepts bounded JSON objects and exposes no CORS headers. It is intended for the DSH browser running on the same origin; it is not an authentication layer against another process running as the same operating-system user.
