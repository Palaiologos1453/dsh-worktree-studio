// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement } = await import('react')
  const Icon = (): ReactNode => createElement('span', { 'aria-hidden': 'true' })
  return {
    Button: ({ icon, children, ...rest }: { readonly icon?: ReactNode; readonly children?: ReactNode } & Record<string, unknown>) =>
      createElement('button', { type: 'button', ...rest }, icon, children),
    Tooltip: ({ children }: { readonly children: ReactNode }) => children,
    Modal: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) => open ? children : null,
    RiskConfirmation: ({
      title, acknowledgeLabel, cancelLabel, confirmLabel, acknowledged,
      onAcknowledgedChange, onCancel, onConfirm,
    }: {
      readonly title: string
      readonly acknowledgeLabel: string
      readonly cancelLabel: string
      readonly confirmLabel: string
      readonly acknowledged: boolean
      readonly onAcknowledgedChange: (value: boolean) => void
      readonly onCancel: () => void
      readonly onConfirm: () => void
    }) => createElement('div', { role: 'dialog', 'aria-label': title },
      createElement('label', null,
        createElement('input', {
          type: 'checkbox',
          checked: acknowledged,
          onChange: (event: { currentTarget: { checked: boolean } }) => { onAcknowledgedChange(event.currentTarget.checked) },
        }),
        acknowledgeLabel,
      ),
      createElement('button', { type: 'button', onClick: onCancel }, cancelLabel),
      createElement('button', { type: 'button', disabled: !acknowledged, onClick: onConfirm }, confirmLabel),
    ),
    IconArchiveOutline20: Icon,
    IconBranchOutline16: Icon,
    IconCheckOutline16: Icon,
    IconCloseOutline16: Icon,
    IconFolderOpenOutline16: Icon,
    IconInspectOutline12: Icon,
    IconPlayOutline16: Icon,
    IconPlusOutline16: Icon,
    IconRefreshOutline16: Icon,
    IconTrashOutline16: Icon,
    IconWarningOutline16: Icon,
  }
})

import { WorktreeStudio, type WorktreeStudioProps } from '../src/client/WorktreeStudio.tsx'
import { en, type StudioLocaleKey } from '../src/client/locales.ts'
import { TaskId, type DashboardView, type TaskView } from '../src/types.ts'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'

afterEach(() => { cleanup() })

const task = (): TaskView => ({
  id: TaskId('wt-11111111-1111-4111-8111-111111111111'),
  title: 'Improve checkout flow',
  repository: 'C:\\repo',
  commonDirectory: 'C:\\repo\\.git',
  path: 'C:\\worktrees\\checkout-flow',
  workspacePath: 'C:\\worktrees\\checkout-flow',
  branch: 'dsh/checkout-flow',
  currentBranch: 'dsh/checkout-flow',
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:01:00.000Z',
  phase: 'validated',
  validationCommand: ['pnpm', 'test'],
  lastValidation: {
    command: ['pnpm', 'test'],
    exitCode: 0,
    timedOut: false,
    passed: true,
    startedAt: '2026-08-19T00:00:10.000Z',
    completedAt: '2026-08-19T00:00:12.000Z',
    stdout: '8 tests passed',
    stderr: '',
    changeToken: 'c'.repeat(64),
  },
  changes: { dirty: false, staged: 0, unstaged: 0, untracked: 0, commitsAhead: 1 },
  exists: true,
  changeToken: 'c'.repeat(64),
})

function dashboard(tasks: readonly TaskView[]): DashboardView {
  return { repository: 'C:\\repo', repositories: ['C:\\repo'], tasks }
}

function props(overrides: Partial<WorktreeStudioProps> = {}): WorktreeStudioProps {
  const empty = dashboard([])
  const workspaceState = {
    items: [{
      workspaceId: 'workspace-1',
      path: 'C:\\repo',
      title: 'repo',
      sessionIds: [],
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    }],
    archivedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
    baselinesReady: true,
    recentWorkspaceId: 'workspace-1',
  } as unknown as WorkspaceListState
  const sessionState = {
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    error: null,
  } as unknown as SessionListState
  return {
    wide: true,
    t: ((key: StudioLocaleKey) => en[key]) as WorktreeStudioProps['t'],
    useWorkspaces: ((selector: (state: WorkspaceListState) => unknown) => selector(workspaceState)) as WorktreeStudioProps['useWorkspaces'],
    useSessions: ((selector: (state: SessionListState) => unknown) => selector(sessionState)) as WorktreeStudioProps['useSessions'],
    loadDashboard: vi.fn().mockResolvedValue(empty),
    createTask: vi.fn(),
    inspectTask: vi.fn(),
    validateTask: vi.fn(),
    previewTask: vi.fn(),
    deliverTask: vi.fn(),
    archiveTask: vi.fn(),
    discardTask: vi.fn(),
    recover: vi.fn(),
    startTaskSession: vi.fn(),
    openPath: vi.fn(),
    ...overrides,
  } as unknown as WorktreeStudioProps
}

describe('WorktreeStudio', () => {
  it('creates a task and opens its native DSH workspace session', async () => {
    const created = task()
    const createTask = vi.fn().mockResolvedValue(created)
    const startTaskSession = vi.fn().mockResolvedValue(undefined)
    render(<WorktreeStudio {...props({ createTask, startTaskSession })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Worktree tasks' }))
    await screen.findByRole('heading', { name: 'Worktree Studio' })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Improve checkout flow' } })
    fireEvent.change(screen.getByLabelText('Validation command'), { target: { value: 'pnpm test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create and open session' }))

    await waitFor(() => {
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        repository: 'C:\\repo',
        title: 'Improve checkout flow',
        validationCommand: 'pnpm test',
      }))
      expect(startTaskSession).toHaveBeenCalledWith(created.workspacePath)
    })
  })

  it('requires a passing merge check and explicit acknowledgement before delivery', async () => {
    const selected = task()
    const loadDashboard = vi.fn().mockResolvedValue(dashboard([selected]))
    const previewTask = vi.fn().mockResolvedValue({
      canMerge: true,
      targetPath: selected.repository,
      targetHead: 'd'.repeat(40),
      sourceHead: selected.headCommit,
      targetDirty: false,
      conflicts: [],
    })
    const deliverTask = vi.fn().mockResolvedValue({ ...selected, phase: 'delivered' })
    render(<WorktreeStudio {...props({ loadDashboard, previewTask, deliverTask })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Worktree tasks' }))
    await screen.findByText(selected.title)
    const deliver = screen.getByRole('button', { name: 'Deliver' })
    expect((deliver as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Merge check' }))
    await screen.findByText('Merge check passed')
    expect((deliver as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(deliver)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I reviewed the current task and target state.' }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge task' }))

    await waitFor(() => { expect(deliverTask).toHaveBeenCalledWith(selected) })
  })
})
