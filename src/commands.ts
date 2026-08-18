/** Human command adapter for worktree-studio. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import stringArgv from 'string-argv'
import { errorMessage } from './errors.ts'
import { TaskId, isTaskId, type TaskView, type WorktreeStudioManager } from './types.ts'
import type {} from './index.ts'

export const name = 'dsh-worktree-studio-commands'
export const inject = ['commands', 'worktreeStudio']

const USAGE = 'Usage: /worktree-studio list | create <title> | inspect <id> | validate <id> <command...> | preview <id> | deliver <id> | archive <id> | recover'

/** Register the conflict-free `/worktree-studio` command. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'worktree-studio',
    description: 'manage isolated Git worktree tasks',
    input: { hint: 'list | create <title> | inspect <id> | validate <id> <command...> | preview <id> | deliver <id> | archive <id> | recover' },
    recordInput: false,
    handler: invocation => execute(ctx.worktreeStudio, invocation),
  }), 'dsh-worktree-studio: command')
}

/** Parse and execute one command without sending it to the model. */
async function execute(manager: WorktreeStudioManager, invocation: CommandInvocation): Promise<CommandResult> {
  try {
    const raw = invocation.rawInput.trim()
    const args = raw === '' ? ['list'] : stringArgv(raw)
    const verb = args[0]
    if (verb === 'list') {
      const cwd = invocation.agent.session.header.cwd
      const dashboard = await manager.dashboard(cwd)
      return {
        kind: 'success',
        text: dashboard.tasks.length === 0
          ? 'No worktree-studio tasks for this repository.'
          : dashboard.tasks.map(formatTask).join('\n'),
      }
    }
    if (verb === 'recover') {
      const report = await manager.recover()
      return { kind: 'success', text: report.problems.length === 0 ? 'Recovery check completed: no problems.' : report.problems.join('\n') }
    }
    if (verb === 'create') {
      const cwd = requireCwd(invocation)
      const title = args.slice(1).join(' ').trim()
      if (title === '') return { kind: 'error', text: `Task title is required. ${USAGE}` }
      const task = await manager.create({ repository: cwd, title })
      return { kind: 'success', text: `Created ${formatTask(task)}\nOpen workspace: ${task.workspacePath}` }
    }
    const id = parseTaskId(args[1])
    if (verb === 'inspect') {
      const result = await manager.inspect(id)
      const summary = result.review.summary.trim() || 'No committed or working-tree diff.'
      return { kind: 'success', text: `${formatTask(result.task)}\n${summary}` }
    }
    if (verb === 'preview') {
      const preview = await manager.previewMerge(id, invocation.agent.session.header.cwd)
      return {
        kind: preview.canMerge ? 'success' : 'error',
        text: preview.canMerge
          ? `Merge preview passed: ${preview.sourceHead ?? '?'} -> ${preview.targetHead ?? '?'}`
          : `Merge preview stopped: ${preview.reason ?? 'unknown reason'}${preview.conflicts.length === 0 ? '' : `\n${preview.conflicts.join('\n')}`}`,
      }
    }
    const current = await findCurrent(manager, id)
    if (verb === 'validate') {
      const command = args.slice(2)
      if (command.length === 0) return { kind: 'error', text: `Validation command is required. ${USAGE}` }
      const task = await manager.validate(id, current.changeToken, command)
      return {
        kind: task.lastValidation?.passed === true ? 'success' : 'error',
        text: task.lastValidation?.passed === true
          ? `Validation passed for ${String(id)}.`
          : `Validation failed for ${String(id)}.`,
      }
    }
    if (verb === 'deliver') {
      const task = await manager.deliver(id, current.changeToken, invocation.agent.session.header.cwd)
      return { kind: 'success', text: `Delivered ${String(task.id)} into ${invocation.agent.session.header.cwd ?? task.repository}.` }
    }
    if (verb === 'archive') {
      const task = await manager.archive({ id, changeToken: current.changeToken })
      return { kind: 'success', text: `Archived ${String(task.id)}.` }
    }
    return { kind: 'error', text: USAGE }
  } catch (error) {
    return { kind: 'error', text: errorMessage(error) }
  }
}

function requireCwd(invocation: CommandInvocation): string {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined) throw new Error('the current session has no workspace path')
  return cwd
}

function parseTaskId(value: string | undefined): ReturnType<typeof TaskId> {
  if (value === undefined || !isTaskId(value)) throw new Error('a valid task id is required')
  return TaskId(value)
}

async function findCurrent(manager: WorktreeStudioManager, id: ReturnType<typeof TaskId>): Promise<TaskView> {
  const task = (await manager.dashboard()).tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new Error(`unknown task ${String(id)}`)
  return task
}

function formatTask(task: TaskView): string {
  const changes = task.changes
  return `${String(task.id)} [${task.phase}] ${task.title} (${changes.commitsAhead} commits, ${changes.staged + changes.unstaged + changes.untracked} pending files)`
}
