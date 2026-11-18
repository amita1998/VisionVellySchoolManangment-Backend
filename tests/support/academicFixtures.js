import './testEnv.js';
import bcrypt from 'bcryptjs';
import { ACCOUNTS, TEST_PASSWORD } from './testEnv.js';
import { pool } from '../../src/config/db.js';
import { resetDatabase } from './db.js';

/**
 * A miniature school used by the dashboard tests:
 *   Class 5 - A : S1 (login VVS-900001), class teacher T1, one published mark
 *   Class 5 - B : S2 (no login), the parent of S2 must never be visible to S1's parent
 */
export async function seedAcademicFixtures() {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
  const ids = {};

  async function user(key, role, username, email) {
    const { rows } = await pool.query(
      `INSERT INTO users (role_id, username, email, password_hash, must_change_password)
       VALUES ((SELECT id FROM roles WHERE code = $1), $2, $3, $4, FALSE) RETURNING id`,
      [role, username, email, passwordHash],
    );
    ids[key] = rows[0].id;
    return rows[0].id;
  }

  await user('admin', 'admin', ACCOUNTS.admin.username, ACCOUNTS.admin.email);
  const teacherUserId = await user('teacher', 'teacher', ACCOUNTS.teacher.username, ACCOUNTS.teacher.email);
  const studentUserId = await user('student', 'student', ACCOUNTS.student.username, null);
  const parentUserId = await user('parent', 'parent', ACCOUNTS.parent.username, ACCOUNTS.parent.email);
  await user('otherParent', 'parent', 'other.parent@vvs.test', 'other.parent@vvs.test');

  const ay = await pool.query(
    `INSERT INTO academic_years (name, start_date, end_date, is_current)
     VALUES ('2026-2027', '2026-04-01', '2027-03-31', TRUE) RETURNING id`,
  );
  ids.yearId = ay.rows[0].id;

  const klass = await pool.query(
    `INSERT INTO classes (name, level_order) VALUES ('Class 5', 3) RETURNING id`,
  );
  ids.classId = klass.rows[0].id;

  const sectionA = await pool.query(
    `INSERT INTO sections (class_id, name) VALUES ($1, 'A') RETURNING id`,
    [ids.classId],
  );
  const sectionB = await pool.query(
    `INSERT INTO sections (class_id, name) VALUES ($1, 'B') RETURNING id`,
    [ids.classId],
  );
  ids.sectionA = sectionA.rows[0].id;
  ids.sectionB = sectionB.rows[0].id;

  const subject = await pool.query(
    `INSERT INTO subjects (name, code) VALUES ('Mathematics', 'MAT') RETURNING id`,
  );
  ids.subjectId = subject.rows[0].id;
  await pool.query('INSERT INTO class_subjects (class_id, subject_id) VALUES ($1, $2)', [
    ids.classId,
    ids.subjectId,
  ]);

  const teacher = await pool.query(
    `INSERT INTO teachers (user_id, first_name, last_name, gender, mobile, email, joining_date, status)
     VALUES ($1, 'Test', 'Teacher', 'female', '9800000001', $2, '2020-06-01', 'active') RETURNING id`,
    [teacherUserId, ACCOUNTS.teacher.email],
  );
  ids.teacherId = teacher.rows[0].id;

  await pool.query(
    `INSERT INTO teacher_subjects (academic_year_id, teacher_id, class_id, subject_id)
     VALUES ($1, $2, $3, $4)`,
    [ids.yearId, ids.teacherId, ids.classId, ids.subjectId],
  );
  await pool.query(
    `INSERT INTO class_teachers (academic_year_id, section_id, teacher_id) VALUES ($1, $2, $3)`,
    [ids.yearId, ids.sectionA, ids.teacherId],
  );

  const s1 = await pool.query(
    `INSERT INTO students (admission_id, user_id, first_name, last_name, gender, date_of_birth,
       admission_date, status)
     VALUES ('VVS-900001', $1, 'Test', 'Student', 'female', '2015-04-04', '2026-04-06', 'active')
     RETURNING id`,
    [studentUserId],
  );
  const s2 = await pool.query(
    `INSERT INTO students (admission_id, first_name, last_name, gender, date_of_birth,
       admission_date, status)
     VALUES ('VVS-900002', 'Other', 'Student', 'male', '2015-05-05', '2026-04-06', 'active')
     RETURNING id`,
  );
  ids.studentId = s1.rows[0].id;
  ids.otherStudentId = s2.rows[0].id;

  await pool.query(
    `INSERT INTO enrollments (student_id, academic_year_id, class_id, section_id, status)
     VALUES ($1, $3, $4, $5, 'active'), ($2, $3, $4, $6, 'active')`,
    [ids.studentId, ids.otherStudentId, ids.yearId, ids.classId, ids.sectionA, ids.sectionB],
  );

  const p1 = await pool.query(
    `INSERT INTO parents (user_id, full_name, mobile, email) VALUES ($1, 'Test Parent', '9800000011', $2)
     RETURNING id`,
    [parentUserId, ACCOUNTS.parent.email],
  );
  const p2 = await pool.query(
    `INSERT INTO parents (user_id, full_name, mobile, email)
     VALUES ($1, 'Other Parent', '9800000012', 'other.parent@vvs.test') RETURNING id`,
    [ids.otherParent],
  );
  await pool.query(
    `INSERT INTO student_parents (student_id, parent_id, relationship, is_primary)
     VALUES ($1, $2, 'mother', TRUE), ($3, $4, 'father', TRUE)`,
    [ids.studentId, p1.rows[0].id, ids.otherStudentId, p2.rows[0].id],
  );

  // S1: present then absent -> 50% ; S2: present both days -> 100%
  const days = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day
       FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 1,
                            (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') AS d`,
  );
  const statuses = ['present', 'absent'];
  for (let index = 0; index < days.rows.length; index += 1) {
    await pool.query(
      `INSERT INTO attendance (student_id, academic_year_id, section_id, attendance_date, status, marked_by)
       VALUES ($1, $2, $3, $4, $5, $6), ($7, $2, $8, $4, 'present', $6)`,
      [
        ids.studentId,
        ids.yearId,
        ids.sectionA,
        days.rows[index].day,
        statuses[index],
        teacherUserId,
        ids.otherStudentId,
        ids.sectionB,
      ],
    );
  }

  const exam = await pool.query(
    `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date,
       publish_status, published_at, published_by, created_by)
     VALUES ('Unit Test 1', 'unit_test', $1, '2026-11-02', '2026-11-03', 'published', now(), $2, $2)
     RETURNING id`,
    [ids.yearId, ids.admin],
  );
  ids.examId = exam.rows[0].id;
  const schedule = await pool.query(
    `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time, max_marks)
     VALUES ($1, $2, $3, '2026-11-02', '09:00', '10:00', 100) RETURNING id`,
    [exam.rows[0].id, ids.classId, ids.subjectId],
  );
  // grades are reference data created by the seed script, not by a migration
  const grade = await pool.query(
    `INSERT INTO grades (code, min_percent, max_percent, grade_point, sort_order) VALUES
       ('A+', 90, 100, 10, 1), ('A', 80, 89.99, 9, 2), ('B+', 70, 79.99, 8, 3),
       ('B', 60, 69.99, 7, 4), ('C', 50, 59.99, 6, 5), ('D', 40, 49.99, 5, 6),
       ('E', 0, 39.99, 4, 7)
     ON CONFLICT (code) DO UPDATE SET max_percent = EXCLUDED.max_percent
     RETURNING id, code`,
  );
  const gradeA = grade.rows.find((row) => row.code === 'A');
  await pool.query(
    `INSERT INTO marks (exam_schedule_id, student_id, marks_obtained, grade_id, status, entered_by, submitted_at)
     VALUES ($1, $2, 88, $3, 'submitted', $4, now())`,
    [schedule.rows[0].id, ids.studentId, gradeA.id, teacherUserId],
  );

  return ids;
}

export { TEST_PASSWORD, ACCOUNTS };
