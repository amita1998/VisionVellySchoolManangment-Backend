import { asyncHandler, badRequest, forbidden } from '../utils/errors.js';
import { query } from '../config/db.js';
import { parseBody, parsePagination } from '../utils/request.js';
import * as fees from '../services/feeService.js';
import {
  assignSchema,
  categorySchema,
  paymentSchema,
  reversalSchema,
  structureSchema,
} from '../validators/feeValidators.js';

const meta = (req) => ({ actor: req.user, ip: req.ip, userAgent: req.headers['user-agent'] });

export const categories = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { categories: await fees.listCategories() } });
});

export const createCategory = asyncHandler(async (req, res) => {
  const payload = parseBody(categorySchema, req.body);
  res.status(201).json({ success: true, data: await fees.createCategory(payload, req.user, req.ip, req.headers['user-agent']) });
});

export const structures = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { structures: await fees.listStructures() } });
});

export const createStructure = asyncHandler(async (req, res) => {
  const payload = parseBody(structureSchema, req.body);
  res.status(201).json({ success: true, data: await fees.createStructure(payload, req.user, req.ip, req.headers['user-agent']) });
});

export const deleteStructure = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await fees.deleteStructure(Number(req.params.id), req.user, req.ip, req.headers['user-agent']) });
});

export const assign = asyncHandler(async (req, res) => {
  const payload = parseBody(assignSchema, req.body);
  res.status(201).json({ success: true, data: await fees.assignFees(payload, req.user, req.ip, req.headers['user-agent']) });
});

export const payments = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  res.json({
    success: true,
    data: await fees.listPayments({
      from: req.query.from || null,
      to: req.query.to || null,
      search: req.query.search || null,
      page,
      limit,
      offset,
    }),
  });
});

export const recordPayment = asyncHandler(async (req, res) => {
  const payload = parseBody(paymentSchema, req.body);
  res.status(201).json({ success: true, data: await fees.recordPayment(payload, req.user, req.ip, req.headers['user-agent']) });
});

export const reverse = asyncHandler(async (req, res) => {
  const payload = parseBody(reversalSchema, req.body);
  res.status(201).json({
    success: true,
    data: await fees.reversePayment(
      { paymentId: Number(req.params.id), reason: payload.reason },
      req.user,
      req.ip,
      req.headers['user-agent'],
    ),
  });
});

export const overview = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await fees.receivableSummary() });
});

export const summary = asyncHandler(async (req, res) => {
  // `me` is the student's own record: the client should never have to know its student id.
  let studentId;
  if (req.params.studentId === 'me') {
    const own = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [req.user.id]);
    if (!own.rows[0]) throw forbidden('No student record is linked to this account.', 'NO_STUDENT_PROFILE');
    studentId = Number(own.rows[0].id);
  } else {
    studentId = Number(req.params.studentId);
    if (!Number.isInteger(studentId) || studentId <= 0) {
      throw badRequest('That student id is not valid.', { studentId: 'Invalid student id' });
    }
  }

  const allowed = await fees.studentFeeAccess(req.user.role, studentId, req.user.id);
  if (!allowed) {
    throw forbidden(
      req.user.role === 'student'
        ? 'Fee details are not visible to students at this school.'
        : 'You can only view fees for your own children.',
      'FEE_FORBIDDEN',
    );
  }
  res.json({ success: true, data: await fees.studentSummary(studentId) });
});
