/** Application error with a stable machine-readable code. */
export class AppError extends Error {
  constructor(status, code, message, fields, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }
}

export const badRequest = (message, fields) => new AppError(400, 'VALIDATION_ERROR', message, fields);
export const unauthorized = (message = 'Please sign in to continue.', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have access to this resource.', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, code = 'CONFLICT') => new AppError(409, code, message);

/** Express 4 does not await handlers; wrap every async controller. */
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
