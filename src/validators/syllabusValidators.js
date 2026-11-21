import { z } from 'zod';

const ID = z.coerce.number().int().positive();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format');

export const chapterSchema = z.object({
  classId: ID,
  streamId: ID.optional().nullable(),
  subjectId: ID,
  chapterNo: z.coerce.number().int().min(1, 'Start at chapter 1').max(999),
  title: z.string().trim().min(1, 'Write the chapter name').max(200),
  description: z.string().trim().max(1000).optional().nullable(),
});

export const chapterUpdateSchema = z
  .object({
    title: z.string().trim().min(1, 'Write the chapter name').max(200).optional(),
    description: z.string().trim().max(1000).optional().nullable(),
    chapterNo: z.coerce.number().int().min(1).max(999).optional(),
    coveredOn: DATE.optional().nullable(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Send at least one field to update.',
    path: ['title'],
  });

export const portionSchema = z.object({
  chapterIds: z.array(ID).max(200),
});

export default { chapterSchema, chapterUpdateSchema, portionSchema };
