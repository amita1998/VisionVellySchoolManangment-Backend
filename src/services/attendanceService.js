import { query, withTransaction } from '../config/db.js';
import { config } from '../config/env.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';
import { pagedMeta } from '../utils/request.js';

/**
 * Attendance rules (BRD 9):
 *  - only the class teacher of that section may mark it;
 *  - one row per student per day, editable until 23:59 IST of that day;
 *  - after the lock, a change needs a correction request approved by an admin;
 *  - percentage = (present + late + half-day x 0.5) / marked days.
 */
const ATTENDANCE_VALUE = `(CASE WHEN a.status IN ('present', 'late') THEN 1
                               WHEN a.status = 'half_day' THEN 0.5
                               ELSE 0 END)`;

async function serverToday(client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT (now() AT TIME ZONE $1)::date AS today,
            to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today_iso`,
    [config.timezone],
  );
  return rows[0];
}

async function classTeacherSections(userId, yearId) {
  const { rows } = await query(
    `SELECT ct.section_id, s.name AS section_name, c.id AS class_id, c.name AS class_name
       FROM class_teachers ct
       JOIN teachers t ON t.id = ct.teacher_id
       JOIN sections s ON s.id = ct.section_id
       JOIN classes c ON c.id = s.class_id
      WHERE t.user_id = $1 AND ct.academic_year_id = $2
      ORDER BY c.level_order, s.name`,
    [userId, yearId],
  );
  return rows;
}

async function assertClassTeacher(userId, sectionId, yearId, client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT ct.id, c.name AS class_name, s.name AS section_name
       FROM class_teachers ct
       JOIN teachers t ON t.id = ct.teacher_id
       JOIN sections s ON s.id = ct.section_id
       JOIN classes c ON c.id = s.class_id
      WHERE t.user_id = $1 AND ct.section_id = $2 AND ct.academic_year_id = $3
      LIMIT 1`,
    [userId, sectionId, yearId],
  );
  if (!rows[0]) {
    throw forbidden('Only the class teacher of this section can mark its attendance.', 'NOT_CLASS_TEACHER');
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

export async function markingSheet({ userId, role, sectionId, date }) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');
  const today = await serverToday();
  const day = date || today.today_iso;

  const isAdmin = role === 'admin';
  if (!isAdmin) await assertClassTeacher(userId, sectionId, year.id);

  const section = await query(
    `SELECT s.id, s.name AS section_name, c.id AS class_id, c.name AS class_name,
            (SELECT trim(concat(t2.first_name, ' ', t2.last_name))
               FROM class_teachers ct JOIN teachers t2 ON t2.id = ct.teacher_id
              WHERE ct.section_id = s.id AND ct.academic_year_id = $2 LIMIT 1) AS class_teacher
       FROM sections s JOIN classes c ON c.id = s.class_id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [sectionId, year.id],
  );
  if (!section.rows[0]) throw notFound('Section not found.');

  const { rows } = await query(
    `SELECT st.id AS student_id, st.admission_id, st.first_name, st.last_name,
            a.id AS attendance_id, a.status, a.remarks, a.marked_at,
            (SELECT u.username FROM users u WHERE u.id = a.marked_by) AS marked_by
       FROM enrollments e
       JOIN students st ON st.id = e.student_id AND st.deleted_at IS NULL
       LEFT JOIN attendance a ON a.student_id = st.id AND a.attendance_date = $3
      WHERE e.section_id = $1 AND e.academic_year_id = $2 AND e.status = 'active'
      ORDER BY st.admission_id`,
    [sectionId, year.id, day],
  );

  return {
    section: section.rows[0],
    date: day,
    today: today.today_iso,
    // A past day is locked. Today is editable until the clock rolls over in IST.
    locked: day < today.today_iso,
    canMark: !isAdmin && !(day < today.today_iso),
    students: rows.map((row) => ({
      studentId: row.student_id,
      admissionId: row.admission_id,
      name: `${row.first_name} ${row.last_name}`,
      attendanceId: row.attendance_id,
      status: row.status,
      remarks: row.remarks,
      markedAt: row.marked_at,
      markedBy: row.marked_by,
    })),
  };
}

export async function mySections(userId) {
  const year = await currentYear();
  const today = await serverToday();
  const sections = await classTeacherSections(userId, year?.id ?? 0);
  const markedToday = await query(
    `SELECT section_id, count(*)::int AS total
       FROM attendance
      WHERE attendance_date = $1 AND academic_year_id = $2
      GROUP BY section_id`,
    [today.today_iso, year?.id ?? 0],
  );
  const markedMap = new Map(markedToday.rows.map((row) => [row.section_id, row.total]));
  return sections.map((row) => ({
    ...row,
    markedToday: markedMap.get(row.section_id) || 0,
  }));
}

export async function markAttendance({ userId, sectionId, date, entries, ip, userAgent }) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');
  const today = await serverToday();

  if (date !== today.today_iso) {
    throw conflict(
      date < today.today_iso
        ? 'That day is locked. Submit a correction request instead.'
        : 'Attendance can only be marked for today.',
      date < today.today_iso ? 'ATTENDANCE_LOCKED' : 'FUTURE_DATE',
    );
  }

  const teacher = await assertClassTeacher(userId, sectionId, year.id);
  if (entries.length === 0) throw conflict('No students to mark.', 'EMPTY_ATTENDANCE');

  const enrolled = await query(
    `SELECT student_id FROM enrollments
      WHERE section_id = $1 AND academic_year_id = $2 AND status = 'active'`,
    [sectionId, year.id],
  );
  const allowed = new Set(enrolled.rows.map((row) => row.student_id));
  for (const entry of entries) {
    if (!allowed.has(entry.studentId)) {
      throw forbidden('One of the students is not in this section.', 'STUDENT_NOT_IN_SECTION');
    }
  }

  const saved = await withTransaction(async (client) => {
    const results = [];
    for (const entry of entries) {
      const { rows } = await client.query(
        `INSERT INTO attendance (student_id, academic_year_id, section_id, attendance_date, status,
           remarks, marked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (student_id, attendance_date) DO UPDATE
           SET status = EXCLUDED.status, remarks = EXCLUDED.remarks,
               marked_by = EXCLUDED.marked_by, marked_at = now()
         RETURNING id, student_id, status`,
        [entry.studentId, year.id, sectionId, date, entry.status, entry.remarks ?? null, userId],
      );
      results.push(rows[0]);
    }

    await audit({
      client,
      actorUserId: userId,
      action: 'attendance.marked',
      entityType: 'attendance',
      entityId: sectionId,
      newValues: {
        date,
        section: `${teacher.class_name} ${teacher.section_name}`,
        count: results.length,
        statuses: results.reduce((accumulator, row) => {
          accumulator[row.status] = (accumulator[row.status] || 0) + 1;
          return accumulator;
        }, {}),
      },
      ip,
      userAgent,
    });

    return results;
  });

  return { saved: saved.length, date, sectionId };
}

// ---------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------

async function scopeFilter(req) {
  const { role, id: userId } = req.user;
  const year = await currentYear();
  const yearId = year?.id ?? 0;

  if (role === 'student') {
    const own = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
    if (!own.rows[0]) return { yearId, clause: 'AND FALSE', params: [] };
    return { yearId, clause: 'AND a.student_id = $4', params: [own.rows[0].id] };
  }
  if (role === 'parent') {
    return {
      yearId,
      clause: `AND a.student_id IN (
                 SELECT sp.student_id FROM student_parents sp
                 JOIN parents p ON p.id = sp.parent_id WHERE p.user_id = $4
               )`,
      params: [userId],
    };
  }
  if (role === 'teacher') {
    return {
      yearId,
      clause: `AND a.section_id IN (
                 SELECT ct.section_id FROM class_teachers ct
                 JOIN teachers t ON t.id = ct.teacher_id
                 WHERE t.user_id = $4 AND ct.academic_year_id = a.academic_year_id
                 UNION
                 SELECT s.id FROM sections s
                 JOIN classes c ON c.id = s.class_id
                 JOIN teacher_subjects ts ON ts.class_id = c.id
                 JOIN teachers t2 ON t2.id = ts.teacher_id
                 WHERE t2.user_id = $4 AND ts.academic_year_id = a.academic_year_id
               )`,
      params: [userId],
    };
  }
  return { yearId, clause: '', params: [] };
}

export async function listAttendance(req) {
  const { role } = req.user;
  const { yearId, clause, params } = await scopeFilter(req);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;

  /**
   * Filters are shared by the list, the count and the summary query, so each one has to be
   * expressible without extra joins: the class filter therefore goes through sections instead of
   * referencing `classes`. Both class and section are honoured — the admin screen sends classId
   * alone when no section is picked, and ignoring it (the old behaviour) made the class dropdown
   * look broken because the register never changed.
   *
   * The class placeholder is numbered AFTER the scope parameters (scopeFilter already owns $4 for
   * students/parents/teachers), never hard-coded.
   */
  const listParams = [
    yearId,
    req.query.date || null,
    req.query.sectionId ? Number(req.query.sectionId) : null,
    ...params,
  ];
  const classParam = listParams.length + 1;
  listParams.push(req.query.classId ? Number(req.query.classId) : null);

  const filters = `
    a.academic_year_id = $1
    ${clause}
    AND ($2::date IS NULL OR a.attendance_date = $2::date)
    AND ($3::int IS NULL OR a.section_id = $3)
    AND (
      $${classParam}::int IS NULL
      OR a.section_id IN (SELECT sec.id FROM sections sec WHERE sec.class_id = $${classParam})
    )
  `;

  // Class-wise view reads oldest-class-first so the register groups naturally; the plain
  // date view keeps newest-day-first.
  const orderBy = req.query.classId
    ? 'ORDER BY c.level_order, s.name, st.admission_id, a.attendance_date DESC'
    : 'ORDER BY a.attendance_date DESC, st.admission_id';

  const [rows, total, summary] = await Promise.all([
    query(
      `SELECT a.id, a.attendance_date, to_char(a.attendance_date, 'DD-MM-YYYY') AS date_label,
              a.status, a.remarks, a.marked_at,
              st.id AS student_id, st.admission_id, st.first_name || ' ' || st.last_name AS student_name,
              c.name AS class_name, s.name AS section_name,
              (SELECT u.username FROM users u WHERE u.id = a.marked_by) AS marked_by
         FROM attendance a
         JOIN students st ON st.id = a.student_id
         JOIN sections s ON s.id = a.section_id
         JOIN classes c ON c.id = s.class_id
        WHERE ${filters}
        ${orderBy}
        LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}`,
      [...listParams, limit, offset],
    ),
    query(
      `SELECT count(*)::int AS total FROM attendance a WHERE ${filters}`,
      listParams,
    ),
    query(
      `SELECT a.status, count(*)::int AS total,
              round(coalesce(sum(${ATTENDANCE_VALUE}), 0), 2)::numeric AS value
         FROM attendance a WHERE ${filters} GROUP BY a.status`,
      listParams,
    ),
  ]);

  const counts = { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
  let value = 0;
  summary.rows.forEach((row) => {
    counts[row.status] = row.total;
    value += Number(row.value);
  });
  const marked = Object.values(counts).reduce((sum, item) => sum + item, 0);

  return {
    rows: rows.rows,
    meta: pagedMeta({ page, limit, total: total.rows[0].total }),
    summary: {
      counts,
      marked,
      percentage: marked ? Math.round((value / marked) * 1000) / 10 : 0,
    },
    scope: role,
  };
}

export async function studentSummary(studentId) {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT a.status, count(*)::int AS total,
            coalesce(sum(${ATTENDANCE_VALUE}), 0)::numeric AS value
       FROM attendance a
      WHERE a.student_id = $1 AND a.academic_year_id = $2
      GROUP BY a.status`,
    [studentId, year?.id ?? 0],
  );
  const counts = { present: 0, absent: 0, late: 0, half_day: 0, leave: 0 };
  let value = 0;
  rows.forEach((row) => {
    counts[row.status] = row.total;
    value += Number(row.value);
  });
  const marked = Object.values(counts).reduce((sum, item) => sum + item, 0);
  return {
    counts,
    marked,
    percentage: marked ? Math.round((value / marked) * 1000) / 10 : 0,
    // School holidays are not counted because no attendance row exists for them.
  };
}

export async function monthly(studentId) {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT to_char(a.attendance_date, 'YYYY-MM') AS month,
            count(*)::int AS marked,
            round(100.0 * sum(${ATTENDANCE_VALUE}) / nullif(count(*), 0), 1) AS percentage,
            count(*) FILTER (WHERE a.status = 'absent')::int AS absent
       FROM attendance a
      WHERE a.student_id = $1 AND a.academic_year_id = $2
      GROUP BY 1 ORDER BY 1 DESC`,
    [studentId, year?.id ?? 0],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export async function requestCorrection({ userId, attendanceId, requestedStatus, reason, ip, userAgent }) {
  const year = await currentYear();
  const attendance = await query(
    `SELECT a.id, a.student_id, a.section_id, a.status, a.attendance_date,
            (SELECT 1 FROM class_teachers ct JOIN teachers t ON t.id = ct.teacher_id
              WHERE ct.section_id = a.section_id AND ct.academic_year_id = a.academic_year_id
                AND t.user_id = $2 LIMIT 1) AS is_class_teacher
       FROM attendance a WHERE a.id = $1`,
    [attendanceId, userId],
  );
  if (!attendance.rows[0]) throw notFound('Attendance record not found.');
  const row = attendance.rows[0];
  if (!row.is_class_teacher) {
    throw forbidden('Only the class teacher of that section can request a correction.', 'NOT_CLASS_TEACHER');
  }
  if (row.status === requestedStatus) {
    throw conflict('The requested status is the same as the current one.', 'CORRECTION_UNCHANGED');
  }

  const pending = await query(
    "SELECT 1 FROM attendance_corrections WHERE attendance_id = $1 AND status = 'pending'",
    [attendanceId],
  );
  if (pending.rows[0]) {
    throw conflict('A correction for this record is already pending.', 'CORRECTION_PENDING');
  }

  const { rows } = await query(
    `INSERT INTO attendance_corrections (attendance_id, student_id, old_status, requested_status,
       reason, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, status, created_at`,
    [attendanceId, row.student_id, row.status, requestedStatus, reason, userId],
  );

  await audit({
    actorUserId: userId,
    action: 'attendance.correction_requested',
    entityType: 'attendance_corrections',
    entityId: rows[0].id,
    oldValues: { status: row.status },
    newValues: { status: requestedStatus, date: row.attendance_date },
    reason,
    ip,
    userAgent,
  });

  return { ...rows[0], yearId: year?.id ?? null };
}

export async function listCorrections(req) {
  const { role, id: userId } = req.user;
  const status = req.query.status || null;

  // Build the parameter list together with the SQL: passing a parameter that the
  // statement does not reference makes Postgres reject the whole bind.
  const params = [status];
  let scope = '';
  if (role !== 'admin') {
    params.push(userId);
    scope = `AND (
        c.requested_by = $2
        OR c.attendance_id IN (
             SELECT a.id FROM attendance a
              WHERE a.section_id IN (
                SELECT ct.section_id FROM class_teachers ct
                JOIN teachers t ON t.id = ct.teacher_id WHERE t.user_id = $2
              )
            )
      )`;
  }

  const { rows } = await query(
    `SELECT c.id, c.status, c.old_status, c.requested_status, c.reason, c.created_at,
            c.reviewed_at, c.review_comment,
            a.attendance_date, to_char(a.attendance_date, 'DD-MM-YYYY') AS date_label,
            st.admission_id, st.first_name || ' ' || st.last_name AS student_name,
            cl.name AS class_name, s.name AS section_name,
            (SELECT u.username FROM users u WHERE u.id = c.requested_by) AS requested_by_name,
            (SELECT u.username FROM users u WHERE u.id = c.reviewed_by) AS reviewed_by_name
       FROM attendance_corrections c
       JOIN attendance a ON a.id = c.attendance_id
       JOIN students st ON st.id = c.student_id
       JOIN sections s ON s.id = a.section_id
       JOIN classes cl ON cl.id = s.class_id
      WHERE ($1::text IS NULL OR c.status::text = $1)
        ${scope}
      ORDER BY (c.status = 'pending') DESC, c.created_at DESC
      LIMIT 100`,
    params,
  );
  return rows;
}

export async function reviewCorrection({ correctionId, adminId, decision, comment, ip, userAgent }) {
  return withTransaction(async (client) => {
    // FOR UPDATE: two admins clicking approve and reject at the same time used to both succeed.
    const corrections = await client.query(
      `SELECT c.*, a.status AS current_status
         FROM attendance_corrections c
         JOIN attendance a ON a.id = c.attendance_id
        WHERE c.id = $1 FOR UPDATE`,
      [correctionId],
    );
    const correction = corrections.rows[0];
    if (!correction) throw notFound('Correction request not found.');
    if (correction.status !== 'pending') {
      throw conflict('This request has already been reviewed.', 'ALREADY_REVIEWED');
    }
    // The request describes a change from a specific value; if attendance moved underneath it,
    // approving would silently overwrite the newer marking.
    if (decision === 'approved' && correction.current_status !== correction.old_status) {
      throw conflict(
        'The attendance changed after this request was raised. Ask for a fresh correction.',
        'ATTENDANCE_CHANGED',
      );
    }

    const updated = await client.query(
      `UPDATE attendance_corrections
          SET status = $2, reviewed_by = $3, reviewed_at = now(), review_comment = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [correctionId, decision, adminId, comment ?? null],
    );
    if (updated.rowCount === 0) throw conflict('This request has already been reviewed.', 'ALREADY_REVIEWED');

    if (decision === 'approved') {
      await client.query(
        'UPDATE attendance SET status = $2, marked_at = now() WHERE id = $1',
        [correction.attendance_id, correction.requested_status],
      );
    }

    await audit({
      client,
      actorUserId: adminId,
      action: decision === 'approved' ? 'attendance.correction_approved' : 'attendance.correction_rejected',
      entityType: 'attendance',
      entityId: correction.attendance_id,
      oldValues: { status: correction.current_status },
      newValues: { status: decision === 'approved' ? correction.requested_status : correction.current_status },
      reason: comment ?? correction.reason,
      ip,
      userAgent,
    });

    return { correctionId, status: decision };
  });
}

export default {
  markingSheet,
  mySections,
  markAttendance,
  listAttendance,
  studentSummary,
  monthly,
  requestCorrection,
  listCorrections,
  reviewCorrection,
};
