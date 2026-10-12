// A scheduled hello is an editable, disabled draft until explicitly saved.
// Provider usage windows are deliberately outside this app's scheduling model.
export function buildScheduledHello({ profileId, datetime, mode = 'once', text, directory = '.' }, now) {
  if (typeof profileId !== 'string' || !profileId.trim()) throw new Error('Choose an account first.');
  if (!['once', 'cron'].includes(mode)) throw new Error('Choose Once or Every day.');
  const timestamp = new Date(datetime).getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Choose a valid local date and time.');
  if (timestamp <= now) throw new Error('Choose a time in the future for the first hello.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Enter a short prompt.');
  return {
    name: 'Scheduled hello',
    defaultDirectory: directory,
    scheduleEnabled: false,
    blocks: [
      { type: 'schedule', params: { datetime, mode } },
      { type: 'directory', params: { path: directory } },
      { type: 'agentStart', params: { profileId, settleMs: 8000 } },
      { type: 'agentWait', params: { profileId, idleMs: 1000, pattern: '', timeoutMs: 60000 } },
      { type: 'agentSend', params: { profileId, text: text.trim(), pressEnter: true } },
      { type: 'log', params: { message: 'Scheduled hello sent. Check the agent terminal for its response.' } },
    ],
  };
}

// Missing flags preserve the scheduler behavior of workflows from older versions.
export function isScheduleEnabled(workflow) {
  return workflow?.scheduleEnabled !== false;
}
