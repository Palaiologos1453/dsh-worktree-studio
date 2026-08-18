/** Durable worktree task lifecycle and guarded delivery. */

import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { StudioError, errorMessage } from './errors.ts'
import { assertCommand, assertPathInside, GitClient, samePath } from './git.ts'
import type { GitStatus } from './git.ts'
import { TaskStore, type StoreState } from './store.ts'
import {
  TaskId,
  type CreateTaskRequest,
  type DashboardView,
  type DoctorView,
  type MergePreview,
  type ReviewView,
  type TaskMutationRequest,
  type TaskRecord,
  type TaskView,
  type WorktreeStudioManager,
} from './types.ts'

/** Deployment choices resolved by the Host plugin. */
export interface WorktreeStudioOptions {
  readonly managedRoot: string
  readonly statePath: string
  readonly gitTimeoutMs: number
  readonly terminationGraceMs: number
  readonly validationTimeoutMs: number
  readonly maxOutputBytes: number
  readonly reviewMaxBytes: number
  readonly requireValidation: boolean
}

const EMPTY_CHANGES = Object.freeze({
  dirty: false,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  commitsAhead: 0,
})

/** Local task manager. Every mutation is serialized in-process and cross-process. */
export class LocalWorktreeStudioManager implements WorktreeStudioManager {
  private readonly git: GitClient
  private readonly store: TaskStore
  private readonly lifecycle = new AbortController()
  private operationTail: Promise<void> = Promise.resolve()
  private admissionOpen = true

  /**
   * @param options - Resolved paths, process limits, and delivery policy.
   * @param subprocess - Harness-owned process-tree runtime.
   * @param git - Optional process adapter for tests.
   * @param store - Optional durable store for tests.
   */
  constructor(
    private readonly options: WorktreeStudioOptions,
    subprocess: SubprocessRuntime,
    git?: GitClient,
    store?: TaskStore,
  ) {
    this.git = git ?? new GitClient(
      subprocess,
      options.gitTimeoutMs,
      options.terminationGraceMs,
      options.maxOutputBytes,
      this.lifecycle.signal,
    )
    this.store = store ?? new TaskStore(options.statePath)
  }

  /** Create a branch-backed worktree and persist its recovery marker first. */
  create(request: CreateTaskRequest): Promise<TaskView> {
    return this.mutate(async () => {
      const title = normalizeTitle(request.title)
      const identity = await this.git.identify(request.repository)
      const baseCommit = await this.git.resolveCommit(identity.topLevel, request.baseRef ?? 'HEAD')
      const id = TaskId(`wt-${randomUUID()}`)
      const shortId = String(id).slice(3, 11)
      const branch = request.branch === undefined || request.branch.trim() === ''
        ? `dsh/${slug(title)}-${shortId}`
        : request.branch.trim()
      await this.git.validateBranch(identity.topLevel, branch)
      const repositoryKey = createHash('sha256').update(identity.commonDirectory).digest('hex').slice(0, 16)
      const path = resolve(this.options.managedRoot, repositoryKey, `${slug(title)}-${shortId}`)
      assertPathInside(this.options.managedRoot, path)
      await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
      if (await pathExists(path)) throw new StudioError('state-conflict', `managed worktree path already exists: ${path}`)
      const validationCommand = request.validationCommand === undefined
        ? undefined
        : [...request.validationCommand]
      if (validationCommand !== undefined) assertCommand(validationCommand)
      const now = new Date().toISOString()
      const pending: TaskRecord = {
        id,
        title,
        repository: identity.topLevel,
        commonDirectory: identity.commonDirectory,
        path,
        branch,
        baseCommit,
        createdAt: now,
        updatedAt: now,
        phase: 'creating',
        ...(validationCommand === undefined ? {} : { validationCommand }),
        pendingOperation: 'create',
      }
      await this.insertTask(pending)
      try {
        await this.git.createWorktree(identity.topLevel, path, baseCommit, branch)
        await this.replaceTask(id, current => clearTransient({
          ...current,
          phase: 'active',
          updatedAt: new Date().toISOString(),
        }))
      } catch (error) {
        await this.replaceTask(id, current => ({
          ...current,
          phase: 'recovery-needed',
          updatedAt: new Date().toISOString(),
          pendingOperation: 'create',
          lastError: errorMessage(error),
        }))
        throw error
      }
      return await this.view(this.requireTask(await this.store.read(), id))
    })
  }

  /** Read fresh Git state for one repository or every known task. */
  async dashboard(repository?: string): Promise<DashboardView> {
    const state = await this.store.read()
    let selectedCommon: string | undefined
    let selectedRepository: string | undefined
    if (repository !== undefined && repository !== '') {
      const identity = await this.git.identify(repository)
      selectedCommon = identity.commonDirectory
      selectedRepository = identity.topLevel
    }
    const records = Object.values(state.tasks)
      .filter(task => selectedCommon === undefined || samePath(task.commonDirectory, selectedCommon))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const tasks = await Promise.all(records.map(task => this.view(task)))
    const repositories = [...new Set(Object.values(state.tasks).map(task => task.repository))].sort()
    return {
      ...(selectedRepository === undefined ? {} : { repository: selectedRepository }),
      tasks,
      repositories,
    }
  }

  /** Return the current task and a bounded diff. */
  async inspect(id: TaskId): Promise<{ readonly task: TaskView; readonly review: ReviewView }> {
    const task = this.requireTask(await this.store.read(), id)
    const view = await this.view(task)
    if (!view.exists) throw new StudioError('not-found', `task ${String(id)} has no linked worktree`)
    return {
      task: view,
      review: await this.git.review(task.path, task.baseCommit, this.options.reviewMaxBytes),
    }
  }

  /** Preview mergeability without touching the target index or working tree. */
  async previewMerge(id: TaskId, targetPath?: string): Promise<MergePreview> {
    const task = this.requireTask(await this.store.read(), id)
    const view = await this.view(task)
    if (!view.exists || view.headCommit === null) {
      return failedPreview(task, targetPath, 'task worktree is missing')
    }
    if (view.changes.dirty) return failedPreview(task, targetPath, 'task worktree has uncommitted changes', view.headCommit)
    if (view.changes.commitsAhead === 0) return failedPreview(task, targetPath, 'task has no commits to deliver', view.headCommit)
    const target = targetPath ?? task.repository
    if (samePath(target, task.path)) return failedPreview(task, target, 'task worktree cannot be its own merge target', view.headCommit)
    return await this.git.previewMerge(target, task.commonDirectory, view.headCommit)
  }

  /** Run the configured argv and bind its result to the exact change token. */
  validate(id: TaskId, changeToken: string, command?: readonly string[]): Promise<TaskView> {
    return this.mutate(async () => {
      const task = this.requireTask(await this.store.read(), id)
      const before = await this.assertToken(task, changeToken)
      const selected = command === undefined ? task.validationCommand : [...command]
      if (selected === undefined) {
        throw new StudioError('invalid-input', 'no validation command is configured for this task')
      }
      assertCommand(selected)
      await this.replaceTask(id, current => ({
        ...current,
        validationCommand: [...selected],
        pendingOperation: 'validate',
        updatedAt: new Date().toISOString(),
      }))
      try {
        const validation = await this.git.validate(
          task.path,
          selected,
          before.changeToken,
          this.options.validationTimeoutMs,
          this.options.maxOutputBytes,
        )
        const after = await this.view(this.requireTask(await this.store.read(), id))
        const stable = after.changeToken === before.changeToken
        await this.replaceTask(id, current => (stable ? clearTransient : clearPendingOnly)({
          ...current,
          lastValidation: validation,
          phase: validation.passed && stable ? 'validated' : 'blocked',
          updatedAt: new Date().toISOString(),
          ...stable ? {} : { lastError: 'worktree changed while validation was running' },
        }))
      } catch (error) {
        await this.replaceTask(id, current => clearPendingOnly({
          ...current,
          phase: 'blocked',
          updatedAt: new Date().toISOString(),
          lastError: `validation could not complete: ${errorMessage(error)}`,
        }))
        throw new StudioError('validation-failed', `validation could not complete: ${errorMessage(error)}`, 409, { cause: error })
      }
      return await this.view(this.requireTask(await this.store.read(), id))
    })
  }

  /** Recheck token, validation, target cleanliness, and merge preview before delivery. */
  deliver(id: TaskId, changeToken: string, targetPath?: string): Promise<TaskView> {
    return this.mutate(async () => {
      const task = this.requireTask(await this.store.read(), id)
      const current = await this.assertToken(task, changeToken)
      if (current.changes.dirty) throw new StudioError('state-conflict', 'commit or discard task changes before delivery')
      if (current.changes.commitsAhead === 0 || current.headCommit === null) {
        throw new StudioError('state-conflict', 'task has no commits to deliver')
      }
      if (this.options.requireValidation
        && (task.lastValidation?.passed !== true || task.lastValidation.changeToken !== current.changeToken)) {
        throw new StudioError('validation-failed', 'run a passing validation against the current task state before delivery')
      }
      const preview = await this.previewMerge(id, targetPath)
      if (!preview.canMerge || preview.targetHead === null) {
        throw new StudioError('merge-conflict', preview.reason ?? 'merge preview did not produce a safe target')
      }
      const pendingOperation = `deliver:${preview.targetPath}:${preview.targetHead}`
      await this.replaceTask(id, record => ({
        ...record,
        pendingOperation,
        updatedAt: new Date().toISOString(),
      }))
      try {
        await this.git.merge(preview.targetPath, preview.targetHead, current.headCommit)
        await this.replaceTask(id, record => clearTransient({
          ...record,
          phase: 'delivered',
          conclusion: 'delivered',
          updatedAt: new Date().toISOString(),
        }))
      } catch (error) {
        if (error instanceof StudioError && error.code === 'recovery-required') {
          await this.markRecovery(id, pendingOperation, error)
        } else {
          await this.replaceTask(id, record => clearPendingOnly({
            ...record,
            phase: 'blocked',
            updatedAt: new Date().toISOString(),
            lastError: errorMessage(error),
          }))
        }
        throw error
      }
      return await this.view(this.requireTask(await this.store.read(), id))
    })
  }

  /** Remove a clean checkout through Git and retain its durable history. */
  archive(request: TaskMutationRequest): Promise<TaskView> {
    return this.mutate(async () => {
      const task = this.requireTask(await this.store.read(), request.id)
      const current = await this.assertToken(task, request.changeToken)
      if (current.changes.dirty) throw new StudioError('state-conflict', 'archive refuses a worktree with uncommitted changes')
      await this.replaceTask(task.id, record => ({
        ...record,
        pendingOperation: 'archive',
        updatedAt: new Date().toISOString(),
      }))
      try {
        await this.git.removeWorktree(task.repository, task.path, false)
        await this.replaceTask(task.id, record => clearTransient({
          ...record,
          phase: 'archived',
          conclusion: record.conclusion ?? 'archived',
          updatedAt: new Date().toISOString(),
        }))
      } catch (error) {
        await this.markRecovery(task.id, 'archive', error)
        throw error
      }
      return await this.view(this.requireTask(await this.store.read(), task.id))
    })
  }

  /** Force-remove only after an exact task-id confirmation. */
  discard(request: TaskMutationRequest, confirmation: string): Promise<TaskView> {
    return this.mutate(async () => {
      const task = this.requireTask(await this.store.read(), request.id)
      await this.assertToken(task, request.changeToken)
      if (confirmation !== String(task.id)) {
        throw new StudioError('invalid-input', `discard confirmation must equal task id ${String(task.id)}`)
      }
      await this.replaceTask(task.id, record => ({
        ...record,
        pendingOperation: 'discard',
        updatedAt: new Date().toISOString(),
      }))
      try {
        await this.git.removeWorktree(task.repository, task.path, true)
        await this.replaceTask(task.id, record => clearTransient({
          ...record,
          phase: 'archived',
          conclusion: 'discarded',
          updatedAt: new Date().toISOString(),
        }))
      } catch (error) {
        await this.markRecovery(task.id, 'discard', error)
        throw error
      }
      return await this.view(this.requireTask(await this.store.read(), task.id))
    })
  }

  /** Reconcile interrupted markers with Git metadata without deleting anything. */
  recover(): Promise<DoctorView> {
    return this.mutate(async () => {
      const state = await this.store.read()
      const byRepository = new Map<string, Set<string>>()
      for (const task of Object.values(state.tasks)) {
        if (task.phase === 'archived') continue
        if (!byRepository.has(task.repository)) {
          const linked = await this.git.listWorktrees(task.repository)
          byRepository.set(task.repository, new Set(linked.map(item => canonicalKey(item.path))))
        }
      }
      await this.store.update(current => {
        const tasks = { ...current.tasks }
        for (const task of Object.values(current.tasks)) {
          if (task.phase === 'archived') continue
          const linked = byRepository.get(task.repository)?.has(canonicalKey(task.path)) === true
          if (!linked) {
            tasks[String(task.id)] = {
              ...task,
              phase: task.pendingOperation === 'archive' || task.pendingOperation === 'discard'
                ? 'archived'
                : 'orphaned',
              ...(task.pendingOperation === 'discard'
                ? { conclusion: 'discarded' as const }
                : task.pendingOperation === 'archive'
                  ? { conclusion: task.conclusion ?? 'archived' as const }
                  : {}),
              updatedAt: new Date().toISOString(),
              ...task.pendingOperation === undefined ? {} : { lastError: `interrupted ${task.pendingOperation} requires review` },
            }
            tasks[String(task.id)] = clearPendingOnly(tasks[String(task.id)] as TaskRecord)
            continue
          }
          if (task.pendingOperation === undefined) continue
          const recoverablePhase = task.pendingOperation === 'create'
            ? 'active'
            : task.pendingOperation === 'validate'
              ? 'blocked'
              : 'recovery-needed'
          tasks[String(task.id)] = clearPendingOnly({
            ...task,
            phase: recoverablePhase,
            updatedAt: new Date().toISOString(),
            lastError: `interrupted ${task.pendingOperation} requires review`,
          })
        }
        return { version: 1, tasks }
      })
      return await this.doctor()
    })
  }

  /** Report Git availability and persisted states that need attention. */
  async doctor(): Promise<DoctorView> {
    const state = await this.store.read()
    const pending = Object.values(state.tasks).filter(task => task.pendingOperation !== undefined).map(task => task.id)
    const orphaned = Object.values(state.tasks).filter(task => task.phase === 'orphaned').map(task => task.id)
    const recoveryNeeded = Object.values(state.tasks).filter(task => task.phase === 'recovery-needed').map(task => task.id)
    const problems = [
      ...pending.map(id => `task ${String(id)} has an interrupted operation`),
      ...orphaned.map(id => `task ${String(id)} is absent from Git worktree metadata`),
      ...recoveryNeeded.map(id => `task ${String(id)} requires manual recovery review`),
    ]
    return {
      gitVersion: await this.git.version(),
      statePath: this.options.statePath,
      pending,
      orphaned,
      recoveryNeeded,
      problems,
    }
  }

  /** Stop mutation admission and wait for the accepted operation to settle. */
  async close(): Promise<void> {
    this.admissionOpen = false
    this.lifecycle.abort(new StudioError('busy', 'worktree studio is closing'))
    await this.operationTail
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.admissionOpen) return Promise.reject(new StudioError('busy', 'worktree studio is closing'))
    const result = this.operationTail.then(() => this.store.exclusive(operation))
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async view(task: TaskRecord): Promise<TaskView> {
    if (!(await pathExists(task.path))) return missingView(task)
    try {
      const status = await this.git.status(task.path, task.baseCommit)
      const changeToken = tokenOf(task, status)
      const phase = task.phase === 'validated' && task.lastValidation?.changeToken !== changeToken
        ? 'active'
        : task.phase
      return {
        ...task,
        phase,
        headCommit: status.headCommit,
        currentBranch: status.branch,
        changes: status.changes,
        exists: true,
        changeToken,
        workspacePath: task.path,
      }
    } catch (error) {
      return {
        ...task,
        phase: task.phase === 'archived' ? 'archived' : 'recovery-needed',
        lastError: errorMessage(error),
        headCommit: null,
        currentBranch: null,
        changes: EMPTY_CHANGES,
        exists: true,
        changeToken: fallbackToken(task),
        workspacePath: task.path,
      }
    }
  }

  private async assertToken(task: TaskRecord, supplied: string): Promise<TaskView> {
    const current = await this.view(task)
    if (!current.exists) throw new StudioError('not-found', `task ${String(task.id)} has no linked worktree`)
    if (supplied !== current.changeToken) {
      throw new StudioError('state-conflict', 'task changed after it was inspected; refresh before retrying')
    }
    return current
  }

  private requireTask(state: StoreState, id: TaskId): TaskRecord {
    const task = state.tasks[String(id)]
    if (task === undefined) throw new StudioError('not-found', `unknown task ${String(id)}`)
    return task
  }

  private async insertTask(task: TaskRecord): Promise<void> {
    await this.store.update(state => {
      if (state.tasks[String(task.id)] !== undefined) throw new StudioError('state-conflict', `duplicate task id ${String(task.id)}`)
      return { version: 1, tasks: { ...state.tasks, [String(task.id)]: task } }
    })
  }

  private async replaceTask(id: TaskId, transform: (task: TaskRecord) => TaskRecord): Promise<void> {
    await this.store.update(state => {
      const current = this.requireTask(state, id)
      const next = transform(current)
      return { version: 1, tasks: { ...state.tasks, [String(id)]: next } }
    })
  }

  private async markRecovery(id: TaskId, operation: string, error: unknown): Promise<void> {
    await this.replaceTask(id, task => ({
      ...task,
      phase: 'recovery-needed',
      pendingOperation: operation,
      updatedAt: new Date().toISOString(),
      lastError: errorMessage(error),
    }))
  }
}

function normalizeTitle(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new StudioError('invalid-input', 'task title must contain 1 to 120 printable characters')
  }
  return normalized
}

function slug(value: string): string {
  const normalized = value.toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  return normalized === '' ? 'task' : normalized
}

function tokenOf(task: TaskRecord, status: GitStatus): string {
  return createHash('sha256')
    .update(String(task.id))
    .update('\0')
    .update(task.path)
    .update('\0')
    .update(status.fingerprint)
    .digest('hex')
}

function fallbackToken(task: TaskRecord): string {
  return createHash('sha256')
    .update(String(task.id))
    .update('\0')
    .update(task.updatedAt)
    .update('\0')
    .update(task.phase)
    .digest('hex')
}

function missingView(task: TaskRecord): TaskView {
  return {
    ...task,
    phase: task.phase === 'archived' ? 'archived' : 'orphaned',
    headCommit: null,
    currentBranch: null,
    changes: EMPTY_CHANGES,
    exists: false,
    changeToken: fallbackToken(task),
    workspacePath: task.path,
  }
}

function failedPreview(task: TaskRecord, targetPath: string | undefined, reason: string, sourceHead: string | null = null): MergePreview {
  return {
    canMerge: false,
    targetPath: targetPath ?? task.repository,
    targetHead: null,
    sourceHead,
    targetDirty: false,
    conflicts: [],
    reason,
  }
}

function clearTransient(task: TaskRecord): TaskRecord {
  const { pendingOperation: _pending, lastError: _error, ...stable } = task
  return stable
}

function clearPendingOnly(task: TaskRecord): TaskRecord {
  const { pendingOperation: _pending, ...stable } = task
  return stable
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function canonicalKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
