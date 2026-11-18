import { z } from 'zod';

export const PASSWORD_POLICY_TEXT =
  'At least 8 characters, with one uppercase letter, one lowercase letter and one digit.';

const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Z]/, 'Add at least one uppercase letter')
  .regex(/[a-z]/, 'Add at least one lowercase letter')
  .regex(/[0-9]/, 'Add at least one digit');

/**
 * Sign-in is credential-only: the server reads the role from the account, so `role`
 * is accepted (older clients still send it and a mismatch is still refused) but it is
 * never required. `users.username` is unique case-insensitively, so the identifier
 * resolves to exactly one account.
 */
export const loginSchema = z.object({
  role: z
    .enum(['admin', 'teacher', 'student', 'parent'], {
      errorMap: () => ({ message: 'Select a role' }),
    })
    .optional(),
  identifier: z
    .string()
    .trim()
    .min(3, 'Enter your email, username or Admission ID')
    .max(160, 'That is too long'),
  password: z.string().min(1, 'Enter your password').max(72),
  rememberMe: z.boolean().optional().default(false),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordField,
    confirmPassword: z.string().min(1, 'Confirm the new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export function validateBody(schema, body) {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return { __invalid: true, fields };
}
