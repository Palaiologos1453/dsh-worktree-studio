/** Durable, lock-coordinated task records. */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { StudioError } from './errors.ts'
import { TaskId, isTaskId, type TaskConclusion, type TaskRecord, type TaskPhase, type ValidationResult } from './types.ts'

const FORMAT_VERSION = 1

/** On-disk state format. Unknown fields are ignored only after required fields validate. */
export interface StoreState {
  readonly version: 1
  readonly tasks: Readonly<Record<string, TaskRecord>>
}

/** File-backed task store with an atomic read-modify-write operation. */
export class TaskStore {
  /**
   * @param filename - Private JSON state file.
   */
  constructor(readonly filename: string) {}

  /** Load the current state or return an initialized empty document. */
  async read(): Promise<StoreState> {
    try {
      const text = await readFile(this.filename, 'utf8')
      return parseState(JSON.parse(text) as unknown)
    } catch (error) {
      if (isMissing(error)) return emptyState()
      if (error instanceof StudioError) throw error
      throw new StudioError('recovery-required', `cannot read task state: ${error instanceof Error ? error.message : String(error)}`, 409, { cause: error })
    }
  }

  /** Replace the complete state while retaining owner-only permissions. */
  async write(state: StoreState): Promise<void> {
    await writeFileAtomic(this.filename, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  /** Serialize a cross-process read/modify/write cycle. */
  async update(mutator: (state: StoreState) => StoreState | Promise<StoreState>): Promise<StoreState> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    return await withFileLock(this.filename, async () => {
      const current = await this.read()
      const next = parseState(await mutator(current))
      await this.write(next)
      return next
    })
  }

  /** Hold one cross-process mutation lease across Git and state operations. */
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    try {
      return await withFileLock(`${this.filename}.operations`, operation)
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out waiting for the writer lock')) {
        throw new StudioError('busy', 'another worktree-studio process is changing task state')
      }
      throw error
    }
  }
}

/** Build the versioned empty document. */
function emptyState(): StoreState {
  return { version: FORMAT_VERSION, tasks: {} }
}

/** Parse and validate the durable JSON boundary. */
function parseState(value: unknown): StoreState {
  if (!isRecord(value) || value.version !== FORMAT_VERSION || !isRecord(value.tasks)) {
    throw new StudioError('recovery-required', 'task state has an unsupported or corrupt format')
  }
  const tasks: Record<string, TaskRecord> = {}
  for (const [key, raw] of Object.entries(value.tasks)) {
    const task = parseTask(raw)
    if (key !== String(task.id)) throw new StudioError('recovery-required', `task state key does not match task id ${key}`)
    tasks[key] = task
  }
  return { version: FORMAT_VERSION, tasks }
}

/** Validate one task record and preserve only the documented fields. */
function parseTask(value: unknown): TaskRecord {
  if (!isRecord(value)) throw new StudioError('recovery-required', 'task state contains a non-object task')
  const id = stringField(value, 'id')
  if (!isTaskId(id)) throw new StudioError('recovery-required', `task state contains an invalid task id ${id}`)
  const phase = stringField(value, 'phase')
  if (!isTaskPhase(phase)) throw new StudioError('recovery-required', `task ${id} has an unknown phase`)
  const base: TaskRecord = {
    id: TaskId(id),
    title: stringField(value, 'title'),
    repository: stringField(value, 'repository'),
    commonDirectory: stringField(value, 'commonDirectory'),
    path: stringField(value, 'path'),
    branch: nullableString(value, 'branch'),
    baseCommit: stringField(value, 'baseCommit'),
    createdAt: stringField(value, 'createdAt'),
    updatedAt: stringField(value, 'updatedAt'),
    phase,
    ...(value.conclusion === undefined ? {} : { conclusion: parseConclusion(value.conclusion) }),
    ...(value.validationCommand === undefined
      ? {}
      : { validationCommand: stringArray(value.validationCommand, 'validationCommand') }),
    ...(optionalString(value, 'pendingOperation') === undefined
      ? {}
      : { pendingOperation: optionalString(value, 'pendingOperation') as string }),
    ...(optionalString(value, 'lastError') === undefined
      ? {}
      : { lastError: optionalString(value, 'lastError') as string }),
    ...(value.lastValidation === undefined ? {} : { lastValidation: parseValidation(value.lastValidation) }),
  }
  return base
}

/** Validate a persisted validation result. */
function parseValidation(value: unknown): ValidationResult {
  if (!isRecord(value) || !Array.isArray(value.command) || value.command.some(item => typeof item !== 'string')) {
    throw new StudioError('recovery-required', 'task state contains an invalid validation result')
  }
  const exitCode = value.exitCode
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) {
    throw new StudioError('recovery-required', 'validation exitCode is invalid')
  }
  return {
    command: [...value.command] as string[],
    exitCode,
    ...(optionalString(value, 'signal') === undefined ? {} : { signal: optionalString(value, 'signal') as string }),
    timedOut: booleanField(value, 'timedOut'),
    passed: booleanField(value, 'passed'),
    startedAt: stringField(value, 'startedAt'),
    completedAt: stringField(value, 'completedAt'),
    stdout: stringValue(value, 'stdout'),
    stderr: stringValue(value, 'stderr'),
    changeToken: stringField(value, 'changeToken'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new StudioError('recovery-required', `task state field ${key} is invalid`)
  return field
}

function stringValue(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new StudioError('recovery-required', `task state field ${key} is invalid`)
  return field
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string') throw new StudioError('recovery-required', `task state field ${key} is invalid`)
  return field
}

function nullableString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  if (field === null) return null
  if (typeof field !== 'string') throw new StudioError('recovery-required', `task state field ${key} is invalid`)
  return field
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new StudioError('recovery-required', `task state field ${key} is invalid`)
  return field
}

function stringArray(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new StudioError('recovery-required', `task state field ${key} is invalid`)
  }
  return [...value] as string[]
}

function isTaskPhase(value: string): value is TaskPhase {
  return value === 'creating' || value === 'active' || value === 'validated'
    || value === 'blocked' || value === 'delivered' || value === 'archived'
    || value === 'orphaned' || value === 'recovery-needed'
}

function parseConclusion(value: unknown): TaskConclusion {
  if (value === 'delivered' || value === 'archived' || value === 'discarded') return value
  throw new StudioError('recovery-required', 'task state contains an invalid conclusion')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}
