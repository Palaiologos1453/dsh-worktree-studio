import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface RepositoryFixture {
  readonly root: string
  readonly repository: string
  readonly managedRoot: string
  readonly statePath: string
}

export interface SubprocessFixture {
  readonly subprocess: SubprocessRuntime
  dispose(): Promise<void>
}

export async function createSubprocessFixture(): Promise<SubprocessFixture> {
  const context = new Context()
  const fiber = await context.plugin(LocalSubprocessRuntime)
  return {
    subprocess: context.subprocess,
    dispose: () => fiber.dispose(),
  }
}

export async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-studio-test-'))
  const repository = join(root, 'repository')
  await mkdir(repository)
  git(repository, ['init', '--initial-branch=main'])
  git(repository, ['config', 'user.email', 'worktree-studio@example.invalid'])
  git(repository, ['config', 'user.name', 'Worktree Studio Test'])
  git(repository, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repository, 'README.md'), '# fixture\n')
  git(repository, ['add', 'README.md'])
  git(repository, ['commit', '-m', 'initial'])
  return {
    root,
    repository,
    managedRoot: join(root, 'managed'),
    statePath: join(root, 'state', 'tasks.json'),
  }
}

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  }).trim()
}

export async function removeFixture(root: string): Promise<void> {
  const absolute = resolve(root)
  const temporary = `${resolve(tmpdir())}${sep}`
  if (!absolute.startsWith(temporary) || !basename(absolute).startsWith('dsh-worktree-studio-test-')) {
    throw new Error(`refusing to remove non-fixture path ${absolute}`)
  }
  await rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
