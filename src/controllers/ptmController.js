import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as ptm from '../services/ptmService.js';
import { bookingDecisionSchema, bookingSchema, slotSchema, slotUpdateSchema } from '../validators/ptmValidators.js';

// slots
export const slots = asyncHandler(async (req, res) => {
  const { from, to, teacherId, status, page, limit } = req.query;
  res.json({
    success: true,
    data: await ptm.listSlots(req.user, {
      from: from || null,
      to: to || null,
      teacherId: teacherId ? Number(teacherId) : null,
      status: status || null,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    }),
  });
});

export const createSlot = asyncHandler(async (req, res) => {
  const payload = parseBody(slotSchema, req.body);
  res.status(201).json({ success: true, data: { slot: await ptm.createSlot(req.user, payload) } });
});

export const updateSlot = asyncHandler(async (req, res) => {
  const payload = parseBody(slotUpdateSchema, req.body);
  res.json({ success: true, data: { slot: await ptm.updateSlot(req.user, Number(req.params.id), payload) } });
});

export const deleteSlot = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await ptm.deleteSlot(req.user, Number(req.params.id)) });
});

// bookings
export const bookings = asyncHandler(async (req, res) => {
  const { slotId, studentId, page, limit } = req.query;
  res.json({
    success: true,
    data: await ptm.listBookings(req.user, {
      slotId: slotId ? Number(slotId) : null,
      studentId: studentId ? Number(studentId) : null,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 100,
    }),
  });
});

export const book = asyncHandler(async (req, res) => {
  const payload = parseBody(bookingSchema, req.body);
  res.status(201).json({ success: true, data: { booking: await ptm.bookSlot(req.user, Number(req.params.slotId), payload) } });
});

export const decideBooking = asyncHandler(async (req, res) => {
  const payload = parseBody(bookingDecisionSchema, req.body);
  res.json({ success: true, data: { booking: await ptm.decideBooking(req.user, Number(req.params.id), payload.status) } });
});

export const cancelBooking = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { booking: await ptm.cancelBooking(req.user, Number(req.params.id)) } });
});
