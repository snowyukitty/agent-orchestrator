// Adapter that keeps exact-session continuation authority with SessionRegistry.

const { deliverScheduledPrompt } = require('./scheduled-prompt-delivery');

const ORCHESTRATOR_PTY_BACKEND_ID = 'orchestrator-pty';

function createOrchestratorPtyContinuationBackend({ registry, deliver = deliverScheduledPrompt } = {}) {
  if (!registry) throw new TypeError('Orchestrator PTY backend needs a session registry');
  if (typeof deliver !== 'function') throw new TypeError('Orchestrator PTY backend needs delivery');
  return {
    id: ORCHESTRATOR_PTY_BACKEND_ID,
    label: 'Orchestrator PTY',
    capabilities: {
      exactSessionIdentity: true,
      agentReadinessProof: true,
      protectedPromptDelivery: true,
      claimBoundDelivery: true,
    },
    getScheduleTarget(sessionId) {
      return registry.scheduleTarget(sessionId);
    },
    inspectSchedule(schedule) {
      const binding = registry.scheduleBinding(schedule?.sessionId);
      return binding
        ? { status: 'matched', binding }
        : { status: 'session_changed' };
    },
    deliverClaimed(schedule) {
      return deliver(schedule, { registry });
    },
  };
}

module.exports = {
  ORCHESTRATOR_PTY_BACKEND_ID,
  createOrchestratorPtyContinuationBackend,
};
