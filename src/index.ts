/** DeepSeek Harness Host plugin for worktree task management. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LocalWorktreeStudioManager, type WorktreeStudioOptions } from './manager.ts'
import { registerWorktreeStudioWeb } from './web.ts'
import type { WorktreeStudioManager } from './types.ts'

export const name = 'dsh-worktree-studio'
export const inject = ['subprocess']

/** User-configurable paths, limits, and delivery policy. */
export interface Config {
  readonly managedRoot: string
  readonly statePath: string
  readonly gitTimeoutMs: number
  readonly terminationGraceMs: number
  readonly validationTimeoutMs: number
  readonly maxOutputBytes: number
  readonly reviewMaxBytes: number
  readonly requireValidation: boolean
}

const dshHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
const stateRoot = join(dshHome, 'plugins', 'dsh-worktree-studio')

/** Loader schema with every deployment-varying limit exposed. */
export const Config: schema<Config> = schema.object({
  managedRoot: schema.string().default(join(stateRoot, 'worktrees')),
  statePath: schema.string().default(join(stateRoot, 'tasks.json')),
  gitTimeoutMs: schema.number().step(1).min(1_000).default(60_000),
  terminationGraceMs: schema.number().step(1).min(100).default(3_000),
  validationTimeoutMs: schema.number().step(1).min(1_000).default(600_000),
  maxOutputBytes: schema.number().step(1).min(16_384).default(1_048_576),
  reviewMaxBytes: schema.number().step(1).min(16_384).default(524_288),
  requireValidation: schema.boolean().default(true),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable worktree task lifecycle shared by commands and Web. */
    worktreeStudio: WorktreeStudioManager
  }
}

/** Resolve and validate configuration before any filesystem or Git mutation. */
function resolveOptions(config: Config): WorktreeStudioOptions {
  const managedRoot = absolutePath('managedRoot', config.managedRoot)
  const statePath = absolutePath('statePath', config.statePath)
  if (sameLocation(managedRoot, statePath) || statePath.startsWith(`${managedRoot}${separator()}`)) {
    throw new TypeError('dsh-worktree-studio: statePath must not be inside managedRoot')
  }
  return {
    managedRoot,
    statePath,
    gitTimeoutMs: positiveInteger('gitTimeoutMs', config.gitTimeoutMs),
    terminationGraceMs: positiveInteger('terminationGraceMs', config.terminationGraceMs),
    validationTimeoutMs: positiveInteger('validationTimeoutMs', config.validationTimeoutMs),
    maxOutputBytes: positiveInteger('maxOutputBytes', config.maxOutputBytes),
    reviewMaxBytes: positiveInteger('reviewMaxBytes', config.reviewMaxBytes),
    requireValidation: config.requireValidation,
  }
}

/** Create the manager for tests or other Host plugins. */
export function createWorktreeStudioManager(
  options: WorktreeStudioOptions,
  subprocess: SubprocessRuntime,
): WorktreeStudioManager {
  return new LocalWorktreeStudioManager(options, subprocess)
}

/** Register the manager, recover interrupted state, and attach Web when available. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const manager = new LocalWorktreeStudioManager(resolveOptions(config), ctx.subprocess)
  ctx.provide('worktreeStudio', manager)
  const report = await manager.recover()
  for (const problem of report.problems) ctx.logger.warn(`dsh-worktree-studio: ${problem}`)
  ctx.inject(['webServer'], webCtx => webCtx.effect(
    () => registerWorktreeStudioWeb(webCtx),
    'dsh-worktree-studio.web',
  ))
  ctx.effect(() => async () => manager.close(), 'dsh-worktree-studio.close')
}

function absolutePath(label: string, value: string): string {
  if (value.trim() === '') throw new TypeError(`dsh-worktree-studio: ${label} must not be empty`)
  return resolve(value)
}

function positiveInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`dsh-worktree-studio: ${label} must be a positive safe integer`)
  }
  return value
}

function sameLocation(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

export { LocalWorktreeStudioManager } from './manager.ts'
export { StudioError } from './errors.ts'
export type * from './types.ts'
