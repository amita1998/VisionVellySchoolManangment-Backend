import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import { audit } from './auditService.js';
import { conflict, notFound } from '../utils/errors.js';
import { temporaryPassword } from '../utils/passwords.js';
import { currentYear } from './academicsService.js';
import { pagedMeta } from '../utils/request.js';

function mapTeacher(row) {
  if (!row) return null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name}`,
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    mobile: row.mobile,
    email: row.email,
    address: row.address,
    qualification: row.qualification,
    experienceYears: row.experience_years ? Number(row.experience_years) : null,
    joiningDate: row.joining_date,
    status: row.status,
    userId: row.user_id,
    subjectCount: row.subject_count ?? 0,
    classTeacherOf: row.class_teacher_of ?? null,
    createdAt: row.created_at,
  };
}

export async function listTeachers({ search, status, page, limit, offset }) {
  const year = await currentYear();
  const term = search ? `%${search.trim()}%` : null;
  const filters = `
    t.deleted_at IS NULL
    AND ($1::text IS NULL OR (t.first_name || ' ' || t.last_name) ILIKE $1
         OR t.employee_id ILIKE $1 OR t.email ILIKE $1)
    AND ($2::text IS NULL OR t.status::text = $2)
  `;
  const params = [term, status ?? null];

  const [rows, total] = await Promise.all([
    query(
      `SELECT t.*,
              (SELECT count(*)::int FROM teacher_subjects ts
                WHERE ts.teacher_id = t.id AND ts.academic_year_id = $3) AS subject_count,
              (SELECT c.name || ' ' || s.name FROM class_teachers ct
                 JOIN sections s ON s.id = ct.section_id JOIN classes c ON c.id = s.class_id
                WHERE ct.teacher_id = t.id AND ct.academic_year_id = $3 LIMIT 1) AS class_teacher_of
         FROM teachers t WHERE ${filters}
        ORDER BY t.employee_id LIMIT $4 OFFSET $5`,
      [...params, year?.id ?? 0, limit, offset],
    ),
    query(`SELECT count(*)::int AS total FROM teachers t WHERE ${filters}`, params),
  ]);

  return { rows: rows.rows.map(mapTeacher), meta: pagedMeta({ page, limit, total: total.rows[0].total }) };
}

export async function getTeacher(teacherId) {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT t.*,
            (SELECT count(*)::int FROM teacher_subjects ts
              WHERE ts.teacher_id = t.id AND ts.academic_year_id = $2) AS subject_count,
            (SELECT c.name || ' ' || s.name FROM class_teachers ct
               JOIN sections s ON s.id = ct.section_id JOIN classes c ON c.id = s.class_id
              WHERE ct.teacher_id = t.id AND ct.academic_year_id = $2 LIMIT 1) AS class_teacher_of
       FROM teachers t WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [teacherId, year?.id ?? 0],
  );
  const teacher = mapTeacher(rows[0]);
  if (!teacher) throw notFound('Teacher not found.');

  const [assignments, classTeacher, login] = await Promise.all([
    query(
      `SELECT ts.id, ts.class_id, ts.subject_id, c.name AS class_name, s.name AS subject_name
         FROM teacher_subjects ts
         JOIN classes c ON c.id = ts.class_id
         JOIN subjects s ON s.id = ts.subject_id
        WHERE ts.teacher_id = $1 AND ts.academic_year_id = $2
        ORDER BY c.level_order, s.name`,
      [teacherId, year?.id ?? 0],
    ),
    query(
      `SELECT ct.id, ct.section_id, ct.effective_from, s.name AS section_name, c.name AS class_name
         FROM class_teachers ct
         JOIN sections s ON s.id = ct.section_id JOIN classes c ON c.id = s.class_id
        WHERE ct.teacher_id = $1 AND ct.academic_year_id = $2`,
      [teacherId, year?.id ?? 0],
    ),
    query('SELECT username, email, is_active, last_login_at, must_change_password FROM users WHERE id = $1', [
      teacher.userId,
    ]),
  ]);

  return {
    ...teacher,
    assignments: assignments.rows,
    classTeacher: classTeacher.rows[0] || null,
    login: login.rows[0] || null,
  };
}

export async function createTeacher({ payload, actor, ip, userAgent }) {
  const password = temporaryPassword();
  const hash = await bcrypt.hash(password, config.auth.bcryptRounds);

  // Duplicate guard: one living teacher per mobile number (the email is blocked by
  // users.username being unique). The index teachers_mobile_unique backs this up.
  const duplicate = await query(
    'SELECT employee_id, first_name, last_name FROM teachers WHERE deleted_at IS NULL AND mobile = $1 LIMIT 1',
    [payload.mobile],
  );
  if (duplicate.rows[0]) {
    const existing = duplicate.rows[0];
    throw conflict(
      `A teacher with that mobile already exists (${existing.employee_id} · ${existing.first_name} ${existing.last_name}). Edit that record instead of adding a new one.`,
      'TEACHER_EXISTS',
    );
  }

  try {
    const result = await withTransaction(async (client) => {
      const user = await client.query(
        `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
         VALUES ((SELECT id FROM roles WHERE code = 'teacher'), $1, $1, $2, TRUE) RETURNING id`,
        [payload.email.toLowerCase(), hash],
      );

      const teacher = await client.query(
        `INSERT INTO teachers (user_id, first_name, last_name, gender, date_of_birth, mobile, email,
           address, qualification, experience_years, joining_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
         RETURNING id, employee_id`,
        [
          user.rows[0].id,
          payload.firstName,
          payload.lastName,
          payload.gender,
          payload.dateOfBirth ?? null,
          payload.mobile,
          payload.email.toLowerCase(),
          payload.address ?? null,
          payload.qualification ?? null,
          payload.experienceYears ?? null,
          payload.joiningDate,
        ],
      );

      const year = await currentYear(client);
      if (year && Array.isArray(payload.assignments)) {
        for (const item of payload.assignments) {
          await client.query(
            `INSERT INTO teacher_subjects (academic_year_id, teacher_id, class_id, subject_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [year.id, teacher.rows[0].id, item.classId, item.subjectId],
          );
        }
      }

      return { teacherId: teacher.rows[0].id, employeeId: teacher.rows[0].employee_id, password };
    });

    await audit({
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'teacher.created',
      entityType: 'teachers',
      entityId: result.teacherId,
      newValues: { employeeId: result.employeeId, email: payload.email },
      ip,
      userAgent,
    });

    return { teacher: await getTeacher(result.teacherId), account: { username: payload.email.toLowerCase(), temporaryPassword: password } };
  } catch (error) {
    if (error.code === '23505') {
      if (error.constraint === 'teachers_mobile_unique') {
        throw conflict('A teacher with that mobile already exists.', 'TEACHER_EXISTS');
      }
      throw conflict('A user with that email already exists.', 'EMAIL_IN_USE');
    }
    throw error;
  }
}

/**
 * Partial update — the edit form sends only the fields the admin changed. The email is the
 * teacher's login name, so changing it renames the account in the same transaction; a mobile
 * or email that another teacher already holds answers 409 instead of a raw database error.
 */
export async function updateTeacher(teacherId, payload, actor, ip, userAgent) {
  const before = await query('SELECT * FROM teachers WHERE id = $1 AND deleted_at IS NULL', [teacherId]);
  const current = before.rows[0];
  if (!current) throw notFound('Teacher not found.');

  const next = {
    firstName: payload.firstName ?? current.first_name,
    lastName: payload.lastName ?? current.last_name,
    gender: payload.gender ?? current.gender,
    dateOfBirth: payload.dateOfBirth === undefined ? current.date_of_birth : payload.dateOfBirth,
    mobile: payload.mobile ?? current.mobile,
    email: payload.email ?? current.email,
    address: payload.address === undefined ? current.address : payload.address,
    qualification: payload.qualification === undefined ? current.qualification : payload.qualification,
    experienceYears:
      payload.experienceYears === undefined ? current.experience_years : payload.experienceYears,
    joiningDate: payload.joiningDate ?? current.joining_date,
    status: payload.status ?? current.status,
  };

  if (next.mobile !== current.mobile) {
    const clash = await query(
      'SELECT employee_id FROM teachers WHERE deleted_at IS NULL AND mobile = $1 AND id <> $2',
      [next.mobile, teacherId],
    );
    if (clash.rows[0]) {
      throw conflict(
        `Another teacher already uses that mobile number (${clash.rows[0].employee_id}).`,
        'TEACHER_EXISTS',
      );
    }
  }

  try {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE teachers
            SET first_name = $2, last_name = $3, gender = $4, date_of_birth = $5, mobile = $6,
                email = $7, address = $8, qualification = $9, experience_years = $10,
                joining_date = $11, status = $12
          WHERE id = $1 AND deleted_at IS NULL`,
        [
          teacherId,
          next.firstName,
          next.lastName,
          next.gender,
          next.dateOfBirth ?? null,
          next.mobile,
          next.email ?? null,
          next.address ?? null,
          next.qualification ?? null,
          next.experienceYears ?? null,
          next.joiningDate,
          next.status,
        ],
      );

      // Email is the login identity; rename the account when it changes.
      if (current.user_id && next.email && next.email !== current.email) {
        await client.query('UPDATE users SET username = $2, email = $2 WHERE id = $1', [
          current.user_id,
          next.email,
        ]);
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      if (error.constraint === 'teachers_mobile_unique') {
        throw conflict('Another teacher already uses that mobile number.', 'TEACHER_EXISTS');
      }
      throw conflict('That email is already a login for another account.', 'EMAIL_IN_USE');
    }
    throw error;
  }

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'teacher.updated',
    entityType: 'teachers',
    entityId: teacherId,
    oldValues: {
      firstName: current.first_name,
      lastName: current.last_name,
      gender: current.gender,
      dateOfBirth: current.date_of_birth,
      mobile: current.mobile,
      email: current.email,
      qualification: current.qualification,
      experienceYears: current.experience_years,
      joiningDate: current.joining_date,
      address: current.address,
      status: current.status,
    },
    newValues: payload,
    ip,
    userAgent,
  });

  return getTeacher(teacherId);
}

/**
 * Deactivating a teacher who is still a class teacher would leave a section without
 * one, which the BRD forbids — the replacement must be set first.
 */
export async function changeTeacherStatus(teacherId, status, actor, ip, userAgent) {
  const year = await currentYear();
  if (status !== 'active') {
    const assigned = await query(
      'SELECT 1 FROM class_teachers WHERE teacher_id = $1 AND academic_year_id = $2',
      [teacherId, year?.id ?? 0],
    );
    if (assigned.rows[0]) {
      throw conflict(
        'This teacher is still a class teacher. Assign a replacement first.',
        'TEACHER_IS_CLASS_TEACHER',
      );
    }
  }
  const { rows } = await query(
    'UPDATE teachers SET status = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, status',
    [teacherId, status],
  );
  if (!rows[0]) throw notFound('Teacher not found.');

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'teacher.status_changed',
    entityType: 'teachers',
    entityId: teacherId,
    newValues: { status },
    ip,
    userAgent,
  });
  return getTeacher(teacherId);
}

export async function setAssignments(teacherId, items, actor, ip, userAgent) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');

  return withTransaction(async (client) => {
    const teacher = await client.query('SELECT id FROM teachers WHERE id = $1 AND deleted_at IS NULL', [teacherId]);
    if (!teacher.rows[0]) throw notFound('Teacher not found.');

    await client.query('DELETE FROM teacher_subjects WHERE teacher_id = $1 AND academic_year_id = $2', [
      teacherId,
      year.id,
    ]);
    for (const item of items) {
      await client.query(
        `INSERT INTO teacher_subjects (academic_year_id, teacher_id, class_id, subject_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [year.id, teacherId, item.classId, item.subjectId],
      );
    }

    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'teacher.assignments_updated',
      entityType: 'teachers',
      entityId: teacherId,
      newValues: { assignments: items },
      ip,
      userAgent,
    });
  }).then(() => getTeacher(teacherId));
}

export async function assignClassTeacher(teacherId, { sectionId, effectiveFrom }, actor, ip, userAgent) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');

  try {
    await withTransaction(async (client) => {
      const section = await client.query('SELECT id FROM sections WHERE id = $1 AND deleted_at IS NULL', [
        sectionId,
      ]);
      if (!section.rows[0]) throw notFound('Section not found.');

      const teacher = await client.query(
        'SELECT id, status FROM teachers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [teacherId],
      );
      if (!teacher.rows[0]) throw notFound('Teacher not found.');
      if (teacher.rows[0].status !== 'active') {
        throw conflict('Only an active teacher can be a class teacher.', 'TEACHER_NOT_ACTIVE');
      }

      // One class teacher per section per year: replace whoever holds it now.
      await client.query('DELETE FROM class_teachers WHERE academic_year_id = $1 AND section_id = $2', [
        year.id,
        sectionId,
      ]);
      await client.query(
        `INSERT INTO class_teachers (academic_year_id, section_id, teacher_id, effective_from)
         VALUES ($1, $2, $3, $4)`,
        [year.id, sectionId, teacherId, effectiveFrom],
      );

      await audit({
        client,
        actorUserId: actor?.id,
        actorRole: actor?.role,
        action: 'class_teacher.assigned',
        entityType: 'class_teachers',
        entityId: teacherId,
        newValues: { sectionId, effectiveFrom },
        ip,
        userAgent,
      });
    });
  } catch (error) {
    if (error.code === '23505') {
      // Two different unique keys can fire here; the message has to say which rule was broken.
      if (error.constraint === 'class_teachers_one_section_per_teacher') {
        throw conflict(
          'This teacher is already the class teacher of another section.',
          'TEACHER_ALREADY_CLASS_TEACHER',
        );
      }
      throw conflict('Another admin just assigned a class teacher to this section. Reload and try again.', 'SECTION_ALREADY_ASSIGNED');
    }
    throw error;
  }

  return getTeacher(teacherId);
}

export async function clearClassTeacher(teacherId, actor, ip, userAgent) {
  const year = await currentYear();
  const { rowCount } = await query(
    'DELETE FROM class_teachers WHERE teacher_id = $1 AND academic_year_id = $2',
    [teacherId, year?.id ?? 0],
  );
  if (rowCount === 0) throw notFound('This teacher is not a class teacher.');
  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'class_teacher.removed',
    entityType: 'teachers',
    entityId: teacherId,
    ip,
    userAgent,
  });
  return getTeacher(teacherId);
}

export async function resetTeacherPassword(teacherId, actor, ip, userAgent) {
  const teacher = await query('SELECT id, email, user_id FROM teachers WHERE id = $1 AND deleted_at IS NULL', [
    teacherId,
  ]);
  if (!teacher.rows[0]) throw notFound('Teacher not found.');

  const password = temporaryPassword();
  const hash = await bcrypt.hash(password, config.auth.bcryptRounds);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = TRUE, is_active = TRUE,
         failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [teacher.rows[0].user_id, hash],
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_reset'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [teacher.rows[0].user_id],
    );
  });

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'teacher.password_reset',
    entityType: 'teachers',
    entityId: teacherId,
    ip,
    userAgent,
  });
  return { username: teacher.rows[0].email, temporaryPassword: password };
}

export async function deleteTeacher(teacherId, actor, ip, userAgent) {
  const year = await currentYear();
  const linked = await query(
    `SELECT
       (SELECT count(*)::int FROM class_teachers WHERE teacher_id = $1 AND academic_year_id = $2) +
       (SELECT count(*)::int FROM teacher_subjects WHERE teacher_id = $1 AND academic_year_id = $2) +
       (SELECT count(*)::int FROM timetable_slots WHERE teacher_id = $1) AS total`,
    [teacherId, year?.id ?? 0],
  );
  if (linked.rows[0].total > 0) {
    throw conflict(
      'This teacher still has classes or a timetable. Remove those assignments first.',
      'TEACHER_IN_USE',
    );
  }

  return withTransaction(async (client) => {
    const rows = await client.query(
      'UPDATE teachers SET deleted_at = now(), status = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING user_id',
      [teacherId, 'resigned'],
    );
    if (!rows.rows[0]) throw notFound('Teacher not found.');
    if (rows.rows[0].user_id) {
      await client.query('UPDATE users SET is_active = FALSE, deleted_at = now() WHERE id = $1', [
        rows.rows[0].user_id,
      ]);
    }
    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'teacher.deleted',
      entityType: 'teachers',
      entityId: teacherId,
      ip,
      userAgent,
    });
  }).then(() => ({ deleted: true }));
}

/**
 * The signed-in teacher's own record plus the classes/subjects they teach this year and the
 * sections they are class teacher of. Powers the teacher's "My Classes" screen and the class
 * filter on their student roster — the client never guesses which classes it may ask about.
 */
export async function myTeaching(userId) {
  const year = await currentYear();
  const yearId = year?.id ?? 0;
  const own = await query(
    `SELECT id, employee_id, first_name, last_name, email
       FROM teachers WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  if (!own.rows[0]) return { teacher: null, academicYear: year?.name ?? null, classes: [] };
  const teacherId = own.rows[0].id;

  const { rows } = await query(
    `SELECT c.id AS class_id, c.name AS class_name,
            string_agg(DISTINCT sub.name, ', ' ORDER BY sub.name) AS subjects,
            (SELECT count(*)::int FROM enrollments e
              WHERE e.class_id = c.id AND e.academic_year_id = $2 AND e.status = 'active') AS students,
            COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.name)
                        FROM sections s
                        JOIN class_teachers ct ON ct.section_id = s.id AND ct.academic_year_id = $2
                       WHERE s.class_id = c.id AND ct.teacher_id = $1), '[]'::json) AS class_teacher_of
       FROM teacher_subjects ts
       JOIN classes c ON c.id = ts.class_id
       JOIN subjects sub ON sub.id = ts.subject_id AND sub.deleted_at IS NULL
      WHERE ts.teacher_id = $1 AND ts.academic_year_id = $2
      GROUP BY c.id, c.name, c.level_order
      ORDER BY c.level_order`,
    [teacherId, yearId],
  );

  return {
    teacher: {
      id: Number(teacherId),
      employeeId: own.rows[0].employee_id,
      name: `${own.rows[0].first_name} ${own.rows[0].last_name}`,
      email: own.rows[0].email,
    },
    academicYear: year?.name ?? null,
    classes: rows.map((row) => ({ ...row, class_id: Number(row.class_id) })),
  };
}

export default {
  listTeachers,
  getTeacher,
  myTeaching,
  createTeacher,
  updateTeacher,
  changeTeacherStatus,
  setAssignments,
  assignClassTeacher,
  clearClassTeacher,
  resetTeacherPassword,
  deleteTeacher,
};
