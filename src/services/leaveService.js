import { query, withTransaction } from '../config/db.js';
import { AppError, conflict, forbidden, notFound } from '../utils/errors.js';
import { pagedMeta } from '../utils/request.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';

/**
 * Leave management.
 *
 * Who may do what:
 *   admin            — sees every request, approves/rejects any of them
 *   class teacher    — sees and decides requests of students in a section they own
 *   student/parent   — apply for themselves / a child, and read their own history
 *   teacher          — applies for their own leave (approved by the admin)
 *
 * Approval of a STUDENT leave writes `attendance = 'leave'` for the dates that have already
 * passed (or today). Future dates are not marked, because a class teacher still takes the
 * register on the day — pre-filling it would hide a genuine absence.
 */

const today = "((now() AT TIME ZONE 'Asia/Kolkata')::date)";

const badRequest = (message, code) => new AppError(400, code, message);

export async function listTypes(actor) {
  // A student only sees what applies to students; staff sees staff types; the admin sees all.
  const wants = actor.role === 'student' || actor.role === 'parent' ? 'student' : 'staff';
  const isAdmin = actor.role === 'admin';
  const { rows } = await query(
    `SELECT id, code, name, applies_to, annual_quota
       FROM leave_types
      WHERE deleted_at IS NULL AND is_active
        ${isAdmin ? '' : `AND applies_to IN ($1, 'both')`}
      ORDER BY name`,
    isAdmin ? [] : [wants],
  );
  return rows;
}

/** Sections where this user is the class teacher (used for the approval scope). */
async function sectionsOfTeacher(userId, yearId, client = null) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `SELECT ct.section_id FROM class_teachers ct
       JOIN teachers t ON t.id = ct.teacher_id
      WHERE t.user_id = $1 AND ct.academic_year_id = $2`,
    [userId, yearId],
  );
  return rows.map((row) => row.section_id);
}

export async function listRequests(req) {
  const { role, id: userId } = req.user;
  const year = await currentYear();
  const yearId = year?.id ?? 0;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;

  const params = [yearId];
  const where = ['lr.academic_year_id = $1'];
  if (req.query.status) {
    params.push(req.query.status);
    where.push(`lr.status = $${params.length}`);
  }

  if (role === 'student') {
    params.push(userId);
    where.push(`lr.student_id = (SELECT id FROM students WHERE user_id = $${params.length} AND deleted_at IS NULL)`);
  } else if (role === 'parent') {
    params.push(userId);
    where.push(`lr.student_id IN (
      SELECT sp.student_id FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
       WHERE p.user_id = $${params.length})`);
  } else if (role === 'teacher') {
    const sections = await sectionsOfTeacher(userId, yearId);
    params.push(userId);
    const userParam = params.length;
    if (sections.length) {
      params.push(sections);
      where.push(`(
        lr.teacher_id = (SELECT id FROM teachers WHERE user_id = $${userParam} AND deleted_at IS NULL)
        OR lr.student_id IN (
          SELECT e.student_id FROM enrollments e
           WHERE e.section_id = ANY($${params.length}::int[]) AND e.academic_year_id = $1 AND e.status = 'active')
      )`);
    } else {
      where.push(`lr.teacher_id = (SELECT id FROM teachers WHERE user_id = $${userParam} AND deleted_at IS NULL)`);
    }
  }

  const filter = where.join(' AND ');
  const [rows, total] = await Promise.all([
    query(
      `SELECT lr.id, lr.from_date, lr.to_date, lr.days, lr.reason, lr.status,
              to_char(lr.from_date, 'DD-MM-YYYY') AS from_label,
              to_char(lr.to_date, 'DD-MM-YYYY') AS to_label,
              lt.name AS leave_type, lt.code AS leave_code,
              coalesce(st.admission_id, t.employee_id) AS member_code,
              coalesce(st.first_name || ' ' || st.last_name, t.first_name || ' ' || t.last_name) AS member_name,
              CASE WHEN lr.student_id IS NOT NULL THEN 'student' ELSE 'teacher' END AS member_type,
              c.name AS class_name, sec.name AS section_name,
              lr.decision_note, lr.decided_at
         FROM leave_requests lr
         JOIN leave_types lt ON lt.id = lr.leave_type_id
         LEFT JOIN students st ON st.id = lr.student_id
         LEFT JOIN teachers t ON t.id = lr.teacher_id
         LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
         LEFT JOIN sections sec ON sec.id = e.section_id
         LEFT JOIN classes c ON c.id = sec.class_id
        WHERE ${filter}
        ORDER BY (lr.status = 'pending') DESC, lr.from_date DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(
      `SELECT count(*)::int AS total FROM leave_requests lr
         LEFT JOIN enrollments e ON e.student_id = lr.student_id AND e.status = 'active'
        WHERE ${filter}`,
      params,
    ),
  ]);

  return { rows: rows.rows, meta: pagedMeta({ page, limit, total: total.rows[0].total }) };
}

/** Days used per leave type this year — what the remaining balance is computed from. */
export async function balance(req) {
  const { role, id: userId } = req.user;
  const year = await currentYear();
  const yearId = year?.id ?? 0;

  let studentId = Number(req.query.studentId) || null;
  let teacherId = Number(req.query.teacherId) || null;

  if (!studentId && !teacherId) {
    if (role === 'student') {
      const own = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
      studentId = own.rows[0]?.id ?? null;
    } else if (role === 'teacher') {
      const own = await query('SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
      teacherId = own.rows[0]?.id ?? null;
    }
  }
  if (!studentId && !teacherId) return { rows: [] };

  // A parent may only read a balance for a child of theirs.
  if (role === 'parent' && studentId) {
    const child = await query(
      `SELECT 1 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = $1 AND p.user_id = $2`,
      [studentId, userId],
    );
    if (!child.rows[0]) throw forbidden('No child of yours matches that selection.', 'CHILD_NOT_FOUND');
  }

  const column = studentId ? 'student_id' : 'teacher_id';
  const memberId = studentId || teacherId;
  const { rows } = await query(
    `SELECT lt.id, lt.name, lt.annual_quota,
            coalesce(sum(CASE WHEN lr.status = 'approved' THEN lr.days ELSE 0 END), 0)::int AS used,
            coalesce(sum(CASE WHEN lr.status = 'pending' THEN lr.days ELSE 0 END), 0)::int AS pending
       FROM leave_types lt
       LEFT JOIN leave_requests lr
              ON lr.leave_type_id = lt.id AND lr.${column} = $2 AND lr.academic_year_id = $1
      WHERE lt.deleted_at IS NULL AND lt.is_active
      GROUP BY lt.id, lt.name, lt.annual_quota
      ORDER BY lt.name`,
    [yearId, memberId],
  );
  return {
    rows: rows.map((row) => ({
      ...row,
      remaining: row.annual_quota === null ? null : Math.max(0, row.annual_quota - row.used),
    })),
  };
}

/** Resolve the member the caller is allowed to apply for. */
async function resolveMember(actor, payload, client) {
  let wantsStudent = Boolean(payload.studentId);
  let wantsTeacher = Boolean(payload.teacherId);
  if (wantsStudent && wantsTeacher) {
    throw badRequest('Choose either a student or a teacher.', 'MEMBER_REQUIRED');
  }
  /**
   * Self-service: a student or teacher applying for themselves never has to know their own id,
   * and a parent with one child does not have to choose. The server resolves the member from the
   * token — a client-supplied id is still checked below, never trusted.
   */
  if (!wantsStudent && !wantsTeacher) {
    if (actor.role === 'student') {
      const own = await client.query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [actor.id]);
      if (own.rows[0]) return { studentId: own.rows[0].id, teacherId: null };
    }
    if (actor.role === 'teacher') {
      const own = await client.query('SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL', [actor.id]);
      if (own.rows[0]) return { studentId: null, teacherId: own.rows[0].id };
    }
    if (actor.role === 'parent') {
      const kids = await client.query(
        `SELECT st.id FROM students st
           JOIN student_parents sp ON sp.student_id = st.id
           JOIN parents p ON p.id = sp.parent_id
          WHERE p.user_id = $1 AND st.deleted_at IS NULL ORDER BY st.id`,
        [actor.id],
      );
      if (kids.rowCount === 1) return { studentId: kids.rows[0].id, teacherId: null };
      if (kids.rowCount > 1) throw badRequest('Choose which child this leave is for.', 'CHILD_REQUIRED');
    }
    throw badRequest('Choose a student or a teacher.', 'MEMBER_REQUIRED');
  }

  if (wantsStudent) {
    const student = await client.query('SELECT id FROM students WHERE id = $1 AND deleted_at IS NULL', [
      payload.studentId,
    ]);
    if (!student.rows[0]) throw notFound('Student not found.');
    if (actor.role === 'admin') return { studentId: payload.studentId, teacherId: null };
    if (actor.role === 'student') {
      const own = await client.query('SELECT 1 FROM students WHERE id = $1 AND user_id = $2', [
        payload.studentId,
        actor.id,
      ]);
      if (own.rows[0]) return { studentId: payload.studentId, teacherId: null };
    }
    if (actor.role === 'parent') {
      const child = await client.query(
        `SELECT 1 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
          WHERE sp.student_id = $1 AND p.user_id = $2`,
        [payload.studentId, actor.id],
      );
      if (child.rows[0]) return { studentId: payload.studentId, teacherId: null };
    }
    throw forbidden('You cannot apply for leave for this student.', 'LEAVE_FORBIDDEN');
  }

  const teacher = await client.query('SELECT id FROM teachers WHERE id = $1 AND deleted_at IS NULL', [
    payload.teacherId,
  ]);
  if (!teacher.rows[0]) throw notFound('Teacher not found.');
  if (actor.role === 'admin') return { studentId: null, teacherId: payload.teacherId };
  if (actor.role === 'teacher') {
    const own = await client.query('SELECT 1 FROM teachers WHERE id = $1 AND user_id = $2', [
      payload.teacherId,
      actor.id,
    ]);
    if (own.rows[0]) return { studentId: null, teacherId: payload.teacherId };
  }
  throw forbidden('You cannot apply for leave for this teacher.', 'LEAVE_FORBIDDEN');
}

export async function apply(actor, payload) {
  return withTransaction(async (client) => {
    const year = await currentYear(client);
    if (!year) throw badRequest('No current academic year is set.', 'NO_CURRENT_YEAR');

    const member = await resolveMember(actor, payload, client);
    const type = await client.query(
      'SELECT id, name, applies_to, annual_quota FROM leave_types WHERE id = $1 AND deleted_at IS NULL AND is_active',
      [payload.leaveTypeId],
    );
    const leaveType = type.rows[0];
    if (!leaveType) throw notFound('Leave type not found.');

    const isStudent = Boolean(member.studentId);
    if (leaveType.applies_to !== 'both' && leaveType.applies_to !== (isStudent ? 'student' : 'staff')) {
      throw badRequest(`${leaveType.name} does not apply to this member.`, 'LEAVE_TYPE_NOT_APPLICABLE');
    }

    // Inclusive day count from the calendar dates as sent.
    const daysRow = await client.query('SELECT ($2::date - $1::date) + 1 AS days', [
      payload.fromDate,
      payload.toDate,
    ]);
    const days = daysRow.rows[0].days;
    if (days <= 0) throw badRequest('The leave must end on or after it starts.', 'LEAVE_RANGE');

    const column = isStudent ? 'student_id' : 'teacher_id';
    const memberId = isStudent ? member.studentId : member.teacherId;

    const overlap = await client.query(
      `SELECT id FROM leave_requests
        WHERE ${column} = $1 AND academic_year_id = $2 AND status IN ('pending', 'approved')
          AND daterange(from_date, to_date, '[]') && daterange($3::date, $4::date, '[]')
        LIMIT 1`,
      [memberId, year.id, payload.fromDate, payload.toDate],
    );
    if (overlap.rows[0]) {
      throw conflict('These dates overlap an existing leave request.', 'LEAVE_OVERLAP');
    }

    if (leaveType.annual_quota !== null) {
      const used = await client.query(
        `SELECT coalesce(sum(days), 0)::int AS used FROM leave_requests
          WHERE ${column} = $1 AND leave_type_id = $2 AND academic_year_id = $3
            AND status IN ('approved', 'pending')`,
        [memberId, leaveType.id, year.id],
      );
      if (used.rows[0].used + days > leaveType.annual_quota) {
        throw conflict(
          `${leaveType.name}: ${used.rows[0].used} of ${leaveType.annual_quota} days already used or pending.`,
          'LEAVE_QUOTA_EXCEEDED',
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO leave_requests
         (academic_year_id, leave_type_id, student_id, teacher_id, from_date, to_date, days, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [year.id, leaveType.id, member.studentId, member.teacherId, payload.fromDate, payload.toDate, days, payload.reason, actor.id],
    );
    await audit({
      client,
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'leave.requested',
      entityType: 'leave_request',
      entityId: rows[0].id,
      newValues: { from: payload.fromDate, to: payload.toDate, days },
    });
    return rows[0];
  });
}

/** Admin, or the class teacher of the student asking. */
async function assertCanDecide(actor, request, yearId) {
  if (actor.role === 'admin') return;
  if (actor.role !== 'teacher' || !request.student_id) {
    throw forbidden('Only the admin or the class teacher can decide this request.', 'LEAVE_DECIDE_FORBIDDEN');
  }
  const sections = await sectionsOfTeacher(actor.id, yearId);
  if (!sections.length) throw forbidden('You are not a class teacher.', 'LEAVE_DECIDE_FORBIDDEN');
  const member = await query(
    `SELECT 1 FROM enrollments WHERE student_id = $1 AND academic_year_id = $2
       AND section_id = ANY($3::int[]) AND status = 'active'`,
    [request.student_id, yearId, sections],
  );
  if (!member.rows[0]) throw forbidden('This student is not in your class.', 'LEAVE_DECIDE_FORBIDDEN');
}

export async function decide(actor, requestId, { decision, note = null }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw badRequest('Decision must be approved or rejected.', 'LEAVE_DECISION_INVALID');
  }
  return withTransaction(async (client) => {
    const year = await currentYear(client);
    const current = await client.query('SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [requestId]);
    const request = current.rows[0];
    if (!request) throw notFound('Leave request not found.');
    if (request.status !== 'pending') throw conflict('This request is already decided.', 'LEAVE_NOT_PENDING');
    await assertCanDecide(actor, request, year?.id ?? 0);

    const { rows } = await client.query(
      `UPDATE leave_requests
          SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE id = $1
        RETURNING *`,
      [requestId, decision, actor.id, note],
    );

    /**
     * Approved STUDENT leave is written into the attendance register for the days that have
     * already happened. Future days stay unmarked so the class teacher still takes the register.
     */
    let marked = 0;
    if (decision === 'approved' && request.student_id) {
      const result = await client.query(
        `INSERT INTO attendance (student_id, academic_year_id, section_id, attendance_date, status, marked_by, remarks)
         SELECT $1, $2, e.section_id, d::date, 'leave', $3, 'Approved leave'
           FROM generate_series($4::date, least($5::date, ${today}), interval '1 day') AS d
           JOIN enrollments e ON e.student_id = $1 AND e.academic_year_id = $2 AND e.status = 'active'
         ON CONFLICT (student_id, attendance_date)
         DO UPDATE SET status = 'leave', remarks = 'Approved leave', marked_by = $3
          WHERE attendance.status <> 'leave'
         RETURNING attendance_date`,
        [request.student_id, request.academic_year_id, actor.id, request.from_date, request.to_date],
      );
      marked = result.rowCount;
    }

    await audit({
      client,
      actorUserId: actor.id,
      actorRole: actor.role,
      action: `leave.${decision}`,
      entityType: 'leave_request',
      entityId: requestId,
      newValues: { decision, note, attendance_rows: marked },
    });
    return { ...rows[0], attendance_marked: marked };
  });
}

export async function cancel(actor, requestId) {
  return withTransaction(async (client) => {
    const current = await client.query('SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE', [requestId]);
    const request = current.rows[0];
    if (!request) throw notFound('Leave request not found.');
    if (request.status !== 'pending') throw conflict('Only a pending request can be cancelled.', 'LEAVE_NOT_PENDING');

    if (actor.role !== 'admin' && request.requested_by !== actor.id) {
      throw forbidden('You can only cancel your own request.', 'LEAVE_CANCEL_FORBIDDEN');
    }

    const { rows } = await client.query(
      `UPDATE leave_requests SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [requestId],
    );
    await audit({
      client,
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'leave.cancelled',
      entityType: 'leave_request',
      entityId: requestId,
    });
    return rows[0];
  });
}
