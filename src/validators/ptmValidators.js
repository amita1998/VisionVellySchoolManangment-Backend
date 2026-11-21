import { z } from 'zod';

const ID = z.coerce.number().int().positive();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format');
const TIME = z.string().regex(/^\d{2}:\d{2}$/, 'Use the HH:MM format');

/** A teacher's meeting slot. `teacherId` is optional: a teacher is always themselves. */
export const slotSchema = z
  .object({
    teacherId: ID.optional(),
    slotDate: DATE,
    startTime: TIME,
    endTime: TIME,
    mode: z.enum(['in_person', 'online', 'phone']).optional(),
    location: z.string().trim().max(120).optional().nullable(),
    capacity: z.coerce.number().int().min(1).max(20).optional(),
    notes: z.string().trim().max(300).optional().nullable(),
  })
  .refine((value) => value.endTime > value.startTime, {
    message: 'The slot must end after it starts',
    path: ['endTime'],
  });

export const slotUpdateSchema = z.object({
  status: z.enum(['open', 'closed', 'cancelled']).optional(),
  notes: z.string().trim().max(300).optional().nullable(),
  location: z.string().trim().max(120).optional().nullable(),
  capacity: z.coerce.number().int().min(1).max(20).optional(),
});

export const bookingSchema = z.object({
  studentId: ID,
  note: z.string().trim().max(300).optional().nullable(),
});

export const bookingDecisionSchema = z.object({
  status: z.enum(['attended', 'no_show']),
});
