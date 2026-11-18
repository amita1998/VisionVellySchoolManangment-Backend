import { validateBody } from '../validators/authValidators.js';
import { AppError } from '../utils/errors.js';

/**
 * Validates req[source] against a zod schema and replaces it with the parsed value.
 * Unknown keys are stripped by zod, so a client cannot smuggle extra fields in.
 */
export function validate(schema, source = 'body') {
  return function validating(req, _res, next) {
    const parsed = validateBody(schema, req[source] ?? {});
    if (parsed && parsed.__invalid) {
      return next(
        new AppError(400, 'VALIDATION_ERROR', 'Please fix the highlighted fields.', parsed.fields),
      );
    }
    req[source] = parsed;
    return next();
  };
}

export default validate;
