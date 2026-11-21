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

/** The whole grade scale, highest band first. Loaded once per request (BE-50). */
async function gradeTable(client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    'SELECT id, code, min_percent FROM grades ORDER BY min_percent DESC',
  );
  return rows;
}

/**
 * Highest band whose minimum is reached. Matching on min_percent alone removes the gaps between
 * bands (80–89.99 followed by 90–100 left 89.995 ungraded) and never depends on a query per student.
 */
function gradeFrom(table, percentage) {
  return table.find((row) => percentage >= Number(row.min_percent)) ?? null;
}

async function gradeFor(percentage, client = null) {
  return gradeFrom(await gradeTable(client), percentage);
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
  return withTransaction(async (client) => {
    // Lock the exam so two admins cannot publish/unpublish against a shifting schedule.
    const locked = await client.query(
      'SELECT id, academic_year_id, publish_status FROM examinations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [examId],
    );
    if (!locked.rows[0]) throw notFound('Exam not found.');
    const exam = locked.rows[0];

    if (publish) {
      const schedules = await client.query('SELECT id, class_id FROM exam_schedules WHERE exam_id = $1', [examId]);
      if (schedules.rows.length === 0) {
        throw conflict('Add at least one paper before publishing.', 'NO_SCHEDULES');
      }

      // The publish gate counts SUBMITTED marks against the real roster (active enrollment in the
      // exam's own year, living students still on the rolls). Counting drafts or deleted students
      // is what used to publish half-entered report cards.
      const required = await client.query(
        `SELECT e.class_id, count(*)::int AS required
           FROM enrollments e
           JOIN students st ON st.id = e.student_id
          WHERE e.academic_year_id = $1 AND e.status = 'active'
            AND st.deleted_at IS NULL
            AND st.status NOT IN ('withdrawn', 'transferred', 'graduated')
          GROUP BY e.class_id`,
        [exam.academic_year_id],
      );
      const requiredByClass = new Map(required.rows.map((row) => [row.class_id, row.required]));

      const submitted = await client.query(
        `SELECT s.id AS schedule_id, count(DISTINCT m.student_id)::int AS submitted
           FROM exam_schedules s
           LEFT JOIN marks m ON m.exam_schedule_id = s.id AND m.status = 'submitted'
          WHERE s.exam_id = $1
          GROUP BY s.id`,
        [examId],
      );

      const pending = submitted.rows.filter(
        (row) => row.submitted < (requiredByClass.get(
          schedules.rows.find((schedule) => schedule.id === row.schedule_id)?.class_id,
        ) ?? 0),
      );
      if (pending.length > 0) {
        throw conflict(
          `Marks are still incomplete for ${pending.length} paper(s). Every enrolled student needs a submitted mark.`,
          'MARKS_INCOMPLETE',
        );
      }
    }

    const { rows } = await client.query(
      `UPDATE examinations
          SET publish_status = $2::exam_publish_status,
              published_at = CASE WHEN $2::text = 'published' THEN now() ELSE NULL END,
              published_by = CASE WHEN $2::text = 'published' THEN $3::int ELSE NULL END
        WHERE id = $1
        RETURNING id, publish_status, published_at`,
      [examId, publish ? 'published' : 'draft', actor?.id ?? null],
    );

    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: publish ? 'exam.published' : 'exam.unpublished',
      entityType: 'examinations',
      entityId: examId,
      ip,
      userAgent,
    });
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export async function marksSheet({ scheduleId, userId, role }) {
  const schedule = await query(
    `SELECT s.id, s.max_marks, s.exam_id, s.class_id, s.subject_id, ex.academic_year_id,
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
  const paper = schedule.rows[0];

  // Scope and roster both follow the EXAM's year, never "whatever year it is now".
  if (role !== 'admin') await assertTeacherPaper(userId, scheduleId, paper.academic_year_id);

  const roster = await query(
    `SELECT st.id AS student_id, st.admission_id, st.first_name || ' ' || st.last_name AS name,
            m.id AS mark_id, m.marks_obtained, m.is_absent, m.status, m.remarks,
            g.code AS grade
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       LEFT JOIN marks m ON m.exam_schedule_id = $1 AND m.student_id = st.id
       LEFT JOIN grades g ON g.id = m.grade_id
      WHERE e.class_id = $2 AND e.academic_year_id = $3 AND e.status = 'active'
        AND st.deleted_at IS NULL
        AND st.status NOT IN ('withdrawn', 'transferred', 'graduated')
      ORDER BY st.admission_id`,
    [scheduleId, paper.class_id, paper.academic_year_id],
  );

  const editable =
    role === 'admin'
      ? paper.publish_status !== 'published'
      : paper.publish_status !== 'published' && roster.rows.every((row) => row.status !== 'submitted');

  return { ...paper, students: roster.rows, editable };
}

export async function saveMarks({ scheduleId, userId, role, entries, submit, ip, userAgent }) {
  // Value checks need no database round-trip; do them first.
  for (const entry of entries) {
    if (entry.isAbsent) continue;
    if (entry.marksObtained === null || entry.marksObtained === undefined) {
      throw conflict('Every student needs marks or an absent mark.', 'MARKS_MISSING');
    }
    if (!Number.isFinite(Number(entry.marksObtained))) {
      throw conflict('Marks must be a number.', 'MARKS_INVALID');
    }
  }

  const grades = await gradeTable();

  const saved = await withTransaction(async (client) => {
    const schedule = await client.query(
      `SELECT s.id, s.max_marks, s.class_id, s.exam_id, ex.academic_year_id, ex.publish_status
         FROM exam_schedules s
         JOIN examinations ex ON ex.id = s.exam_id
        WHERE s.id = $1 FOR UPDATE`,
      [scheduleId],
    );
    if (!schedule.rows[0]) throw notFound('Paper not found.');
    const paper = schedule.rows[0];
    if (paper.publish_status === 'published') {
      throw conflict('Results are published; an admin must unlock this paper first.', 'MARKS_LOCKED');
    }
    if (role !== 'admin') await assertTeacherPaper(userId, scheduleId, paper.academic_year_id, client);

    const maxMarks = Number(paper.max_marks);
    for (const entry of entries) {
      if (entry.isAbsent) continue;
      if (Number(entry.marksObtained) < 0 || Number(entry.marksObtained) > maxMarks) {
        throw conflict(`Marks must be between 0 and ${maxMarks}.`, 'MARKS_OUT_OF_RANGE');
      }
    }

    // Read the submitted state inside the lock, otherwise a submit that lands between the check
    // and the write is silently turned back into drafts.
    const submitted = await client.query(
      "SELECT count(*)::int AS total FROM marks WHERE exam_schedule_id = $1 AND status = 'submitted'",
      [scheduleId],
    );
    if (submitted.rows[0].total > 0 && role !== 'admin') {
      throw conflict('These marks are submitted. Ask the admin to unlock them.', 'MARKS_SUBMITTED');
    }

    const roster = await client.query(
      `SELECT st.id AS student_id
         FROM enrollments e
         JOIN students st ON st.id = e.student_id
        WHERE e.class_id = $1 AND e.academic_year_id = $2 AND e.status = 'active'
          AND st.deleted_at IS NULL
          AND st.status NOT IN ('withdrawn', 'transferred', 'graduated')`,
      [paper.class_id, paper.academic_year_id],
    );
    const allowed = new Set(roster.rows.map((row) => row.student_id));
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

    const results = [];
    for (const entry of entries) {
      const percentage = entry.isAbsent || entry.marksObtained === null
        ? null
        : (Number(entry.marksObtained) / maxMarks) * 100;
      const grade = percentage === null ? null : gradeFrom(grades, percentage);
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
  const paper = await query('SELECT id FROM exam_schedules WHERE id = $1', [scheduleId]);
  if (!paper.rows[0]) throw notFound('Paper not found.');
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
  if (!reason || reason.trim().length < 5) {
    throw conflict('An override needs a logged reason.', 'REASON_REQUIRED');
  }
  if (!isAbsent && (!Number.isFinite(Number(marksObtained)) || Number(marksObtained) < 0)) {
    throw conflict('Marks must be a number.', 'MARKS_INVALID');
  }

  const grades = await gradeTable();

  return withTransaction(async (client) => {
    const schedule = await client.query(
      `SELECT s.max_marks, s.class_id, ex.academic_year_id, ex.publish_status
         FROM exam_schedules s JOIN examinations ex ON ex.id = s.exam_id
        WHERE s.id = $1 FOR UPDATE`,
      [scheduleId],
    );
    if (!schedule.rows[0]) throw notFound('Paper not found.');
    const paper = schedule.rows[0];
    if (paper.publish_status === 'published') {
      throw conflict('The exam is published. Unpublish it before overriding a mark.', 'EXAM_PUBLISHED');
    }
    const maxMarks = Number(paper.max_marks);
    if (!isAbsent && Number(marksObtained) > maxMarks) {
      throw conflict(`Marks must be between 0 and ${maxMarks}.`, 'MARKS_OUT_OF_RANGE');
    }

    // The student must be on this paper's class roster for the exam's year.
    const enrolled = await client.query(
      `SELECT 1 FROM enrollments e
         JOIN students st ON st.id = e.student_id
        WHERE e.student_id = $1 AND e.class_id = $2 AND e.academic_year_id = $3
          AND e.status = 'active' AND st.deleted_at IS NULL`,
      [studentId, paper.class_id, paper.academic_year_id],
    );
    if (!enrolled.rows[0]) {
      throw forbidden('That student is not in this paper\'s class.', 'STUDENT_NOT_IN_CLASS');
    }

    const before = await client.query(
      'SELECT id, marks_obtained, is_absent, status FROM marks WHERE exam_schedule_id = $1 AND student_id = $2',
      [scheduleId, studentId],
    );

    const percentage = isAbsent ? null : (Number(marksObtained) / maxMarks) * 100;
    const grade = percentage === null ? null : gradeFrom(grades, percentage);

    const { rows } = await client.query(
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
      client,
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
  });
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
       LEFT JOIN marks m ON m.exam_schedule_id = s.id AND m.student_id = $1 AND m.status = 'submitted'
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
      const index = totals.rows.findIndex((row) => row.student_id === studentId);
    if (index >= 0) {
      const total = Number(totals.rows[index].total);
      const ahead = totals.rows.filter((row) => Number(row.total) > total).length;
      rank = { position: ahead + 1, of: totals.rows.length };
    }
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

export async function classResults({ examId, classId, user }) {
  const exam = await query(
    'SELECT id, academic_year_id FROM examinations WHERE id = $1 AND deleted_at IS NULL',
    [examId],
  );
  if (!exam.rows[0]) throw notFound('Exam not found.');
  const examYear = exam.rows[0].academic_year_id;

  // Permission is not scope: a teacher may hold result.view.assigned and still not teach this class.
  if (user?.role !== 'admin') {
    const teaches = await query(
      `SELECT 1 FROM teacher_subjects ts
         JOIN teachers t ON t.id = ts.teacher_id
        WHERE t.user_id = $1 AND ts.class_id = $2 AND ts.academic_year_id = $3
        LIMIT 1`,
      [user?.id, classId, examYear],
    );
    if (!teaches.rows[0]) {
      throw forbidden('You can only see the results of classes you teach this year.', 'RESULT_FORBIDDEN');
    }
  }

  const { rows } = await query(
    `SELECT st.id AS student_id, st.admission_id, st.first_name || ' ' || st.last_name AS name,
            count(DISTINCT s.id) FILTER (WHERE m.status = 'submitted')::int AS papers,
            coalesce(sum(m.marks_obtained) FILTER (WHERE m.status = 'submitted'), 0)::numeric AS obtained,
            coalesce(sum(s.max_marks) FILTER (WHERE m.status = 'submitted'), 0)::numeric AS maximum
       FROM enrollments e
       JOIN students st ON st.id = e.student_id
       LEFT JOIN exam_schedules s ON s.exam_id = $1 AND s.class_id = e.class_id
       LEFT JOIN marks m ON m.exam_schedule_id = s.id AND m.student_id = st.id
      WHERE e.class_id = $2 AND e.academic_year_id = $3 AND e.status = 'active'
        AND st.deleted_at IS NULL
        AND st.status NOT IN ('withdrawn', 'transferred', 'graduated')
      GROUP BY st.id, st.admission_id, st.first_name, st.last_name
      ORDER BY obtained DESC, st.admission_id`,
    [examId, classId, examYear],
  );

  // Standard competition ranking: equal totals share a rank (1, 1, 3), not 1, 2, 3.
  let position = 0;
  let previous = null;
  return rows.map((row, index) => {
    const obtained = Number(row.obtained);
    const maximum = Number(row.maximum);
    if (previous === null || obtained !== previous) {
      position = index + 1;
      previous = obtained;
    }
    const percentage = maximum > 0 ? Math.round((obtained / maximum) * 1000) / 10 : 0;
    return {
      position,
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
