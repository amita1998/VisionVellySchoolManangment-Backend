import { z } from 'zod';
import { validateBody } from '../validators/authValidators.js';
import { AppError } from '../utils/errors.js';

/** Shared helpers: pagination parsing and a zod runner that throws the standard error. */
export function parsePagination(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const requestedLimit = Number.parseInt(req.query.limit, 10) || 20;
  const limit = Math.min(100, Math.max(1, requestedLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function parseBody(schema, body) {
  const parsed = validateBody(schema, body ?? {});
  if (parsed && parsed.__invalid) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Please fix the highlighted fields.', parsed.fields);
  }
  return parsed;
}

export function pagedMeta({ page, limit, total }) {
  return {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

export const optionalId = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])
  .optional();

export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
