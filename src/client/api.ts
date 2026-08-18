/** Typed fetch adapter for the loopback Host route. */

import type {
  DashboardView,
  DoctorView,
  MergePreview,
  ReviewView,
  TaskId,
  TaskView,
} from '../types.ts'

const ROUTE = '/api/dsh-worktree-studio'

interface ErrorEnvelope {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

interface SuccessEnvelope<T> {
  readonly ok: true
  readonly value: T
}

/** Client callbacks exposed to the component through the slot inject face. */
export interface StudioClientActions {
  loadDashboard(repository?: string, signal?: AbortSignal): Promise<DashboardView>
  createTask(input: {
    readonly repository: string
    readonly title: string
    readonly branch?: string
    readonly baseRef?: string
    readonly validationCommand?: string
  }): Promise<TaskView>
  inspectTask(id: TaskId): Promise<{ readonly task: TaskView; readonly review: ReviewView }>
  validateTask(task: TaskView, command?: string): Promise<TaskView>
  previewTask(task: TaskView): Promise<MergePreview>
  deliverTask(task: TaskView): Promise<TaskView>
  archiveTask(task: TaskView): Promise<TaskView>
  discardTask(task: TaskView): Promise<TaskView>
  recover(): Promise<DoctorView>
  startTaskSession(path: string): Promise<void>
  openPath(path: string): Promise<void>
}

/** Load the dashboard with an abortable GET. */
export async function loadDashboard(repository?: string, signal?: AbortSignal): Promise<DashboardView> {
  const query = repository === undefined ? '' : `?repository=${encodeURIComponent(repository)}`
  return await request<DashboardView>(`${ROUTE}${query}`, undefined, signal)
}

/** Post one operation and unwrap the stable envelope. */
export async function post<T>(body: Record<string, unknown>): Promise<T> {
  return await request<T>(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function request<T>(url: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) })
  let envelope: SuccessEnvelope<T> | ErrorEnvelope
  try {
    envelope = await response.json() as SuccessEnvelope<T> | ErrorEnvelope
  } catch {
    throw new Error(`worktree-studio request failed (${String(response.status)})`)
  }
  if (!response.ok || !envelope.ok) {
    const failure = envelope as ErrorEnvelope
    throw new Error(`${failure.error.code}: ${failure.error.message}`)
  }
  return envelope.value
}

