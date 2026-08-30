// Guarded PTY delivery for one already-durably-claimed occurrence.

const { normalizePrompt } = require('./session-prompt-schedules');

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const SUBMIT_DELAY_MS = 100;
const QUIET_PERIOD_MS = 30_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function deliverScheduledPrompt(schedule, {
  registry,
  delay = sleep,
  quietPeriodMs = QUIET_PERIOD_MS,
} = {}) {
  if (!registry) return 'unavailable';
  const prompt = normalizePrompt(schedule?.prompt);
  const claimToken = schedule?.deliveryClaim?.token;
  let began = false;
  try {
    const start = registry.beginScheduledDelivery(schedule, claimToken, quietPeriodMs);
    if (!start?.ok) return start?.status || 'unavailable';
    began = true;

    let pasteRevision;
    try {
      pasteRevision = registry.writeScheduledPaste(
        schedule.sessionId,
        schedule.sessionIncarnationId,
        claimToken,
        `${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`
      );
    } catch (_error) {
      return 'error';
    }

    await delay(SUBMIT_DELAY_MS);
    const recheck = registry.revalidateScheduledDelivery(schedule, claimToken, pasteRevision);
    if (!recheck?.ok) return 'error';

    try {
      return registry.submitScheduledDelivery(
        schedule.sessionId,
        schedule.sessionIncarnationId,
        claimToken,
        '\r'
      ) ? 'sent' : 'error';
    } catch (_error) {
      return 'error';
    }
  } finally {
    if (began) registry.endScheduledDelivery(schedule?.sessionId, claimToken);
  }
}

module.exports = {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  QUIET_PERIOD_MS,
  SUBMIT_DELAY_MS,
  deliverScheduledPrompt,
};
