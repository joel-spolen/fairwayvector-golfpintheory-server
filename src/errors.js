export class APIError extends Error {
  constructor(statusCode, code, message, retryAfter) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}