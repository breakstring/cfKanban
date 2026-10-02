export class LocalRuntimeError extends Error {
  constructor(code, { outcomeUnknown = false } = {}) {
    super('The local workbench operation was refused. Verify the local service and selected connection.');
    this.name = 'LocalRuntimeError';
    this.code = code;
    this.outcome_unknown = outcomeUnknown;
  }
}
export const failure = (code, outcome_unknown = false) => ({ ok: false, error: { code }, ...(outcome_unknown ? { outcome_unknown: true } : {}) });
