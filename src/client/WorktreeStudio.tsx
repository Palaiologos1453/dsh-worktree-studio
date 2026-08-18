import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  Button,
  IconArchiveOutline20,
  IconBranchOutline16,
  IconCheckOutline16,
  IconCloseOutline16,
  IconFolderOpenOutline16,
  IconInspectOutline12,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  Modal,
  RiskConfirmation,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DashboardView, MergePreview, ReviewView, TaskId, TaskView } from '../types.ts'
import type { StudioClientActions } from './api.ts'
import type { StudioLocaleKey } from './locales.ts'
import css from './WorktreeStudio.module.css'

/** Slot-composed launcher props. */
export type WorktreeStudioProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'worktreeStudio'>
  & InjectFace<StudioClientActions>

type Filter = 'active' | 'archived' | 'all'
type Confirmation = 'deliver' | 'archive' | 'discard'

interface CreateInput {
  readonly repository: string
  readonly title: string
  readonly branch?: string
  readonly baseRef?: string
  readonly validationCommand?: string
}

/** Sidebar action plus the full task-board modal. */
export function WorktreeStudio(props: WorktreeStudioProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label={() => props.t('launcher')} disabled={props.wide} delayMs={400}>
        <button
          type="button"
          className={css.launcher}
          aria-label={props.t('launcher')}
          onClick={() => { setOpen(true) }}
        >
          <IconBranchOutline16 size={props.wide ? 16 : 18} />
          {props.wide ? <span>{props.t('launcher')}</span> : null}
        </button>
      </Tooltip>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={props.t('title')}
        className={css.modal ?? ''}
        headless
      >
        <TaskBoard {...props} close={() => { setOpen(false) }} open={open} />
      </Modal>
    </>
  )
}

function TaskBoard({
  close,
  open,
  t,
  useSessions,
  useWorkspaces,
  loadDashboard,
  createTask,
  inspectTask,
  validateTask,
  previewTask,
  deliverTask,
  archiveTask,
  discardTask,
  recover,
  startTaskSession,
  openPath,
}: WorktreeStudioProps & { readonly close: () => void; readonly open: boolean }): ReactNode {
  const workspaces = useWorkspaces(state => state.items)
  const currentSession = useSessions(state => state.current)
  const currentCwd = useSessions(state => currentSession === undefined ? undefined : state.byId[currentSession]?.cwd)
  const [repository, setRepository] = useState<string>()
  const [dashboard, setDashboard] = useState<DashboardView>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [sessionError, setSessionError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState<TaskId>()
  const [filter, setFilter] = useState<Filter>('active')
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [review, setReview] = useState<{ readonly id: TaskId; readonly value: ReviewView }>()
  const [preview, setPreview] = useState<{ readonly id: TaskId; readonly value: MergePreview }>()
  const [validationDraft, setValidationDraft] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (!open || repository !== undefined) return
    setRepository(currentCwd ?? workspaces[0]?.path)
  }, [currentCwd, open, repository, workspaces])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    void loadDashboard(repository, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return
        setDashboard(value)
        setLoading(false)
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return
        setError(messageOf(reason))
        setLoading(false)
      },
    )
    return () => { controller.abort() }
  }, [loadDashboard, open, refresh, repository])

  const tasks = useMemo(() => (dashboard?.tasks ?? []).filter(task => {
    if (filter === 'all') return true
    const archived = task.phase === 'archived'
    return filter === 'archived' ? archived : !archived
  }), [dashboard, filter])
  const selected = (dashboard?.tasks ?? []).find(task => task.id === selectedId)

  useEffect(() => {
    if (selectedId !== undefined && tasks.some(task => task.id === selectedId)) return
    setSelectedId(tasks[0]?.id)
  }, [selectedId, tasks])

  useEffect(() => {
    setReview(undefined)
    setPreview(undefined)
    setValidationDraft(selected?.validationCommand?.map(quoteArg).join(' ') ?? '')
  }, [selected?.id])

  const reload = (): void => { setRefresh(value => value + 1) }
  const run = async <T,>(label: string, operation: () => Promise<T>, complete?: (value: T) => void): Promise<void> => {
    if (busy !== undefined) return
    setBusy(label)
    setError(undefined)
    setSessionError(false)
    try {
      const value = await operation()
      complete?.(value)
      reload()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const create = async (input: CreateInput): Promise<void> => {
    if (busy !== undefined) return
    setBusy('create')
    setError(undefined)
    setSessionError(false)
    try {
      const task = await createTask(input)
      setSelectedId(task.id)
      reload()
      try {
        await startTaskSession(task.workspacePath)
        close()
      } catch (reason) {
        setSessionError(true)
        setError(messageOf(reason))
      }
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const confirm = (): void => {
    if (selected === undefined || confirmation === undefined) return
    const action = confirmation
    setConfirmation(undefined)
    setAcknowledged(false)
    if (action === 'deliver') void run('deliver', () => deliverTask(selected))
    if (action === 'archive') void run('archive', () => archiveTask(selected))
    if (action === 'discard') void run('discard', () => discardTask(selected))
  }

  const confirmationCopy = confirmation === undefined ? undefined : confirmationText(confirmation, t)

  return (
    <div className={css.root}>
      <header className={css.header}>
        <div className={css.heading}>
          <IconBranchOutline16 size={18} aria-hidden="true" />
          <h2>{t('title')}</h2>
        </div>
        <label className={css.repositoryPicker}>
          <span>{t('repository')}</span>
          <select
            value={repository ?? ''}
            onChange={(event) => {
              setRepository(event.currentTarget.value || undefined)
              setSelectedId(undefined)
            }}
          >
            <option value="">{t('allRepositories')}</option>
            {workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.path}>{workspace.title}</option>
            ))}
          </select>
        </label>
        <div className={css.headerActions}>
          <Tooltip label={t('recover')} side="bottom">
            <button
              type="button"
              className={css.iconButton}
              disabled={busy !== undefined}
              aria-label={t('recover')}
              onClick={() => { void run('recover', recover) }}
            >
              <IconWarningOutline16 size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t('refresh')} side="bottom">
            <button type="button" className={css.iconButton} aria-label={t('refresh')} onClick={reload}>
              <IconRefreshOutline16 size={16} />
            </button>
          </Tooltip>
          <button type="button" className={css.iconButton} aria-label={t('close')} onClick={close}>
            <IconCloseOutline16 size={16} />
          </button>
        </div>
      </header>

      <div className={css.body}>
        <aside className={css.sidebar}>
          <div className={css.sidebarTop}>
            <strong>{t('taskList')}</strong>
            <Button
              size="sm"
              variant="toolbar"
              icon={<IconPlusOutline16 size={14} />}
              onClick={() => { setCreateOpen(true) }}
            >
              {t('createTask')}
            </Button>
          </div>
          <div className={css.filters} role="group" aria-label={t('taskList')}>
            {(['active', 'archived', 'all'] as const).map(value => (
              <button
                type="button"
                key={value}
                data-selected={filter === value ? 'true' : undefined}
                onClick={() => { setFilter(value) }}
              >
                {t(value)}
              </button>
            ))}
          </div>
          <div className={css.taskList} aria-busy={loading}>
            {loading ? <p className={css.empty}>{t('loading')}</p> : null}
            {!loading && tasks.length === 0 ? <p className={css.empty}>{t('empty')}</p> : null}
            {tasks.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                selected={task.id === selected?.id}
                t={t}
                onSelect={() => { setSelectedId(task.id); setCreateOpen(false) }}
              />
            ))}
          </div>
        </aside>

        <main className={css.content}>
          {error !== undefined ? (
            <div className={css.error} role="alert">
              <IconWarningOutline16 size={16} />
              <span>{sessionError ? `${t('sessionError')} ${error}` : error}</span>
            </div>
          ) : null}
          {createOpen ? (
            <CreateTaskForm
              repository={repository ?? workspaces[0]?.path}
              busy={busy === 'create'}
              t={t}
              onCancel={() => { setCreateOpen(false) }}
              onCreate={(input) => { void create(input) }}
            />
          ) : selected === undefined ? (
            <div className={css.blank}>{t('emptySelection')}</div>
          ) : (
            <TaskDetails
              task={selected}
              review={review?.id === selected.id ? review.value : undefined}
              preview={preview?.id === selected.id ? preview.value : undefined}
              validationDraft={validationDraft}
              busy={busy}
              t={t}
              onValidationDraft={setValidationDraft}
              onReview={() => {
                void run('review', () => inspectTask(selected.id), value => {
                  setReview({ id: selected.id, value: value.review })
                })
              }}
              onValidate={() => {
                void run('validate', () => validateTask(selected, validationDraft.trim() || undefined))
              }}
              onPreview={() => {
                void run('preview', () => previewTask(selected), value => {
                  setPreview({ id: selected.id, value })
                })
              }}
              onDeliver={() => { setConfirmation('deliver'); setAcknowledged(false) }}
              onArchive={() => { setConfirmation('archive'); setAcknowledged(false) }}
              onDiscard={() => { setConfirmation('discard'); setAcknowledged(false) }}
              onSession={() => {
                void run('session', () => startTaskSession(selected.workspacePath), close)
              }}
              onFolder={() => { void run('folder', () => openPath(selected.workspacePath)) }}
            />
          )}
        </main>
      </div>

      {confirmationCopy !== undefined ? (
        <RiskConfirmation
          open
          title={confirmationCopy.title}
          description={confirmationCopy.description}
          acknowledgeLabel={t('confirmation')}
          cancelLabel={t('cancel')}
          confirmLabel={confirmationCopy.action}
          acknowledged={acknowledged}
          disabled={busy !== undefined}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => { setConfirmation(undefined); setAcknowledged(false) }}
          onConfirm={confirm}
        />
      ) : null}
    </div>
  )
}

function TaskRow({
  task,
  selected,
  t,
  onSelect,
}: {
  readonly task: TaskView
  readonly selected: boolean
  readonly t: WorktreeStudioProps['t']
  readonly onSelect: () => void
}): ReactNode {
  const pending = task.changes.staged + task.changes.unstaged + task.changes.untracked
  return (
    <button
      type="button"
      className={css.taskRow}
      data-selected={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className={css.stateDot} data-phase={task.phase} aria-hidden="true" />
      <span className={css.taskText}>
        <strong>{task.title}</strong>
        <small>{task.currentBranch ?? task.branch ?? task.phase}</small>
      </span>
      <span className={css.taskCounts}>{task.changes.commitsAhead}/{pending}</span>
      <span className={css.visuallyHidden}>{t(task.exists ? (task.changes.dirty ? 'dirty' : 'clean') : 'missing')}</span>
    </button>
  )
}

function CreateTaskForm({
  repository,
  busy,
  t,
  onCancel,
  onCreate,
}: {
  readonly repository: string | undefined
  readonly busy: boolean
  readonly t: WorktreeStudioProps['t']
  readonly onCancel: () => void
  readonly onCreate: (input: CreateInput) => void
}): ReactNode {
  const [title, setTitle] = useState('')
  const [branch, setBranch] = useState('')
  const [baseRef, setBaseRef] = useState('HEAD')
  const [validationCommand, setValidationCommand] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (repository === undefined || title.trim() === '') return
    onCreate({
      repository,
      title: title.trim(),
      ...(branch.trim() === '' ? {} : { branch: branch.trim() }),
      ...(baseRef.trim() === '' ? {} : { baseRef: baseRef.trim() }),
      ...(validationCommand.trim() === '' ? {} : { validationCommand: validationCommand.trim() }),
    })
  }
  return (
    <form className={css.createForm} onSubmit={submit}>
      <div className={css.sectionHeading}>
        <IconPlusOutline16 size={16} />
        <h3>{t('createTask')}</h3>
      </div>
      <label>
        <span>{t('taskTitle')}</span>
        <input autoFocus maxLength={120} value={title} onChange={event => { setTitle(event.currentTarget.value) }} />
      </label>
      <div className={css.formGrid}>
        <label>
          <span>{t('branch')}</span>
          <input value={branch} placeholder={t('branchPlaceholder')} onChange={event => { setBranch(event.currentTarget.value) }} />
        </label>
        <label>
          <span>{t('baseRef')}</span>
          <input value={baseRef} onChange={event => { setBaseRef(event.currentTarget.value) }} />
        </label>
      </div>
      <label>
        <span>{t('validationCommand')}</span>
        <input value={validationCommand} placeholder={t('validationPlaceholder')} onChange={event => { setValidationCommand(event.currentTarget.value) }} />
      </label>
      <code className={css.repositoryPath}>{repository ?? t('allRepositories')}</code>
      <div className={css.formActions}>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button
          variant="primary"
          icon={<IconPlusOutline16 size={15} />}
          disabled={busy || repository === undefined || title.trim() === ''}
          type="submit"
        >
          {t('createAndOpen')}
        </Button>
      </div>
    </form>
  )
}

function TaskDetails({
  task,
  review,
  preview,
  validationDraft,
  busy,
  t,
  onValidationDraft,
  onReview,
  onValidate,
  onPreview,
  onDeliver,
  onArchive,
  onDiscard,
  onSession,
  onFolder,
}: {
  readonly task: TaskView
  readonly review: ReviewView | undefined
  readonly preview: MergePreview | undefined
  readonly validationDraft: string
  readonly busy: string | undefined
  readonly t: WorktreeStudioProps['t']
  readonly onValidationDraft: (value: string) => void
  readonly onReview: () => void
  readonly onValidate: () => void
  readonly onPreview: () => void
  readonly onDeliver: () => void
  readonly onArchive: () => void
  readonly onDiscard: () => void
  readonly onSession: () => void
  readonly onFolder: () => void
}): ReactNode {
  const validated = task.lastValidation?.passed === true && task.lastValidation.changeToken === task.changeToken
  const mergeReady = preview?.canMerge === true && preview.sourceHead === task.headCommit
  const pending = task.changes.staged + task.changes.unstaged + task.changes.untracked
  return (
    <div className={css.details}>
      <div className={css.detailHeader}>
        <div className={css.detailTitle}>
          <span className={css.stateDot} data-phase={task.phase} aria-hidden="true" />
          <div>
            <h3>{task.title}</h3>
            <span>{task.currentBranch ?? task.branch ?? task.phase}</span>
          </div>
        </div>
        <div className={css.detailActions}>
          <Tooltip label={t('openFolder')} side="bottom">
            <button type="button" className={css.iconButton} aria-label={t('openFolder')} disabled={busy !== undefined} onClick={onFolder}>
              <IconFolderOpenOutline16 size={16} />
            </button>
          </Tooltip>
          <Button size="sm" variant="outline" icon={<IconPlayOutline16 size={14} />} disabled={busy !== undefined || !task.exists} onClick={onSession}>
            {t('openSession')}
          </Button>
        </div>
      </div>

      <dl className={css.metadata}>
        <div><dt>{t('path')}</dt><dd><code>{task.path}</code></dd></div>
        <div><dt>{t('base')}</dt><dd><code>{short(task.baseCommit)}</code></dd></div>
        <div><dt>{t('head')}</dt><dd><code>{short(task.headCommit)}</code></dd></div>
      </dl>

      <div className={css.metrics}>
        <Metric value={task.changes.commitsAhead} label={t('commits')} />
        <Metric value={task.changes.staged} label={t('staged')} />
        <Metric value={task.changes.unstaged} label={t('unstaged')} />
        <Metric value={task.changes.untracked} label={t('untracked')} />
      </div>

      <div className={css.workflowBar}>
        <Button size="sm" variant="outline" icon={<IconInspectOutline12 size={13} />} disabled={busy !== undefined || !task.exists} onClick={onReview}>
          {t('review')}
        </Button>
        <Button size="sm" variant="outline" icon={<IconCheckOutline16 size={14} />} disabled={busy !== undefined || !task.exists || validationDraft.trim() === ''} onClick={onValidate}>
          {t('validate')}
        </Button>
        <Button size="sm" variant="outline" icon={<IconBranchOutline16 size={14} />} disabled={busy !== undefined || !task.exists || task.changes.dirty || task.changes.commitsAhead === 0} onClick={onPreview}>
          {t('preview')}
        </Button>
        <Button size="sm" variant="primary" icon={<IconBranchOutline16 size={14} />} disabled={busy !== undefined || !mergeReady || !validated} onClick={onDeliver}>
          {t('deliver')}
        </Button>
        <span className={css.workflowSpacer} />
        <Tooltip label={t('archive')} side="bottom">
          <button type="button" className={css.iconButton} aria-label={t('archive')} disabled={busy !== undefined || pending > 0 || !task.exists} onClick={onArchive}>
            <IconArchiveOutline20 size={16} />
          </button>
        </Tooltip>
        <Tooltip label={t('discard')} side="bottom">
          <button type="button" className={css.dangerButton} aria-label={t('discard')} disabled={busy !== undefined || !task.exists} onClick={onDiscard}>
            <IconTrashOutline16 size={16} />
          </button>
        </Tooltip>
      </div>

      <label className={css.validationCommand}>
        <span>{t('validationCommand')}</span>
        <input value={validationDraft} placeholder={t('validationPlaceholder')} onChange={event => { onValidationDraft(event.currentTarget.value) }} />
      </label>

      <div className={css.resultBands}>
        <StatusBand
          state={validated ? 'success' : task.lastValidation === undefined ? 'neutral' : 'error'}
          title={t('lastValidation')}
          text={task.lastValidation === undefined
            ? t('noValidation')
            : task.lastValidation.timedOut ? t('timedOut') : t(task.lastValidation.passed ? 'passed' : 'failed')}
        />
        {preview !== undefined ? (
          <StatusBand
            state={preview.canMerge ? 'success' : 'error'}
            title={t(preview.canMerge ? 'mergeReady' : 'mergeBlocked')}
            text={preview.reason ?? `${short(preview.sourceHead)} -> ${short(preview.targetHead)}`}
          />
        ) : null}
        {task.lastError !== undefined ? <StatusBand state="error" title={t('lastError')} text={task.lastError} /> : null}
      </div>

      {review !== undefined ? (
        <section className={css.outputSection}>
          <div className={css.outputHeading}><h4>{t('diff')}</h4>{review.truncated ? <span>{t('truncated')}</span> : null}</div>
          {review.summary.trim() !== '' ? <pre className={css.summary}>{review.summary}</pre> : null}
          <pre className={css.diff}>{review.diff || t('noOutput')}</pre>
          {review.untrackedPaths.length > 0 ? (
            <div className={css.untracked}><strong>{t('untrackedFiles')}</strong><code>{review.untrackedPaths.join('\n')}</code></div>
          ) : null}
        </section>
      ) : null}

      {task.lastValidation !== undefined ? (
        <section className={css.outputSection}>
          <div className={css.outputHeading}><h4>{t('validationOutput')}</h4></div>
          <Output label={t('stdout')} value={task.lastValidation.stdout} empty={t('noOutput')} />
          <Output label={t('stderr')} value={task.lastValidation.stderr} empty={t('noOutput')} />
        </section>
      ) : null}

      {preview !== undefined && preview.conflicts.length > 0 ? (
        <section className={css.outputSection}>
          <div className={css.outputHeading}><h4>{t('conflicts')}</h4></div>
          <code className={css.conflicts}>{preview.conflicts.join('\n')}</code>
        </section>
      ) : null}
    </div>
  )
}

function Metric({ value, label }: { readonly value: number; readonly label: string }): ReactNode {
  return <div><strong>{value}</strong><span>{label}</span></div>
}

function StatusBand({ state, title, text }: { readonly state: 'success' | 'error' | 'neutral'; readonly title: string; readonly text: string }): ReactNode {
  return <div className={css.statusBand} data-state={state}><strong>{title}</strong><span>{text}</span></div>
}

function Output({ label, value, empty }: { readonly label: string; readonly value: string; readonly empty: string }): ReactNode {
  return <div className={css.output}><strong>{label}</strong><pre>{value.trim() || empty}</pre></div>
}

function short(value: string | null): string {
  return value === null ? '-' : value.slice(0, 10)
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : JSON.stringify(value)
}

function confirmationText(kind: Confirmation, t: WorktreeStudioProps['t']): {
  readonly title: string
  readonly description: string
  readonly action: string
} {
  const keys: Record<Confirmation, readonly [StudioLocaleKey, StudioLocaleKey, StudioLocaleKey]> = {
    deliver: ['confirmDeliverTitle', 'confirmDeliverDescription', 'confirmDeliverAction'],
    archive: ['confirmArchiveTitle', 'confirmArchiveDescription', 'confirmArchiveAction'],
    discard: ['confirmDiscardTitle', 'confirmDiscardDescription', 'confirmDiscardAction'],
  }
  const [title, description, action] = keys[kind]
  return { title: t(title), description: t(description), action: t(action) }
}
