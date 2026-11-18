import { asyncHandler, forbidden } from '../utils/errors.js';
import { parseBody, parsePagination } from '../utils/request.js';
import { query } from '../config/db.js';
import { PERMISSIONS, roleHasPermission } from '../config/permissions.js';
import * as teachers from '../services/teacherService.js';
import {
  assignmentsSchema,
  classTeacherSchema,
  teacherSchema,
  teacherStatusSchema,
  updateTeacherSchema,
} from '../validators/peopleValidators.js';

async function assertCanView(req, teacherId) {
  if (roleHasPermission(req.user.role, PERMISSIONS.TEACHER_VIEW_ALL)) return;
  if (req.user.role === 'teacher') {
    const own = await query('SELECT 1 FROM teachers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [
      teacherId,
      req.user.id,
    ]);
    if (own.rows[0]) return;
  }
  throw forbidden('You can only view your own record.', 'TEACHER_FORBIDDEN');
}

export const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const result = await teachers.listTeachers({
    search: req.query.search?.trim() || null,
    status: req.query.status || null,
    page,
    limit,
    offset,
  });
  res.json({ success: true, data: result });
});

export const detail = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await assertCanView(req, id);
  res.json({ success: true, data: await teachers.getTeacher(id) });
});

/** The signed-in teacher's own record + classes; no id in the URL, so nothing to tamper with. */
export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await teachers.myTeaching(req.user.id) });
});

export const create = asyncHandler(async (req, res) => {
  const payload = parseBody(teacherSchema, req.body);
  const result = await teachers.createTeacher({
    payload,
    actor: req.user,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.status(201).json({ success: true, data: result });
});

export const update = asyncHandler(async (req, res) => {
  const payload = parseBody(updateTeacherSchema, req.body);
  const result = await teachers.updateTeacher(
    Number(req.params.id),
    payload,
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const changeStatus = asyncHandler(async (req, res) => {
  const payload = parseBody(teacherStatusSchema, req.body);
  const result = await teachers.changeTeacherStatus(
    Number(req.params.id),
    payload.status,
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const setAssignments = asyncHandler(async (req, res) => {
  const payload = parseBody(assignmentsSchema, req.body);
  const result = await teachers.setAssignments(
    Number(req.params.id),
    payload.items,
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const assignClassTeacher = asyncHandler(async (req, res) => {
  const payload = parseBody(classTeacherSchema, req.body);
  const result = await teachers.assignClassTeacher(
    Number(req.params.id),
    payload,
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const clearClassTeacher = asyncHandler(async (req, res) => {
  const result = await teachers.clearClassTeacher(
    Number(req.params.id),
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const result = await teachers.resetTeacherPassword(
    Number(req.params.id),
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const remove = asyncHandler(async (req, res) => {
  const result = await teachers.deleteTeacher(
    Number(req.params.id),
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});
