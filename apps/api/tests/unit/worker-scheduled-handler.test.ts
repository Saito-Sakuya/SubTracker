import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), run: vi.fn() }))
vi.mock('../../src/worker/database-init', () => ({ ensureDatabaseInitialized: mocks.initialize }))
vi.mock('../../src/worker/scheduled', () => ({ runWorkerScheduledTasks: mocks.run }))

import worker from '../../src/worker/index'

describe('Worker scheduled event handler', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the event scheduled minute rather than the delayed execution time', async () => {
    const scheduledTime = Date.parse('2026-10-15T18:02:00.500Z')
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime },
      { DB: {} as never },
      { waitUntil: vi.fn() }
    )

    expect(mocks.initialize).toHaveBeenCalledTimes(1)
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(new Date('2026-10-15T18:02:00Z'))
  })

  it('ignores retired triggers during propagation without touching the database', async () => {
    for (const cron of ['2 * * * *', '10 * * * *', '0 * * * *']) {
      await worker.scheduled(
        { cron, scheduledTime: Date.parse('2026-10-15T18:02:00Z') },
        { DB: {} as never },
        { waitUntil: vi.fn() }
      )
    }

    expect(mocks.initialize).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
