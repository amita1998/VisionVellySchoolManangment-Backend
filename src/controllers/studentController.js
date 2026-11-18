import path from 'node:path';
import fs from 'node:fs';
import { asyncHandler, forbidden } from '../utils/errors.js';
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
  res.json({ success: true, data: student });
});

export const create = asyncHandler(async (req, res) => {
  const { payload: rawPayload, documentTypes: rawTypes } = multipart(req);
  const payload = parseBody(admissionSchema, rawPayload);
  const documentTypes = documentTypesSchema.parse(rawTypes) || [];
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
  let types = [];
  try {
    types = JSON.parse(req.body.documentTypes || '[]');
  } catch {
    types = [];
  }
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
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${path.basename(document.file_name).replace(/"/g, '')}"`,
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
