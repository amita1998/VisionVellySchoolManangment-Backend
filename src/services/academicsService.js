import { config } from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import { AppError, conflict, notFound } from '../utils/errors.js';

/**
 * `badRequest()` in utils/errors.js takes *fields* as its second argument, not a code.
 * Stream rules need their own machine-readable codes so the UI can point at the right control,
 * so they raise AppError directly.
 */
const badRequestWithCode = (message, code) => new AppError(400, code, message);

/** Current academic year (one row max, enforced by a partial unique index). */
export async function currentYear(client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    'SELECT id, name, start_date, end_date, is_current FROM academic_years WHERE is_current AND deleted_at IS NULL LIMIT 1',
  );
  return rows[0] || null;
}

export async function listAcademicYears() {
  const { rows } = await query(
    `SELECT id, name, start_date, end_date, is_current, is_closed,
            to_char(start_date, 'DD-MM-YYYY') AS start_label,
            to_char(end_date, 'DD-MM-YYYY') AS end_label
       FROM academic_years WHERE deleted_at IS NULL ORDER BY start_date DESC`,
  );
  return rows;
}

export async function createAcademicYear({ name, startDate, endDate }) {
  try {
    const { rows } = await query(
      `INSERT INTO academic_years (name, start_date, end_date) VALUES ($1, $2, $3)
       RETURNING id, name, start_date, end_date, is_current`,
      [name, startDate, endDate],
    );
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw conflict('That academic year already exists.', 'YEAR_EXISTS');
    throw error;
  }
}

export async function setCurrentYear(yearId, actorId) {
  return withTransaction(async (client) => {
    const exists = await client.query('SELECT id FROM academic_years WHERE id = $1 AND deleted_at IS NULL', [
      yearId,
    ]);
    if (!exists.rows[0]) throw notFound('Academic year not found.');

    await client.query('UPDATE academic_years SET is_current = FALSE WHERE is_current');
    await client.query('UPDATE academic_years SET is_current = TRUE WHERE id = $1', [yearId]);
    await client.query(
      `UPDATE school_settings SET current_academic_year_id = $1, updated_by = $2 WHERE id = 1`,
      [yearId, actorId ?? null],
    );
    const { rows } = await client.query(
      'SELECT id, name, start_date, end_date, is_current FROM academic_years WHERE id = $1',
      [yearId],
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Classes and sections
// ---------------------------------------------------------------------------

/**
 * Streams exist for the senior classes only (Class 11 and 12, `level_order >= 13`).
 * Everything else keeps `stream_id IS NULL`, which is why no existing row had to change.
 */
const SENIOR_LEVEL = 13;

export function classNeedsStream(levelOrder) {
  return Number(levelOrder) >= SENIOR_LEVEL;
}

export async function listStreams() {
  const { rows } = await query(
    `SELECT id, code, name FROM streams WHERE deleted_at IS NULL AND is_active ORDER BY name`,
  );
  return rows;
}

async function assertStreamForClass(client, classId, streamId) {
  const { rows } = await client.query(
    'SELECT id, name, level_order, strength_limit FROM classes WHERE id = $1 AND deleted_at IS NULL',
    [classId],
  );
  const klass = rows[0];
  if (!klass) throw notFound('Class not found.');
  const senior = classNeedsStream(klass.level_order);

  if (!senior && streamId) {
    throw badRequestWithCode(
      `${klass.name} does not use streams — only Class 11 and Class 12 do.`,
      'STREAM_NOT_APPLICABLE',
    );
  }
  if (senior && !streamId) {
    throw badRequestWithCode(
      `${klass.name} needs a stream (Science / Commerce / Arts).`,
      'STREAM_REQUIRED',
    );
  }
  if (streamId) {
    const stream = await client.query(
      'SELECT id FROM streams WHERE id = $1 AND deleted_at IS NULL AND is_active',
      [streamId],
    );
    if (!stream.rows[0]) throw badRequestWithCode('Unknown stream.', 'STREAM_NOT_FOUND');
  }
  return klass;
}

export async function listClasses() {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT c.id, c.name, c.level_order, c.is_pre_primary, c.strength_limit,
            (c.level_order >= ${SENIOR_LEVEL}) AS needs_stream,
            (SELECT count(*)::int FROM class_subjects cs
               JOIN subjects sub ON sub.id = cs.subject_id AND sub.deleted_at IS NULL
              WHERE cs.class_id = c.id) AS subject_count,
            (SELECT count(*)::int FROM enrollments e
              WHERE e.class_id = c.id AND e.academic_year_id = $1 AND e.status = 'active') AS student_count,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', s.id, 'name', s.name, 'capacity', s.capacity,
                       'stream_id', s.stream_id,
                       'stream', (SELECT st.name FROM streams st WHERE st.id = s.stream_id),
                       'students', (SELECT count(*)::int FROM enrollments e2
                                     WHERE e2.section_id = s.id AND e2.academic_year_id = $1
                                       AND e2.status = 'active'),
                       'class_teacher', (SELECT trim(concat(t.first_name, ' ', t.last_name))
                                           FROM class_teachers ct JOIN teachers t ON t.id = ct.teacher_id
                                          WHERE ct.section_id = s.id AND ct.academic_year_id = $1
                                          LIMIT 1))
                     ORDER BY (SELECT st.name FROM streams st WHERE st.id = s.stream_id) NULLS FIRST,
                              s.name)
                FROM sections s WHERE s.class_id = c.id AND s.deleted_at IS NULL
            ), '[]'::json) AS sections,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'stream_id', cs.stream_id,
                       'stream', (SELECT st.name FROM streams st WHERE st.id = cs.stream_id),
                       'subjects', cs.total)
                     ORDER BY (SELECT st.name FROM streams st WHERE st.id = cs.stream_id) NULLS FIRST)
                FROM (SELECT cs.stream_id, count(*)::int AS total
                        FROM class_subjects cs
                        JOIN subjects sub ON sub.id = cs.subject_id AND sub.deleted_at IS NULL
                       WHERE cs.class_id = c.id
                       GROUP BY cs.stream_id) cs
            ), '[]'::json) AS subjects_by_stream
       FROM classes c
      WHERE c.deleted_at IS NULL
      ORDER BY c.level_order`,
    [year?.id ?? 0],
  );
  return rows;
}

export async function createClass({ name, levelOrder, isPrePrimary, strengthLimit }) {
  try {
    const { rows } = await query(
      `INSERT INTO classes (name, level_order, is_pre_primary, strength_limit)
       VALUES ($1, $2, $3, $4) RETURNING id, name, level_order, is_pre_primary, strength_limit`,
      [name, levelOrder, Boolean(isPrePrimary), strengthLimit ?? 40],
    );
    return rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('A class with that name or position already exists.', 'CLASS_EXISTS');
    }
    throw error;
  }
}

export async function updateClass(classId, { name, levelOrder, isPrePrimary, strengthLimit }) {
  try {
    const { rows } = await query(
      `UPDATE classes SET name = $2, level_order = $3, is_pre_primary = $4, strength_limit = $5
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, name, level_order, is_pre_primary, strength_limit`,
      [classId, name, levelOrder, Boolean(isPrePrimary), strengthLimit ?? 40],
    );
    if (!rows[0]) throw notFound('Class not found.');
    return rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('Another class already uses that name or position.', 'CLASS_EXISTS');
    }
    throw error;
  }
}

export async function deleteClass(classId) {
  const used = await query('SELECT count(*)::int AS total FROM enrollments WHERE class_id = $1', [classId]);
  if (used.rows[0].total > 0) {
    throw conflict('This class has enrolment history and cannot be removed.', 'CLASS_IN_USE');
  }
  const { rows } = await query(
    'UPDATE classes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
    [classId],
  );
  if (!rows[0]) throw notFound('Class not found.');
  return { deleted: true };
}

export async function createSection(classId, { name, capacity, streamId = null }) {
  return withTransaction(async (client) => {
    const klass = await assertStreamForClass(client, classId, streamId);
    try {
      const { rows } = await client.query(
        `INSERT INTO sections (class_id, name, capacity, stream_id) VALUES ($1, $2, $3, $4)
         RETURNING id, name, capacity, stream_id`,
        [classId, name, capacity ?? klass.strength_limit ?? 40, streamId],
      );
      return rows[0];
    } catch (error) {
      if (error.code === '23505') {
        throw conflict('That section already exists for this class.', 'SECTION_EXISTS');
      }
      throw error;
    }
  });
}

/**
 * `streamId` is optional: omitted keeps the current stream (so a capacity-only edit on Class 11
 * does not silently drop the stream), an explicit value moves the section.
 */
export async function updateSection(sectionId, { name, capacity, streamId }) {
  return withTransaction(async (client) => {
    const current = await client.query(
      'SELECT class_id, stream_id FROM sections WHERE id = $1 AND deleted_at IS NULL',
      [sectionId],
    );
    if (!current.rows[0]) throw notFound('Section not found.');
    const nextStream = streamId === undefined ? current.rows[0].stream_id : streamId ?? null;
    await assertStreamForClass(client, current.rows[0].class_id, nextStream);

    try {
      const { rows } = await client.query(
        `UPDATE sections SET name = $2, capacity = $3, stream_id = $4
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, name, capacity, stream_id`,
        [sectionId, name, capacity, nextStream],
      );
      if (!rows[0]) throw notFound('Section not found.');
      return rows[0];
    } catch (error) {
      if (error.code === '23505') throw conflict('That section name is already used.', 'SECTION_EXISTS');
      throw error;
    }
  });
}

export async function deleteSection(sectionId) {
  const used = await query('SELECT count(*)::int AS total FROM enrollments WHERE section_id = $1', [sectionId]);
  if (used.rows[0].total > 0) {
    throw conflict('This section still has students enrolled.', 'SECTION_IN_USE');
  }
  // A section that still has a class teacher or timetable slots is not free: a soft-deleted section
  // keeps its class_teachers row, which then blocks that teacher's deactivation.
  const blockers = await query(
    `SELECT (SELECT count(*)::int FROM class_teachers WHERE section_id = $1) AS teachers,
            (SELECT count(*)::int FROM timetable_slots WHERE section_id = $1) AS slots`,
    [sectionId],
  );
  if (blockers.rows[0].teachers > 0) {
    throw conflict('This section still has a class teacher. Clear that first.', 'SECTION_HAS_CLASS_TEACHER');
  }
  if (blockers.rows[0].slots > 0) {
    throw conflict('This section still has timetable periods. Remove them first.', 'SECTION_HAS_TIMETABLE');
  }
  const { rows } = await query(
    'UPDATE sections SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
    [sectionId],
  );
  if (!rows[0]) throw notFound('Section not found.');
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export async function listSubjects() {
  const { rows } = await query(
    `SELECT s.id, s.name, s.code, s.is_pre_primary,
            (SELECT count(*)::int FROM class_subjects cs WHERE cs.subject_id = s.id) AS class_count,
            (SELECT count(*)::int FROM teacher_subjects ts WHERE ts.subject_id = s.id) AS teacher_count
       FROM subjects s WHERE s.deleted_at IS NULL ORDER BY s.name`,
  );
  return rows;
}

export async function createSubject({ name, code, isPrePrimary }) {
  try {
    const { rows } = await query(
      'INSERT INTO subjects (name, code, is_pre_primary) VALUES ($1, $2, $3) RETURNING id, name, code, is_pre_primary',
      [name, code, Boolean(isPrePrimary)],
    );
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw conflict('That subject code is already used.', 'SUBJECT_EXISTS');
    throw error;
  }
}

export async function updateSubject(subjectId, { name, code, isPrePrimary }) {
  try {
    const { rows } = await query(
      `UPDATE subjects SET name = $2, code = $3, is_pre_primary = $4
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, code, is_pre_primary`,
      [subjectId, name, code, Boolean(isPrePrimary)],
    );
    if (!rows[0]) throw notFound('Subject not found.');
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw conflict('That subject code is already used.', 'SUBJECT_EXISTS');
    throw error;
  }
}

export async function deleteSubject(subjectId) {
  const used = await query(
    `SELECT
       (SELECT count(*)::int FROM class_subjects WHERE subject_id = $1) +
       (SELECT count(*)::int FROM teacher_subjects WHERE subject_id = $1) +
       (SELECT count(*)::int FROM exam_schedules WHERE subject_id = $1) AS total`,
    [subjectId],
  );
  if (used.rows[0].total > 0) {
    throw conflict('This subject is assigned to classes, teachers or exams.', 'SUBJECT_IN_USE');
  }
  const { rows } = await query(
    'UPDATE subjects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
    [subjectId],
  );
  if (!rows[0]) throw notFound('Subject not found.');
  return { deleted: true };
}

/**
 * Subjects assigned to a class. For Class 11/12 the assignment is per stream, so the caller passes
 * the stream; `IS NOT DISTINCT FROM` matches NULL for every other class instead of returning nothing.
 */
export async function classSubjects(classId, streamId = null) {
  const { rows } = await query(
    `SELECT s.id, s.name, s.code, cs.stream_id
       FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id AND s.deleted_at IS NULL
      WHERE cs.class_id = $1 AND cs.stream_id IS NOT DISTINCT FROM $2::int
      ORDER BY s.name`,
    [classId, streamId ?? null],
  );
  return rows;
}

/**
 * Replaces the subject list of ONE class, or of one class+stream for Class 11/12.
 * The delete is scoped the same way, so editing Class 11 - Science never wipes Commerce.
 */
export async function setClassSubjects(classId, subjectIds, streamId = null) {
  return withTransaction(async (client) => {
    await assertStreamForClass(client, classId, streamId);

    await client.query(
      'DELETE FROM class_subjects WHERE class_id = $1 AND stream_id IS NOT DISTINCT FROM $2::int',
      [classId, streamId ?? null],
    );
    for (const subjectId of [...new Set(subjectIds)]) {
      await client.query(
        `INSERT INTO class_subjects (class_id, subject_id, stream_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [classId, subjectId, streamId ?? null],
      );
    }
    const { rows } = await client.query(
      `SELECT s.id, s.name, s.code, cs.stream_id FROM class_subjects cs
         JOIN subjects s ON s.id = cs.subject_id
        WHERE cs.class_id = $1 AND cs.stream_id IS NOT DISTINCT FROM $2::int
        ORDER BY s.name`,
      [classId, streamId ?? null],
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Options for pickers (students, teachers, timetable)
// ---------------------------------------------------------------------------

export async function options() {
  const year = await currentYear();
  const [classes, subjects, years, streams, teachers] = await Promise.all([
    listClasses(),
    listSubjects(),
    listAcademicYears(),
    listStreams(),
    query(
      `SELECT id, employee_id, trim(concat(first_name, ' ', last_name)) AS name, status
         FROM teachers WHERE deleted_at IS NULL AND status = 'active' ORDER BY first_name`,
    ),
  ]);
  return {
    currentYear: year,
    academicYears: years,
    classes: classes.map((row) => ({
      id: row.id,
      name: row.name,
      levelOrder: row.level_order,
      needsStream: row.needs_stream,
      sections: row.sections,
      subjectsByStream: row.subjects_by_stream,
      studentCount: row.student_count,
    })),
    streams,
    subjects,
    teachers: teachers.rows,
  };
}

export async function schoolProfile() {
  const { rows } = await query(
    `SELECT school_name, tagline, address, phone, email, fee_visible_to_students,
            attendance_lock_time, timezone, currency,
            (SELECT name FROM academic_years WHERE id = current_academic_year_id) AS academic_year
       FROM school_settings WHERE id = 1`,
  );
  return rows[0] || { school_name: 'Vision Valley School', timezone: config.timezone };
}

export default {
  currentYear,
  listAcademicYears,
  createAcademicYear,
  setCurrentYear,
  listClasses,
  createClass,
  updateClass,
  deleteClass,
  createSection,
  updateSection,
  deleteSection,
  listSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
  classSubjects,
  setClassSubjects,
  options,
  schoolProfile,
};
