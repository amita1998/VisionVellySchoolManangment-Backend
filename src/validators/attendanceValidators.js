import { z } from 'zod';

const ID = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');

export const STATUSES = ['present', 'absent', 'late', 'half_day', 'leave'];

export const markSchema = z.object({
  sectionId: ID,
  date: DATE,
  entries: z
    .array(
      z.object({
        studentId: ID,
        status: z.enum(STATUSES),
        remarks: z.string().trim().max(200).optional().nullable(),
      }),
    )
    .min(1, 'Mark at least one student')
    .max(300),
});

export const correctionSchema = z.object({
  attendanceId: ID,
  requestedStatus: z.enum(STATUSES),
  reason: z.string().trim().min(5, 'Give a short reason').max(500),
});

export const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().trim().max(500).optional(),
});
