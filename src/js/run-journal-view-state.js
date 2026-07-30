// ============================================================
// Run Journal async view ownership
//
// List and detail requests may resolve in any order. This small state machine
// gives each request a monotonic generation and binds detail ownership to the
// selected run, so a stale response can never repaint or retarget Delete.
// ============================================================

export class RunJournalViewState {
  constructor() {
    this.selectedRunId = null;
    this._listGeneration = 0;
    this._detailGeneration = 0;
  }

  beginListRequest() {
    this._detailGeneration += 1;
    this._listGeneration += 1;
    return this._listGeneration;
  }

  isCurrentListRequest(generation) {
    return generation === this._listGeneration;
  }

  beginDetailRequest(runId) {
    this.selectedRunId = runId;
    this._detailGeneration += 1;
    return this._detailGeneration;
  }

  isCurrentDetailRequest(generation, runId) {
    return (
      generation === this._detailGeneration
      && runId === this.selectedRunId
    );
  }

  invalidateAll() {
    this._listGeneration += 1;
    this._detailGeneration += 1;
  }

  clearSelectionIf(runId) {
    if (this.selectedRunId === runId) this.selectedRunId = null;
  }

  clearSelection() {
    this.selectedRunId = null;
  }
}
