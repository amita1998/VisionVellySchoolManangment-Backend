import { asyncHandler, forbidden } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import { query } from '../config/db.js';
import { PERMISSIONS, roleHasPermission } from '../config/permissions.js';
import * as attendance from '../services/attendanceService.js';
import { correctionSchema, markSchema, reviewSchema } from '../validators/attendanceValidators.js';

async function assertCanViewStudent(req, studentId) {
  const { role, id: userId } = req.user;
  if (role === 'admin') return;
  if (role === 'student') {
    const own = await query('SELECT 1 FROM students WHERE id = $1 AND user_id = $2', [studentId, userId]);
    if (own.rows[0]) return;
  }
  if (role === 'parent') {
    const child = await query(
      `SELECT 1 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = $1 AND p.user_id = $2`,
      [studentId, userId],
    );
    if (child.rows[0]) return;
  }
  if (role === 'teacher') {
    const assigned = await query(
      `SELECT 1 FROM enrollments e
        WHERE e.student_id = $1 AND (
          e.section_id IN (SELECT ct.section_id FROM class_teachers ct
                             JOIN teachers t ON t.id = ct.teacher_id WHERE t.user_id = $2)
          OR e.class_id IN (SELECT ts.class_id FROM teacher_subjects ts
                              JOIN teachers t2 ON t2.id = ts.teacher_id WHERE t2.user_id = $2)
        )`,
      [studentId, userId],
    );
    if (assigned.rows[0]) return;
  }
  throw forbidden('You can only view attendance you are allowed to see.', 'ATTENDANCE_FORBIDDEN');
}

export const sections = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { sections: await attendance.mySections(req.user.id) } });
});

export const sheet = asyncHandler(async (req, res) => {
  const data = await attendance.markingSheet({
    userId: req.user.id,
    role: req.user.role,
    sectionId: Number(req.query.sectionId),
    date: req.query.date || null,
  });
  res.json({ success: true, data });
});

export const mark = asyncHandler(async (req, res) => {
  const payload = parseBody(markSchema, req.body);
  const result = await attendance.markAttendance({
    userId: req.user.id,
    sectionId: payload.sectionId,
    date: payload.date,
    entries: payload.entries,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({ success: true, data: result });
});

export const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await attendance.listAttendance(req) });
});

export const summary = asyncHandler(async (req, res) => {
  // '/summary/me' resolves the signed-in student so a pupil never needs to know an id.
  let studentId;
  if (req.params.studentId === 'me') {
    const own = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [
      req.user.id,
    ]);
    if (!own.rows[0]) throw forbidden('No student record is linked to this account.', 'NO_STUDENT_PROFILE');
    studentId = own.rows[0].id;
  } else {
    studentId = Number(req.params.studentId);
    await assertCanViewStudent(req, studentId);
  }
  res.json({
    success: true,
    data: {
      summary: await attendance.studentSummary(studentId),
      months: await attendance.monthly(studentId),
    },
  });
});

export const requestCorrection = asyncHandler(async (req, res) => {
  const payload = parseBody(correctionSchema, req.body);
  const result = await attendance.requestCorrection({
    userId: req.user.id,
    attendanceId: payload.attendanceId,
    requestedStatus: payload.requestedStatus,
    reason: payload.reason,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.status(201).json({ success: true, data: result });
});

export const corrections = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { corrections: await attendance.listCorrections(req) } });
});

export const review = asyncHandler(async (req, res) => {
  const payload = parseBody(reviewSchema, req.body);
  const result = await attendance.reviewCorrection({
    correctionId: Number(req.params.id),
    adminId: req.user.id,
    decision: payload.decision,
    comment: payload.comment,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.json({ success: true, data: result });
});

export { roleHasPermission, PERMISSIONS };
