import { z } from 'zod';

const ID = z.coerce.number().int().positive();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format');

/** A leave application: exactly one member, a type, an inclusive date range and a reason. */
export const leaveRequestSchema = z
  .object({
    leaveTypeId: ID,
    studentId: ID.optional(),
    teacherId: ID.optional(),
    fromDate: DATE,
    toDate: DATE,
    reason: z.string().trim().min(3, 'Say why the leave is needed').max(500),
  })
  // A student/teacher may omit both and apply for themselves; a parent may omit it for a single child.
  .refine((value) => !(value.studentId && value.teacherId), {
    message: 'Choose either a student or a teacher',
    path: ['studentId'],
  })
  .refine((value) => value.toDate >= value.fromDate, {
    message: 'The leave must end on or after it starts',
    path: ['toDate'],
  });

export const leaveDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(300).optional().nullable(),
});
