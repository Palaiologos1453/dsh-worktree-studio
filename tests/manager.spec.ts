import { afterEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalWorktreeStudioManager, type WorktreeStudioOptions } from '../src/manager.ts'
import { TaskStore } from '../src/store.ts'
import { StudioError } from '../src/errors.ts'
import {
  createRepositoryFixture,
  createSubprocessFixture,
  git,
  removeFixture,
  type RepositoryFixture,
  type SubprocessFixture,
} from './helpers.ts'

const fixtures: RepositoryFixture[] = []
const managers: LocalWorktreeStudioManager[] = []
const subprocesses: SubprocessFixture[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  await Promise.all(subprocesses.splice(0).map(subprocess => subprocess.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => removeFixture(fixture.root)))
})

function options(fixture: RepositoryFixture, requireValidation = true): WorktreeStudioOptions {
  return {
    managedRoot: fixture.managedRoot,
    statePath: fixture.statePath,
    gitTimeoutMs: 10_000,
    terminationGraceMs: 200,
    validationTimeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
    reviewMaxBytes: 64 * 1024,
    requireValidation,
  }
}

async function setup(requireValidation = true): Promise<{
  readonly fixture: RepositoryFixture
  readonly manager: LocalWorktreeStudioManager
}> {
  const fixture = await createRepositoryFixture()
  fixtures.push(fixture)
  const subprocess = await createSubprocessFixture()
  subprocesses.push(subprocess)
  const manager = new LocalWorktreeStudioManager(options(fixture, requireValidation), subprocess.subprocess)
  managers.push(manager)
  return { fixture, manager }
}

describe('LocalWorktreeStudioManager', () => {
  it('creates, validates, previews, delivers, and archives one task', async () => {
    const { fixture, manager } = await setup()
    let task = await manager.create({
      repository: fixture.repository,
      title: 'Add delivery proof',
      validationCommand: [process.execPath, '-e', 'process.exit(0)'],
    })
    expect(task).toMatchObject({ phase: 'active', exists: true, branch: expect.stringMatching(/^dsh\//u) })

    await writeFile(join(task.path, 'proof.txt'), 'delivered\n')
    git(task.path, ['add', 'proof.txt'])
    git(task.path, ['commit', '-m', 'add proof'])
    task = (await manager.dashboard(fixture.repository)).tasks[0] as typeof task
    expect(task.changes).toMatchObject({ dirty: false, commitsAhead: 1 })

    task = await manager.validate(task.id, task.changeToken)
    expect(task.phase).toBe('validated')
    expect(task.lastValidation).toMatchObject({ passed: true, timedOut: false, exitCode: 0 })

    const preview = await manager.previewMerge(task.id, fixture.repository)
    expect(preview).toMatchObject({ canMerge: true, targetDirty: false, conflicts: [] })
    task = await manager.deliver(task.id, task.changeToken, fixture.repository)
    expect(task.phase).toBe('delivered')
    expect(await readFile(join(fixture.repository, 'proof.txt'), 'utf8')).toBe('delivered\n')

    task = await manager.archive({ id: task.id, changeToken: task.changeToken })
    expect(task).toMatchObject({ phase: 'archived', exists: false, conclusion: 'delivered' })
  })

  it('rejects stale mutations and requires the exact task id before discard', async () => {
    const { fixture, manager } = await setup(false)
    const created = await manager.create({ repository: fixture.repository, title: 'Disposable task' })
    await writeFile(join(created.path, 'uncommitted.txt'), 'keep until confirmed\n')
    const current = (await manager.dashboard(fixture.repository)).tasks[0] as typeof created

    await expect(manager.archive({ id: created.id, changeToken: created.changeToken }))
      .rejects.toMatchObject({ code: 'state-conflict' })
    await expect(manager.discard({ id: current.id, changeToken: current.changeToken }, 'discard'))
      .rejects.toMatchObject({ code: 'invalid-input' })

    const discarded = await manager.discard(
      { id: current.id, changeToken: current.changeToken },
      String(current.id),
    )
    expect(discarded).toMatchObject({ phase: 'archived', conclusion: 'discarded', exists: false })
  })

  it('records failed validation and blocks unvalidated delivery', async () => {
    const { fixture, manager } = await setup()
    let task = await manager.create({
      repository: fixture.repository,
      title: 'Failing task',
      validationCommand: [process.execPath, '-e', 'process.exit(7)'],
    })
    await writeFile(join(task.path, 'change.txt'), 'change\n')
    git(task.path, ['add', 'change.txt'])
    git(task.path, ['commit', '-m', 'change'])
    task = (await manager.dashboard(fixture.repository)).tasks[0] as typeof task

    await expect(manager.deliver(task.id, task.changeToken, fixture.repository))
      .rejects.toMatchObject({ code: 'validation-failed' })
    task = await manager.validate(task.id, task.changeToken)
    expect(task).toMatchObject({ phase: 'blocked', lastValidation: { passed: false, exitCode: 7 } })
  })

  it('invalidates validation when an unchanged status entry gets new content', async () => {
    const { fixture, manager } = await setup()
    let task = await manager.create({
      repository: fixture.repository,
      title: 'Content fingerprint',
      validationCommand: [process.execPath, '-e', 'process.exit(0)'],
    })
    const changedPath = join(task.path, 'same-status.txt')
    await writeFile(changedPath, 'first\n')
    task = (await manager.dashboard(fixture.repository)).tasks[0] as typeof task
    task = await manager.validate(task.id, task.changeToken)
    expect(task.phase).toBe('validated')
    const validatedToken = task.changeToken

    await writeFile(changedPath, 'other\n')
    task = (await manager.dashboard(fixture.repository)).tasks[0] as typeof task
    expect(task.changeToken).not.toBe(validatedToken)
    expect(task.phase).toBe('active')
    expect(task.lastValidation?.changeToken).toBe(validatedToken)
  })

  it('marks an interrupted validation as blocked during recovery', async () => {
    const { fixture, manager } = await setup(false)
    const task = await manager.create({ repository: fixture.repository, title: 'Interrupted task' })
    const store = new TaskStore(fixture.statePath)
    await store.update(state => ({
      version: 1,
      tasks: {
        ...state.tasks,
        [String(task.id)]: {
          ...(state.tasks[String(task.id)] as NonNullable<(typeof state.tasks)[string]>),
          pendingOperation: 'validate',
        },
      },
    }))

    const report = await manager.recover()
    expect(report.pending).toEqual([])
    const recovered = (await manager.dashboard(fixture.repository)).tasks[0]
    expect(recovered).toMatchObject({ phase: 'blocked', lastError: expect.stringContaining('interrupted validate') })
  })

  it('does not mutate a dirty target during merge preview', async () => {
    const { fixture, manager } = await setup(false)
    let task = await manager.create({ repository: fixture.repository, title: 'Preview task' })
    await writeFile(join(task.path, 'feature.txt'), 'feature\n')
    git(task.path, ['add', 'feature.txt'])
    git(task.path, ['commit', '-m', 'feature'])
    task = (await manager.dashboard(fixture.repository)).tasks[0] as typeof task
    await writeFile(join(fixture.repository, 'README.md'), 'dirty target\n')

    const before = git(fixture.repository, ['rev-parse', 'HEAD'])
    const preview = await manager.previewMerge(task.id, fixture.repository)
    const after = git(fixture.repository, ['rev-parse', 'HEAD'])
    expect(preview).toMatchObject({ canMerge: false, targetDirty: true })
    expect(after).toBe(before)
  })
})
