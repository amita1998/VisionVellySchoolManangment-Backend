import { z } from 'zod';

const ID = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const TIME = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM').optional().nullable();

export const AUDIENCES = ['all', 'classes', 'teachers', 'students', 'parents'];
export const ANNOUNCEMENT_TYPES = ['general', 'class_wise', 'circular', 'holiday', 'exam', 'event'];
export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'];

export const eventSchema = z
  .object({
    title: z.string().trim().min(2, 'Required').max(120),
    description: z.string().trim().max(1000).optional().nullable(),
    categoryId: ID.optional().nullable(),
    eventDate: DATE,
    startTime: TIME,
    endTime: TIME,
    location: z.string().trim().max(120).optional().nullable(),
    audience: z.enum(AUDIENCES).default('all'),
    classIds: z.array(ID).max(20).optional(),
    publish: z.boolean().optional(),
  })
  .refine((data) => !data.startTime || !data.endTime || data.startTime < data.endTime, {
    path: ['endTime'],
    message: 'The end time must be after the start time',
  });

export const announcementSchema = z
  .object({
    title: z.string().trim().min(2, 'Required').max(140),
    body: z.string().trim().min(2, 'Required').max(4000),
    type: z.enum(ANNOUNCEMENT_TYPES).default('general'),
    status: z.enum(ANNOUNCEMENT_STATUSES).default('draft'),
    audience: z.enum(AUDIENCES).default('all'),
    classIds: z.array(ID).max(20).optional(),
  })
  .refine((data) => data.audience !== 'classes' || (data.classIds && data.classIds.length > 0), {
    path: ['classIds'],
    message: 'Pick at least one class',
  });

export const notificationReadSchema = z.object({
  read: z.boolean().optional(),
});

export const announcementStatusSchema = z.object({
  status: z.enum(ANNOUNCEMENT_STATUSES),
});

export const assignmentSchema = z.object({
  title: z.string().trim().min(2, 'Required').max(140),
  description: z.string().trim().max(2000).optional().nullable(),
  classId: ID,
  sectionId: ID.optional().nullable(),
  subjectId: ID,
  dueDate: DATE,
});

export const assignmentQuery = z.object({}).optional();

export const periodSchema = z.object({
  periodNo: z.coerce.number().int().min(1).max(20).optional(),
  label: z.string().trim().min(1).max(20),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM'),
  isBreak: z.boolean().optional(),
});

export const slotSchema = z.object({
  sectionId: ID,
  dayOfWeek: z.coerce.number().int().min(1).max(6),
  periodId: ID,
  subjectId: ID,
  teacherId: ID,
  room: z.string().trim().max(40).optional().nullable(),
  effectiveFrom: DATE.optional(),
});
