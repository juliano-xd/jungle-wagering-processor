export abstract class DomainError extends Error {
  readonly _tag = 'DomainError';
  protected constructor(message: string, public readonly code: string) {
    super(message);
    this.name = this.constructor.name;
    if (typeof (Error as any).captureStackTrace === 'function') {
      (Error as any).captureStackTrace(this, this.constructor);
    }
  }
}