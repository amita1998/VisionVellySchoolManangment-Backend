import { query, withTransaction } from '../config/db.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';

/**
 * Examination rules (BRD 10):
 *  - admin creates exams and schedules; a schedule is one paper for one class+subject;
 *  - teachers enter marks only for the classes/subjects assigned to them, draft -> submit;
 *  - after submit, edits need an admin unlock or an admin override (both audited);
 *  - students and parents see results only after the exam is published;
 *  - the grade comes from the configurable grade scale (A+ .. E).
 */

async function gradeFor(percentage, client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT id, code FROM grades
      WHERE $1 >= min_percent AND $1 <= max_percent
      ORDER BY sort_order LIMIT 1`,
    [percentage],
  );
  return rows[0] || null;
}

async function assertTeacherPaper(userId, scheduleId, yearId, client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT es.id, es.class_id, es.subject_id, es.max_marks, es.exam_id
       FROM exam_schedules es
       JOIN examinations ex ON ex.id = es.exam_id
       JOIN teacher_subjects ts ON ts.class_id = es.class_id AND ts.subject_id = es.subject_id
       JOIN teachers t ON t.id = ts.teacher_id
      WHERE es.id = $1 AND t.user_id = $2 AND ts.academic_year_id = $3
      LIMIT 1`,
    [scheduleId, userId, yearId],
  );
  if (!rows[0]) {
    throw forbidden('You can only enter marks for your own classes and subjects.', 'NOT_YOUR_SUBJECT');
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

export async function listExams({ yearId, includeDrafts = true }) {
  const year = yearId ? { id: yearId } : await currentYear();
  const { rows } = await query(
    `SELECT ex.id, ex.name, ex.exam_type, ex.start_date, ex.end_date, ex.publish_status,
            to_char(ex.start_date, 'DD-MM-YYYY') AS start_label,
            to_char(ex.end_date, 'DD-MM-YYYY') AS end_label,
            ex.published_at,
            (SELECT count(*)::int FROM exam_schedules s WHERE s.exam_id = ex.id) AS schedule_count,
            (SELECT count(DISTINCT s.class_id)::int FROM exam_schedules s WHERE s.exam_id = ex.id) AS class_count,
            (SELECT count(*)::int FROM marks m
               JOIN exam_schedules s2 ON s2.id = m.exam_schedule_id
              WHERE s2.exam_id = ex.id AND m.status = 'submitted') AS submitted_marks
       FROM examinations ex
      WHERE ex.academic_year_id = $1 AND ex.deleted_at IS NULL
        ${includeDrafts ? '' : "AND ex.publish_status = 'published'"}
      ORDER BY ex.start_date DESC`,
    [year?.id ?? 0],
  );
  return rows;
}

export async function createExam({ name, examType, startDate, endDate, actor, ip, userAgent }) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');
  try {
    const { rows } = await query(
      `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, exam_type, start_date, end_date, publish_status`,
      [name, examType, year.id, startDate, endDate, actor?.id ?? null],
    );
    await audit({
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'exam.created',
      entityType: 'examinations',
      entityId: rows[0].id,
      newValues: { name, examType, startDate, endDate },
      ip,
      userAgent,
    });
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw conflict('An exam with that name already exists this year.', 'EXAM_EXISTS');
    throw error;
  }
}

export async function getExam(examId) {
  const exam = await query(
    `SELECT ex.*, to_char(ex.start_date, 'DD-MM-YYYY') AS start_label,
            to_char(ex.end_date, 'DD-MM-YYYY') AS end_label
       FROM examinations ex WHERE ex.id = $1 AND ex.deleted_at IS NULL`,
    [examId],
  );
  if (!exam.rows[0]) throw notFound('Exam not found.');

  const schedules = await query(
    `SELECT s.id, s.class_id, s.subject_id, s.exam_date, to_char(s.exam_date, 'DD-MM-YYYY') AS date_label,
            to_char(s.start_time, 'HH24:MI') AS start_time,
            to_char(s.end_time, 'HH24:MI') AS end_time,
            s.room, s.max_marks,
            c.name AS class_name, sub.name AS subject_name, sub.code AS subject_code,
            (SELECT count(*)::int FROM marks m WHERE m.exam_schedule_id = s.id) AS marks_entered,
            (SELECT count(*)::int FROM marks m WHERE m.exam_schedule_id = s.id AND m.status = 'submitted') AS marks_submitted,
            (SELECT count(*)::int FROM enrollments e
              WHERE e.class_id = s.class_id AND e.academic_year_id = $2 AND e.status = 'active') AS student_count
       FROM exam_schedules s
       JOIN classes c ON c.id = s.class_id
       JOIN subjects sub ON sub.id = s.subject_id
      WHERE s.exam_id = $1
      ORDER BY s.exam_date, c.level_order, sub.name`,
    [examId, exam.rows[0].academic_year_id],
  );

  return { ...exam.rows[0], schedules: schedules.rows };
}

export async function addSchedule({ examId, classId, subjectId, examDate, startTime, endTime, room, maxMarks, actor, ip, userAgent }) {
  const exam = await query('SELECT id, academic_year_id, publish_status FROM examinations WHERE id = $1 AND deleted_at IS NULL', [examId]);
  if (!exam.rows[0]) throw notFound('Exam not found.');
  if (exam.rows[0].publish_status === 'published') {
    throw conflict('The exam is published; unpublish it before changing the schedule.', 'EXAM_PUBLISHED');
  }

  const taught = await query('SELECT 1 FROM class_subjects WHERE class_id = $1 AND subject_id = $2', [classId, subjectId]);
  if (!taught.rows[0]) throw conflict('That subject is not taught to this class.', 'SUBJECT_NOT_IN_CLASS');

  try {
    const { rows } = await query(
      `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time, room, max_marks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, class_id, subject_id, exam_date, max_marks`,
      [examId, classId, subjectId, examDate, startTime, endTime, room ?? null, maxMarks ?? 100],
    );
    await audit({
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'exam.schedule_added',
      entityType: 'exam_schedules',
      entityId: rows[0].id,
      newValues: { examId, classId, subjectId, examDate },
      ip,
      userAgent,
    });
    return rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('That paper is already scheduled for this exam.', 'SCHEDULE_EXISTS');
    }
    throw error;
  }
}

export async function deleteSchedule({ examId, scheduleId, actor, ip, userAgent }) {
  const exam = await query('SELECT publish_status FROM examinations WHERE id = $1', [examId]);
  if (exam.rows[0]?.publish_status === 'published') {
    throw conflict('The exam is published; unpublish it first.', 'EXAM_PUBLISHED');
  }
  const used = await query('SELECT count(*)::int AS total FROM marks WHERE exam_schedule_id = $1', [scheduleId]);
  if (used.rows[0].total > 0) {
    throw conflict('Marks already exist for this paper.', 'SCHEDULE_HAS_MARKS');
  }
  const { rowCount } = await query('DELETE FROM exam_schedules WHERE id = $1 AND exam_id = $2', [
    scheduleId,
    examId,
  ]);
  if (rowCount === 0) throw notFound('Schedule not found.');
  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'exam.schedule_removed',
    entityType: 'exam_schedules',
    entityId: scheduleId,
    ip,
    userAgent,
  });
  return { deleted: true };
}

export async function setPublished({ examId, publish, actor, ip, userAgent }) {
  const exam = await getExam(examId);
  if (publish) {
    if (exam.schedules.length === 0) {
      throw conflict('Add at least one paper before publishing.', 'NO_SCHEDULES');
    }
    const pending = exam.schedules.filter((schedule) => schedule.marks_entered < schedule.student_count);
    if (pending.length > 0) {
      throw conflict(
        `Marks are still incomplete for ${pending.length} paper(s).`,
        'MARKS_INCOMPLETE',
      );
    }
  }

  const { rows } = await query(
    `UPDATE examinations
        SET publish_status = $2::exam_publish_status,
            published_at = CASE WHEN $2::text = 'published' THEN now() ELSE NULL END,
            published_by = CASE WHEN $2::text = 'published' THEN $3::int ELSE NULL END
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, publish_status, published_at`,
    [examId, publish ? 'published' : 'draft', actor?.id ?? null],
  );

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: publish ? 'exam.published' : 'exam.unpublished',
    entityType: 'examinations',
    entityId: examId,
    ip,
    userAgent,
  });
  return rows[0];
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export async function marksSheet({ scheduleId, userId, role }) {
  const year = await currentYear();
  const yearId = year?.id ?? 0;
  if (role !== 'admin') await assertTeacherPaper(userId, scheduleId, yearId);

  const schedule = await query(
    `SELECT s.id, s.max_marks, s.exam_id, s.class_id, s.subject_id,
            to_char(s.exam_date, 'DD-MM-YYYY') AS date_label,
            c.name AS class_name, sub.name AS subject_name,
            ex.name AS exam_name, ex.publish_status
       FROM exam_schedules s
       JOIN classes c ON c.id = s.class_id
       JOIN subjects sub ON sub.id = s.subject_id
       JOIN examinations ex ON ex.id = s.exam_id
      WHERE s.id = $1`,
    [scheduleId],
  );
  if (!schedule.rows[0]) throw notFound('Paper not found.');

  const roster = await query(
    `SELECT st.id AS student_id, st.admission_id, st.first_name || ' ' || st.last_name AS name,
            m.id AS mark_id, m.marks_obtained, m.is_absent, m.status, m.remarks,
            g.code AS grade
       FROM enrollments e
       JOIN students st ON st.id = e.student_id AND st.deleted_at IS NULL
       LEFT JOIN marks m ON m.exam_schedule_id = $1 AND m.student_id = st.id
       LEFT JOIN grades g ON g.id = m.grade_id
      WHERE e.class_id = $2 AND e.academic_year_id = $3 AND e.status = 'active'
      ORDER BY st.admission_id`,
    [scheduleId, schedule.rows[0].class_id, yearId],
  );

  const editable =
    role === 'admin'
      ? schedule.rows[0].publish_status !== 'published'
      : schedule.rows[0].publish_status !== 'published' &&
        roster.rows.every((row) => row.status !== 'submitted');

  return { ...schedule.rows[0], students: roster.rows, editable };
}

export async function saveMarks({ scheduleId, userId, role, entries, submit, ip, userAgent }) {
  const year = await currentYear();
  const yearId = year?.id ?? 0;
  if (role !== 'admin') await assertTeacherPaper(userId, scheduleId, yearId);

  const schedule = await query(
    `SELECT s.id, s.max_marks, s.class_id, s.exam_id, ex.publish_status
       FROM exam_schedules s JOIN examinations ex ON ex.id = s.exam_id WHERE s.id = $1`,
    [scheduleId],
  );
  if (!schedule.rows[0]) throw notFound('Paper not found.');
  if (schedule.rows[0].publish_status === 'published') {
    throw conflict('Results are published; an admin must unlock this paper first.', 'MARKS_LOCKED');
  }
  const maxMarks = Number(schedule.rows[0].max_marks);

  const submitted = await query(
    "SELECT count(*)::int AS total FROM marks WHERE exam_schedule_id = $1 AND status = 'submitted'",
    [scheduleId],
  );
  if (submitted.rows[0].total > 0 && role !== 'admin') {
    throw conflict('These marks are submitted. Ask the admin to unlock them.', 'MARKS_SUBMITTED');
  }

  for (const entry of entries) {
    if (!entry.isAbsent) {
      if (entry.marksObtained === null || entry.marksObtained === undefined) {
        throw conflict('Every student needs marks or an absent mark.', 'MARKS_MISSING');
      }
      if (Number(entry.marksObtained) < 0 || Number(entry.marksObtained) > maxMarks) {
        throw conflict(`Marks must be between 0 and ${maxMarks}.`, 'MARKS_OUT_OF_RANGE');
      }
    }
  }

  const enrolled = await query(
    `SELECT student_id FROM enrollments WHERE class_id = $1 AND academic_year_id = $2 AND status = 'active'`,
    [schedule.rows[0].class_id, yearId],
  );
  const allowed = new Set(enrolled.rows.map((row) => row.student_id));
  for (const entry of entries) {
    if (!allowed.has(entry.studentId)) {
      throw forbidden('One of the students is not in this class.', 'STUDENT_NOT_IN_CLASS');
    }
  }

  if (submit) {
    const covered = new Set(entries.map((entry) => entry.studentId));
    const missing = [...allowed].filter((id) => !covered.has(id));
    if (missing.length > 0) {
      throw conflict(
        `${missing.length} student(s) still have no marks. Enter every student before submitting.`,
        'MARKS_INCOMPLETE',
      );
    }
  }

  const saved = await withTransaction(async (client) => {
    const results = [];
    for (const entry of entries) {
      const percentage = entry.isAbsent || entry.marksObtained === null
        ? null
        : (Number(entry.marksObtained) / maxMarks) * 100;
      const grade = percentage === null ? null : await gradeFor(percentage, client);
      const { rows } = await client.query(
        `INSERT INTO marks (exam_schedule_id, student_id, marks_obtained, is_absent, grade_id,
           status, remarks, entered_by, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (exam_schedule_id, student_id) DO UPDATE
           SET marks_obtained = EXCLUDED.marks_obtained,
               is_absent = EXCLUDED.is_absent,
               grade_id = EXCLUDED.grade_id,
               status = EXCLUDED.status,
               remarks = EXCLUDED.remarks,
               entered_by = EXCLUDED.entered_by,
               submitted_at = EXCLUDED.submitted_at
         RETURNING id, student_id, marks_obtained, status`,
        [
          scheduleId,
          entry.studentId,
          entry.isAbsent ? null : Number(entry.marksObtained),
          Boolean(entry.isAbsent),
          grade?.id ?? null,
          submit ? 'submitted' : 'draft',
          entry.remarks ?? null,
          userId,
          submit ? new Date() : null,
        ],
      );
      results.push(rows[0]);
    }

    await audit({
      client,
      actorUserId: userId,
      action: submit ? 'marks.submitted' : 'marks.saved',
      entityType: 'exam_schedules',
      entityId: scheduleId,
      newValues: { count: results.length, submitted: Boolean(submit) },
      ip,
      userAgent,
    });
    return results;
  });

  return { saved: saved.length, submitted: Boolean(submit) };
}

export async function unlockMarks({ scheduleId, adminId, reason, ip, userAgent }) {
  const { rowCount } = await query(
    "UPDATE marks SET status = 'draft', submitted_at = NULL WHERE exam_schedule_id = $1 AND status = 'submitted'",
    [scheduleId],
  );
  await audit({
    actorUserId: adminId,
    action: 'marks.unlocked',
    entityType: 'exam_schedules',
    entityId: scheduleId,
    newValues: { unlocked: rowCount },
    reason: reason ?? null,
    ip,
    userAgent,
  });
  return { unlocked: rowCount };
}

export async function overrideMark({ scheduleId, studentId, marksObtained, isAbsent, reason, adminId, ip, userAgent }) {
  const schedule = await query('SELECT max_marks FROM exam_schedules WHERE id = $1', [scheduleId]);
  if (!schedule.rows[0]) throw notFound('Paper not found.');
  const maxMarks = Number(schedule.rows[0].max_marks);
  if (!isAbsent && (marksObtained === null || marksObtained < 0 || marksObtained > maxMarks)) {
    throw conflict(`Marks must be between 0 and ${maxMarks}.`, 'MARKS_OUT_OF_RANGE');
  }
  if (!reason || reason.trim().length < 5) {
    throw conflict('An override needs a logged reason.', 'REASON_REQUIRED');
  }

  const before = await query(
    'SELECT id, marks_obtained, is_absent, status FROM marks WHERE exam_schedule_id = $1 AND student_id = $2',
    [scheduleId, studentId],
  );

  const percentage = isAbsent ? null : (Number(marksObtained) / maxMarks) * 100;
  const grade = percentage === null ? null : await gradeFor(percentage);

  const { rows } = await query(
    `INSERT INTO marks (exam_schedule_id, student_id, marks_obtained, is_absent, grade_id, status,
       remarks, entered_by, submitted_at)
     VALUES ($1, $2, $3, $4, $5, 'submitted', $6, $7, now())
     ON CONFLICT (exam_schedule_id, student_id) DO UPDATE
       SET marks_obtained = EXCLUDED.marks_obtained, is_absent = EXCLUDED.is_absent,
           grade_id = EXCLUDED.grade_id, status = 'submitted', remarks = EXCLUDED.remarks,
           entered_by = EXCLUDED.entered_by, submitted_at = now()
     RETURNING id, marks_obtained, is_absent, grade_id`,
    [scheduleId, studentId, isAbsent ? null : Number(marksObtained), Boolean(isAbsent), grade?.id ?? null, reason, adminId],
  );

  await audit({
    actorUserId: adminId,
    action: 'marks.overridden',
    entityType: 'marks',
    entityId: rows[0].id,
    oldValues: before.rows[0] || null,
    newValues: { marksObtained, isAbsent },
    reason,
    ip,
    userAgent,
  });

  return rows[0];
}

// ---------------------------------------------------------------------------
// Teacher view / results / report cards
// ---------------------------------------------------------------------------

export async function myPapers(userId) {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT s.id AS schedule_id, s.max_marks, s.exam_date,
            to_char(s.exam_date, 'DD-MM-YYYY') AS date_label,
            c.name AS class_name, sub.name AS subject_name,
            ex.id AS exam_id, ex.name AS exam_name, ex.publish_status,
            (SELECT count(*)::int FROM enrollments e
              WHERE e.class_id = s.class_id AND e.academic_year_id = $2 AND e.status = 'active') AS students,
            (SELECT count(*)::int FROM marks m
              WHERE m.exam_schedule_id = s.id AND m.status = 'submitted') AS submitted,
            (SELECT count(*)::int FROM marks m WHERE m.exam_schedule_id = s.id) AS entered
       FROM exam_schedules s
       JOIN classes c ON c.id = s.class_id
       JOIN subjects sub ON sub.id = s.subject_id
       JOIN examinations ex ON ex.id = s.exam_id AND ex.deleted_at IS NULL
       JOIN teacher_subjects ts ON ts.class_id = s.class_id AND ts.subject_id = s.subject_id
       JOIN teachers t ON t.id = ts.teacher_id
      WHERE t.user_id = $1 AND ts.academic_year_id = $2
      ORDER BY s.exam_date DESC, c.level_order, sub.name`,
    [userId, year?.id ?? 0],
  );
  return rows;
}

export async function reportCard({ studentId, examId }) {
  const student = await query(
    `SELECT st.id, st.admission_id, st.first_name || ' ' || st.last_name AS name
       FROM students st WHERE st.id = $1 AND st.deleted_at IS NULL`,
    [studentId],
  );
  if (!student.rows[0]) throw notFound('Student not found.');

  const exam = await query(
    'SELECT id, name, publish_status, academic_year_id, to_char(published_at, \'DD-MM-YYYY\') AS published_on FROM examinations WHERE id = $1 AND deleted_at IS NULL',
    [examId],
  );
  if (!exam.rows[0]) throw notFound('Exam not found.');

  const enrollment = await query(
    `SELECT c.id AS class_id, c.name AS class_name, s.name AS section_name
       FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN sections s ON s.id = e.section_id
      WHERE e.student_id = $1 AND e.academic_year_id = $2 LIMIT 1`,
    [studentId, exam.rows[0].academic_year_id],
  );

  const papers = await query(
    `SELECT sub.name AS subject_name, s.max_marks,
            m.marks_obtained, m.is_absent, g.code AS grade, m.status
       FROM exam_schedules s
       JOIN subjects sub ON sub.id = s.subject_id
       LEFT JOIN marks m ON m.exam_schedule_id = s.id AND m.student_id = $1
       LEFT JOIN grades g ON g.id = m.grade_id
      WHERE s.exam_id = $2 AND s.class_id = $3
      ORDER BY sub.name`,
    [studentId, examId, enrollment.rows[0]?.class_id ?? 0],
  );

  const obtained = papers.rows.reduce((sum, row) => sum + Number(row.marks_obtained || 0), 0);
  const maximum = papers.rows.reduce((sum, row) => sum + Number(row.max_marks || 0), 0);
  const percentage = maximum > 0 ? Math.round((obtained / maximum) * 1000) / 10 : 0;
  const grade = maximum > 0 ? await gradeFor(percentage) : null;

  let rank = null;
  if (enrollment.rows[0] && exam.rows[0].publish_status === 'published') {
    const totals = await query(
      `SELECT m.student_id, sum(m.marks_obtained)::numeric AS total
         FROM marks m
         JOIN exam_schedules s ON s.id = m.exam_schedule_id
        WHERE s.exam_id = $1 AND s.class_id = $2 AND m.status = 'submitted'
        GROUP BY m.student_id
        ORDER BY total DESC`,
      [examId, enrollment.rows[0].class_id],
    );
    const position = totals.rows.findIndex((row) => row.student_id === studentId);
    rank = position >= 0 ? { position: position + 1, of: totals.rows.length } : null;
  }

  return {
    student: student.rows[0],
    exam: exam.rows[0],
    class: enrollment.rows[0] || null,
    papers: papers.rows,
    totals: { obtained, maximum, percentage, grade: grade?.code ?? null },
    rank,
  };
}

export async function classResults({ examId, classId }) {
  const { rows } = await query(
    `SELECT st.id AS student_id, st.admission_id, st.first_name || ' ' || st.last_name AS name,
            count(m.id)::int AS papers,
            coalesce(sum(m.marks_obtained), 0)::numeric AS obtained,
            coalesce(sum(s.max_marks), 0)::numeric AS maximum
       FROM enrollments e
       JOIN students st ON st.id = e.student_id AND st.deleted_at IS NULL
       LEFT JOIN exam_schedules s ON s.exam_id = $1 AND s.class_id = e.class_id
       LEFT JOIN marks m ON m.exam_schedule_id = s.id AND m.student_id = st.id
      WHERE e.class_id = $2 AND e.status = 'active'
      GROUP BY st.id, st.admission_id, st.first_name, st.last_name
      ORDER BY obtained DESC, st.admission_id`,
    [examId, classId],
  );

  return rows.map((row, index) => {
    const obtained = Number(row.obtained);
    const maximum = Number(row.maximum);
    const percentage = maximum > 0 ? Math.round((obtained / maximum) * 1000) / 10 : 0;
    return {
      position: index + 1,
      studentId: row.student_id,
      admissionId: row.admission_id,
      name: row.name,
      papers: row.papers,
      obtained,
      maximum,
      percentage,
    };
  });
}

export default {
  listExams,
  createExam,
  getExam,
  addSchedule,
  deleteSchedule,
  setPublished,
  marksSheet,
  saveMarks,
  unlockMarks,
  overrideMark,
  myPapers,
  reportCard,
  classResults,
};
