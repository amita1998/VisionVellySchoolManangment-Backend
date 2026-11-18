import { z } from 'zod';

const ID = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const MONEY = z.coerce.number().min(0).max(10000000);

export const PAYMENT_MODES = ['cash', 'cheque', 'bank_transfer', 'upi', 'card'];
export const PLANS = ['monthly', 'quarterly', 'term', 'one_time'];

export const categorySchema = z.object({
  name: z.string().trim().min(1, 'Required').max(60),
  code: z.string().trim().min(1, 'Required').max(12).regex(/^[A-Za-z]+$/, 'Letters only'),
});

export const structureSchema = z.object({
  name: z.string().trim().min(2, 'Required').max(80),
  classId: ID,
  categoryId: ID,
  totalAmount: MONEY,
  installmentPlan: z.enum(PLANS),
});

export const assignSchema = z
  .object({
    structureId: ID,
    studentIds: z.array(ID).max(500).optional(),
    classId: ID.optional(),
    concession: MONEY.optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((data) => (data.studentIds && data.studentIds.length > 0) || data.classId, {
    path: ['studentIds'],
    message: 'Choose students or a whole class',
  });

export const paymentSchema = z.object({
  studentFeeId: ID,
  amount: MONEY.refine((value) => value > 0, 'Amount must be positive'),
  paymentMode: z.enum(PAYMENT_MODES),
  referenceNo: z.string().trim().max(60).optional().nullable(),
  paidOn: DATE,
  remarks: z.string().trim().max(200).optional().nullable(),
});

export const reversalSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason').max(300),
});
