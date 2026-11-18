import { query } from '../config/db.js';
import { badRequest, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';
import { PERMISSIONS, PERMISSION_LABELS, ROLE_PERMISSIONS } from '../config/permissions.js';

/**
 * Settings, audit trail and report exports (BRD 17–19, 21.1).
 * Reports are built here as { columns, rows } so the same data can be returned as
 * JSON (on screen) or CSV (download) without duplicating SQL.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings() {
  const { rows } = await query(
    `SELECT s.id, s.school_name, s.tagline, s.address, s.phone, s.email, s.website, s.logo_path,
            s.fee_visible_to_students, to_char(s.attendance_lock_time, 'HH24:MI') AS attendance_lock_time,
            s.timezone, s.currency, s.updated_at,
            (SELECT name FROM academic_years WHERE id = s.current_academic_year_id) AS academic_year
       FROM school_settings s WHERE s.id = 1`,
  );
  return {
    settings: rows[0] || {
      id: 1,
      school_name: 'Vision Valley School',
      fee_visible_to_students: false,
      attendance_lock_time: '23:59',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      academic_year: null,
    },
    permissions: {
      roles: Object.keys(ROLE_PERMISSIONS),
      matrix: Object.fromEntries(
        Object.entries(ROLE_PERMISSIONS).map(([role, list]) => [
          role,
          list.includes('*') ? Object.values(PERMISSIONS) : list,
        ]),
      ),
      labels: PERMISSION_LABELS,
    },
  };
}

export async function updateSettings(payload, actor, ip, userAgent) {
  const before = await query('SELECT * FROM school_settings WHERE id = 1');
  // Upsert on the singleton row: a database that has never saved settings still works.
  const { rows } = await query(
    `INSERT INTO school_settings (id, school_name, tagline, address, phone, email, website,
       fee_visible_to_students, attendance_lock_time, updated_by)
     VALUES (1, coalesce($1, 'Vision Valley School'), $2, $3, $4, $5, $6,
             coalesce($7::boolean, FALSE), coalesce($8::time, '23:59'::time), $9)
     ON CONFLICT (id) DO UPDATE
        SET school_name = COALESCE($1, school_settings.school_name),
            tagline = COALESCE($2, school_settings.tagline),
            address = COALESCE($3, school_settings.address),
            phone = COALESCE($4, school_settings.phone),
            email = COALESCE($5, school_settings.email),
            website = COALESCE($6, school_settings.website),
            fee_visible_to_students = COALESCE($7::boolean, school_settings.fee_visible_to_students),
            attendance_lock_time = COALESCE($8::time, school_settings.attendance_lock_time),
            updated_by = $9
      RETURNING id, school_name, fee_visible_to_students, to_char(attendance_lock_time, 'HH24:MI') AS attendance_lock_time`,
    [
      payload.schoolName ?? null,
      payload.tagline ?? null,
      payload.address ?? null,
      payload.phone ?? null,
      payload.email || null,
      payload.website ?? null,
      typeof payload.feeVisibleToStudents === 'boolean' ? payload.feeVisibleToStudents : null,
      payload.attendanceLockTime ?? null,
      actor?.id ?? null,
    ],
  );

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'settings.updated',
    entityType: 'school_settings',
    entityId: 1,
    oldValues: before.rows[0] || null,
    newValues: payload,
    ip,
    userAgent,
  });
  return rows[0];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function listAudit({ action, entityType, from, to, actor: actorName, page, limit, offset }) {
  const term = actorName ? `%${actorName.trim()}%` : null;
  const filters = `
    ($1::text IS NULL OR a.action ILIKE $1)
    AND ($2::text IS NULL OR a.entity_type = $2)
    AND ($3::date IS NULL OR a.created_at >= $3::date)
    AND ($4::date IS NULL OR a.created_at < ($4::date + interval '1 day'))
    AND ($5::text IS NULL OR u.username ILIKE $5)
  `;
  const params = [action ? `%${action}%` : null, entityType ?? null, from ?? null, to ?? null, term];

  const [rows, total] = await Promise.all([
    query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.reason,
              a.old_values, a.new_values,
              to_char(a.created_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI') AS created_label,
              coalesce(u.username, 'system') AS actor, a.actor_role
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ${filters}
        ORDER BY a.created_at DESC
        LIMIT $6 OFFSET $7`,
      [...params, limit, offset],
    ),
    query(
      `SELECT count(*)::int AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${filters}`,
      params,
    ),
  ]);

  return { rows: rows.rows, total: total.rows[0].total, page, limit };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const YEAR_FILTER = (alias = 'e') => `${alias}.academic_year_id = $1`;

export async function reportStudents({ classId, status }) {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT st.admission_id, st.first_name || ' ' || st.last_name AS name, st.gender,
            to_char(st.date_of_birth, 'DD-MM-YYYY') AS dob,
            c.name AS class_name, s.name AS section_name, st.status::text AS status,
            to_char(st.admission_date, 'DD-MM-YYYY') AS admission_date,
            (SELECT p.mobile FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
              WHERE sp.student_id = st.id ORDER BY sp.is_primary DESC LIMIT 1) AS guardian_mobile
       FROM students st
       LEFT JOIN enrollments e ON e.student_id = st.id AND ${YEAR_FILTER()}
       LEFT JOIN classes c ON c.id = e.class_id
       LEFT JOIN sections s ON s.id = e.section_id
      WHERE st.deleted_at IS NULL
        AND ($2::int IS NULL OR e.class_id = $2)
        AND ($3::text IS NULL OR st.status::text = $3)
      ORDER BY st.admission_id`,
    [year?.id ?? 0, classId ?? null, status ?? null],
  );
  return {
    columns: [
      ['admission_id', 'Admission ID'],
      ['name', 'Student'],
      ['gender', 'Gender'],
      ['dob', 'Date of birth'],
      ['class_name', 'Class'],
      ['section_name', 'Section'],
      ['status', 'Status'],
      ['admission_date', 'Admitted on'],
      ['guardian_mobile', 'Guardian mobile'],
    ],
    rows: rows,
  };
}

/**
 * A teacher holds `report.view.class`, so the class-level reports must be narrowed to the
 * classes they actually teach in the current academic year. Admin gets `null` = no restriction.
 */
async function teacherClassScope(actor) {
  if (!actor || actor.role !== 'teacher') return null;
  const year = await currentYear();
  const { rows } = await query(
    `SELECT DISTINCT ts.class_id
       FROM teacher_subjects ts
       JOIN teachers t ON t.id = ts.teacher_id
      WHERE t.user_id = $1 AND ts.academic_year_id = $2`,
    [actor.id, year?.id ?? 0],
  );
  return rows.map((row) => row.class_id);
}

export async function reportAttendance({ from, to, classId }, actor) {
  const year = await currentYear();
  const scope = await teacherClassScope(actor);
  const { rows } = await query(
    `SELECT st.admission_id, st.first_name || ' ' || st.last_name AS name,
            c.name AS class_name, s.name AS section_name,
            count(*)::int AS marked,
            count(*) FILTER (WHERE a.status = 'present')::int AS present,
            count(*) FILTER (WHERE a.status = 'absent')::int AS absent,
            count(*) FILTER (WHERE a.status = 'late')::int AS late,
            count(*) FILTER (WHERE a.status = 'half_day')::int AS half_day,
            count(*) FILTER (WHERE a.status = 'leave')::int AS leave,
            round(100.0 * sum(CASE WHEN a.status IN ('present','late') THEN 1
                                   WHEN a.status = 'half_day' THEN 0.5 ELSE 0 END)
                  / nullif(count(*), 0), 1) AS percentage
       FROM attendance a
       JOIN students st ON st.id = a.student_id
       JOIN sections s ON s.id = a.section_id
       JOIN classes c ON c.id = s.class_id
      WHERE a.academic_year_id = $1
        AND ($2::date IS NULL OR a.attendance_date >= $2::date)
        AND ($3::date IS NULL OR a.attendance_date <= $3::date)
        AND ($4::int IS NULL OR c.id = $4)
        AND ($5::int[] IS NULL OR c.id = ANY($5::int[]))
      GROUP BY st.admission_id, st.first_name, st.last_name, c.name, s.name
      ORDER BY st.admission_id`,
    [year?.id ?? 0, from ?? null, to ?? null, classId ?? null, scope],
  );
  return {
    columns: [
      ['admission_id', 'Admission ID'],
      ['name', 'Student'],
      ['class_name', 'Class'],
      ['section_name', 'Section'],
      ['marked', 'Days'],
      ['present', 'Present'],
      ['absent', 'Absent'],
      ['late', 'Late'],
      ['half_day', 'Half day'],
      ['leave', 'Leave'],
      ['percentage', 'Attendance %'],
    ],
    rows,
  };
}

export async function reportResults({ examId }, actor) {
  // The exam is a required filter, not an optional one: without it this query would run with a
  // NULL parameter, which PostgreSQL cannot type, and surfaced as a 500. Ask for it explicitly.
  if (!Number.isInteger(examId) || examId <= 0) {
    throw badRequest('Choose an examination for this report.', {
      examId: 'Choose an examination',
    });
  }
  const exam = await query('SELECT id FROM examinations WHERE id = $1 AND deleted_at IS NULL', [examId]);
  if (exam.rows.length === 0) throw notFound('That examination does not exist.');
  const scope = await teacherClassScope(actor);

  const { rows } = await query(
    `SELECT st.admission_id, st.first_name || ' ' || st.last_name AS name,
            c.name AS class_name, sub.name AS subject_name,
            es.max_marks, m.marks_obtained, m.is_absent, g.code AS grade,
            ex.name AS exam_name, ex.publish_status::text AS published
       FROM marks m
       JOIN exam_schedules es ON es.id = m.exam_schedule_id
       JOIN examinations ex ON ex.id = es.exam_id
       JOIN subjects sub ON sub.id = es.subject_id
       JOIN classes c ON c.id = es.class_id
       JOIN students st ON st.id = m.student_id
       LEFT JOIN grades g ON g.id = m.grade_id
      WHERE es.exam_id = $1
        AND ($2::int[] IS NULL OR es.class_id = ANY($2::int[]))
      ORDER BY c.name, st.admission_id, sub.name`,
    [examId, scope],
  );
  return {
    columns: [
      ['exam_name', 'Exam'],
      ['class_name', 'Class'],
      ['admission_id', 'Admission ID'],
      ['name', 'Student'],
      ['subject_name', 'Subject'],
      ['max_marks', 'Max'],
      ['marks_obtained', 'Marks'],
      ['grade', 'Grade'],
      ['published', 'Status'],
    ],
    rows,
  };
}

export async function reportFees({ from, to }) {
  const { rows } = await query(
    `SELECT to_char(p.paid_on, 'DD-MM-YYYY') AS paid_on, r.receipt_no,
            st.admission_id, st.first_name || ' ' || st.last_name AS name,
            c.name AS class_name, fc.name AS category, fs.name AS structure_name,
            p.payment_mode::text AS mode, p.reference_no,
            p.amount, CASE WHEN p.is_reversal THEN 'reversal' ELSE 'payment' END AS kind,
            (SELECT u.username FROM users u WHERE u.id = p.recorded_by) AS recorded_by
       FROM fee_payments p
       JOIN student_fees sf ON sf.id = p.student_fee_id
       JOIN fee_structures fs ON fs.id = sf.fee_structure_id
       JOIN fee_categories fc ON fc.id = fs.category_id
       JOIN classes c ON c.id = fs.class_id
       JOIN students st ON st.id = sf.student_id
       LEFT JOIN fee_receipts r ON r.payment_id = p.id
      WHERE ($1::date IS NULL OR p.paid_on >= $1::date)
        AND ($2::date IS NULL OR p.paid_on <= $2::date)
      ORDER BY p.paid_on DESC, p.id DESC`,
    [from ?? null, to ?? null],
  );
  return {
    columns: [
      ['paid_on', 'Date'],
      ['receipt_no', 'Receipt'],
      ['admission_id', 'Admission ID'],
      ['name', 'Student'],
      ['class_name', 'Class'],
      ['category', 'Category'],
      ['structure_name', 'Fee'],
      ['mode', 'Mode'],
      ['reference_no', 'Reference'],
      ['amount', 'Amount'],
      ['kind', 'Type'],
      ['recorded_by', 'Recorded by'],
    ],
    rows,
  };
}

const REPORT_BUILDERS = {
  students: reportStudents,
  attendance: reportAttendance,
  results: reportResults,
  fees: reportFees,
};

export async function buildReport(name, params, actor) {
  const builder = REPORT_BUILDERS[name];
  if (!builder) return null;
  return builder(params, actor);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv({ columns, rows }) {
  const header = columns.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((row) => columns.map(([key]) => csvCell(row[key])).join(',')).join('\n');
  return `${header}\n${body}`;
}

export { REPORT_BUILDERS };
