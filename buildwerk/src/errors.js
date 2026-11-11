/** A failed operation. Caught by try/catch blocks and by «Bei Fehler: fortfahren». */
export class OperationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OperationError';
    Object.assign(this, details);
  }
}

/** Base class for signals that unwind the operation stack without being failures. */
export class ControlSignal extends Error {}

/** The user (or a signal) stopped the run. */
export class CancelledError extends ControlSignal {
  constructor() {
    super('Ausführung abgebrochen');
  }
}

/** «Makro beenden»: ends the run successfully. */
export class StopSignal extends ControlSignal {}

/** «Schleife verlassen» / «Nächster Durchlauf». */
export class BreakSignal extends ControlSignal {}
export class ContinueSignal extends ControlSignal {}

export function toOperationError(error) {
  if (error instanceof OperationError) return error;
  const wrapped = new OperationError(error?.message || String(error));
  wrapped.cause = error;
  return wrapped;
}
