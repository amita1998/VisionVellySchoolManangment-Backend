import { z } from 'zod';

const NAME = z.string().trim().min(1, 'Required').max(80, 'Too long');
// Indian mobile: exactly ten digits, no spaces, no dashes, no letters, starts 6-9.
const PHONE = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number (digits only)');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const ID = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);

export const STUDENT_STATUSES = [
  'new_admission',
  'active',
  'promoted',
  'academic_year_renewed',
  'graduated',
  'transferred',
  'withdrawn',
  'suspended',
];

const guardianSchema = z.object({
  fullName: NAME,
  relationship: z.enum(['father', 'mother', 'guardian']).default('guardian'),
  mobile: PHONE,
  email: z.union([z.string().trim().email('Enter a valid email'), z.literal('')]).optional(),
  occupation: z.string().trim().max(80).optional(),
  addressLine: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().trim().max(10).optional(),
  isPrimary: z.boolean().optional(),
});

export const admissionSchema = z.object({
  firstName: NAME,
  lastName: NAME,
  gender: z.enum(['male', 'female', 'other']),
  dateOfBirth: DATE,
  bloodGroup: z.string().trim().max(5).optional().nullable(),
  admissionDate: DATE,
  previousSchool: z.string().trim().max(160).optional().nullable(),
  classId: ID,
  sectionId: ID,
  academicYearId: ID.optional(),
  rollNo: z.coerce.number().int().min(0).max(999).optional().nullable(),
  createLogin: z.boolean().optional(),
  parents: z.array(guardianSchema).min(1, 'Add at least one parent or guardian').max(3),
});

/**
 * Every field is optional: the profile screen sends only what the admin actually changed.
 * `classId`/`sectionId` move the student inside the current academic year, `guardians`
 * edits the contact block of an already-linked guardian (never adds or removes one).
 */
const guardianUpdateSchema = z.object({
  id: ID,
  mobile: PHONE.optional(),
  email: z.union([z.string().trim().email('Enter a valid email'), z.literal('')]).optional().nullable(),
  occupation: z.string().trim().max(80).optional().nullable(),
  addressLine: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  pincode: z.string().trim().max(10).optional().nullable(),
});

export const updateStudentSchema = z
  .object({
    firstName: NAME.optional(),
    lastName: NAME.optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    dateOfBirth: DATE.optional(),
    bloodGroup: z.string().trim().max(5).optional().nullable(),
    previousSchool: z.string().trim().max(160).optional().nullable(),
    rollNo: z.union([z.coerce.number().int().min(0).max(999), z.null()]).optional(),
    classId: ID.optional(),
    sectionId: ID.optional(),
    guardians: z.array(guardianUpdateSchema).max(3).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Send at least one field to update',
  });

export const studentStatusSchema = z.object({
  status: z.enum(STUDENT_STATUSES),
  effectiveDate: DATE,
  remarks: z.string().trim().max(500).optional(),
});

export const documentTypesSchema = z.array(z.string().trim().max(60)).max(6).optional();

// ---------------------------------------------------------------------------

export const teacherSchema = z.object({
  firstName: NAME,
  lastName: NAME,
  gender: z.enum(['male', 'female', 'other']),
  dateOfBirth: DATE.optional().nullable(),
  mobile: PHONE,
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  address: z.string().trim().max(240).optional().nullable(),
  qualification: z.string().trim().max(120).optional().nullable(),
  experienceYears: z.coerce.number().min(0).max(60).optional().nullable(),
  joiningDate: DATE,
  assignments: z
    .array(z.object({ classId: ID, subjectId: ID }))
    .max(60)
    .optional(),
});

// The email is the teacher's login name, so it is editable — the service renames the account.
// No `status` here on purpose: a plain edit must not be able to resign a class teacher, which
// would skip the "still a class teacher" guard that /teachers/:id/status enforces.
export const updateTeacherSchema = teacherSchema.omit({ assignments: true }).partial();

export const teacherStatusSchema = z.object({
  status: z.enum(['active', 'on_leave', 'resigned']),
});

export const assignmentsSchema = z.object({
  items: z.array(z.object({ classId: ID, subjectId: ID })).max(60),
});

export const classTeacherSchema = z.object({
  sectionId: ID,
  effectiveFrom: DATE,
});

// ---------------------------------------------------------------------------

export const classSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(40),
  levelOrder: z.coerce.number().int().min(0).max(30),
  isPrePrimary: z.boolean().optional(),
  strengthLimit: z.coerce.number().int().min(1).max(200).optional(),
});

/** A section carries a stream only for Class 11/12; the service rejects a stream elsewhere. */
export const sectionSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(10),
  capacity: z.coerce.number().int().min(1).max(200).optional(),
  streamId: z.union([ID, z.literal(''), z.null()]).optional(),
});

export const subjectSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(60),
  code: z
    .string()
    .trim()
    .min(1, 'Required')
    .max(12)
    .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and dashes only'),
  isPrePrimary: z.boolean().optional(),
});

/** Stream is required by the service for Class 11/12 and refused for every other class. */
export const classSubjectsSchema = z.object({
  subjectIds: z.array(ID).max(40),
  streamId: z.union([ID, z.literal(''), z.null()]).optional(),
});

export const academicYearSchema = z
  .object({
    name: z.string().trim().regex(/^\d{4}-\d{4}$/, 'Use the 2026-2027 format'),
    startDate: DATE,
    endDate: DATE,
  })
  .refine((data) => data.startDate < data.endDate, {
    path: ['endDate'],
    message: 'The end date must be after the start date',
  });
