import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';
import { query, withTransaction } from '../config/db.js';
import { audit } from './auditService.js';
import { conflict, notFound } from '../utils/errors.js';
import { removeUploads, saveUpload } from '../utils/uploads.js';
import { temporaryPassword } from '../utils/passwords.js';
import { currentYear } from './academicsService.js';
import { pagedMeta } from '../utils/request.js';

const PUBLIC_COLUMNS = `
  s.id, s.admission_id, s.first_name, s.last_name, s.date_of_birth, s.gender, s.blood_group,
  s.admission_date, s.previous_school, s.status, s.photo_path, s.user_id, s.created_at
`;

function mapStudent(row) {
  if (!row) return null;
  return {
    id: row.id,
    admissionId: row.admission_id,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name}`,
    dateOfBirth: row.date_of_birth,
    gender: row.gender,
    bloodGroup: row.blood_group,
    admissionDate: row.admission_date,
    previousSchool: row.previous_school,
    status: row.status,
    photoPath: row.photo_path,
    userId: row.user_id,
    className: row.class_name ?? null,
    sectionName: row.section_name ?? null,
    classId: row.class_id ?? null,
    sectionId: row.section_id ?? null,
    rollNo: row.roll_no ?? null,
    guardianMobile: row.guardian_mobile ?? null,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * A teacher holds `student.view.assigned`, so the roster must be limited to the classes they
 * actually teach in the current academic year. Admin gets `null` = no restriction.
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

export async function listStudents({ search, classId, sectionId, status, page, limit, offset }, actor) {
  const year = await currentYear();
  const yearId = year?.id ?? 0;
  const term = search ? `%${search.trim()}%` : null;
  const scope = await teacherClassScope(actor);

  const filters = `
    s.deleted_at IS NULL
    AND ($1::text IS NULL OR (s.first_name || ' ' || s.last_name) ILIKE $1 OR s.admission_id ILIKE $1)
    AND ($2::int IS NULL OR e.class_id = $2)
    AND ($3::int IS NULL OR e.section_id = $3)
    AND ($4::text IS NULL OR s.status::text = $4)
    AND ($5::int[] IS NULL OR e.class_id = ANY($5::int[]))
  `;
  const params = [term, classId ?? null, sectionId ?? null, status ?? null, scope];

  const [rows, total] = await Promise.all([
    query(
      `SELECT ${PUBLIC_COLUMNS}, c.name AS class_name, sec.name AS section_name,
              e.class_id, e.section_id, e.roll_no,
              (SELECT p.mobile FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
                WHERE sp.student_id = s.id ORDER BY sp.is_primary DESC LIMIT 1) AS guardian_mobile
         FROM students s
         LEFT JOIN enrollments e ON e.student_id = s.id AND e.academic_year_id = $6
         LEFT JOIN classes c ON c.id = e.class_id
         LEFT JOIN sections sec ON sec.id = e.section_id
        WHERE ${filters}
        ORDER BY s.admission_id
        LIMIT $7 OFFSET $8`,
      [...params, yearId, limit, offset],
    ),
    query(
      `SELECT count(*)::int AS total FROM students s
         LEFT JOIN enrollments e ON e.student_id = s.id AND e.academic_year_id = $6
        WHERE ${filters}`,
      [...params, yearId],
    ),
  ]);

  return {
    rows: rows.rows.map(mapStudent),
    meta: pagedMeta({ page, limit, total: total.rows[0].total }),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function getStudent(studentId) {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, c.name AS class_name, sec.name AS section_name,
            e.class_id, e.section_id, e.roll_no
       FROM students s
       LEFT JOIN enrollments e ON e.student_id = s.id AND e.academic_year_id = $2
       LEFT JOIN classes c ON c.id = e.class_id
       LEFT JOIN sections sec ON sec.id = e.section_id
      WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [studentId, year?.id ?? 0],
  );
  const student = mapStudent(rows[0]);
  if (!student) throw notFound('Student not found.');

  const [parents, documents, history, login] = await Promise.all([
    query(
      `SELECT p.id, p.full_name, p.mobile, p.email, p.occupation, p.address_line, p.city, p.state,
              p.pincode, sp.relationship, sp.is_primary, p.user_id
         FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = $1 ORDER BY sp.is_primary DESC, p.full_name`,
      [studentId],
    ),
    query(
      `SELECT id, doc_type, file_name, mime_type, size_bytes, created_at
         FROM documents WHERE owner_type = 'student' AND owner_id = $1 AND deleted_at IS NULL
        ORDER BY created_at`,
      [studentId],
    ),
    query(
      `SELECT id, from_status, to_status, effective_date, remarks, created_at,
              (SELECT u.username FROM users u WHERE u.id = h.changed_by) AS changed_by
         FROM student_status_history h
        WHERE h.student_id = $1 ORDER BY h.effective_date DESC, h.id DESC`,
      [studentId],
    ),
    query(
      `SELECT u.username, u.is_active, u.last_login_at, u.must_change_password
         FROM users u WHERE u.id = $1`,
      [student.user_id],
    ),
  ]);

  return {
    ...student,
    parents: parents.rows,
    documents: documents.rows,
    statusHistory: history.rows,
    login: login.rows[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export async function createStudent({ payload, files = [], documentTypes = [], actor, ip, userAgent }) {
  const year = payload.academicYearId ? { id: payload.academicYearId } : await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');

  const section = await query('SELECT id, class_id FROM sections WHERE id = $1 AND deleted_at IS NULL', [
    payload.sectionId,
  ]);
  if (!section.rows[0]) throw notFound('Section not found.');
  if (section.rows[0].class_id !== payload.classId) {
    throw conflict('The section does not belong to the selected class.', 'SECTION_CLASS_MISMATCH');
  }

  const sharedPassword = temporaryPassword();
  const sharedHash = await bcrypt.hash(sharedPassword, config.auth.bcryptRounds);

  // Duplicate guard: the same child admitted twice (double click, or a re-typed form).
  // The database enforces this too (students_identity_unique); this check exists so the
  // message can name the admission already on file.
  const duplicate = await query(
    `SELECT admission_id FROM students
      WHERE deleted_at IS NULL
        AND (
          (lower(btrim(first_name)) = lower(btrim($1))
           AND lower(btrim(last_name)) = lower(btrim($2))
           AND date_of_birth = $3)
          OR EXISTS (
            SELECT 1 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
             WHERE sp.student_id = students.id AND p.mobile = $4
               AND lower(btrim(students.first_name)) = lower(btrim($1))
               AND lower(btrim(students.last_name)) = lower(btrim($2))
          )
        )
      LIMIT 1`,
    [
      payload.firstName,
      payload.lastName,
      payload.dateOfBirth,
      (payload.parents || [])[0]?.mobile ?? '',
    ],
  );
  if (duplicate.rows[0]) {
    throw conflict(
      `This student is already admitted as ${duplicate.rows[0].admission_id}. Edit that record instead of adding a new one.`,
      'STUDENT_EXISTS',
    );
  }

  const writtenFiles = [];
  // Guardian logins created by this admission (an already-existing family account keeps its
  // old password, so it must not be advertised with the new shared one).
  const guardianLogins = [];
  try {
    const result = await withTransaction(async (client) => {
      // 1. Student row — admission_id comes from the database sequence, never the client.
      const student = await client.query(
        `INSERT INTO students (first_name, last_name, gender, date_of_birth, blood_group,
           admission_date, previous_school, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING id, admission_id`,
        [
          payload.firstName,
          payload.lastName,
          payload.gender,
          payload.dateOfBirth,
          payload.bloodGroup ?? null,
          payload.admissionDate,
          payload.previousSchool ?? null,
        ],
      );
      const studentId = student.rows[0].id;
      const admissionId = student.rows[0].admission_id;

      // 2. Login: username is the Admission ID.
      let login = null;
      if (payload.createLogin !== false) {
        const user = await client.query(
          `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
           VALUES ((SELECT id FROM roles WHERE code = 'student'), $1, NULL, $2, TRUE)
           RETURNING id`,
          [admissionId, sharedHash],
        );
        await client.query('UPDATE students SET user_id = $2 WHERE id = $1', [studentId, user.rows[0].id]);
        login = { username: admissionId, temporaryPassword: sharedPassword };
      }

      // 3. Enrollment for the academic year.
      await client.query(
        `INSERT INTO enrollments (student_id, academic_year_id, class_id, section_id, roll_no, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [studentId, year.id, payload.classId, payload.sectionId, payload.rollNo ?? null],
      );

      // 4. Guardians — one family account is reused when the mobile or email matches.
      for (const parent of payload.parents || []) {
        const existing = await client.query(
          `SELECT id, user_id FROM parents
            WHERE deleted_at IS NULL AND (lower(email) = lower($1) OR mobile = $2)
            LIMIT 1`,
          [parent.email ?? '', parent.mobile],
        );

        let parentId;
        if (existing.rows[0]) {
          parentId = existing.rows[0].id;
          if (!existing.rows[0].user_id) {
            const user = await client.query(
              `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
               VALUES ((SELECT id FROM roles WHERE code = 'parent'), $1, $2, $3, TRUE)
               RETURNING id`,
              [parent.email || parent.mobile, parent.email ?? null, sharedHash],
            );
            await client.query('UPDATE parents SET user_id = $2 WHERE id = $1', [
              parentId,
              user.rows[0].id,
            ]);
            guardianLogins.push({
              name: parent.fullName,
              username: parent.email || parent.mobile,
            });
          }
        } else {
          const created = await client.query(
            `INSERT INTO parents (full_name, mobile, email, occupation, address_line, city, state, pincode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              parent.fullName,
              parent.mobile,
              parent.email ?? null,
              parent.occupation ?? null,
              parent.addressLine ?? null,
              parent.city ?? null,
              parent.state ?? null,
              parent.pincode ?? null,
            ],
          );
          parentId = created.rows[0].id;
          const user = await client.query(
            `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
             VALUES ((SELECT id FROM roles WHERE code = 'parent'), $1, $2, $3, TRUE)
             RETURNING id`,
            [parent.email || parent.mobile, parent.email ?? null, sharedHash],
          );
          await client.query('UPDATE parents SET user_id = $2 WHERE id = $1', [parentId, user.rows[0].id]);
          guardianLogins.push({
            name: parent.fullName,
            username: parent.email || parent.mobile,
          });
        }

        await client.query(
          `INSERT INTO student_parents (student_id, parent_id, relationship, is_primary)
           VALUES ($1, $2, $3, $4) ON CONFLICT (student_id, parent_id) DO NOTHING`,
          [studentId, parentId, parent.relationship || 'guardian', Boolean(parent.isPrimary)],
        );
      }

      // 5. Documents (already validated for type and size by multer).
      for (let index = 0; index < files.length; index += 1) {
        // An empty file part (a form field left untouched) is not a document: skip it instead of
        // writing a 0-byte row — and instead of failing the whole admission on a storage error.
        if (!files[index] || !files[index].size) continue;
        const stored = await saveUpload({ file: files[index], folder: `students/${studentId}` });
        writtenFiles.push(stored.filePath);
        await client.query(
          `INSERT INTO documents (owner_type, owner_id, doc_type, file_name, file_path, mime_type,
             size_bytes, uploaded_by)
           VALUES ('student', $1, $2, $3, $4, $5, $6, $7)`,
          [
            studentId,
            documentTypes[index] || 'admission_document',
            stored.fileName,
            stored.filePath,
            stored.mimeType,
            stored.sizeBytes,
            actor?.id ?? null,
          ],
        );
      }

      // 6. Lifecycle history.
      await client.query(
        `INSERT INTO student_status_history (student_id, academic_year_id, from_status, to_status,
           effective_date, remarks, changed_by)
         VALUES ($1, $2, 'new_admission', 'active', $3, 'Admission', $4)`,
        [studentId, year.id, payload.admissionDate, actor?.id ?? null],
      );

      return { studentId, admissionId, login };
    });

    await audit({
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'student.admitted',
      entityType: 'students',
      entityId: result.studentId,
      newValues: {
        admissionId: result.admissionId,
        classId: payload.classId,
        sectionId: payload.sectionId,
        guardians: (payload.parents || []).length,
        documents: files.length,
      },
      ip,
      userAgent,
    });

    return {
      student: await getStudent(result.studentId),
      account: result.login,
      guardians: guardianLogins,
    };
  } catch (error) {
    await removeUploads(writtenFiles);
    if (error.code === '23505') {
      // The unique index is the race-proof backstop for two submits of the same child.
      if (error.constraint === 'students_identity_unique') {
        throw conflict(
          'This student is already admitted (same name and date of birth). Edit that record instead of adding a new one.',
          'STUDENT_EXISTS',
        );
      }
      throw conflict('That username or guardian already exists.', 'DUPLICATE_ACCOUNT');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Update / status / delete
// ---------------------------------------------------------------------------

/**
 * Partial update: student columns, current-year placement (class / section / roll) and
 * the contact block of linked guardians. One transaction, one audit row with old + new
 * values. A guardian mobile that doubles as the family login is renamed with it, so the
 * parent does not lose access after the number is corrected.
 */
export async function updateStudent(studentId, payload, actor, ip, userAgent) {
  const before = await getStudent(studentId);

  try {
  await withTransaction(async (client) => {
    const current = await client.query(
      `SELECT id, first_name, last_name, gender, date_of_birth, blood_group, previous_school
         FROM students WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [studentId],
    );
    if (!current.rows[0]) throw notFound('Student not found.');
    const row = current.rows[0];

    await client.query(
      `UPDATE students
          SET first_name = $2, last_name = $3, gender = $4, date_of_birth = $5,
              blood_group = $6, previous_school = $7
        WHERE id = $1`,
      [
        studentId,
        payload.firstName ?? row.first_name,
        payload.lastName ?? row.last_name,
        payload.gender ?? row.gender,
        payload.dateOfBirth ?? row.date_of_birth,
        payload.bloodGroup === undefined ? row.blood_group : payload.bloodGroup || null,
        payload.previousSchool === undefined ? row.previous_school : payload.previousSchool || null,
      ],
    );

    const movingPlacement =
      payload.classId !== undefined || payload.sectionId !== undefined || payload.rollNo !== undefined;

    if (movingPlacement) {
      const year = await currentYear(client);
      if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

      const existing = await client.query(
        `SELECT id, class_id, section_id, roll_no FROM enrollments
          WHERE student_id = $1 AND academic_year_id = $2 FOR UPDATE`,
        [studentId, year.id],
      );
      const enrollment = existing.rows[0] || null;

      const classId = payload.classId ?? enrollment?.class_id ?? null;
      const sectionId = payload.sectionId ?? enrollment?.section_id ?? null;
      const rollNo = payload.rollNo !== undefined ? payload.rollNo : enrollment?.roll_no ?? null;

      if (sectionId) {
        const section = await client.query('SELECT class_id FROM sections WHERE id = $1 AND deleted_at IS NULL', [
          sectionId,
        ]);
        if (!section.rows[0]) throw notFound('That section does not exist.');
        if (classId && section.rows[0].class_id !== Number(classId)) {
          throw conflict('That section belongs to another class.', 'SECTION_CLASS_MISMATCH');
        }
      }

      if (enrollment) {
        await client.query('UPDATE enrollments SET class_id = $2, section_id = $3, roll_no = $4 WHERE id = $1', [
          enrollment.id,
          classId ?? enrollment.class_id,
          sectionId ?? enrollment.section_id,
          rollNo,
        ]);
      } else if (classId && sectionId) {
        await client.query(
          `INSERT INTO enrollments (student_id, academic_year_id, class_id, section_id, roll_no, status)
           VALUES ($1, $2, $3, $4, $5, 'active')`,
          [studentId, year.id, classId, sectionId, rollNo],
        );
      } else {
        throw conflict('This student has no enrollment in the current academic year.', 'NO_ENROLLMENT');
      }
    }

    for (const guardian of payload.guardians || []) {
      const linked = await client.query(
        `SELECT p.id, p.mobile, p.email, p.occupation, p.address_line, p.city, p.state, p.pincode, p.user_id
           FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
          WHERE sp.student_id = $1 AND p.id = $2`,
        [studentId, guardian.id],
      );
      const parent = linked.rows[0];
      if (!parent) throw notFound('That guardian is not linked to this student.');

      const mobile = guardian.mobile ?? parent.mobile;
      if (mobile !== parent.mobile) {
        const clash = await client.query(
          'SELECT id FROM parents WHERE mobile = $1 AND id <> $2 AND deleted_at IS NULL',
          [mobile, parent.id],
        );
        if (clash.rowCount) throw conflict('Another guardian already uses that mobile number.', 'MOBILE_IN_USE');
      }

      await client.query(
        `UPDATE parents
            SET mobile = $2, email = $3, occupation = $4, address_line = $5,
                city = $6, state = $7, pincode = $8
          WHERE id = $1`,
        [
          parent.id,
          mobile,
          guardian.email === undefined ? parent.email : guardian.email || null,
          guardian.occupation === undefined ? parent.occupation : guardian.occupation || null,
          guardian.addressLine === undefined ? parent.address_line : guardian.addressLine || null,
          guardian.city === undefined ? parent.city : guardian.city || null,
          guardian.state === undefined ? parent.state : guardian.state || null,
          guardian.pincode === undefined ? parent.pincode : guardian.pincode || null,
        ],
      );

      // The family login is the guardian's email when there is one, otherwise the mobile.
      // Both the username and users.email follow the contact details, so signing in with the
      // new address works immediately.
      const nextEmail = guardian.email === undefined ? parent.email : guardian.email || null;
      if (parent.user_id) {
        const oldIdentities = [parent.email, parent.mobile].filter(Boolean).map((v) => v.toLowerCase());
        if (nextEmail && oldIdentities.includes(String(parent.email || '').toLowerCase())) {
          await client.query('UPDATE users SET username = $2 WHERE id = $1', [parent.user_id, nextEmail]);
        } else if (mobile !== parent.mobile && oldIdentities.includes(String(parent.mobile).toLowerCase())) {
          await client.query('UPDATE users SET username = $2 WHERE id = $1', [parent.user_id, mobile]);
        }
        if (nextEmail !== parent.email) {
          await client.query('UPDATE users SET email = $2 WHERE id = $1', [parent.user_id, nextEmail]);
        }
      }
    }
  });
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('That email is already used by another login.', 'EMAIL_IN_USE');
    }
    throw error;
  }

  const after = await getStudent(studentId);

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'student.updated',
    entityType: 'students',
    entityId: studentId,
    oldValues: {
      firstName: before.firstName,
      lastName: before.lastName,
      gender: before.gender,
      dateOfBirth: before.dateOfBirth,
      bloodGroup: before.bloodGroup,
      previousSchool: before.previousSchool,
      classId: before.classId,
      sectionId: before.sectionId,
      rollNo: before.rollNo,
      guardians: before.parents.map((parent) => ({ id: parent.id, mobile: parent.mobile })),
    },
    newValues: payload,
    ip,
    userAgent,
  });

  return after;
}

export async function changeStatus(studentId, { status, effectiveDate, remarks }, actor, ip, userAgent) {
  await withTransaction(async (client) => {
    const current = await client.query(
      'SELECT id, status FROM students WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [studentId],
    );
    if (!current.rows[0]) throw notFound('Student not found.');
    if (current.rows[0].status === status) {
      throw conflict('The student already has that status.', 'STATUS_UNCHANGED');
    }

    const year = await currentYear(client);
    await client.query('UPDATE students SET status = $2 WHERE id = $1', [studentId, status]);
    await client.query(
      `INSERT INTO student_status_history (student_id, academic_year_id, from_status, to_status,
         effective_date, remarks, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [studentId, year?.id ?? null, current.rows[0].status, status, effectiveDate, remarks ?? null, actor?.id ?? null],
    );

    // A student who leaves must not keep a working login.
    if (['transferred', 'withdrawn', 'graduated', 'suspended'].includes(status)) {
      await client.query(
        `UPDATE users SET is_active = FALSE, deactivated_at = now()
          WHERE id = (SELECT user_id FROM students WHERE id = $1)`,
        [studentId],
      );
    }

    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'student.status_changed',
      entityType: 'students',
      entityId: studentId,
      oldValues: { status: current.rows[0].status },
      newValues: { status },
      reason: remarks ?? null,
      ip,
      userAgent,
    });
  });

  // Read back after COMMIT: a query through the pool inside the transaction
  // would return the pre-update row.
  return getStudent(studentId);
}

/**
 * Issue a fresh temporary password for a guardian's family login. The login name is the
 * guardian's email (or mobile when there is no email) — the same identity the admission slip
 * prints — so this is how the school recovers a parent who lost their password.
 */
export async function resetGuardianPassword(studentId, parentId, actor, ip, userAgent) {
  const linked = await query(
    `SELECT p.id, p.full_name, p.email, p.mobile, p.user_id
       FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
      WHERE sp.student_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [studentId, parentId],
  );
  const parent = linked.rows[0];
  if (!parent) throw notFound('That guardian is not linked to this student.');
  if (!parent.user_id) throw conflict('This guardian has no login account.', 'NO_ACCOUNT');

  const password = temporaryPassword();
  const hash = await bcrypt.hash(password, config.auth.bcryptRounds);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = TRUE, is_active = TRUE,
         failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [parent.user_id, hash],
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_reset'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [parent.user_id],
    );
  });

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'parent.password_reset',
    entityType: 'parents',
    entityId: parent.id,
    newValues: { studentId, login: parent.email || parent.mobile },
    ip,
    userAgent,
  });

  return {
    guardian: parent.full_name,
    username: parent.email || parent.mobile,
    temporaryPassword: password,
  };
}

export async function softDeleteStudent(studentId, actor, ip, userAgent) {
  await withTransaction(async (client) => {
    const existing = await client.query('SELECT id, admission_id, user_id FROM students WHERE id = $1 AND deleted_at IS NULL', [
      studentId,
    ]);
    if (!existing.rows[0]) throw notFound('Student not found.');

    await client.query('UPDATE students SET deleted_at = now(), status = $2 WHERE id = $1', [
      studentId,
      'withdrawn',
    ]);
    if (existing.rows[0].user_id) {
      await client.query('UPDATE users SET is_active = FALSE, deleted_at = now() WHERE id = $1', [
        existing.rows[0].user_id,
      ]);
    }
    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'student.deleted',
      entityType: 'students',
      entityId: studentId,
      oldValues: { admissionId: existing.rows[0].admission_id },
      ip,
      userAgent,
    });
  });
  return { deleted: true };
}

export async function resetStudentPassword(studentId, actor, ip, userAgent) {
  const student = await query(
    'SELECT id, admission_id, user_id FROM students WHERE id = $1 AND deleted_at IS NULL',
    [studentId],
  );
  if (!student.rows[0]) throw notFound('Student not found.');
  if (!student.rows[0].user_id) throw conflict('This student has no login account.', 'NO_ACCOUNT');

  const password = temporaryPassword();
  const hash = await bcrypt.hash(password, config.auth.bcryptRounds);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = TRUE, is_active = TRUE,
         failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [student.rows[0].user_id, hash],
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_reset'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [student.rows[0].user_id],
    );
  });

  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'student.password_reset',
    entityType: 'students',
    entityId: studentId,
    ip,
    userAgent,
  });

  return { username: student.rows[0].admission_id, temporaryPassword: password };
}

export async function addDocuments(studentId, files, documentTypes, actor) {
  const student = await query('SELECT id FROM students WHERE id = $1 AND deleted_at IS NULL', [studentId]);
  if (!student.rows[0]) throw notFound('Student not found.');

  const written = [];
  try {
    return await withTransaction(async (client) => {
      const inserted = [];
      for (let index = 0; index < files.length; index += 1) {
        // An empty file part (a form field left untouched) is not a document: skip it instead of
        // writing a 0-byte row — and instead of failing the whole admission on a storage error.
        if (!files[index] || !files[index].size) continue;
        const stored = await saveUpload({ file: files[index], folder: `students/${studentId}` });
        written.push(stored.filePath);
        const { rows } = await client.query(
          `INSERT INTO documents (owner_type, owner_id, doc_type, file_name, file_path, mime_type,
             size_bytes, uploaded_by)
           VALUES ('student', $1, $2, $3, $4, $5, $6, $7)
           RETURNING id, doc_type, file_name, mime_type, size_bytes, created_at`,
          [
            studentId,
            documentTypes[index] || 'admission_document',
            stored.fileName,
            stored.filePath,
            stored.mimeType,
            stored.sizeBytes,
            actor?.id ?? null,
          ],
        );
        inserted.push(rows[0]);
      }
      return inserted;
    });
  } catch (error) {
    await removeUploads(written);
    throw error;
  }
}

export async function getDocument(documentId) {
  const { rows } = await query(
    `SELECT d.*, s.user_id AS student_user_id
       FROM documents d
       LEFT JOIN students s ON d.owner_type = 'student' AND s.id = d.owner_id
      WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [documentId],
  );
  if (!rows[0]) throw notFound('Document not found.');
  return rows[0];
}

export async function deleteDocument(documentId, actor, ip, userAgent) {
  const document = await getDocument(documentId);
  await query('UPDATE documents SET deleted_at = now() WHERE id = $1', [documentId]);
  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'document.deleted',
    entityType: 'documents',
    entityId: documentId,
    oldValues: { filePath: document.file_path },
    ip,
    userAgent,
  });
  await removeUploads([document.file_path]);
  return { deleted: true };
}

export default {
  listStudents,
  getStudent,
  createStudent,
  updateStudent,
  changeStatus,
  softDeleteStudent,
  resetStudentPassword,
  addDocuments,
  getDocument,
  deleteDocument,
};
