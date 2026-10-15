import { CronExpressionParser } from 'cron-parser'
import { getWorkerPublicConfig } from '../runtime'
import { autoRenewDueSubscriptions, reconcileExpiredSubscriptions } from '../services/subscription.service'
import { scanRenewalNotifications } from '../services/notification.service'
import { purgeExpiredComputedCache } from '../services/computed-cache-store.service'
import { refreshExchangeRates } from '../services/exchange-rate.service'
import { getAppTimezone } from '../services/settings.service'
import { invalidateWorkerLiteCache } from '../services/worker-lite-cache.service'
import { runDailyTaskAtLocalHour } from '../services/worker-cron.service'

export async function runWorkerScheduledTasks(now: Date) {
  const config = getWorkerPublicConfig()
  const tasks = [
    {
      name: 'refreshExchangeRates',
      cron: config.cronRefreshRates,
      async run() {
        await purgeExpiredComputedCache()
        await runDailyTaskAtLocalHour('refreshExchangeRates', await getAppTimezone(), 2, now, async () => {
          await refreshExchangeRates()
          await invalidateWorkerLiteCache(['exchange-rates', 'statistics', 'calendar'])
        })
      }
    },
    {
      name: 'autoRenewDueSubscriptions',
      cron: config.cronAutoRenew,
      run: () => autoRenewDueSubscriptions()
    },
    {
      name: 'reconcileExpiredSubscriptions',
      cron: config.cronReconcileExpired,
      async run() {
        await runDailyTaskAtLocalHour('reconcileExpiredSubscriptions', await getAppTimezone(), 2, now, async () => {
          await reconcileExpiredSubscriptions()
        })
      }
    },
    {
      name: 'scanRenewalNotifications',
      cron: config.cronScan,
      run: () => scanRenewalNotifications(now)
    }
  ]

  const errors: Error[] = []
  for (const task of tasks) {
    try {
      if (CronExpressionParser.parse(task.cron, { tz: 'UTC' }).includesDate(now)) {
        await task.run()
      }
    } catch (error) {
      // Other due jobs, especially reminders, must still run after a failure.
      errors.push(new Error(`Worker cron task ${task.name} failed`, { cause: error }))
    }
  }

  if (errors.length) {
    throw new AggregateError(errors, 'Worker scheduled tasks failed')
  }
}
