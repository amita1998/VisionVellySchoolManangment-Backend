#!/usr/bin/env node
/**
 * Reference data + first admin + optional demo data.
 * Safe to re-run: every insert is guarded by a lookup on its natural key.
 *
 * No credentials live in this file. The first admin comes from ADMIN_EMAIL /
 * ADMIN_INITIAL_PASSWORD in the environment; if the password is blank a strong
 * one is generated and printed exactly once.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../src/config/db.js';
import { config } from '../src/config/env.js';

const log = (...args) => console.log('[seed]', ...args);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const CLASS_LIST = [
  { name: 'Nursery', level: 0, prePrimary: true },
  { name: 'LKG', level: 1, prePrimary: true },
  { name: 'UKG', level: 2, prePrimary: true },
  ...Array.from({ length: 12 }, (_, index) => ({
    name: `Class ${index + 1}`,
    level: index + 3,
    prePrimary: false,
  })),
];

const SUBJECT_LIST = [
  // pre-primary
  { code: 'ENG-P', name: 'English Readiness', prePrimary: true },
  { code: 'NUM-P', name: 'Numbers & Shapes', prePrimary: true },
  { code: 'RHY-P', name: 'Rhymes & Stories', prePrimary: true },
  { code: 'ART-P', name: 'Art & Craft', prePrimary: true },
  { code: 'PE-P', name: 'Physical Activity', prePrimary: true },
  // shared
  { code: 'ENG', name: 'English' },
  { code: 'HIN', name: 'Hindi' },
  { code: 'MAT', name: 'Mathematics' },
  { code: 'EVS', name: 'Environmental Studies' },
  { code: 'SCI', name: 'Science' },
  { code: 'SST', name: 'Social Science' },
  { code: 'CMP', name: 'Computer Science' },
  { code: 'ART', name: 'Art & Craft' },
  { code: 'PE', name: 'Physical Education' },
  { code: 'IT', name: 'Information Technology' },
  { code: 'PHY', name: 'Physics' },
  { code: 'CHE', name: 'Chemistry' },
  { code: 'BIO', name: 'Biology' },
  { code: 'ACC', name: 'Accountancy' },
  { code: 'BST', name: 'Business Studies' },
  { code: 'ECO', name: 'Economics' },
];

/** which subject codes each class is taught */
function subjectsForClass(className) {
  if (['Nursery', 'LKG', 'UKG'].includes(className)) {
    return SUBJECT_LIST.filter((s) => s.prePrimary).map((s) => s.code);
  }
  const n = Number(className.split(' ')[1]);
  if (n <= 5) return ['ENG', 'MAT', 'EVS', 'CMP', 'ART', 'PE'];
  if (n <= 8) return ['ENG', 'HIN', 'MAT', 'SCI', 'SST', 'CMP', 'ART', 'PE'];
  if (n <= 10) return ['ENG', 'HIN', 'MAT', 'SCI', 'SST', 'IT'];
  return ['ENG', 'PHY', 'CHE', 'MAT', 'BIO', 'CMP', 'ACC', 'BST', 'ECO', 'PE'];
}

const PERIOD_LIST = [
  { periodNo: 1, label: 'P1', start: '08:00', end: '08:45' },
  { periodNo: 2, label: 'P2', start: '08:45', end: '09:30' },
  { periodNo: 3, label: 'P3', start: '09:30', end: '10:15' },
  { periodNo: null, label: 'Short Break', start: '10:15', end: '10:35', isBreak: true },
  { periodNo: 4, label: 'P4', start: '10:35', end: '11:20' },
  { periodNo: 5, label: 'P5', start: '11:20', end: '12:05' },
  { periodNo: 6, label: 'P6', start: '12:05', end: '12:50' },
  { periodNo: null, label: 'Lunch', start: '12:50', end: '13:30', isBreak: true },
  { periodNo: 7, label: 'P7', start: '13:30', end: '14:15' },
  { periodNo: 8, label: 'P8', start: '14:15', end: '15:00' },
];

const GRADE_LIST = [
  { code: 'A+', min: 90, max: 100, point: 10, order: 1, remarks: 'Outstanding' },
  { code: 'A', min: 80, max: 89.99, point: 9, order: 2, remarks: 'Excellent' },
  { code: 'B+', min: 70, max: 79.99, point: 8, order: 3, remarks: 'Very good' },
  { code: 'B', min: 60, max: 69.99, point: 7, order: 4, remarks: 'Good' },
  { code: 'C', min: 50, max: 59.99, point: 6, order: 5, remarks: 'Average' },
  { code: 'D', min: 40, max: 49.99, point: 5, order: 6, remarks: 'Needs attention' },
  { code: 'E', min: 0, max: 39.99, point: 4, order: 7, remarks: 'Needs improvement' },
];

const FEE_CATEGORIES = [
  { name: 'Admission', code: 'ADM' },
  { name: 'Tuition', code: 'TUI' },
  { name: 'Transport', code: 'TRA' },
  { name: 'Examination', code: 'EXM' },
  { name: 'Activity / Events', code: 'ACT' },
  { name: 'Other', code: 'OTH' },
];

const EVENT_CATEGORIES = [
  'Annual Function',
  'Sports Day',
  'Parent-Teacher Meeting',
  'Science Exhibition',
  'Cultural Events',
  'Competitions',
  'School Holiday',
  'Academic Event',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function temporaryPassword() {
  // Guaranteed character classes so it passes the same policy the API enforces,
  // then shuffled. Never a predictable string.
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '@#$%&*';
  const pick = (alphabet) => alphabet[crypto.randomInt(alphabet.length)];
  const base = [pick(upper), pick(lower), pick(digits), pick(special)];
  const all = upper + lower + digits + special;
  while (base.length < 14) base.push(pick(all));
  for (let i = base.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base.join('');
}

async function one(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] || null;
}

async function ensureAcademicYear(client, year) {
  const existing = await one(client, 'SELECT id FROM academic_years WHERE name = $1', [year.name]);
  if (existing) {
    await client.query(
      'UPDATE academic_years SET start_date = $2, end_date = $3, is_current = $4, is_closed = $5 WHERE id = $1',
      [existing.id, year.start, year.end, year.current, year.closed],
    );
    return existing.id;
  }
  const created = await one(
    client,
    `INSERT INTO academic_years (name, start_date, end_date, is_current, is_closed)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [year.name, year.start, year.end, year.current, year.closed],
  );
  return created.id;
}

async function ensureClass(client, item) {
  const existing = await one(
    client,
    'SELECT id FROM classes WHERE lower(name) = lower($1) AND deleted_at IS NULL',
    [item.name],
  );
  if (existing) return existing.id;
  const created = await one(
    client,
    'INSERT INTO classes (name, level_order, is_pre_primary) VALUES ($1, $2, $3) RETURNING id',
    [item.name, item.level, item.prePrimary],
  );
  return created.id;
}

async function ensureSection(client, classId, name) {
  const existing = await one(
    client,
    'SELECT id FROM sections WHERE class_id = $1 AND name = $2 AND deleted_at IS NULL',
    [classId, name],
  );
  if (existing) return existing.id;
  const created = await one(
    client,
    'INSERT INTO sections (class_id, name) VALUES ($1, $2) RETURNING id',
    [classId, name],
  );
  return created.id;
}

async function ensureSubject(client, item) {
  const existing = await one(
    client,
    'SELECT id FROM subjects WHERE lower(code) = lower($1) AND deleted_at IS NULL',
    [item.code],
  );
  if (existing) return existing.id;
  const created = await one(
    client,
    'INSERT INTO subjects (name, code, is_pre_primary) VALUES ($1, $2, $3) RETURNING id',
    [item.name, item.code, Boolean(item.prePrimary)],
  );
  return created.id;
}

async function ensurePeriod(client, item) {
  const existing = await one(client, 'SELECT id FROM periods WHERE label = $1', [item.label]);
  if (existing) return existing.id;
  const created = await one(
    client,
    `INSERT INTO periods (period_no, label, start_time, end_time, is_break)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [item.periodNo, item.label, item.start, item.end, Boolean(item.isBreak)],
  );
  return created.id;
}

async function ensureLookup(client, table, name, code) {
  const existing = await one(
    client,
    `SELECT id FROM ${table} WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
    [name],
  );
  if (existing) return existing.id;
  const created = code
    ? await one(client, `INSERT INTO ${table} (name, code) VALUES ($1, $2) RETURNING id`, [name, code])
    : await one(client, `INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [name]);
  return created.id;
}

async function ensureUser(client, { roleCode, username, email, passwordHash, mustChangePassword, isActive = true }) {
  const existing = await one(client, 'SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (existing) return { id: existing.id, created: false };
  const created = await one(
    client,
    `INSERT INTO users (role_id, username, email, password_hash, must_change_password, is_active)
     VALUES ((SELECT id FROM roles WHERE code = $1), $2, $3, $4, $5, $6) RETURNING id`,
    [roleCode, username, email ?? null, passwordHash, mustChangePassword, isActive],
  );
  return { id: created.id, created: true };
}

// ---------------------------------------------------------------------------
// Seed steps
// ---------------------------------------------------------------------------

async function seedReference(client) {
  // Academic years: previous (closed) + current (April -> March).
  const previousYearId = await ensureAcademicYear(client, {
    name: '2025-2026',
    start: '2025-04-01',
    end: '2026-03-31',
    current: false,
    closed: true,
  });
  const currentYearId = await ensureAcademicYear(client, {
    name: '2026-2027',
    start: '2026-04-01',
    end: '2027-03-31',
    current: true,
    closed: false,
  });

  const classIds = new Map();
  const sectionIds = new Map(); // `${className}|A` -> id
  for (const item of CLASS_LIST) {
    const id = await ensureClass(client, item);
    classIds.set(item.name, id);
    for (const sectionName of ['A', 'B', 'C']) {
      const sectionId = await ensureSection(client, id, sectionName);
      sectionIds.set(`${item.name}|${sectionName}`, sectionId);
    }
  }

  const subjectIds = new Map();
  for (const item of SUBJECT_LIST) {
    subjectIds.set(item.code, await ensureSubject(client, item));
  }

  for (const item of CLASS_LIST) {
    const classId = classIds.get(item.name);
    for (const code of subjectsForClass(item.name)) {
      await client.query(
        `INSERT INTO class_subjects (class_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [classId, subjectIds.get(code)],
      );
    }
  }

  for (const item of PERIOD_LIST) await ensurePeriod(client, item);

  for (const item of GRADE_LIST) {
    await client.query(
      `INSERT INTO grades (code, min_percent, max_percent, grade_point, remarks, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING`,
      [item.code, item.min, item.max, item.point, item.remarks, item.order],
    );
  }

  const categoryIds = new Map();
  for (const item of FEE_CATEGORIES) {
    categoryIds.set(item.code, await ensureLookup(client, 'fee_categories', item.name, item.code));
  }
  for (const name of EVENT_CATEGORIES) await ensureLookup(client, 'event_categories', name);

  await client.query(
    `INSERT INTO school_settings (id, school_name, tagline, address, phone, email, website,
       current_academic_year_id, fee_visible_to_students)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, FALSE)
     ON CONFLICT (id) DO UPDATE SET
       current_academic_year_id = EXCLUDED.current_academic_year_id,
       updated_at = now()`,
    [
      'Vision Valley School',
      'Learn. Grow. Lead.',
      'Vision Valley Campus, Pune, Maharashtra',
      '+91 20 4000 1234',
      'office@visionvalley.edu.in',
      'https://visionvalley.edu.in',
      currentYearId,
    ],
  );

  return { previousYearId, currentYearId, classIds, sectionIds, subjectIds, categoryIds };
}

async function seedAdmin(client) {
  const email = (config.seed.adminEmail || '').trim().toLowerCase();
  if (!email) throw new Error('ADMIN_EMAIL is not set; cannot seed the first admin.');

  const existing = await one(client, 'SELECT id FROM users WHERE lower(username) = $1', [email]);
  if (existing) {
    log(`admin already exists: ${email}`);
    return { email, generated: false };
  }

  const isGenerated = !config.seed.adminInitialPassword;
  const password = isGenerated ? temporaryPassword() : config.seed.adminInitialPassword;
  const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);

  const { id: userId } = await ensureUser(client, {
    roleCode: 'admin',
    username: email,
    email,
    passwordHash,
    // A password the operator chose in .env is not a temporary password.
    mustChangePassword: isGenerated,
  });

  await client.query(
    `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, new_values, reason)
     VALUES ($1, 'system', 'user.seeded', 'users', $1, $2, 'first admin created by seed')`,
    [userId, JSON.stringify({ username: email, role: 'admin' })],
  );

  log(`admin created: ${email}`);
  if (isGenerated) {
    log(`ADMIN TEMPORARY PASSWORD (shown once, change on first login): ${password}`);
  }
  return { email, generated: isGenerated, password: isGenerated ? password : undefined };
}

async function seedDemo(client, refs) {
  if (config.isProduction) throw new Error('SEED_DEMO must never run with NODE_ENV=production');
  const demoPassword = config.seed.demoPassword;
  if (!demoPassword) throw new Error('DEMO_PASSWORD is not set; cannot seed demo accounts.');

  const passwordHash = await bcrypt.hash(demoPassword, 10);
  const nowYear = refs.currentYearId;

  const teachers = [
    { first: 'Anjali', last: 'Desai', gender: 'female', mobile: '9820011001', subjects: [['Class 1', 'MAT'], ['Class 5', 'MAT'], ['Class 8', 'MAT']], classTeacherOf: 'Class 1|A' },
    { first: 'Rohit', last: 'Mehta', gender: 'male', mobile: '9820011002', subjects: [['Class 1', 'ENG'], ['Class 5', 'ENG'], ['Class 8', 'ENG']], classTeacherOf: 'Class 5|A' },
    { first: 'Priya', last: 'Nair', gender: 'female', mobile: '9820011003', subjects: [['Class 8', 'SCI'], ['Class 10', 'SCI']], classTeacherOf: 'Class 8|A' },
    { first: 'Suresh', last: 'Iyer', gender: 'male', mobile: '9820011004', subjects: [['Class 8', 'SST'], ['Class 10', 'SST']], classTeacherOf: 'Class 10|A' },
    { first: 'Kavita', last: 'Joshi', gender: 'female', mobile: '9820011005', subjects: [['Class 1', 'CMP'], ['Class 5', 'CMP'], ['Class 8', 'CMP']], classTeacherOf: 'Nursery|A' },
    { first: 'Arjun', last: 'Patel', gender: 'male', mobile: '9820011006', subjects: [['Class 5', 'PE'], ['Class 10', 'PE']], classTeacherOf: 'Class 12|A' },
  ];

  const teacherIds = new Map();
  for (const teacher of teachers) {
    const email = `${teacher.first.toLowerCase()}.${teacher.last.toLowerCase()}@visionvalley.edu.in`;
    const { id: userId } = await ensureUser(client, {
      roleCode: 'teacher',
      username: email,
      email,
      passwordHash,
      mustChangePassword: false,
    });

    let teacherRow = await one(client, 'SELECT id FROM teachers WHERE lower(email) = lower($1)', [email]);
    if (!teacherRow) {
      teacherRow = await one(
        client,
        `INSERT INTO teachers (user_id, first_name, last_name, gender, date_of_birth, mobile, email,
           qualification, experience_years, joining_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active') RETURNING id`,
        [
          userId,
          teacher.first,
          teacher.last,
          teacher.gender,
          '1985-06-15',
          teacher.mobile,
          email,
          'M.A., B.Ed.',
          8.5,
          '2019-06-01',
        ],
      );
    }
    teacherIds.set(email, teacherRow.id);
    const teacherId = teacherRow.id;

    // teacher-subject assignments
    for (const [className, code] of teacher.subjects) {
      await client.query(
        `INSERT INTO teacher_subjects (academic_year_id, teacher_id, class_id, subject_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [nowYear, teacherId, refs.classIds.get(className), refs.subjectIds.get(code)],
      );
    }

    // class teacher
    if (teacher.classTeacherOf) {
      const [className, sectionName] = teacher.classTeacherOf.split('|');
      const sectionId = refs.sectionIds.get(`${className}|${sectionName}`);
      const exists = await one(
        client,
        'SELECT id FROM class_teachers WHERE academic_year_id = $1 AND section_id = $2',
        [nowYear, sectionId],
      );
      if (!exists) {
        await client.query(
          `INSERT INTO class_teachers (academic_year_id, section_id, teacher_id, effective_from)
           VALUES ($1, $2, $3, '2026-04-01')`,
          [nowYear, sectionId, teacherId],
        );
      }
    }
  }

  const students = [
    { first: 'Aarav', last: 'Sharma', gender: 'male', dob: '2022-05-14', className: 'Nursery' },
    { first: 'Diya', last: 'Patel', gender: 'female', dob: '2021-08-02', className: 'LKG' },
    { first: 'Vihaan', last: 'Gupta', gender: 'male', dob: '2020-11-23', className: 'UKG' },
    { first: 'Ananya', last: 'Sharma', gender: 'female', dob: '2019-06-18', className: 'Class 1' },
    { first: 'Kabir', last: 'Singh', gender: 'male', dob: '2018-09-09', className: 'Class 2' },
    { first: 'Ishita', last: 'Verma', gender: 'female', dob: '2017-12-01', className: 'Class 3' },
    { first: 'Reyansh', last: 'Patel', gender: 'male', dob: '2016-07-21', className: 'Class 4' },
    { first: 'Meera', last: 'Joshi', gender: 'female', dob: '2015-10-30', className: 'Class 5' },
    { first: 'Advait', last: 'Kulkarni', gender: 'male', dob: '2014-04-11', className: 'Class 6' },
    { first: 'Sara', last: 'Khan', gender: 'female', dob: '2013-08-25', className: 'Class 7' },
    { first: 'Dhruv', last: 'Malhotra', gender: 'male', dob: '2012-05-05', className: 'Class 8' },
    { first: 'Nisha', last: 'Reddy', gender: 'female', dob: '2011-09-19', className: 'Class 9' },
    { first: 'Aryan', last: 'Chauhan', gender: 'male', dob: '2010-06-07', className: 'Class 10' },
    { first: 'Tanvi', last: 'Deshpande', gender: 'female', dob: '2009-11-15', className: 'Class 11' },
    { first: 'Rohan', last: 'Kapoor', gender: 'male', dob: '2008-03-28', className: 'Class 12' },
  ];

  const studentIds = new Map();
  for (const student of students) {
    let row = await one(
      client,
      'SELECT id, admission_id FROM students WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2) AND date_of_birth = $3',
      [student.first, student.last, student.dob],
    );
    if (!row) {
      row = await one(
        client,
        `INSERT INTO students (first_name, last_name, gender, date_of_birth, admission_date, status)
         VALUES ($1, $2, $3, $4, '2026-04-06', 'active') RETURNING id, admission_id`,
      [student.first, student.last, student.gender, student.dob],
    );
      // Student login: Admission ID is the username.
      const { id: userId } = await ensureUser(client, {
        roleCode: 'student',
        username: row.admission_id,
        email: null,
        passwordHash,
        mustChangePassword: false,
      });
      await client.query('UPDATE students SET user_id = $2 WHERE id = $1', [row.id, userId]);
      await client.query(
        `INSERT INTO student_status_history (student_id, academic_year_id, from_status, to_status,
           effective_date, remarks)
         VALUES ($1, $2, 'new_admission', 'active', '2026-04-06', 'demo seed')`,
        [row.id, nowYear],
      );
    }

    studentIds.set(`${student.first}|${student.last}`, row.id);

    const classId = refs.classIds.get(student.className);
    const sectionId = refs.sectionIds.get(`${student.className}|A`);
    const enrolled = await one(
      client,
      'SELECT id FROM enrollments WHERE student_id = $1 AND academic_year_id = $2',
      [row.id, nowYear],
    );
    if (!enrolled) {
      await client.query(
        `INSERT INTO enrollments (student_id, academic_year_id, class_id, section_id, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [row.id, nowYear, classId, sectionId],
      );
    }
  }

  // Two family accounts with siblings, one single-child account.
  const families = [
    {
      parent: { full: 'Rakesh Sharma', mobile: '9830012001', email: 'rakesh.sharma@example.com', occupation: 'Engineer' },
      children: [
        ['Aarav', 'Sharma'],
        ['Ananya', 'Sharma'],
      ],
    },
    {
      parent: { full: 'Sunita Patel', mobile: '9830012002', email: 'sunita.patel@example.com', occupation: 'Doctor' },
      children: [
        ['Diya', 'Patel'],
        ['Reyansh', 'Patel'],
      ],
    },
    {
      parent: { full: 'Imran Khan', mobile: '9830012003', email: 'imran.khan@example.com', occupation: 'Business' },
      children: [['Sara', 'Khan']],
    },
  ];

  for (const family of families) {
    const { id: userId } = await ensureUser(client, {
      roleCode: 'parent',
      username: family.parent.email,
      email: family.parent.email,
      passwordHash,
      mustChangePassword: false,
    });
    let parentRow = await one(client, 'SELECT id FROM parents WHERE user_id = $1', [userId]);
    if (!parentRow) {
      parentRow = await one(
        client,
        `INSERT INTO parents (user_id, full_name, mobile, email, occupation, address_line, city, state, pincode)
         VALUES ($1, $2, $3, $4, $5, '12 Valley Road', 'Pune', 'Maharashtra', '411001') RETURNING id`,
        [userId, family.parent.full, family.parent.mobile, family.parent.email, family.parent.occupation],
      );
    }
    for (const [first, last] of family.children) {
      const studentId = studentIds.get(`${first}|${last}`);
      if (!studentId) continue;
      await client.query(
        `INSERT INTO student_parents (student_id, parent_id, relationship, is_primary)
         VALUES ($1, $2, 'father', TRUE) ON CONFLICT DO NOTHING`,
        [studentId, parentRow.id],
      );
    }
  }

  // Fee structures: tuition per class (quarterly) + examination fee for Class 1-12.
  const tuitionByLevel = (className) => {
    if (['Nursery', 'LKG', 'UKG'].includes(className)) return 18000;
    const n = Number(className.split(' ')[1]);
    if (n <= 5) return 24000;
    if (n <= 8) return 30000;
    if (n <= 10) return 36000;
    return 42000;
  };

  const dueDates = ['2026-04-10', '2026-07-10', '2026-10-10', '2027-01-10'];
  const tuitionStructureIds = new Map();

  for (const item of CLASS_LIST) {
    const classId = refs.classIds.get(item.name);
    let structure = await one(
      client,
      `SELECT id FROM fee_structures
       WHERE academic_year_id = $1 AND class_id = $2 AND category_id = $3 AND deleted_at IS NULL`,
      [nowYear, classId, refs.categoryIds.get('TUI')],
    );
    if (!structure) {
      const total = tuitionByLevel(item.name);
      structure = await one(
        client,
        `INSERT INTO fee_structures (academic_year_id, class_id, category_id, name, total_amount, installment_plan)
         VALUES ($1, $2, $3, $4, $5, 'quarterly') RETURNING id`,
        [nowYear, classId, refs.categoryIds.get('TUI'), `Tuition ${item.name} 2026-27`, total],
      );
      const perInstallment = total / 4;
      for (let index = 0; index < 4; index += 1) {
        await client.query(
          `INSERT INTO fee_installments (fee_structure_id, seq, label, due_date, amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [structure.id, index + 1, `Q${index + 1}`, dueDates[index], perInstallment],
        );
      }
    }
    tuitionStructureIds.set(item.name, structure.id);

    if (!item.prePrimary) {
      const exists = await one(
        client,
        `SELECT id FROM fee_structures
         WHERE academic_year_id = $1 AND class_id = $2 AND category_id = $3 AND deleted_at IS NULL`,
        [nowYear, classId, refs.categoryIds.get('EXM')],
      );
      if (!exists) {
        const examStructure = await one(
          client,
          `INSERT INTO fee_structures (academic_year_id, class_id, category_id, name, total_amount, installment_plan)
           VALUES ($1, $2, $3, $4, 2500, 'one_time') RETURNING id`,
          [nowYear, classId, refs.categoryIds.get('EXM'), `Examination ${item.name} 2026-27`],
        );
        await client.query(
          `INSERT INTO fee_installments (fee_structure_id, seq, label, due_date, amount)
           VALUES ($1, 1, 'Annual', '2026-09-15', 2500)`,
          [examStructure.id],
        );
      }
    }
  }

  // Assign tuition fees to demo students, with one concession.
  for (const student of students) {
    const studentId = studentIds.get(`${student.first}|${student.last}`);
    const structureId = tuitionStructureIds.get(student.className);
    if (!studentId || !structureId) continue;
    const existing = await one(
      client,
      'SELECT id FROM student_fees WHERE student_id = $1 AND fee_structure_id = $2',
      [studentId, structureId],
    );
    if (existing) continue;
    const gross = tuitionByLevel(student.className);
    const concession = student.last === 'Khan' ? Math.round(gross * 0.1) : 0;
    await client.query(
      `INSERT INTO student_fees (student_id, academic_year_id, fee_structure_id, gross_amount,
         concession_amount, concession_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [studentId, nowYear, structureId, gross, concession, concession ? 'Sibling concession (10%)' : null],
    );
  }

  // A couple of recorded payments so receipts/fee dashboards have real data.
  const paymentSeeds = [
    { student: ['Aryan', 'Chauhan'], amount: 9000, mode: 'upi', reference: 'UPI-882134' },
    { student: ['Ananya', 'Sharma'], amount: 6000, mode: 'cash', reference: null },
  ];
  const adminRow = await one(client, 'SELECT id FROM users WHERE role_id = (SELECT id FROM roles WHERE code = $1)', ['admin']);

  for (const item of paymentSeeds) {
    const studentId = studentIds.get(item.student.join('|'));
    const className = students.find((s) => s.first === item.student[0] && s.last === item.student[1]).className;
    const feeRow = await one(
      client,
      'SELECT id FROM student_fees WHERE student_id = $1 AND fee_structure_id = $2',
      [studentId, tuitionStructureIds.get(className)],
    );
    if (!feeRow) continue;
    const already = await one(client, 'SELECT id FROM fee_payments WHERE student_fee_id = $1', [feeRow.id]);
    if (already) continue;
    const payment = await one(
      client,
      `INSERT INTO fee_payments (student_fee_id, amount, payment_mode, reference_no, paid_on, remarks, recorded_by)
       VALUES ($1, $2, $3, $4, '2026-04-15', 'demo seed', $5) RETURNING id`,
      [feeRow.id, item.amount, item.mode, item.reference, adminRow?.id ?? null],
    );
    await client.query(
      `INSERT INTO fee_receipts (payment_id, student_fee_id, student_id, amount, issued_on, issued_by)
       VALUES ($1, $2, $3, $4, '2026-04-15', $5)`,
      [payment.id, feeRow.id, studentId, item.amount, adminRow?.id ?? null],
    );
  }

  // Events
  const eventSeeds = [
    { title: 'Parent-Teacher Meeting', category: 'Parent-Teacher Meeting', date: '2026-11-28', start: '09:00', end: '13:00', location: 'Main Auditorium' },
    { title: 'Annual Sports Day', category: 'Sports Day', date: '2026-12-05', start: '08:30', end: '14:00', location: 'School Ground' },
    { title: 'Winter Break Begins', category: 'School Holiday', date: '2026-12-24', start: null, end: null, location: '—' },
  ];
  for (const event of eventSeeds) {
    const exists = await one(client, 'SELECT id FROM events WHERE title = $1 AND deleted_at IS NULL', [event.title]);
    if (exists) continue;
    const categoryRow = await one(
      client,
      'SELECT id FROM event_categories WHERE lower(name) = lower($1) AND deleted_at IS NULL',
      [event.category],
    );
    await client.query(
      `INSERT INTO events (title, description, category_id, event_date, start_time, end_time, location,
         audience, is_published, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'all', TRUE, now(), $8)`,
      [
        event.title,
        `${event.title} at Vision Valley School.`,
        categoryRow?.id ?? null,
        event.date,
        event.start,
        event.end,
        event.location,
        adminRow?.id ?? null,
      ],
    );
  }

  // Announcements
  const announcementSeeds = [
    {
      title: 'Term II Examination Schedule Published',
      body: 'The Term II examination schedule is now available. Please check the timetable section for dates and rooms.',
      type: 'exam',
    },
    {
      title: 'Annual Day Auditions',
      body: 'Auditions for the Annual Day programme will be held next week during the activity period. Interested students should register with their class teacher.',
      type: 'general',
    },
  ];
  for (const item of announcementSeeds) {
    const exists = await one(client, 'SELECT id FROM announcements WHERE title = $1 AND deleted_at IS NULL', [item.title]);
    if (exists) continue;
    await client.query(
      `INSERT INTO announcements (title, body, type, status, audience, published_at, created_by)
       VALUES ($1, $2, $3, 'published', 'all', now(), $4)`,
      [item.title, item.body, item.type, adminRow?.id ?? null],
    );
  }

  // Assignments (view-only for students/parents in this release)
  const assignmentSeeds = [
    { title: 'Fractions worksheet', className: 'Class 5', code: 'MAT', teacherEmail: 'anjali.desai@visionvalley.edu.in', due: '2026-11-25' },
    { title: 'Photosynthesis diagram', className: 'Class 10', code: 'SCI', teacherEmail: 'priya.nair@visionvalley.edu.in', due: '2026-11-30' },
  ];
  for (const item of assignmentSeeds) {
    const exists = await one(client, 'SELECT id FROM assignments WHERE title = $1 AND deleted_at IS NULL', [item.title]);
    if (exists) continue;
    const teacherRow = await one(client, 'SELECT id, user_id FROM teachers WHERE lower(email) = lower($1)', [
      item.teacherEmail,
    ]);
    await client.query(
      `INSERT INTO assignments (title, description, class_id, subject_id, teacher_id, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        item.title,
        `${item.title} — submit as instructed in class.`,
        refs.classIds.get(item.className),
        refs.subjectIds.get(item.code),
        teacherRow.id,
        item.due,
        teacherRow.user_id,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Timetable: Mon-Sat, first six teaching periods, for the demo sections
  // -------------------------------------------------------------------------
  const periods = await client.query(
    'SELECT id, period_no FROM periods WHERE is_break = FALSE ORDER BY period_no LIMIT 6',
  );
  const timetableClasses = ['Class 1', 'Class 5', 'Class 8', 'Class 10'];

  for (const className of timetableClasses) {
    const classId = refs.classIds.get(className);
    const sectionId = refs.sectionIds.get(`${className}|A`);
    const subjectRows = await client.query(
      `SELECT cs.subject_id, s.name
         FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id
        WHERE cs.class_id = $1 ORDER BY s.name`,
      [classId],
    );
    if (subjectRows.rows.length === 0) continue;

    for (let day = 1; day <= 6; day += 1) {
      for (let index = 0; index < periods.rows.length; index += 1) {
        const subject = subjectRows.rows[(day + index) % subjectRows.rows.length];
        const teacher = await one(
          client,
          `SELECT teacher_id FROM teacher_subjects
            WHERE academic_year_id = $1 AND class_id = $2 AND subject_id = $3 LIMIT 1`,
          [nowYear, classId, subject.subject_id],
        );
        if (!teacher) continue;
        await client.query(
          `INSERT INTO timetable_slots (academic_year_id, section_id, day_of_week, period_id, subject_id,
             teacher_id, room, effective_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-04-01')
           ON CONFLICT DO NOTHING`,
          [nowYear, sectionId, day, periods.rows[index].id, subject.subject_id, teacher.teacher_id, 'Room 1'],
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Attendance: last 25 calendar days, Sundays excluded, deterministic statuses
  // -------------------------------------------------------------------------
  const attendanceDays = await client.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day
       FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - 24,
                            (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') AS d
      WHERE extract(isodow FROM d) <> 7`,
  );

  for (const student of students) {
    const studentId = studentIds.get(`${student.first}|${student.last}`);
    const sectionId = refs.sectionIds.get(`${student.className}|A`);
    if (!studentId) continue;
    const classTeacher = await one(
      client,
      `SELECT t.user_id FROM class_teachers ct JOIN teachers t ON t.id = ct.teacher_id
        WHERE ct.academic_year_id = $1 AND ct.section_id = $2`,
      [nowYear, sectionId],
    );
    const markedBy = classTeacher?.user_id ?? adminRow?.id ?? null;
    if (!markedBy) continue;

    for (let index = 0; index < attendanceDays.rows.length; index += 1) {
      const day = attendanceDays.rows[index].day;
      const bucket = (studentId * 7 + index * 3) % 20;
      const status = bucket === 0 ? 'absent' : bucket === 1 ? 'late' : bucket === 2 ? 'half_day' : 'present';
      await client.query(
        `INSERT INTO attendance (student_id, academic_year_id, section_id, attendance_date, status, marked_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [studentId, nowYear, sectionId, day, status, markedBy],
      );
    }
  }

  // -------------------------------------------------------------------------
  // One published examination with submitted marks
  // -------------------------------------------------------------------------
  let exam = await one(
    client,
    'SELECT id FROM examinations WHERE academic_year_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL',
    [nowYear, 'Term I Assessment'],
  );
  if (!exam) {
    exam = await one(
      client,
      `INSERT INTO examinations (name, exam_type, academic_year_id, start_date, end_date,
         publish_status, published_at, published_by, created_by)
       VALUES ($1, 'mid_term', $2, '2026-09-14', '2026-09-22', 'published', now(), $3, $3)
       RETURNING id`,
      ['Term I Assessment', nowYear, adminRow?.id ?? null],
    );
  }

  const grades = await client.query('SELECT id, code, min_percent, max_percent FROM grades');

  for (const className of timetableClasses) {
    const classId = refs.classIds.get(className);
    const subjectsOfClass = await client.query(
      `SELECT subject_id FROM class_subjects WHERE class_id = $1 ORDER BY subject_id LIMIT 3`,
      [classId],
    );
    for (const subject of subjectsOfClass.rows) {
      const schedule = await one(
        client,
        `INSERT INTO exam_schedules (exam_id, class_id, subject_id, exam_date, start_time, end_time,
           room, max_marks)
         VALUES ($1, $2, $3, '2026-09-15', '09:00', '10:30', 'Hall A', 100)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [exam.id, classId, subject.subject_id],
      );
      let scheduleId = schedule?.id;
      if (!scheduleId) {
        const existing = await one(
          client,
          'SELECT id FROM exam_schedules WHERE exam_id = $1 AND class_id = $2 AND subject_id = $3',
          [exam.id, classId, subject.subject_id],
        );
        scheduleId = existing?.id;
      }
      if (!scheduleId) continue;

      const enrolled = await client.query(
        'SELECT student_id FROM enrollments WHERE class_id = $1 AND academic_year_id = $2',
        [classId, nowYear],
      );
      const teacher = await one(
        client,
        'SELECT user_id FROM teacher_subjects ts JOIN teachers t ON t.id = ts.teacher_id WHERE ts.class_id = $1 AND ts.subject_id = $2 LIMIT 1',
        [classId, subject.subject_id],
      );
      for (const row of enrolled.rows) {
        const obtained = 45 + ((row.student_id * 13 + subject.subject_id * 7) % 51); // 45..95
        const grade = grades.rows.find(
          (g) => obtained >= Number(g.min_percent) && obtained <= Number(g.max_percent),
        );
        await client.query(
          `INSERT INTO marks (exam_schedule_id, student_id, marks_obtained, grade_id, status,
             entered_by, submitted_at)
           VALUES ($1, $2, $3, $4, 'submitted', $5, now()) ON CONFLICT DO NOTHING`,
          [scheduleId, row.student_id, obtained, grade?.id ?? null, teacher?.user_id ?? adminRow?.id ?? null],
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const result = await withTransaction(async (client) => {
    const refs = await seedReference(client);
    const admin = await seedAdmin(client);
    if (config.seed.demo) {
      log('seeding demo data (SEED_DEMO=true)');
      await seedDemo(client, refs);
    } else {
      log('skipping demo data (SEED_DEMO is not true)');
    }
    return { admin };
  });

  const counts = await pool.query(`
    SELECT 'roles' AS table, count(*) FROM roles
    UNION ALL SELECT 'users', count(*) FROM users
    UNION ALL SELECT 'academic_years', count(*) FROM academic_years
    UNION ALL SELECT 'classes', count(*) FROM classes
    UNION ALL SELECT 'sections', count(*) FROM sections
    UNION ALL SELECT 'subjects', count(*) FROM subjects
    UNION ALL SELECT 'class_subjects', count(*) FROM class_subjects
    UNION ALL SELECT 'periods', count(*) FROM periods
    UNION ALL SELECT 'grades', count(*) FROM grades
    UNION ALL SELECT 'fee_categories', count(*) FROM fee_categories
    UNION ALL SELECT 'fee_structures', count(*) FROM fee_structures
    UNION ALL SELECT 'teachers', count(*) FROM teachers
    UNION ALL SELECT 'students', count(*) FROM students
    UNION ALL SELECT 'parents', count(*) FROM parents
    UNION ALL SELECT 'student_parents', count(*) FROM student_parents
    UNION ALL SELECT 'enrollments', count(*) FROM enrollments
    UNION ALL SELECT 'class_teachers', count(*) FROM class_teachers
    UNION ALL SELECT 'teacher_subjects', count(*) FROM teacher_subjects
    UNION ALL SELECT 'student_fees', count(*) FROM student_fees
    UNION ALL SELECT 'fee_payments', count(*) FROM fee_payments
    UNION ALL SELECT 'fee_receipts', count(*) FROM fee_receipts
    UNION ALL SELECT 'events', count(*) FROM events
    UNION ALL SELECT 'announcements', count(*) FROM announcements
    UNION ALL SELECT 'assignments', count(*) FROM assignments
  `);

  console.log('');
  for (const row of counts.rows) {
    console.log(`  ${row.table.padEnd(22)} ${row.count}`);
  }
  console.log('');
  log(`done in ${Date.now() - started} ms`);
  if (result.admin.generated) {
    log(`first login: ${result.admin.email} (temporary password printed above)`);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error('[seed] failed:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
