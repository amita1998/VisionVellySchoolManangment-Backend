import path from 'node:path';
import fs from 'node:fs';
import { asyncHandler, badRequest, forbidden } from '../utils/errors.js';
import { parseBody, parsePagination } from '../utils/request.js';
import { absolutePath, mapUploadError } from '../utils/uploads.js';
import { query } from '../config/db.js';
import * as students from '../services/studentService.js';
import { PERMISSIONS } from '../config/permissions.js';
import { roleHasPermission } from '../config/permissions.js';
import {
  admissionSchema,
  documentTypesSchema,
  studentStatusSchema,
  updateStudentSchema,
} from '../validators/peopleValidators.js';

/** Zod errors here must become the standard 400 envelope, not a raw 500. */
function parseDocumentTypes(raw) {
  const parsed = documentTypesSchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('Check the document types.', { documentTypes: parsed.error.issues[0]?.message ?? 'Invalid' });
  }
  return parsed.data || [];
}

function multipart(req) {
  if (req.is('multipart/form-data')) {
    let payload = {};
    try {
      payload = JSON.parse(req.body.payload || '{}');
    } catch {
      payload = {};
    }
    let documentTypes = [];
    try {
      documentTypes = JSON.parse(req.body.documentTypes || '[]');
    } catch {
      documentTypes = [];
    }
    return { payload, documentTypes };
  }
  return { payload: req.body, documentTypes: [] };
}

/** A student may read their own record; a parent only their own children. */
async function assertCanView(req, studentId) {
  const { role, id: userId } = req.user;
  if (roleHasPermission(role, PERMISSIONS.STUDENT_VIEW_ALL)) return;
  if (role === 'student') {
    const own = await query('SELECT 1 FROM students WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [
      studentId,
      userId,
    ]);
    if (own.rows[0]) return;
  }
  if (role === 'parent') {
    const linked = await query(
      `SELECT 1 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = $1 AND p.user_id = $2`,
      [studentId, userId],
    );
    if (linked.rows[0]) return;
  }
  // A teacher holds student.view.assigned and can list the roster; opening one of those students
  // used to answer 403. Scope it in SQL: the student must be in a class/section they teach this year.
  if (role === 'teacher') {
    const teaches = await query(
      `SELECT 1
         FROM enrollments e
         JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.is_current AND ay.deleted_at IS NULL
        WHERE e.student_id = $1 AND e.status = 'active'
          AND (
            EXISTS (SELECT 1 FROM class_teachers ct
                     WHERE ct.academic_year_id = e.academic_year_id
                       AND ct.section_id = e.section_id AND ct.teacher_id = (SELECT id FROM teachers WHERE user_id = $2 AND deleted_at IS NULL))
            OR EXISTS (SELECT 1 FROM teacher_subjects ts
                        WHERE ts.academic_year_id = e.academic_year_id
                          AND ts.class_id = e.class_id AND ts.teacher_id = (SELECT id FROM teachers WHERE user_id = $2 AND deleted_at IS NULL))
          )
        LIMIT 1`,
      [studentId, userId],
    );
    if (teaches.rows[0]) return;
  }
  throw forbidden('You can only view your own records.', 'STUDENT_FORBIDDEN');
}

export const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const result = await students.listStudents(
    {
      search: req.query.search?.trim() || null,
      classId: req.query.classId ? Number(req.query.classId) : null,
      sectionId: req.query.sectionId ? Number(req.query.sectionId) : null,
      status: req.query.status || null,
      page,
      limit,
      offset,
    },
    req.user,
  );
  res.json({ success: true, data: result });
});

export const detail = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  await assertCanView(req, id);
  const student = await students.getStudent(id);

  // Login metadata (username, last login, password flags) and the admin usernames in the status
  // history are office information; a parent or a student has no use for them.
  if (req.user.role !== 'admin') {
    delete student.login;
    if (Array.isArray(student.statusHistory)) {
      student.statusHistory = student.statusHistory.map(({ changed_by: _ignored, ...rest }) => rest);
    }
  }
  res.json({ success: true, data: student });
});

export const create = asyncHandler(async (req, res) => {
  const { payload: rawPayload, documentTypes: rawTypes } = multipart(req);
  const payload = parseBody(admissionSchema, rawPayload);
  const documentTypes = parseDocumentTypes(rawTypes);
  const result = await students.createStudent({
    payload,
    files: req.files || [],
    documentTypes,
    actor: req.user,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
  res.status(201).json({ success: true, data: result });
});

export const update = asyncHandler(async (req, res) => {
  const payload = parseBody(updateStudentSchema, req.body);
  const student = await students.updateStudent(
    Number(req.params.id),
    payload,
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: student });
});

export const changeStatus = asyncHandler(async (req, res) => {
  const payload = parseBody(studentStatusSchema, req.body);
  const student = await students.changeStatus(
    Number(req.params.id),
    payload,
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: student });
});

export const remove = asyncHandler(async (req, res) => {
  const result = await students.softDeleteStudent(
    Number(req.params.id),
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const result = await students.resetStudentPassword(
    Number(req.params.id),
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const resetGuardianPassword = asyncHandler(async (req, res) => {
  const result = await students.resetGuardianPassword(
    Number(req.params.id),
    Number(req.params.parentId),
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export const addDocuments = asyncHandler(async (req, res) => {
  let rawTypes = [];
  try {
    rawTypes = JSON.parse(req.body.documentTypes || '[]');
  } catch {
    rawTypes = [];
  }
  const types = parseDocumentTypes(rawTypes);
  const inserted = await students.addDocuments(
    Number(req.params.id),
    req.files || [],
    types,
    req.user,
  );
  res.status(201).json({ success: true, data: inserted });
});

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) return null;
  return { start, end };
}

/** Streams the stored file with an explicit content type and a safe disposition. */
export const downloadDocument = asyncHandler(async (req, res, next) => {
  const document = await students.getDocument(Number(req.params.docId));
  if (document.owner_type === 'student') await assertCanView(req, document.owner_id);
  else if (!roleHasPermission(req.user.role, PERMISSIONS.STUDENT_VIEW_ALL)) {
    throw forbidden('Not allowed.');
  }

  const filePath = absolutePath(document.file_path);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ success: false, error: { code: 'FILE_MISSING', message: 'The stored file is missing.' } });
    return;
  }

  const size = fs.statSync(filePath).size;
  res.setHeader('Content-Type', document.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Downloads are attachments on purpose: a file that slipped through the type checks must never be
  // rendered inside the app's origin.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${path.basename(document.file_name).replace(/"/g, '')}"`,
  );

  const range = parseRange(req.headers.range, size);
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath, range).pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(size));
  fs.createReadStream(filePath).pipe(res);
  return next;
});

export const deleteDocument = asyncHandler(async (req, res) => {
  const result = await students.deleteDocument(
    Number(req.params.docId),
    req.user,
    req.ip,
    req.headers['user-agent'],
  );
  res.json({ success: true, data: result });
});

export { mapUploadError };
