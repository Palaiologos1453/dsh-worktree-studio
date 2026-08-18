/** Browser plugin: sidebar launcher and session-linked task board. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MergePreview, TaskId, TaskView } from '../types.ts'
import { loadDashboard, post, type StudioClientActions } from './api.ts'
import { WorktreeStudio } from './WorktreeStudio.tsx'
import { en, zh, type StudioLocaleKey } from './locales.ts'

export type { StudioClientActions } from './api.ts'
export type { WorktreeStudioProps } from './WorktreeStudio.tsx'
export type { StudioLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Worktree task lifecycle copy. */
    worktreeStudio: StudioLocaleKey
  }
}

const NS = 'worktreeStudio'

/** Client services and slot declarations required by the task board. */
export const inject = ['slots', 'locale', 'workspaces']

/** Register localized callbacks and the sidebar footer contribution. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-worktree-studio: dictionaries')

  const actions: StudioClientActions = {
    loadDashboard,
    createTask: input => post<TaskView>({ operation: 'create', ...input }),
    inspectTask: id => post({ operation: 'inspect', id }),
    validateTask: (task, command) => post<TaskView>({
      operation: 'validate',
      id: task.id,
      changeToken: task.changeToken,
      ...(command === undefined ? {} : { validationCommand: command }),
    }),
    previewTask: task => post<MergePreview>({ operation: 'preview', id: task.id }),
    deliverTask: task => post<TaskView>({
      operation: 'deliver',
      id: task.id,
      changeToken: task.changeToken,
    }),
    archiveTask: task => post<TaskView>({
      operation: 'archive',
      id: task.id,
      changeToken: task.changeToken,
    }),
    discardTask: task => post<TaskView>({
      operation: 'discard',
      id: task.id,
      changeToken: task.changeToken,
      confirmation: task.id,
    }),
    recover: () => post({ operation: 'recover' }),
    async startTaskSession(path) {
      const workspace = await ctx.workspaces.create({ path })
      ctx.workspaces.startSession(workspace.workspaceId)
    },
    openPath: path => ctx.workspaces.openPath(path),
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'worktree-studio',
    order: 20,
    locale: NS,
    inject: (): StudioClientActions => actions,
  }, WorktreeStudio))
}

