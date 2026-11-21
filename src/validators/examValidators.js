import { z } from 'zod';

const ID = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const TIME = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');

export const EXAM_TYPES = ['unit_test', 'mid_term', 'final', 'practical', 'internal_assessment'];

export const examSchema = z
  .object({
    name: z.string().trim().min(2, 'Required').max(80),
    examType: z.enum(EXAM_TYPES),
    startDate: DATE,
    endDate: DATE,
  })
  .refine((data) => data.startDate <= data.endDate, {
    path: ['endDate'],
    message: 'The end date cannot be before the start date',
  });

export const scheduleSchema = z
  .object({
    classId: ID,
    subjectId: ID,
    examDate: DATE,
    startTime: TIME,
    endTime: TIME,
    room: z.string().trim().max(40).optional().nullable(),
    maxMarks: z.coerce.number().min(1).max(500).optional(),
  })
  .refine((data) => data.startTime < data.endTime, {
    path: ['endTime'],
    message: 'The end time must be after the start time',
  });

export const publishSchema = z.object({ publish: z.boolean() });

/**
 * A mark is a finite number or nothing. `Number('abc')` is NaN, and both `NaN < 0` and `NaN > max`
 * are false — a NaN used to slip through validation into a NUMERIC column and turn a whole class's
 * totals into NaN.
 */
const MARK_VALUE = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .refine(
    (value) => value === null || value === undefined || value === '' || Number.isFinite(Number(value)),
    { message: 'Enter a number' },
  );

export const marksSchema = z.object({
  submit: z.boolean().optional().default(false),
  entries: z
    .array(
      z.object({
        studentId: ID,
        marksObtained: MARK_VALUE,
        isAbsent: z.boolean().optional(),
        remarks: z.string().trim().max(200).optional().nullable(),
      }),
    )
    .min(1, 'Nothing to save')
    .max(300),
});

export const unlockSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const overrideSchema = z.object({
  studentId: ID,
  marksObtained: MARK_VALUE,
  isAbsent: z.boolean().optional(),
  reason: z.string().trim().min(5, 'A reason is required').max(300),
});
