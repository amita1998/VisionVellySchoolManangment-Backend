import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as leave from '../services/leaveService.js';
import { leaveDecisionSchema, leaveRequestSchema } from '../validators/leaveValidators.js';

export const types = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { types: await leave.listTypes(req.user) } });
});

export const requests = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await leave.listRequests(req) });
});

export const balance = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await leave.balance(req) });
});

export const apply = asyncHandler(async (req, res) => {
  const payload = parseBody(leaveRequestSchema, req.body);
  res.status(201).json({ success: true, data: { request: await leave.apply(req.user, payload) } });
});

export const decide = asyncHandler(async (req, res) => {
  const payload = parseBody(leaveDecisionSchema, req.body);
  res.json({ success: true, data: { request: await leave.decide(req.user, Number(req.params.id), payload) } });
});

export const cancel = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { request: await leave.cancel(req.user, Number(req.params.id)) } });
});
