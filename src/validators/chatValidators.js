import { z } from 'zod';

const ID = z.coerce.number().int().positive();

/** Start (or find) the thread for one child and one teacher. `teacherId` is optional for a teacher. */
export const threadSchema = z.object({
  studentId: ID,
  teacherId: ID.optional(),
});

export const messageSchema = z.object({
  body: z.string().trim().min(1, 'Write a message').max(2000, 'Keep it under 2000 characters'),
});

export default { threadSchema, messageSchema };
