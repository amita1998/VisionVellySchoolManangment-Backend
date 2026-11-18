import { z } from 'zod';

export const settingsSchema = z.object({
  schoolName: z.string().trim().min(2).max(120).optional(),
  tagline: z.string().trim().max(160).optional().nullable(),
  address: z.string().trim().max(240).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional().nullable(),
  website: z.string().trim().max(160).optional().nullable(),
  feeVisibleToStudents: z.boolean().optional(),
  attendanceLockTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM').optional(),
});
