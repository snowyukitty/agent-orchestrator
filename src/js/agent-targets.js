// ============================================================
// Workflow Agent Targeting
// Pure target-selection helpers shared by block rendering, execution, and
// renderer self-tests.
// ============================================================

/** Special Send to Agent target: every live agent session opened by this run. */
export const WORKFLOW_AGENT_TARGET = '@workflow-agents';

/**
 * Return live, workflow-owned agent sessions in stable tab/creation order.
 *
 * Shell command PTYs are deliberately excluded: a team barrier represents
 * account-backed Agent Session lanes, not every process a workflow happened
 * to spawn.
 */
export function workflowAgentSessions(sessions, spawnedIds) {
  const owned = spawnedIds instanceof Set ? spawnedIds : new Set(spawnedIds || []);
  return (Array.isArray(sessions) ? sessions : []).filter(session => (
    session
    && typeof session.id === 'string'
    && owned.has(session.id)
    && typeof session.profileId === 'string'
    && session.profileId
    && session.status !== 'exited'
  ));
}

/**
 * Select every lane that still owes the workflow a completion signal.
 * A successful individual wait removes its lane from `pendingIds`, so a later
 * Join Agents block never waits for the same prompt twice. Pending membership
 * is authoritative: an exited lane remains in the result, and a lane removed
 * from the renderer is reconstructed from metadata captured when it was sent.
 */
export function pendingWorkflowAgentSessions(
  sessions,
  spawnedIds,
  pendingIds,
  pendingMetadata = new Map()
) {
  const list = Array.isArray(sessions) ? sessions : [];
  const owned = spawnedIds instanceof Set ? spawnedIds : new Set(spawnedIds || []);
  const pending = pendingIds instanceof Set ? pendingIds : new Set(pendingIds || []);
  const remembered = pendingMetadata instanceof Map
    ? pendingMetadata
    : new Map(Object.entries(pendingMetadata || {}));
  const selected = [];
  const seen = new Set();

  // Preserve the renderer's stable tab/creation order, including exited lanes.
  for (const session of list) {
    if (
      !session
      || typeof session.id !== 'string'
      || !owned.has(session.id)
      || !pending.has(session.id)
    ) continue;
    const captured = remembered.get(session.id);
    if (!(typeof session.profileId === 'string' && session.profileId) && !captured) continue;
    selected.push({ ...captured, ...session });
    seen.add(session.id);
  }

  // A manually closed tab disappears from SessionManager immediately. Keep its
  // captured identity in the barrier and surface a non-ready "removed" result.
  for (const id of pending) {
    if (seen.has(id) || !owned.has(id)) continue;
    const captured = remembered.get(id);
    if (!captured) continue;
    selected.push({ ...captured, id, status: 'removed' });
  }
  return selected;
}
