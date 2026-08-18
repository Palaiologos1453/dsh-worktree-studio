/** Loopback-only Web adapter for the task manager. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import stringArgv from 'string-argv'
import { StudioError, errorMessage } from './errors.ts'
import { TaskId, isTaskId } from './types.ts'
import type {} from './index.ts'

export const WORKTREE_STUDIO_ROUTE = '/api/dsh-worktree-studio'
const BODY_LIMIT_BYTES = 256 * 1024

/** Register the same-origin loopback route and return its disposer. */
export function registerWorktreeStudioWeb(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: WORKTREE_STUDIO_ROUTE,
    async handler(request, response) {
      if (!isLoopbackSameOrigin(request)) {
        send(response, 403, { ok: false, error: { code: 'forbidden', message: 'loopback same-origin access is required' } })
        return
      }
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? WORKTREE_STUDIO_ROUTE, 'http://localhost')
          const repository = url.searchParams.get('repository') ?? undefined
          send(response, 200, { ok: true, value: await ctx.worktreeStudio.dashboard(repository) })
          return
        }
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'GET or POST is required' } })
          return
        }
        const value = await dispatch(ctx, await readBody(request))
        send(response, 200, { ok: true, value })
      } catch (error) {
        const domain = error instanceof StudioError
          ? error
          : new StudioError('invalid-input', errorMessage(error), 400, { cause: error })
        send(response, domain.status, { ok: false, error: { code: domain.code, message: domain.message } })
      }
    },
  })
}

/** Dispatch one validated Web operation to the manager. */
async function dispatch(ctx: Context, input: Record<string, unknown>): Promise<unknown> {
  const operation = requiredString(input, 'operation')
  if (operation === 'create') {
    const commandLine = optionalString(input, 'validationCommand')
    const validationCommand = commandLine === undefined || commandLine.trim() === ''
      ? undefined
      : parseCommandLine(commandLine)
    return await ctx.worktreeStudio.create({
      repository: requiredString(input, 'repository'),
      title: requiredString(input, 'title'),
      ...(optionalString(input, 'branch') === undefined ? {} : { branch: optionalString(input, 'branch') as string }),
      ...(optionalString(input, 'baseRef') === undefined ? {} : { baseRef: optionalString(input, 'baseRef') as string }),
      ...(validationCommand === undefined ? {} : { validationCommand }),
    })
  }
  if (operation === 'recover') return await ctx.worktreeStudio.recover()
  if (operation === 'doctor') return await ctx.worktreeStudio.doctor()
  const id = taskId(input)
  if (operation === 'inspect') return await ctx.worktreeStudio.inspect(id)
  if (operation === 'preview') return await ctx.worktreeStudio.previewMerge(id, optionalString(input, 'targetPath'))
  const changeToken = requiredToken(input)
  if (operation === 'validate') {
    const commandLine = optionalString(input, 'validationCommand')
    return await ctx.worktreeStudio.validate(
      id,
      changeToken,
      commandLine === undefined || commandLine.trim() === '' ? undefined : parseCommandLine(commandLine),
    )
  }
  if (operation === 'deliver') {
    return await ctx.worktreeStudio.deliver(id, changeToken, optionalString(input, 'targetPath'))
  }
  if (operation === 'archive') return await ctx.worktreeStudio.archive({ id, changeToken })
  if (operation === 'discard') {
    return await ctx.worktreeStudio.discard({ id, changeToken }, requiredString(input, 'confirmation'))
  }
  throw new StudioError('invalid-input', `unsupported operation: ${operation}`)
}

/** Parse a user-authored command line into spawn argv without invoking a shell. */
function parseCommandLine(value: string): readonly string[] {
  try {
    const argv = stringArgv(value)
    if (argv.length === 0) throw new Error('empty command')
    return argv
  } catch (error) {
    throw new StudioError('invalid-input', `validation command cannot be parsed: ${errorMessage(error)}`)
  }
}

/** Read one bounded JSON object. */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.toLocaleLowerCase().startsWith('application/json')) {
    throw new StudioError('invalid-input', 'content-type must be application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw new StudioError('invalid-input', 'request body exceeds 256 KiB')
    chunks.push(chunk)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new StudioError('invalid-input', `request body is not valid JSON: ${errorMessage(error)}`)
  }
  if (!isRecord(parsed)) throw new StudioError('invalid-input', 'request body must be a JSON object')
  return parsed
}

/** Keep privileged Git operations local even when the Web server binds widely. */
function isLoopbackSameOrigin(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StudioError('invalid-input', `${key} must be a non-empty string`)
  }
  return value
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new StudioError('invalid-input', `${key} must be a string`)
  return value
}

function taskId(input: Record<string, unknown>): ReturnType<typeof TaskId> {
  const value = requiredString(input, 'id')
  if (!isTaskId(value)) throw new StudioError('invalid-input', 'id is not a worktree-studio task id')
  return TaskId(value)
}

function requiredToken(input: Record<string, unknown>): string {
  const value = requiredString(input, 'changeToken')
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new StudioError('invalid-input', 'changeToken is invalid')
  return value
}
