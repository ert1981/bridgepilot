/** Structured error returned to client agents. Never includes stack traces. */
export class ApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ProviderErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'BAD_RESPONSE'
  | 'NETWORK'
  | 'NO_ROUTE'
  | 'UNSUPPORTED'
  | 'ABORTED';

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.code === 'TIMEOUT' || this.code === 'RATE_LIMITED' || this.code === 'HTTP_5XX' || this.code === 'NETWORK';
  }
}
