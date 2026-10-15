import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithRuntimeContext, type WorkerBindings } from '../../src/runtime'

const mocks = vi.hoisted(() => ({
  autoRenew: vi.fn(),
  reconcile: vi.fn(),
  scan: vi.fn(),
  purge: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  timezone: vi.fn(),
  daily: vi.fn()
}))

vi.mock('../../src/services/subscription.service', () => ({
  autoRenewDueSubscriptions: mocks.autoRenew,
  reconcileExpiredSubscriptions: mocks.reconcile
}))
vi.mock('../../src/services/notification.service', () => ({ scanRenewalNotifications: mocks.scan }))
vi.mock('../../src/services/computed-cache-store.service', () => ({ purgeExpiredComputedCache: mocks.purge }))
vi.mock('../../src/services/exchange-rate.service', () => ({ refreshExchangeRates: mocks.refresh }))
vi.mock('../../src/services/worker-lite-cache.service', () => ({ invalidateWorkerLiteCache: mocks.invalidate }))
vi.mock('../../src/services/settings.service', () => ({ getAppTimezone: mocks.timezone }))
vi.mock('../../src/services/worker-cron.service', () => ({ runDailyTaskAtLocalHour: mocks.daily }))

import { runWorkerScheduledTasks } from '../../src/worker/scheduled'

function runAt(timestamp: string, overrides: Partial<WorkerBindings> = {}) {
  return runWithRuntimeContext(
    { bindings: { DB: {} as never, ...overrides } },
    () => runWorkerScheduledTasks(new Date(timestamp))
  )
}

describe('single-trigger Worker scheduling', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.timezone.mockResolvedValue('Asia/Shanghai')
    mocks.daily.mockImplementation(async (_key, _timezone, _hour, _now, execute) => {
      await execute()
      return true
    })
  })

  it('preserves all default job frequencies across a complete hour', async () => {
    for (let minute = 0; minute < 60; minute++) {
      await runAt(`2026-10-15T18:${String(minute).padStart(2, '0')}:00Z`)
    }

    expect(mocks.scan).toHaveBeenCalledTimes(60)
    expect(mocks.autoRenew).toHaveBeenCalledTimes(1)
    expect(mocks.purge).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).toHaveBeenCalledTimes(1)
    expect(mocks.daily).toHaveBeenCalledWith(
      'refreshExchangeRates', 'Asia/Shanghai', 2, new Date('2026-10-15T18:00:00Z'), expect.any(Function)
    )
    expect(mocks.daily).toHaveBeenCalledWith(
      'reconcileExpiredSubscriptions', 'Asia/Shanghai', 2, new Date('2026-10-15T18:10:00Z'), expect.any(Function)
    )
    expect(mocks.invalidate).toHaveBeenCalledWith(['exchange-rates', 'statistics', 'calendar'])
  })

  it('runs all jobs with identical schedules and renews before scanning reminders', async () => {
    await runAt('2026-10-15T18:05:00Z', {
      CRON_SCAN: '*/5 * * * *',
      CRON_AUTO_RENEW: '*/5 * * * *',
      CRON_REFRESH_RATES: '*/5 * * * *',
      CRON_RECONCILE_EXPIRED: '*/5 * * * *'
    })

    for (const task of [mocks.scan, mocks.autoRenew, mocks.refresh, mocks.reconcile]) {
      expect(task).toHaveBeenCalledTimes(1)
    }
    expect(mocks.autoRenew.mock.invocationCallOrder[0]).toBeLessThan(mocks.scan.mock.invocationCallOrder[0])
  })

  it('honors custom UTC schedules with steps, ranges, lists and named weekdays', async () => {
    const overrides = { CRON_SCAN: '5,10-20/5 18 * OCT THU' }
    await runAt('2026-10-15T18:15:00Z', overrides)
    await runAt('2026-10-15T18:16:00Z', overrides)
    await runAt('2026-10-15T10:15:00Z', overrides)
    await runAt('2026-10-16T18:15:00Z', overrides)

    expect(mocks.scan).toHaveBeenCalledExactlyOnceWith(new Date('2026-10-15T18:15:00Z'))
  })

  it('retains the local-time daily gates and only purges cache hourly', async () => {
    mocks.daily.mockResolvedValue(false)
    await runAt('2026-10-15T17:00:00Z')
    await runAt('2026-10-15T17:10:00Z')

    expect(mocks.daily).toHaveBeenCalledTimes(2)
    expect(mocks.purge).toHaveBeenCalledTimes(1)
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.scan).toHaveBeenCalledTimes(2)
  })

  it('runs other due jobs after a failure and still reports the original error', async () => {
    const failure = new Error('exchange-rate upstream unavailable')
    mocks.refresh.mockRejectedValue(failure)

    const result = runAt('2026-10-15T18:02:00Z', { CRON_REFRESH_RATES: '2 * * * *' })
    await expect(result).rejects.toMatchObject({
      errors: [expect.objectContaining({ cause: failure })]
    })

    expect(mocks.autoRenew).toHaveBeenCalledTimes(1)
    expect(mocks.scan).toHaveBeenCalledTimes(1)
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it('reports invalid cron config without suppressing unrelated due jobs', async () => {
    await expect(runAt('2026-10-15T18:02:00Z', { CRON_REFRESH_RATES: 'invalid' }))
      .rejects.toThrow('Worker scheduled tasks failed')
    expect(mocks.autoRenew).toHaveBeenCalledTimes(1)
    expect(mocks.scan).toHaveBeenCalledTimes(1)
  })
})
