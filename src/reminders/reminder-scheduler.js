import Bree from "bree";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";
import { reminderStore } from "./reminder-store.js";
import { reminderService } from "./reminder-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = resolve(__dirname, "jobs");
mkdirSync(JOBS_DIR, { recursive: true });

const REMINDER_JOB_PATH = resolve(JOBS_DIR, "send-reminder.js");
const FOLLOWUP_JOB_PATH = resolve(JOBS_DIR, "send-followup.js");

function jobName(prefix, id) {
  return `${prefix}-${id}`;
}

function millisUntil(isoDate) {
  if (!isoDate) return 0;
  const target = new Date(isoDate).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, target - Date.now());
}

export class ReminderScheduler {
  constructor() {
    this.bree = new Bree({
      root: false,
      jobs: [],
      logger,
      workerMessageHandler: (name, message) => {
        this._handleWorkerMessage(name, message).catch((error) => {
          logger.error("Reminder worker message failed", {
            name,
            message,
            error,
          });
        });
      },
      errorHandler: (error, workerMetadata) => {
        logger.error("Reminder worker error", { error, workerMetadata });
      },
    });

    this.followupJobs = new Map();
    reminderService.registerScheduler(this);
  }

  async start() {
    logger.info("⏰ Starting reminder scheduler...");
    await this._restoreReminderJobs();
    await this._restoreFollowupJobs();
    await this.bree.start();
    logger.info("Reminder scheduler started");
  }

  async stop() {
    logger.info("⏹️ Stopping reminder scheduler...");
    try {
      await this.bree.stop();
    } catch (error) {
      logger.warn("Failed to stop Bree cleanly", error);
    }
    this.followupJobs.clear();
    logger.info("Reminder scheduler stopped");
  }

  async scheduleReminder(reminder, { start = true } = {}) {
    const jobNameValue = jobName("reminder", reminder.id);
    await this._removeJob(jobNameValue);

    const jobConfig = {
      name: jobNameValue,
      path: REMINDER_JOB_PATH,
      worker: {
        workerData: { reminderId: reminder.id },
      },
      timeout: false,
    };

    if (reminder.type === "cron") {
      jobConfig.cron = reminder.cron_expression;
      jobConfig.timezone = reminder.timezone ?? "local";
    } else if (reminder.type === "once") {
      if (reminder.run_at) {
        const runAtDate = new Date(reminder.run_at);
        if (!Number.isNaN(runAtDate.getTime())) {
          if (runAtDate <= new Date()) {
            jobConfig.timeout = 0;
          } else {
            jobConfig.date = runAtDate;
          }
        } else {
          logger.warn("Invalid run_at for reminder; defaulting to immediate", {
            reminderId: reminder.id,
            runAt: reminder.run_at,
          });
          jobConfig.timeout = 0;
        }
      } else {
        jobConfig.timeout = 0;
      }
    }

    await this.bree.add(jobConfig);
    logger.info("Scheduled reminder job", {
      reminderId: reminder.id,
      jobName: jobNameValue,
      type: reminder.type,
      cron: reminder.cron_expression,
      runAt: reminder.run_at,
    });

    if (start) {
      await this._startJobSafely(jobNameValue);
    }
  }

  async unscheduleReminder(reminderId) {
    const jobNameValue = jobName("reminder", reminderId);
    await this._removeJob(jobNameValue);

    const pendingOccurrences = reminderStore.listPendingOccurrencesByReminder(
      reminderId,
    );
    for (const occurrence of pendingOccurrences) {
      await this.cancelFollowup(occurrence.id);
    }

    logger.info("Removed reminder job", { reminderId });
  }

  async scheduleFollowup(
    occurrenceId,
    delayMs,
    { start = true, nextRetryAt, skipPersist = false } = {},
  ) {
    const jobNameValue = jobName("followup", occurrenceId);
    await this._removeJob(jobNameValue);

    const timeoutMs = Math.max(0, delayMs);
    const jobConfig = {
      name: jobNameValue,
      path: FOLLOWUP_JOB_PATH,
      worker: {
        workerData: { occurrenceId },
      },
      timeout: timeoutMs,
    };

    await this.bree.add(jobConfig);
    this.followupJobs.set(occurrenceId, jobNameValue);

    const nextRunIso =
      nextRetryAt ?? new Date(Date.now() + timeoutMs).toISOString();

    if (!skipPersist) {
      reminderStore.setOccurrenceFollowup(occurrenceId, {
        nextRetryAt: nextRunIso,
        followupJobName: jobNameValue,
      });
    }

    logger.info("Scheduled follow-up job", {
      occurrenceId,
      jobName: jobNameValue,
      delayMs: timeoutMs,
      nextRunIso,
    });

    if (start) {
      await this._startJobSafely(jobNameValue);
    }
  }

  async cancelFollowup(occurrenceId, { clearStore = true } = {}) {
    const jobNameValue = this.followupJobs.get(occurrenceId);
    if (jobNameValue) {
      await this._removeJob(jobNameValue);
      this.followupJobs.delete(occurrenceId);
      logger.info("Cancelled follow-up job", {
        occurrenceId,
        jobName: jobNameValue,
      });
    }

    if (clearStore) {
      reminderStore.clearOccurrenceFollowup(occurrenceId);
    }
  }

  async cancelFollowupsByReminder(reminderId) {
    const occurrences = reminderStore.listPendingOccurrencesByReminder(
      reminderId,
    );
    for (const occurrence of occurrences) {
      await this.cancelFollowup(occurrence.id);
    }
  }

  async _restoreReminderJobs() {
    const reminders = reminderStore.listActiveReminders();
    logger.info("Restoring reminder jobs", { count: reminders.length });

    for (const reminder of reminders) {
      await this.scheduleReminder(reminder, { start: false });
    }
  }

  async _restoreFollowupJobs() {
    const occurrences = reminderStore.listPendingFollowups();
    logger.info("Restoring follow-up jobs", { count: occurrences.length });

    for (const occurrence of occurrences) {
      const delayMs = millisUntil(occurrence.next_retry_at);
      await this.scheduleFollowup(occurrence.id, delayMs, {
        start: false,
        nextRetryAt: occurrence.next_retry_at,
        skipPersist: true,
      });
    }
  }

  async _handleWorkerMessage(name, message) {
    if (!message) return;
    if (typeof message === "string") {
      // Bree sends "done" when workers finish; ignore.
      return;
    }

    if (message.type === "reminder:trigger" && message.reminderId) {
      logger.debug("Reminder trigger received", {
        worker: name,
        reminderId: message.reminderId,
      });
      await reminderService.triggerReminder(message.reminderId);
      return;
    }

    if (message.type === "followup:trigger" && message.occurrenceId) {
      logger.debug("Follow-up trigger received", {
        worker: name,
        occurrenceId: message.occurrenceId,
      });
      this.followupJobs.delete(message.occurrenceId);
      await reminderService.triggerFollowup(message.occurrenceId);
      return;
    }

    if (message.type === "reminder:error") {
      logger.error("Reminder worker reported error", {
        worker: name,
        error: message.error,
      });
      return;
    }

    logger.warn("Unhandled reminder worker message", {
      worker: name,
      message,
    });
  }

  _hasJob(name) {
    return this.bree.config.jobs.some((job) => job.name === name);
  }

  async _removeJob(name) {
    if (!this._hasJob(name)) {
      return;
    }

    try {
      await this.bree.stop(name);
    } catch (error) {
      // Ignore if job was not running
      logger.debug("Job stop failed (likely not running)", {
        name,
        error: error?.message,
      });
    }

    try {
      await this.bree.remove(name);
    } catch (error) {
      logger.warn("Failed to remove job", { name, error });
    }
  }

  async _startJobSafely(name) {
    try {
      await this.bree.start(name);
    } catch (error) {
      logger.error("Failed to start job", { name, error });
    }
  }
}

export const reminderScheduler = new ReminderScheduler();
