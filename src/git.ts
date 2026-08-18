/** Managed Git and explicit-argv validation process adapter. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { StudioError, errorMessage } from './errors.ts'
import type { ChangeSummary, MergePreview, ReviewView, ValidationResult } from './types.ts'

/** Complete process outcome. Timeout and signal remain independent of exit code. */
export interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly stdoutHash: string
}

/** Canonical identity shared by every checkout of one repository. */
export interface RepositoryIdentity {
  readonly topLevel: string
  readonly commonDirectory: string
  readonly headCommit: string
}

/** Parsed `git worktree list --porcelain` record. */
export interface LinkedWorktree {
  readonly path: string
  readonly head: string
  readonly branch: string | null
  readonly detached: boolean
  readonly locked: boolean
}

/** Fresh status plus the full fingerprint used for optimistic mutation checks. */
export interface GitStatus {
  readonly headCommit: string
  readonly branch: string | null
  readonly changes: ChangeSummary
  readonly fingerprint: string
}

interface ProcessOptions {
  readonly cwd: string
  readonly timeoutMs: number
  readonly terminationGraceMs: number
  readonly maxOutputBytes: number
  readonly stdin?: string
  readonly signal?: AbortSignal
  readonly env?: NodeJS.ProcessEnv
}

const WINDOWS_ARGV_SCRIPT = Buffer.from([
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())',
  "  if ([string]::IsNullOrWhiteSpace([string]$payload.program)) { throw 'validation argv is empty' }",
  '  $program = [string]$payload.program',
  '  $rest = [string[]]$payload.args',
  '  $resolved = Get-Command -Name $program -CommandType Application -ErrorAction Stop | Select-Object -First 1',
  '  & $resolved.Source @rest',
  '  if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
  '  if ($?) { exit 0 } else { exit 1 }',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 127',
  '}',
].join('\n'), 'utf16le').toString('base64')

class BoundedOutput {
  private readonly chunks: Buffer[] = []
  private readonly hash = createHash('sha256')
  private length = 0
  private clipped = false

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.hash.update(chunk)
    if (this.length >= this.limit) {
      this.clipped = true
      return
    }
    const remaining = this.limit - this.length
    const selected = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
    this.chunks.push(selected)
    this.length += selected.length
    if (selected.length !== chunk.length) this.clipped = true
  }

  result(): { readonly text: string; readonly truncated: boolean; readonly hash: string } {
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.clipped,
      hash: this.hash.digest('hex'),
    }
  }
}

/** Run one executable through the Harness process-tree owner and await quiescence. */
export async function runProcess(
  subprocess: SubprocessRuntime,
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (isAborted(options.signal)) {
    throw abortReason(options.signal)
  }
  const stdout = new BoundedOutput(options.maxOutputBytes)
  const stderr = new BoundedOutput(options.maxOutputBytes)
  const timeoutController = new AbortController()
  const signal = options.signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([options.signal, timeoutController.signal])
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd: options.cwd,
    stdio: {
      stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    graceMs: options.terminationGraceMs,
    signal,
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  const stdoutStream = handle.stdout
  const stderrStream = handle.stderr
  if (stdoutStream === undefined || stderrStream === undefined) {
    handle.terminate()
    await handle.done.catch((_spawnFailure: unknown) => undefined)
    await handle.waitForExit()
    throw new Error('subprocess provider did not expose requested output pipes')
  }
  const stdoutDone = collect(stdoutStream, stdout)
  const stderrDone = collect(stderrStream, stderr)

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    timeoutController.abort(new Error('process timed out'))
  }, options.timeoutMs)
  timeout.unref()

  try {
    const [outcome] = await Promise.all([handle.done, stdoutDone, stderrDone])
    await handle.waitForExit()
    if (isAborted(options.signal)) {
      throw abortReason(options.signal)
    }
    const out = stdout.result()
    const err = stderr.result()
    return {
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      stdoutHash: out.hash,
    }
  } catch (error) {
    handle.terminate()
    await Promise.allSettled([handle.done, stdoutDone, stderrDone])
    await handle.waitForExit()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function collect(stream: Readable, output: BoundedOutput): Promise<void> {
  for await (const raw of stream) output.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array))
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('process aborted')
}

/** Host-side Git adapter with bounded output and no shell interpolation. */
export class GitClient {
  /**
   * @param timeoutMs - Deadline for ordinary Git operations.
   * @param maxOutputBytes - Per-stream capture bound.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly timeoutMs: number,
    private readonly terminationGraceMs: number,
    private readonly maxOutputBytes: number,
    private readonly signal?: AbortSignal,
  ) {}

  /** Read the installed Git version. */
  async version(cwd = process.cwd()): Promise<string> {
    return (await this.checked(cwd, ['--version'])).stdout.trim()
  }

  /** Resolve one checkout to its canonical repository identity. */
  async identify(cwd: string): Promise<RepositoryIdentity> {
    const absolute = resolve(cwd)
    const [topLevelRaw, commonRaw, headRaw] = await Promise.all([
      this.checked(absolute, ['rev-parse', '--path-format=absolute', '--show-toplevel']),
      this.checked(absolute, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.checked(absolute, ['rev-parse', '--verify', 'HEAD^{commit}']),
    ])
    const topLevel = await realpath(topLevelRaw.stdout.trim())
    const commonValue = commonRaw.stdout.trim()
    const commonDirectory = await realpath(isAbsolute(commonValue) ? commonValue : resolve(absolute, commonValue))
    return { topLevel, commonDirectory, headCommit: headRaw.stdout.trim() }
  }

  /** Resolve a ref to exactly one commit. */
  async resolveCommit(repository: string, ref: string): Promise<string> {
    if (ref.length === 0 || ref.includes('\0') || ref.startsWith('-')) {
      throw new StudioError('invalid-input', 'base ref must be non-empty and must not start with "-"')
    }
    return (await this.checked(repository, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim()
  }

  /** Validate a branch with Git's own ref rules. */
  async validateBranch(repository: string, branch: string): Promise<void> {
    if (branch.length > 160 || branch.includes('\0') || branch.startsWith('-')) {
      throw new StudioError('invalid-input', 'branch name is invalid')
    }
    await this.checked(repository, ['check-ref-format', '--branch', branch])
  }

  /** Create a detached or newly branched linked worktree. */
  async createWorktree(
    repository: string,
    path: string,
    baseCommit: string,
    branch: string | null,
  ): Promise<void> {
    if (branch !== null) await this.validateBranch(repository, branch)
    await this.checked(repository, [
      'worktree', 'add',
      ...(branch === null ? ['--detach'] : ['-b', branch]),
      path,
      baseCommit,
    ])
  }

  /** Read fresh changes and an exact fingerprint of status output. */
  async status(path: string, baseCommit: string): Promise<GitStatus> {
    const [status, head, branchResult, ahead] = await Promise.all([
      this.checked(path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      this.checked(path, ['rev-parse', '--verify', 'HEAD^{commit}']),
      this.raw(path, ['branch', '--show-current']),
      this.checked(path, ['rev-list', '--count', `${baseCommit}..HEAD`]),
    ])
    if (status.stdoutTruncated) {
      throw new StudioError('git-failure', 'git status output exceeded the configured capture limit')
    }
    let staged = 0
    let unstaged = 0
    let untracked = 0
    const untrackedPaths: string[] = []
    for (const entry of status.stdout.split('\0')) {
      if (entry.startsWith('? ')) {
        untracked += 1
        untrackedPaths.push(entry.slice(2))
        continue
      }
      if (entry.startsWith('1 ') || entry.startsWith('2 ') || entry.startsWith('u ')) {
        const indexState = entry[2]
        const worktreeState = entry[3]
        if (indexState !== undefined && indexState !== '.') staged += 1
        if (worktreeState !== undefined && worktreeState !== '.') unstaged += 1
      }
    }
    const commitsAhead = Number.parseInt(ahead.stdout.trim(), 10)
    if (!Number.isSafeInteger(commitsAhead) || commitsAhead < 0) {
      throw new StudioError('git-failure', `Git returned an invalid commit count: ${ahead.stdout.trim()}`)
    }
    const headCommit = head.stdout.trim()
    const branch = branchResult.exitCode === 0 && branchResult.stdout.trim() !== ''
      ? branchResult.stdout.trim()
      : null
    const [trackedDiff, untrackedHash] = await Promise.all([
      this.checked(path, ['diff', '--binary', '--full-index', '--no-ext-diff', headCommit, '--'], 0),
      hashUntracked(path, untrackedPaths),
    ])
    return {
      headCommit,
      branch,
      changes: {
        dirty: staged + unstaged + untracked > 0,
        staged,
        unstaged,
        untracked,
        commitsAhead,
      },
      fingerprint: createHash('sha256')
        .update(headCommit)
        .update('\0')
        .update(status.stdout)
        .update('\0')
        .update(trackedDiff.stdoutHash)
        .update('\0')
        .update(untrackedHash)
        .digest('hex'),
    }
  }

  /** Parse every worktree currently registered in Git metadata. */
  async listWorktrees(repository: string): Promise<readonly LinkedWorktree[]> {
    const result = await this.checked(repository, ['worktree', 'list', '--porcelain'])
    if (result.stdoutTruncated) {
      throw new StudioError('git-failure', 'git worktree list output exceeded the configured capture limit')
    }
    const rows: LinkedWorktree[] = []
    let current: { path?: string; head?: string; branch: string | null; detached: boolean; locked: boolean } = {
      branch: null,
      detached: false,
      locked: false,
    }
    const commit = (): void => {
      if (current.path !== undefined && current.head !== undefined) {
        rows.push({
          path: current.path,
          head: current.head,
          branch: current.branch,
          detached: current.detached,
          locked: current.locked,
        })
      }
      current = { branch: null, detached: false, locked: false }
    }
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (line === '') {
        commit()
      } else if (line.startsWith('worktree ')) {
        if (current.path !== undefined) commit()
        current.path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch refs/heads/')) {
        current.branch = line.slice('branch refs/heads/'.length)
      } else if (line === 'detached') {
        current.detached = true
      } else if (line === 'locked' || line.startsWith('locked ')) {
        current.locked = true
      }
    }
    commit()
    return rows
  }

  /** Produce a bounded diff without modifying either checkout. */
  async review(path: string, baseCommit: string, maxBytes: number): Promise<ReviewView> {
    const [summary, diff, untracked] = await Promise.all([
      this.checked(path, ['diff', '--stat', baseCommit]),
      this.raw(path, ['diff', '--binary', '--full-index', baseCommit], maxBytes),
      this.raw(path, ['ls-files', '--others', '--exclude-standard', '-z'], maxBytes),
    ])
    const untrackedPaths = untracked.stdout.split('\0').filter(Boolean)
    return {
      summary: summary.stdout,
      diff: diff.stdout,
      untrackedPaths,
      truncated: diff.stdoutTruncated || untracked.stdoutTruncated,
    }
  }

  /** Check whether a source commit merges cleanly into an unchanged target. */
  async previewMerge(targetPath: string, commonDirectory: string, sourceHead: string): Promise<MergePreview> {
    const targetIdentity = await this.identify(targetPath)
    if (!samePath(targetIdentity.commonDirectory, commonDirectory)) {
      return {
        canMerge: false,
        targetPath: targetIdentity.topLevel,
        targetHead: targetIdentity.headCommit,
        sourceHead,
        targetDirty: false,
        conflicts: [],
        reason: 'target checkout belongs to a different Git repository',
      }
    }
    const targetStatus = await this.status(targetIdentity.topLevel, targetIdentity.headCommit)
    if (targetStatus.changes.dirty) {
      return {
        canMerge: false,
        targetPath: targetIdentity.topLevel,
        targetHead: targetIdentity.headCommit,
        sourceHead,
        targetDirty: true,
        conflicts: [],
        reason: 'target checkout has uncommitted changes',
      }
    }
    const result = await this.raw(targetIdentity.topLevel, [
      'merge-tree', '--write-tree', targetIdentity.headCommit, sourceHead,
    ])
    if (result.timedOut) {
      return {
        canMerge: false,
        targetPath: targetIdentity.topLevel,
        targetHead: targetIdentity.headCommit,
        sourceHead,
        targetDirty: false,
        conflicts: [],
        reason: 'merge preview timed out',
      }
    }
    const text = `${result.stdout}\n${result.stderr}`
    const conflicts = [...text.matchAll(/CONFLICT[^\n]*?(?: in |: )([^\r\n]+)/gu)]
      .map(match => match[1]?.trim())
      .filter((value): value is string => value !== undefined && value !== '')
    return {
      canMerge: result.exitCode === 0,
      targetPath: targetIdentity.topLevel,
      targetHead: targetIdentity.headCommit,
      sourceHead,
      targetDirty: false,
      conflicts: [...new Set(conflicts)],
      ...(result.exitCode === 0 ? {} : { reason: conflicts.length > 0 ? 'merge conflicts detected' : compactFailure(result) }),
    }
  }

  /** Merge one exact source commit and restore the target after a failed merge. */
  async merge(targetPath: string, expectedTargetHead: string, sourceHead: string): Promise<string> {
    const identity = await this.identify(targetPath)
    if (identity.headCommit !== expectedTargetHead) {
      throw new StudioError('state-conflict', 'target HEAD changed after merge preview; refresh and review again')
    }
    const targetStatus = await this.status(identity.topLevel, expectedTargetHead)
    if (targetStatus.changes.dirty) {
      throw new StudioError('state-conflict', 'target checkout has uncommitted changes')
    }
    const result = await this.raw(identity.topLevel, ['merge', '--no-ff', '--no-edit', sourceHead])
    if (result.exitCode !== 0 || result.timedOut) {
      let restoreFailure: string | undefined
      try {
        await this.raw(identity.topLevel, ['merge', '--abort'])
        const restored = await this.identify(identity.topLevel)
        const restoredStatus = await this.status(identity.topLevel, expectedTargetHead)
        if (restored.headCommit !== expectedTargetHead || restoredStatus.changes.dirty) {
          restoreFailure = 'target HEAD or working tree differs from the pre-merge state'
        }
      } catch (error) {
        restoreFailure = errorMessage(error)
      }
      if (restoreFailure !== undefined) {
        throw new StudioError(
          'recovery-required',
          `merge failed and target restoration could not be verified: ${restoreFailure}`,
        )
      }
      throw new StudioError('merge-conflict', `merge stopped and the target was restored: ${compactFailure(result)}`)
    }
    return (await this.checked(identity.topLevel, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
  }

  /** Remove through Git so dirty and locked worktrees retain Git's protection. */
  async removeWorktree(repository: string, path: string, force: boolean): Promise<void> {
    await this.checked(repository, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  }

  /** Execute a configured validation argv without interpreting shell syntax. */
  async validate(
    path: string,
    command: readonly string[],
    changeToken: string,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<ValidationResult> {
    assertCommand(command)
    const invocation = validationInvocation(command)
    const startedAt = new Date().toISOString()
    const result = await runProcess(this.subprocess, invocation.executable, invocation.args, {
      cwd: path,
      timeoutMs,
      terminationGraceMs: this.terminationGraceMs,
      maxOutputBytes,
      env: { CI: process.env.CI ?? '1' },
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    })
    const completedAt = new Date().toISOString()
    return {
      command: [...command],
      exitCode: result.exitCode,
      ...(result.signal === null ? {} : { signal: result.signal }),
      timedOut: result.timedOut,
      passed: result.exitCode === 0 && !result.timedOut,
      startedAt,
      completedAt,
      stdout: result.stdout + (result.stdoutTruncated ? '\n[output truncated]' : ''),
      stderr: result.stderr + (result.stderrTruncated ? '\n[output truncated]' : ''),
      changeToken,
    }
  }

  private raw(cwd: string, args: readonly string[], maxOutputBytes = this.maxOutputBytes): Promise<ProcessResult> {
    return runProcess(this.subprocess, 'git', args, {
      cwd,
      timeoutMs: this.timeoutMs,
      terminationGraceMs: this.terminationGraceMs,
      maxOutputBytes,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        LC_ALL: 'C',
      },
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    }).catch((error: unknown) => {
      if (error instanceof StudioError) throw error
      throw new StudioError('git-failure', `cannot run Git: ${errorMessage(error)}`, 502, { cause: error })
    })
  }

  private async checked(cwd: string, args: readonly string[], maxOutputBytes = this.maxOutputBytes): Promise<ProcessResult> {
    const result = await this.raw(cwd, args, maxOutputBytes)
    if (result.exitCode !== 0 || result.timedOut) {
      throw new StudioError('git-failure', `git ${args[0] ?? ''} failed: ${compactFailure(result)}`)
    }
    return result
  }
}

function validationInvocation(command: readonly string[]): {
  readonly executable: string
  readonly args: readonly string[]
  readonly stdin?: string
} {
  if (process.platform !== 'win32') {
    return { executable: command[0] as string, args: command.slice(1) }
  }
  return {
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', WINDOWS_ARGV_SCRIPT],
    stdin: JSON.stringify({ program: command[0], args: command.slice(1) }),
  }
}

async function hashUntracked(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) {
    hash.update(path)
    hash.update('\0')
    const absolute = resolve(root, path)
    const rel = relative(resolve(root), absolute)
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw new StudioError('unsafe-path', `untracked path escapes its repository: ${path}`)
    }
    try {
      const info = await lstat(absolute)
      hash.update(String(info.mode))
      hash.update('\0')
      if (info.isSymbolicLink()) {
        hash.update(await readlink(absolute))
      } else if (info.isFile()) {
        for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer)
      } else {
        hash.update(`special:${String(info.size)}:${String(info.mtimeMs)}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      hash.update('missing-during-snapshot')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Require an argv that can be passed directly to spawn. */
export function assertCommand(command: readonly string[]): void {
  if (command.length === 0 || command.length > 64 || command[0]?.trim() === '') {
    throw new StudioError('invalid-input', 'validation command must contain 1 to 64 arguments')
  }
  if (command.some(value => value.length > 4096 || value.includes('\0'))) {
    throw new StudioError('invalid-input', 'validation command contains an invalid argument')
  }
}

/** Reject a generated child path that escapes its configured root. */
export function assertPathInside(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new StudioError('unsafe-path', `managed worktree path escapes its configured root: ${candidate}`)
  }
}

/** Platform-aware comparison after callers canonicalize both paths. */
export function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

/** Compact subprocess diagnostics without leaking unbounded output. */
function compactFailure(result: ProcessResult): string {
  if (result.timedOut) return 'operation timed out'
  const detail = result.stderr.trim() || result.stdout.trim()
  return detail === ''
    ? `process exited with ${String(result.exitCode)}${result.signal === null ? '' : ` (${result.signal})`}`
    : detail.slice(0, 2000)
}
