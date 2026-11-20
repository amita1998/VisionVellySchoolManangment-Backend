import { z } from 'zod';

const ID = z.coerce.number().int().positive();
const TEXT = (max) => z.string().trim().max(max);

/** Catalogue payload. `totalCopies` is the shelf count; availability is derived by the service. */
export const bookSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  author: TEXT(160).optional().nullable(),
  isbn: TEXT(32).optional().nullable(),
  category: z.string().trim().min(1).max(60).optional(),
  publisher: TEXT(120).optional().nullable(),
  publishedYear: z.coerce.number().int().min(1400).max(2100).optional().nullable(),
  totalCopies: z.coerce.number().int().min(1).max(999).optional(),
  shelf: TEXT(40).optional().nullable(),
  isActive: z.boolean().optional(),
});

/** Every field optional: the edit form sends only what changed. */
export const bookUpdateSchema = bookSchema.partial();

/**
 * A loan belongs to exactly one member. The XOR is validated here so the caller gets a field
 * error instead of the database's check-constraint message.
 */
export const issueSchema = z
  .object({
    bookId: ID,
    studentId: ID.optional(),
    teacherId: ID.optional(),
    loanDays: z.coerce.number().int().min(1).max(180).optional(),
    notes: TEXT(300).optional().nullable(),
  })
  .refine((value) => Boolean(value.studentId) !== Boolean(value.teacherId), {
    message: 'Choose either a student or a teacher',
    path: ['studentId'],
  });

export const returnSchema = z
  .object({
    finePaid: z.boolean().optional(),
    lost: z.boolean().optional(),
    notes: TEXT(300).optional().nullable(),
  })
  .optional();
