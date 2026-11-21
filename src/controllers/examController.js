import { asyncHandler, forbidden, badRequest } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import { query } from '../config/db.js';
import * as exams from '../services/examService.js';
import {
  examSchema,
  marksSchema,
  overrideSchema,
  publishSchema,
  scheduleSchema,
  unlockSchema,
} from '../validators/examValidators.js';

const meta = (req) => ({ actor: req.user, ip: req.ip, userAgent: req.headers['user-agent'] });

// ---------- exams ----------
export const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { exams: await exams.listExams({ yearId: req.query.yearId ? Number(req.query.yearId) : null }) } });
});

export const create = asyncHandler(async (req, res) => {
  const payload = parseBody(examSchema, req.body);
  res.status(201).json({ success: true, data: await exams.createExam({ ...payload, ...meta(req) }) });
});

export const detail = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await exams.getExam(Number(req.params.id)) });
});

export const addSchedule = asyncHandler(async (req, res) => {
  const payload = parseBody(scheduleSchema, req.body);
  const result = await exams.addSchedule({ examId: Number(req.params.id), ...payload, ...meta(req) });
  res.status(201).json({ success: true, data: result });
});

export const removeSchedule = asyncHandler(async (req, res) => {
  const result = await exams.deleteSchedule({
    examId: Number(req.params.id),
    scheduleId: Number(req.params.scheduleId),
    ...meta(req),
  });
  res.json({ success: true, data: result });
});

export const publish = asyncHandler(async (req, res) => {
  const payload = parseBody(publishSchema, req.body);
  const result = await exams.setPublished({ examId: Number(req.params.id), publish: payload.publish, ...meta(req) });
  res.json({ success: true, data: result });
});

export const mine = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { papers: await exams.myPapers(req.user.id) } });
});

// ---------- marks ----------
export const marksSheet = asyncHandler(async (req, res) => {
  const data = await exams.marksSheet({
    scheduleId: Number(req.params.scheduleId),
    userId: req.user.id,
    role: req.user.role,
  });
  res.json({ success: true, data });
});

export const saveMarks = asyncHandler(async (req, res) => {
  const payload = parseBody(marksSchema, req.body);
  const entries = payload.entries.map((entry) => ({
    studentId: entry.studentId,
    isAbsent: Boolean(entry.isAbsent),
    marksObtained:
      entry.isAbsent || entry.marksObtained === null || entry.marksObtained === ''
        ? null
        : Number(entry.marksObtained),
    remarks: entry.remarks ?? null,
  }));

  const result = await exams.saveMarks({
    scheduleId: Number(req.params.scheduleId),
    userId: req.user.id,
    role: req.user.role,
    entries,
    submit: Boolean(payload.submit),
    ...meta(req),
  });
  res.json({ success: true, data: result });
});

export const unlock = asyncHandler(async (req, res) => {
  const payload = parseBody(unlockSchema, req.body || {});
  const result = await exams.unlockMarks({
    scheduleId: Number(req.params.scheduleId),
    adminId: req.user.id,
    reason: payload.reason,
    ...meta(req),
  });
  res.json({ success: true, data: result });
});

export const override = asyncHandler(async (req, res) => {
  const payload = parseBody(overrideSchema, req.body);
  const result = await exams.overrideMark({
    scheduleId: Number(req.params.scheduleId),
    studentId: payload.studentId,
    marksObtained: payload.marksObtained === null || payload.marksObtained === '' ? null : Number(payload.marksObtained),
    isAbsent: Boolean(payload.isAbsent),
    reason: payload.reason,
    adminId: req.user.id,
    ...meta(req),
  });
  res.json({ success: true, data: result });
});

// ---------- results / report cards ----------
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
    const teaches = await query(
      `SELECT 1 FROM enrollments e
         JOIN teacher_subjects ts ON ts.class_id = e.class_id
         JOIN teachers t ON t.id = ts.teacher_id
        WHERE e.student_id = $1 AND t.user_id = $2 LIMIT 1`,
      [studentId, userId],
    );
    if (teaches.rows[0]) return;
  }
  throw forbidden('You can only view your own results.', 'RESULT_FORBIDDEN');
}

async function resolveStudentId(req) {
  if (req.params.studentId !== 'me') return Number(req.params.studentId);
  const own = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [req.user.id]);
  if (!own.rows[0]) throw forbidden('No student record is linked to this account.', 'NO_STUDENT_PROFILE');
  return own.rows[0].id;
}

export const reportCard = asyncHandler(async (req, res) => {
  const studentId = await resolveStudentId(req);
  const examId = Number(req.query.examId);
  if (!examId) throw badRequest('examId is required');

  await assertCanViewStudent(req, studentId);
  const card = await exams.reportCard({ studentId, examId });

  // Students and parents only see published results.
  if (['student', 'parent'].includes(req.user.role) && card.exam.publish_status !== 'published') {
    throw forbidden('These results have not been published yet.', 'RESULT_NOT_PUBLISHED');
  }
  res.json({ success: true, data: card });
});

export const publishedExams = asyncHandler(async (req, res) => {
  const studentId = await resolveStudentId(req);
  await assertCanViewStudent(req, studentId);
  const isStaff = ['admin', 'teacher'].includes(req.user.role);

  const { rows } = await query(
    `SELECT DISTINCT ex.id, ex.name, ex.exam_type, ex.publish_status, ex.start_date, ex.published_at,
            to_char(ex.published_at, 'DD-MM-YYYY') AS published_on
       FROM examinations ex
       JOIN exam_schedules s ON s.exam_id = ex.id
       JOIN enrollments e ON e.class_id = s.class_id AND e.academic_year_id = ex.academic_year_id
      WHERE e.student_id = $1 AND ex.deleted_at IS NULL
        ${isStaff ? '' : "AND ex.publish_status = 'published'"}
      ORDER BY ex.published_at DESC NULLS LAST, ex.start_date DESC`,
    [studentId],
  );
  res.json({ success: true, data: { exams: rows } });
});

export const classResults = asyncHandler(async (req, res) => {
  const examId = Number(req.params.examId);
  const classId = Number(req.params.classId);
  res.json({ success: true, data: { results: await exams.classResults({ examId, classId, user: req.user }) } });
});
