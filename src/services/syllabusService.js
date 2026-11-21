import { query, withTransaction } from '../config/db.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';

/**
 * Chapter-wise syllabus and the portion attached to each exam paper.
 *
 * Who may do what:
 *   admin   — chapters for any class/subject, and the portion of any paper
 *   teacher — chapters and portions only for the (class, subject) pairs they teach this year
 *   student — reads the chapters of their own class (+ stream)
 *   parent  — reads the chapters of one of their children
 *
 * `covered_on` is the teacher's tick; progress is derived (covered / total), never stored.
 */

const CHAPTER_SELECT = `
  SELECT sc.id, sc.class_id, c.name AS class_name,
         sc.stream_id, st.name AS stream_name,
         sc.subject_id, sub.name AS subject_name, sub.code AS subject_code,
         sc.chapter_no, sc.title, sc.description, sc.covered_on,
         to_char(sc.covered_on, 'DD-MM-YYYY') AS covered_label,
         (SELECT count(*)::int FROM syllabus_portions p WHERE p.chapter_id = sc.id) AS portions
    FROM syllabus_chapters sc
    JOIN classes c ON c.id = sc.class_id
    LEFT JOIN streams st ON st.id = sc.stream_id
    JOIN subjects sub ON sub.id = sc.subject_id`;

/** The (class, subject) pairs a teacher owns this year. */
async function teacherPairs(userId, yearId) {
  const { rows } = await query(
    `SELECT DISTINCT ts.class_id, ts.subject_id
       FROM teacher_subjects ts
       JOIN teachers t ON t.id = ts.teacher_id
      WHERE t.user_id = $1 AND ts.academic_year_id = $2`,
    [userId, yearId],
  );
  return rows;
}

async function assertTeacherPair(user, yearId, classId, subjectId) {
  const pairs = await teacherPairs(user.id, yearId);
  const allowed = pairs.some((pair) => pair.class_id === classId && pair.subject_id === subjectId);
  if (!allowed) {
    throw forbidden('You can only change the syllabus of classes and subjects you teach.', 'SYLLABUS_NOT_YOUR_SUBJECT');
  }
}

/** A student's current class + stream (their own, or one of a parent's children). */
async function enrollmentOf(user, yearId, { childId = null } = {}) {
  let studentId;
  if (user.role === 'student') {
    const { rows } = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [user.id]);
    if (!rows[0]) throw forbidden('No student record is linked to your account.', 'SYLLABUS_NO_STUDENT_PROFILE');
    studentId = rows[0].id;
  } else {
    if (childId) {
      const { rows } = await query(
        `SELECT st.id FROM students st
           JOIN student_parents sp ON sp.student_id = st.id
           JOIN parents p ON p.id = sp.parent_id
          WHERE st.id = $1 AND p.user_id = $2 AND st.deleted_at IS NULL`,
        [childId, user.id],
      );
      if (!rows[0]) throw forbidden('That child is not linked to your account.', 'SYLLABUS_NOT_YOUR_CHILD');
      studentId = rows[0].id;
    } else {
      const { rows } = await query(
        `SELECT st.id FROM students st
           JOIN student_parents sp ON sp.student_id = st.id
           JOIN parents p ON p.id = sp.parent_id
          WHERE p.user_id = $1 AND st.deleted_at IS NULL
          ORDER BY st.id LIMIT 1`,
        [user.id],
      );
      if (!rows[0]) throw forbidden('No child is linked to your account.', 'SYLLABUS_NOT_YOUR_CHILD');
      studentId = rows[0].id;
    }
  }

  const { rows } = await query(
    `SELECT e.class_id, e.section_id, sec.stream_id, c.name AS class_name, sec.name AS section_name
       FROM enrollments e
       JOIN classes c ON c.id = e.class_id
       JOIN sections sec ON sec.id = e.section_id
      WHERE e.student_id = $1 AND e.academic_year_id = $2
      LIMIT 1`,
    [studentId, yearId],
  );
  if (!rows[0]) throw notFound('This student has no enrollment for the current academic year.');
  return { studentId, ...rows[0] };
}

export async function listChapters(user, { classId = null, subjectId = null, childId = null } = {}) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  const params = [year.id];
  const clauses = ['sc.academic_year_id = $1', 'sc.deleted_at IS NULL'];
  let scope = { classes: [], subjects: [] };
  let pupil = null;

  if (user.role === 'teacher') {
    params.push(user.id);
    clauses.push(
      `(sc.class_id, sc.subject_id) IN (
         SELECT ts.class_id, ts.subject_id FROM teacher_subjects ts
           JOIN teachers t ON t.id = ts.teacher_id
          WHERE t.user_id = $${params.length} AND ts.academic_year_id = $1)`,
    );
  } else if (user.role === 'student' || user.role === 'parent') {
    pupil = await enrollmentOf(user, year.id, { childId });
    params.push(pupil.class_id);
    clauses.push(`sc.class_id = $${params.length}`);
    params.push(pupil.stream_id === null ? 0 : pupil.stream_id);
    clauses.push(`coalesce(sc.stream_id, 0) = $${params.length}`);
  } else if (user.role !== 'admin') {
    throw forbidden('You cannot read the syllabus.', 'SYLLABUS_FORBIDDEN');
  }

  if (classId && user.role === 'admin') {
    params.push(classId);
    clauses.push(`sc.class_id = $${params.length}`);
  }
  if (subjectId) {
    params.push(subjectId);
    clauses.push(`sc.subject_id = $${params.length}`);
  }

  const where = clauses.join(' AND ');
  const { rows } = await query(
    `${CHAPTER_SELECT} WHERE ${where} ORDER BY c.level_order, sub.name, sc.chapter_no`,
    params,
  );

  // The filter options are derived from the rows themselves, so a teacher never sees a class or a
  // subject they do not teach in a dropdown.
  const classMap = new Map();
  const subjectMap = new Map();
  for (const row of rows) {
    classMap.set(row.class_id, { id: row.class_id, name: row.class_name, streamId: row.stream_id, streamName: row.stream_name });
    subjectMap.set(row.subject_id, { id: row.subject_id, name: row.subject_name });
  }
  scope = {
    classes: [...classMap.values()],
    subjects: [...subjectMap.values()],
    pupil,
  };

  const covered = rows.filter((row) => row.covered_on).length;
  return {
    rows,
    scope,
    progress: {
      total: rows.length,
      covered,
      percent: rows.length ? Math.round((covered / rows.length) * 100) : 0,
    },
  };
}

/** The (class, subject) pairs the caller may edit — the UI's two pickers, without guessing. */
export async function teachingPairs(user) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  if (user.role === 'admin') {
    const { rows } = await query(
      `SELECT cs.class_id, c.name AS class_name, cs.stream_id, st.name AS stream_name,
              cs.subject_id, sub.name AS subject_name,
              (SELECT count(*)::int FROM syllabus_chapters sc
                WHERE sc.academic_year_id = $1 AND sc.class_id = cs.class_id
                  AND coalesce(sc.stream_id, 0) = coalesce(cs.stream_id, 0)
                  AND sc.subject_id = cs.subject_id AND sc.deleted_at IS NULL) AS chapters
         FROM class_subjects cs
         JOIN classes c ON c.id = cs.class_id AND c.deleted_at IS NULL
         JOIN subjects sub ON sub.id = cs.subject_id AND sub.deleted_at IS NULL
         LEFT JOIN streams st ON st.id = cs.stream_id
        ORDER BY c.level_order, sub.name`,
      [year.id],
    );
    return { rows };
  }

  if (user.role !== 'teacher') throw forbidden('You cannot read the syllabus.', 'SYLLABUS_FORBIDDEN');

  const { rows } = await query(
    `SELECT ts.class_id, c.name AS class_name, c.level_order, ts.subject_id, sub.name AS subject_name,
            (SELECT count(*)::int FROM syllabus_chapters sc
              WHERE sc.academic_year_id = $2 AND sc.class_id = ts.class_id
                AND sc.subject_id = ts.subject_id AND sc.deleted_at IS NULL) AS chapters
       FROM teacher_subjects ts
       JOIN teachers t ON t.id = ts.teacher_id AND t.user_id = $1
       JOIN classes c ON c.id = ts.class_id AND c.deleted_at IS NULL
       JOIN subjects sub ON sub.id = ts.subject_id AND sub.deleted_at IS NULL
      WHERE ts.academic_year_id = $2
      GROUP BY ts.class_id, c.name, c.level_order, ts.subject_id, sub.name
      ORDER BY c.level_order, sub.name`,
    [user.id, year.id],
  );
  return { rows };
}

export async function createChapter(user, payload) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');
  if (user.role === 'teacher') {
    await assertTeacherPair(user, year.id, payload.classId, payload.subjectId);
  } else if (user.role !== 'admin') {
    throw forbidden('Only a teacher or the admin can change the syllabus.', 'SYLLABUS_FORBIDDEN');
  }

  const assigned = await query(
    `SELECT 1 FROM class_subjects cs
      WHERE cs.class_id = $1 AND cs.subject_id = $2
        AND coalesce(cs.stream_id, 0) = coalesce($3::int, 0)`,
    [payload.classId, payload.subjectId, payload.streamId ?? null],
  );
  if (!assigned.rows[0]) {
    throw badRequest('That subject is not assigned to this class.', { subjectId: 'Not in this class' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO syllabus_chapters
         (academic_year_id, class_id, stream_id, subject_id, chapter_no, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [year.id, payload.classId, payload.streamId ?? null, payload.subjectId,
        payload.chapterNo, payload.title, payload.description ?? null, user.id],
    );
    await audit({
      actorUserId: user.id, actorRole: user.role, action: 'syllabus.chapter.created',
      entityType: 'syllabus_chapter', entityId: rows[0].id,
      newValues: { classId: payload.classId, subjectId: payload.subjectId, chapterNo: payload.chapterNo, title: payload.title },
    });
    const created = await query(`${CHAPTER_SELECT} WHERE sc.id = $1`, [rows[0].id]);
    return created.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('That chapter number already exists for this class and subject.', 'CHAPTER_EXISTS');
    }
    throw error;
  }
}

export async function updateChapter(user, chapterId, payload) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  const current = await query(
    'SELECT * FROM syllabus_chapters WHERE id = $1 AND deleted_at IS NULL',
    [chapterId],
  );
  const chapter = current.rows[0];
  if (!chapter) throw notFound('Chapter not found.');
  if (user.role === 'teacher') {
    await assertTeacherPair(user, year.id, chapter.class_id, chapter.subject_id);
  } else if (user.role !== 'admin') {
    throw forbidden('Only a teacher or the admin can change the syllabus.', 'SYLLABUS_FORBIDDEN');
  }

  const sets = [];
  const params = [chapterId];
  const set = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (payload.title !== undefined) set('title', payload.title);
  if (payload.description !== undefined) set('description', payload.description);
  if (payload.chapterNo !== undefined) set('chapter_no', payload.chapterNo);
  if (payload.coveredOn !== undefined) set('covered_on', payload.coveredOn);
  if (sets.length === 0) throw badRequest('Send at least one field to update.');

  try {
    await query(`UPDATE syllabus_chapters SET ${sets.join(', ')} WHERE id = $1`, params);
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('That chapter number already exists for this class and subject.', 'CHAPTER_EXISTS');
    }
    throw error;
  }

  await audit({
    actorUserId: user.id, actorRole: user.role, action: 'syllabus.chapter.updated',
    entityType: 'syllabus_chapter', entityId: chapterId,
    oldValues: { chapterNo: chapter.chapter_no, title: chapter.title, coveredOn: chapter.covered_on },
    newValues: payload,
  });
  const updated = await query(`${CHAPTER_SELECT} WHERE sc.id = $1`, [chapterId]);
  return updated.rows[0];
}

export async function deleteChapter(user, chapterId) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');
  const current = await query('SELECT * FROM syllabus_chapters WHERE id = $1 AND deleted_at IS NULL', [chapterId]);
  const chapter = current.rows[0];
  if (!chapter) throw notFound('Chapter not found.');
  if (user.role === 'teacher') {
    await assertTeacherPair(user, year.id, chapter.class_id, chapter.subject_id);
  } else if (user.role !== 'admin') {
    throw forbidden('Only a teacher or the admin can change the syllabus.', 'SYLLABUS_FORBIDDEN');
  }
  await query('UPDATE syllabus_chapters SET deleted_at = now() WHERE id = $1', [chapterId]);
  await audit({
    actorUserId: user.id, actorRole: user.role, action: 'syllabus.chapter.deleted',
    entityType: 'syllabus_chapter', entityId: chapterId,
    oldValues: { chapterNo: chapter.chapter_no, title: chapter.title },
  });
  return { id: chapterId, deleted: true };
}

// ---------------------------------------------------------------------------
// Exam portions
// ---------------------------------------------------------------------------

/**
 * Exam papers with their attached chapters. A teacher sees their own papers, a student/parent the
 * papers of their class (published exams only), the admin every paper of the year.
 */
export async function listPortions(user, { examId = null, childId = null } = {}) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  const params = [year.id];
  const clauses = ['ex.academic_year_id = $1', 'ex.deleted_at IS NULL'];
  let pupil = null;

  if (user.role === 'teacher') {
    params.push(user.id);
    clauses.push(
      `(s.class_id, s.subject_id) IN (
         SELECT ts.class_id, ts.subject_id FROM teacher_subjects ts
           JOIN teachers t ON t.id = ts.teacher_id
          WHERE t.user_id = $${params.length} AND ts.academic_year_id = $1)`,
    );
  } else if (user.role === 'student' || user.role === 'parent') {
    pupil = await enrollmentOf(user, year.id, { childId });
    params.push(pupil.class_id);
    clauses.push(`s.class_id = $${params.length}`);
    // The portion is not a mark: a family needs it BEFORE the paper, so an unpublished exam is
    // still readable. Only the class scope applies (results stay gated by the exam publish gate).
  } else if (user.role !== 'admin') {
    throw forbidden('You cannot read the syllabus.', 'SYLLABUS_FORBIDDEN');
  }

  if (examId) {
    params.push(examId);
    clauses.push(`ex.id = $${params.length}`);
  }

  const where = clauses.join(' AND ');
  const { rows } = await query(
    `SELECT s.id AS schedule_id, ex.id AS exam_id, ex.name AS exam_name, ex.publish_status,
            s.class_id, c.name AS class_name, s.subject_id, sub.name AS subject_name,
            to_char(s.exam_date, 'DD-MM-YYYY') AS exam_date_label,
            s.max_marks
       FROM exam_schedules s
       JOIN examinations ex ON ex.id = s.exam_id
       JOIN classes c ON c.id = s.class_id
       JOIN subjects sub ON sub.id = s.subject_id
      WHERE ${where}
      ORDER BY s.exam_date DESC, c.level_order, sub.name`,
    params,
  );

  if (rows.length === 0) return { rows: [], pupil };

  const portions = await query(
    `SELECT p.exam_schedule_id, sc.id AS chapter_id, sc.chapter_no, sc.title, sc.covered_on
       FROM syllabus_portions p
       JOIN syllabus_chapters sc ON sc.id = p.chapter_id AND sc.deleted_at IS NULL
      WHERE p.exam_schedule_id = ANY($1::int[])
      ORDER BY sc.chapter_no`,
    [rows.map((row) => row.schedule_id)],
  );

  const byId = new Map();
  for (const row of portions.rows) {
    if (!byId.has(row.exam_schedule_id)) byId.set(row.exam_schedule_id, []);
    byId.get(row.exam_schedule_id).push(row);
  }

  return {
    rows: rows.map((row) => ({ ...row, chapters: byId.get(row.schedule_id) ?? [] })),
    pupil,
  };
}

/** Replace the portion of one exam paper. */
export async function setPortion(user, scheduleId, chapterIds) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  const scheduleResult = await query(
    `SELECT s.id, s.class_id, s.subject_id, s.exam_id
       FROM exam_schedules s
       JOIN examinations ex ON ex.id = s.exam_id
      WHERE s.id = $1 AND ex.academic_year_id = $2 AND ex.deleted_at IS NULL`,
    [scheduleId, year.id],
  );
  const schedule = scheduleResult.rows[0];
  if (!schedule) throw notFound('Exam paper not found.');

  if (user.role === 'teacher') {
    await assertTeacherPair(user, year.id, schedule.class_id, schedule.subject_id);
  } else if (user.role !== 'admin') {
    throw forbidden('Only a teacher or the admin can set the exam portion.', 'SYLLABUS_FORBIDDEN');
  }

  const unique = [...new Set(chapterIds)];
  if (unique.length > 0) {
    const valid = await query(
      `SELECT id FROM syllabus_chapters
        WHERE id = ANY($1::int[]) AND academic_year_id = $2
          AND class_id = $3 AND subject_id = $4 AND deleted_at IS NULL`,
      [unique, year.id, schedule.class_id, schedule.subject_id],
    );
    if (valid.rows.length !== unique.length) {
      throw badRequest(
        'Every chapter must belong to the same class and subject as the paper.',
        { chapterIds: 'Chapter from another class or subject' },
      );
    }
  }

  return withTransaction(async (client) => {
    await client.query('DELETE FROM syllabus_portions WHERE exam_schedule_id = $1', [scheduleId]);
    for (const chapterId of unique) {
      await client.query(
        'INSERT INTO syllabus_portions (exam_schedule_id, chapter_id) VALUES ($1, $2)',
        [scheduleId, chapterId],
      );
    }
    await audit({
      client,
      actorUserId: user.id, actorRole: user.role, action: 'syllabus.portion.updated',
      entityType: 'exam_schedule', entityId: scheduleId,
      newValues: { chapterIds: unique },
    });
    return { scheduleId, chapterIds: unique };
  });
}

export default {
  listChapters, createChapter, updateChapter, deleteChapter, listPortions, setPortion,
};
