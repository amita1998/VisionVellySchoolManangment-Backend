import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as chat from '../services/chatService.js';
import { messageSchema, threadSchema } from '../validators/chatValidators.js';

export const threads = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await chat.listThreads(req.user) });
});

export const unread = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await chat.unreadCount(req.user) });
});

export const contacts = asyncHandler(async (req, res) => {
  const studentId = req.query.studentId ? Number(req.query.studentId) : null;
  res.json({ success: true, data: await chat.contacts(req.user, { studentId }) });
});

export const startThread = asyncHandler(async (req, res) => {
  const payload = parseBody(threadSchema, req.body);
  const result = await chat.startThread(req.user, payload);
  res.status(result.created ? 201 : 200).json({ success: true, data: result });
});

export const messages = asyncHandler(async (req, res) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  res.json({ success: true, data: await chat.listMessages(req.user, Number(req.params.id), { before, limit }) });
});

export const send = asyncHandler(async (req, res) => {
  const payload = parseBody(messageSchema, req.body);
  res.status(201).json({ success: true, data: { message: await chat.sendMessage(req.user, Number(req.params.id), payload.body) } });
});

export const read = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await chat.markRead(req.user, Number(req.params.id)) });
});
