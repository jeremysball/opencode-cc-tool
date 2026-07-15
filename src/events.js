/**
 * @typedef {object} EventTask
 * @property {string} id
 * @property {string} directory
 * @property {string} status
 * @property {boolean} [internal]
 */

/**
 * Creates daemon-lifetime event state for one task manager instance.
 *
 * @param {((event: object) => void)|undefined} onEvent
 */
export function createTaskEvents(onEvent) {
  let sequence = 0;
  const emittedStatuses = new Map();

  /**
   * @param {EventTask} task
   * @param {string|null} [previousStatus]
   */
  function emitState(task, previousStatus = null) {
    if (typeof onEvent !== "function" || task.internal) return;
    const emittedStatus = emittedStatuses.get(task.id);
    if (emittedStatus === task.status) return;

    emittedStatuses.set(task.id, task.status);
    const event = {
      sequence: ++sequence,
      type: "task.state",
      taskId: task.id,
      directory: task.directory,
      status: task.status,
      previousStatus: emittedStatus ?? previousStatus,
      occurredAt: new Date().toISOString(),
      activity: null,
      outputWatermark: null,
    };
    try {
      onEvent(event);
    } catch (error) {
      // Event consumers observe task state; they cannot interrupt task lifecycle.
      console.error("Dropped task.state event after onEvent failure", {
        taskId: task.id,
        status: event.status,
        sequence: event.sequence,
      }, error);
    }
  }

  return { emitState };
}
