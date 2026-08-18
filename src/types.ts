/** Public data vocabulary for the worktree task lifecycle. */

/** Opaque identifier for one persisted task. */
export type TaskId = string & { readonly __taskId: unique symbol }

const TASK_ID_PATTERN = /^wt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Test whether a string is a canonical Worktree Studio UUID. */
export function isTaskId(value: string): value is TaskId {
  return TASK_ID_PATTERN.test(value)
}

/** Brand a validated task identifier. */
export function TaskId(value: string): TaskId {
  if (!isTaskId(value)) throw new TypeError('task id must be a canonical worktree-studio UUID')
  return value as TaskId
}

/** Lifecycle states stored for a task. */
export type TaskPhase =
  | 'creating'
  | 'active'
  | 'validated'
  | 'blocked'
  | 'delivered'
  | 'archived'
  | 'orphaned'
  | 'recovery-needed'

/** Durable terminal disposition retained after checkout removal. */
export type TaskConclusion = 'delivered' | 'archived' | 'discarded'

/** Counts derived from one Git status snapshot. */
export interface ChangeSummary {
  readonly dirty: boolean
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly commitsAhead: number
}

/** Last validation result recorded for a task. */
export interface ValidationResult {
  readonly command: readonly string[]
  readonly exitCode: number | null
  readonly signal?: string
  readonly timedOut: boolean
  readonly passed: boolean
  readonly startedAt: string
  readonly completedAt: string
  readonly stdout: string
  readonly stderr: string
  readonly changeToken: string
}

/** Persisted task record. Pending operations make restart recovery explicit. */
export interface TaskRecord {
  readonly id: TaskId
  readonly title: string
  readonly repository: string
  readonly commonDirectory: string
  readonly path: string
  readonly branch: string | null
  readonly baseCommit: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly phase: TaskPhase
  readonly conclusion?: TaskConclusion
  readonly validationCommand?: readonly string[]
  readonly pendingOperation?: string
  readonly lastValidation?: ValidationResult
  readonly lastError?: string
}

/** A task plus fresh Git state for the Web and command consumers. */
export interface TaskView extends TaskRecord {
  readonly headCommit: string | null
  readonly currentBranch: string | null
  readonly changes: ChangeSummary
  readonly exists: boolean
  readonly changeToken: string
  /** Path clients pass to the native Workspace registry after creation. */
  readonly workspacePath: string
}

/** Non-mutating review output bounded by the configured byte limit. */
export interface ReviewView {
  readonly summary: string
  readonly diff: string
  readonly untrackedPaths: readonly string[]
  readonly truncated: boolean
}

/** Result of checking a merge without changing the target checkout. */
export interface MergePreview {
  readonly canMerge: boolean
  readonly targetPath: string
  readonly targetHead: string | null
  readonly sourceHead: string | null
  readonly targetDirty: boolean
  readonly conflicts: readonly string[]
  readonly reason?: string
}

/** Dashboard projection for one repository or all known repositories. */
export interface DashboardView {
  readonly repository?: string
  readonly tasks: readonly TaskView[]
  readonly repositories: readonly string[]
}

/** Health report for durable state and pending operations. */
export interface DoctorView {
  readonly gitVersion: string
  readonly statePath: string
  readonly pending: readonly TaskId[]
  readonly orphaned: readonly TaskId[]
  readonly recoveryNeeded: readonly TaskId[]
  readonly problems: readonly string[]
}

/** Creation request accepted by the manager. */
export interface CreateTaskRequest {
  readonly repository: string
  readonly title: string
  readonly branch?: string
  readonly baseRef?: string
  readonly validationCommand?: readonly string[]
}

/** Mutation token required by every state-changing task operation. */
export interface TaskMutationRequest {
  readonly id: TaskId
  readonly changeToken: string
}

/** Manager contract used by Host adapters and tests. */
export interface WorktreeStudioManager {
  create(request: CreateTaskRequest): Promise<TaskView>
  dashboard(repository?: string): Promise<DashboardView>
  inspect(id: TaskId): Promise<{ readonly task: TaskView; readonly review: ReviewView }>
  previewMerge(id: TaskId, targetPath?: string): Promise<MergePreview>
  validate(id: TaskId, changeToken: string, command?: readonly string[]): Promise<TaskView>
  deliver(id: TaskId, changeToken: string, targetPath?: string): Promise<TaskView>
  archive(request: TaskMutationRequest): Promise<TaskView>
  discard(request: TaskMutationRequest, confirmation: string): Promise<TaskView>
  recover(): Promise<DoctorView>
  doctor(): Promise<DoctorView>
  close(): Promise<void>
}
