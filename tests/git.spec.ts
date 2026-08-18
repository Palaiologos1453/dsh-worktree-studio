import { afterEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertPathInside, GitClient, runProcess } from '../src/git.ts'
import {
  createRepositoryFixture,
  createSubprocessFixture,
  git as runGit,
  removeFixture,
  type RepositoryFixture,
  type SubprocessFixture,
} from './helpers.ts'

const fixtures: RepositoryFixture[] = []
const subprocesses: SubprocessFixture[] = []

afterEach(async () => {
  await Promise.all(subprocesses.splice(0).map(subprocess => subprocess.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => removeFixture(fixture.root)))
})

describe('GitClient', () => {
  it('reports timeout independently from process exit fields', async () => {
    const subprocess = await createSubprocessFixture()
    subprocesses.push(subprocess)
    const result = await runProcess(subprocess.subprocess, process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {
      cwd: process.cwd(),
      timeoutMs: 40,
      terminationGraceMs: 20,
      maxOutputBytes: 1024,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode === null || Number.isInteger(result.exitCode)).toBe(true)
  })

  it('does not forward credential-shaped ambient variables', async () => {
    const subprocess = await createSubprocessFixture()
    subprocesses.push(subprocess)
    const key = 'WORKTREE_STUDIO_SECRET_CANARY'
    const previous = process.env[key]
    process.env[key] = 'must-not-reach-child'
    try {
      const result = await runProcess(
        subprocess.subprocess,
        process.execPath,
        ['-e', `process.stdout.write(process.env.${key} ?? 'scrubbed')`],
        {
          cwd: process.cwd(),
          timeoutMs: 5_000,
          terminationGraceMs: 200,
          maxOutputBytes: 1024,
        },
      )
      expect(result.stdout).toBe('scrubbed')
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it.runIf(process.platform === 'win32')('runs package-manager command shims with argv semantics on Windows', async () => {
    const subprocess = await createSubprocessFixture()
    subprocesses.push(subprocess)
    const git = new GitClient(subprocess.subprocess, 10_000, 200, 16 * 1024)
    const result = await git.validate(process.cwd(), ['pnpm', '--version'], 'a'.repeat(64), 10_000, 16 * 1024)
    expect(result.stderr).toBe('')
    expect(result).toMatchObject({ passed: true, timedOut: false, exitCode: 0 })
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('lists a real linked worktree and bounds review output', async () => {
    const fixture = await createRepositoryFixture()
    fixtures.push(fixture)
    const subprocess = await createSubprocessFixture()
    subprocesses.push(subprocess)
    const git = new GitClient(subprocess.subprocess, 10_000, 200, 512 * 1024)
    const identity = await git.identify(fixture.repository)
    const path = join(fixture.managedRoot, 'large')
    await git.createWorktree(fixture.repository, path, identity.headCommit, 'dsh/large')
    await writeFile(join(path, 'large.txt'), 'x'.repeat(64 * 1024))
    runGit(path, ['add', '--intent-to-add', 'large.txt'])

    const linked = await git.listWorktrees(fixture.repository)
    expect(linked.some(item => item.branch === 'dsh/large')).toBe(true)
    const review = await git.review(path, identity.headCommit, 1024)
    expect(review.truncated).toBe(true)
    expect(Buffer.byteLength(review.diff, 'utf8')).toBeLessThanOrEqual(1024)
  })

  it('rejects a managed path that escapes its configured root', () => {
    expect(() => assertPathInside(join(tmpdir(), 'managed'), join(tmpdir(), 'outside'))).toThrow()
  })
})
