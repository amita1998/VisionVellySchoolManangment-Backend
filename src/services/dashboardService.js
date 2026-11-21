import { config } from '../config/env.js';
import { query } from '../config/db.js';
import { forbidden, notFound } from '../utils/errors.js';

/**
 * Dashboard data builders.
 *
 * Every number here is computed from the database — no placeholder figures. Each
 * builder is scoped to what its role may read:
 *   admin   -> whole school
 *   teacher -> only the classes/subjects assigned in the current academic year
 *   student -> only their own records
 *   parent  -> only their own children (the childId is verified against the link table)
 */

const ATTENDANCE_VALUE = `(CASE WHEN a.status IN ('present', 'late') THEN 1
                               WHEN a.status = 'half_day' THEN 0.5
                               ELSE 0 END)`;

async function today() {
  const { rows } = await query(
    `SELECT (now() AT TIME ZONE $1)::date AS today,
            extract(year  FROM (now() AT TIME ZONE $1))::int AS year,
            extract(month FROM (now() AT TIME ZONE $1))::int AS month,
            extract(isodow FROM (now() AT TIME ZONE $1))::int AS iso_dow,
            to_char((now() AT TIME ZONE $1)::date, 'DD-MM-YYYY') AS label`,
    [config.timezone],
  );
  return rows[0];
}

async function currentAcademicYear() {
  const { rows } = await query(
    'SELECT id, name FROM academic_years WHERE is_current AND deleted_at IS NULL LIMIT 1',
  );
  return rows[0] || null;
}

function percentage(part, total) {
  if (!total) return 0;
  return Math.round((Number(part) / Number(total)) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Shared shell pieces
// ---------------------------------------------------------------------------

/**
 * Audience rules (BRD 13.3): everyone / selected classes / teachers / students /
 * parents. A class-wise notice reaches that class's students, parents and teachers.
 * `userId` is required so the returned read state is the caller's own.
 */
async function noticesFor({ role, classIds = [], userId = null, limit = 5 }) {
  const audienceForRole =
    role === 'teacher' ? ['teachers'] : role === 'student' ? ['students'] : role === 'parent' ? ['parents'] : [];
  const { rows } = await query(
    `SELECT a.id, a.title, a.type, a.published_at,
            (ar.user_id IS NOT NULL) AS is_read
       FROM announcements a
       LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = $4
      WHERE a.status = 'published' AND a.deleted_at IS NULL
        AND (
              $1 = 'admin'
          OR a.audience = 'all'
          OR (a.audience = 'classes' AND EXISTS (
                SELECT 1 FROM announcement_classes ac
                 WHERE ac.announcement_id = a.id AND ac.class_id = ANY($2::int[])
             ))
          OR a.audience::text = ANY($3::text[])
        )
      ORDER BY a.published_at DESC NULLS LAST
      LIMIT $5`,
    [role, classIds, audienceForRole, userId, limit],
  );
  return rows;
}

async function calendarFor({ classIds = [], role = 'admin', limit = 200 }) {
  const now = await today();
  const { rows } = await query(
    `WITH month_bounds AS (
       SELECT make_date($1::int, $2::int, 1) AS first_day,
              (make_date($1::int, $2::int, 1) + interval '1 month - 1 day')::date AS last_day
     )
     SELECT e.event_date AS date, e.title, 'event' AS kind, c.name AS category
       FROM events e
       LEFT JOIN event_categories c ON c.id = e.category_id
      CROSS JOIN month_bounds mb
      WHERE e.is_published AND e.deleted_at IS NULL
        AND e.event_date BETWEEN mb.first_day AND mb.last_day
        AND (
              e.audience = 'all'
           OR (e.audience = 'classes' AND EXISTS (
                SELECT 1 FROM event_classes ec
                 WHERE ec.event_id = e.id AND ec.class_id = ANY($3::int[])
              ))
           OR ($5 = 'admin')
           OR ($5 = 'teacher' AND e.audience = 'teachers')
           OR ($5 = 'student' AND e.audience = 'students')
           OR ($5 = 'parent' AND e.audience = 'parents')
        )
     UNION ALL
     SELECT es.exam_date AS date, ex.name || ' · ' || s.name AS title, 'exam' AS kind, 'Examination' AS category
       FROM exam_schedules es
       JOIN examinations ex ON ex.id = es.exam_id
       JOIN subjects s ON s.id = es.subject_id
      CROSS JOIN month_bounds mb
      WHERE ex.deleted_at IS NULL
        AND es.class_id = ANY($3::int[])
        AND es.exam_date BETWEEN mb.first_day AND mb.last_day
     ORDER BY date, title
     LIMIT $4`,
    [now.year, now.month, classIds, limit, role],
  );
  const monthLabel = new Date(Date.UTC(now.year, now.month - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return {
    year: now.year,
    month: now.month,
    today: now.today,
    label: monthLabel,
    events: rows,
  };
}

async function upcomingEvents({ role, classIds = [], limit = 4 }) {
  const audiences =
    role === 'admin'
      ? ['teachers', 'students', 'parents']
      : role === 'teacher'
        ? ['teachers']
        : role === 'student'
          ? ['students']
          : ['parents'];
  const { rows } = await query(
    `SELECT e.id, e.title, e.event_date, to_char(e.event_date, 'DD-MM-YYYY') AS date_label,
            to_char(e.start_time, 'HH24:MI') AS start_time, e.location, c.name AS category
       FROM events e
       LEFT JOIN event_categories c ON c.id = e.category_id
      WHERE e.is_published AND e.deleted_at IS NULL
        AND e.event_date >= (now() AT TIME ZONE $1)::date
        AND (
              e.audience = 'all'
           OR (e.audience = 'classes' AND EXISTS (
                SELECT 1 FROM event_classes ec
                 WHERE ec.event_id = e.id AND ec.class_id = ANY($2::int[])
              ))
           OR e.audience::text = ANY($3::text[])
        )
      ORDER BY e.event_date, e.start_time NULLS LAST
      LIMIT $4`,
    [config.timezone, classIds, audiences, limit],
  );
  return rows;
}

async function unreadNotifications(userId) {
  const { rows } = await query(
    'SELECT count(*)::int AS total FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return rows[0].total;
}

function shellUser(user, name) {
  const display =
    name || user.name || (user.role === 'admin' ? 'Administrator' : user.username || 'User');
  return {
    id: user.id,
    name: display,
    email: user.email,
    role: user.role,
    initials: display
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join(''),
  };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function adminDashboard(user) {
  const year = await currentAcademicYear();
  const now = await today();

  const [counts, attendanceToday, classes, weekly, activities, events, notices] = await Promise.all([
    query(`SELECT
        (SELECT count(*)::int FROM students WHERE deleted_at IS NULL AND status = 'active') AS students,
        (SELECT count(*)::int FROM teachers WHERE deleted_at IS NULL AND status = 'active') AS teachers,
        (SELECT count(*)::int FROM classes  WHERE deleted_at IS NULL) AS classes,
        (SELECT count(*)::int FROM sections WHERE deleted_at IS NULL) AS sections`),
    query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status IN ('present', 'late'))::int AS present,
              count(*) FILTER (WHERE status = 'absent')::int AS absent,
              coalesce(sum(${ATTENDANCE_VALUE}), 0)::numeric AS value
         FROM attendance a
        WHERE a.attendance_date = $1`,
      [now.today],
    ),
    query(
      `SELECT c.id AS class_id, c.name AS class_name, s.id AS section_id, s.name AS section_name,
              trim(concat(t.first_name, ' ', t.last_name)) AS class_teacher,
              (SELECT count(*)::int FROM enrollments e
                WHERE e.section_id = s.id AND e.academic_year_id = $1 AND e.status = 'active') AS students
         FROM sections s
         JOIN classes c ON c.id = s.class_id
         LEFT JOIN class_teachers ct ON ct.section_id = s.id AND ct.academic_year_id = $1
         LEFT JOIN teachers t ON t.id = ct.teacher_id
        WHERE s.deleted_at IS NULL AND c.deleted_at IS NULL
        ORDER BY c.level_order, s.name
        LIMIT 6`,
      [year?.id ?? 0],
    ),
    query(
      `SELECT to_char(attendance_date, 'DD/MM') AS day,
              round(100.0 * coalesce(sum(${ATTENDANCE_VALUE}), 0) / nullif(count(*), 0), 1) AS percentage
         FROM attendance a
        WHERE attendance_date > (now() AT TIME ZONE $1)::date - 7
        GROUP BY attendance_date
        ORDER BY attendance_date`,
      [config.timezone],
    ),
    query(
      `SELECT a.action, a.created_at, a.entity_type,
              coalesce(trim(concat(u.username)), 'system') AS actor
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.created_at DESC
        LIMIT 6`,
    ),
    upcomingEvents({ role: 'admin', classIds: [], limit: 4 }),
    noticesFor({ role: 'admin', classIds: [], userId: user.id, limit: 4 }),
  ]);

  const attendance = attendanceToday.rows[0];
  const cards = [
    { key: 'students', label: 'Total Students', value: counts.rows[0].students, icon: 'bi-people', tone: 'blue', to: '/admin/students' },
    { key: 'teachers', label: 'Total Teachers', value: counts.rows[0].teachers, icon: 'bi-person-video3', tone: 'purple', to: '/admin/teachers' },
    { key: 'classes', label: 'Total Classes', value: counts.rows[0].classes, hint: `${counts.rows[0].sections} sections`, icon: 'bi-grid-3x3-gap', tone: 'pink', to: '/admin/classes' },
    {
      key: 'attendance',
      label: 'Attendance Today',
      value: attendance.total ? `${percentage(attendance.value, attendance.total)}%` : '—',
      hint: attendance.total ? `${attendance.present} present · ${attendance.absent} absent` : 'Not marked yet',
      icon: 'bi-calendar2-check',
      tone: 'mint',
      to: '/admin/attendance',
    },
  ];

  return {
    role: 'admin',
    today: now,
    shell: {
      user: shellUser(user),
      calendar: await calendarFor({ classIds: [], role: 'admin' }),
      notices,
      unreadNotifications: await unreadNotifications(user.id),
      reminders: buildAdminReminders(attendance, notices),
    },
    cards,
    quickActions: [
      { label: 'Add Student', icon: 'bi-person-plus', to: '/admin/students/new' },
      { label: 'Add Teacher', icon: 'bi-person-badge', to: '/admin/teachers/new' },
      { label: 'View Attendance', icon: 'bi-calendar2-check', to: '/admin/attendance' },
      { label: 'Create Event', icon: 'bi-calendar-plus', to: '/admin/events' },
      { label: 'Publish Notice', icon: 'bi-megaphone', to: '/admin/announcements' },
      { label: 'Generate Report', icon: 'bi-file-earmark-bar-graph', to: '/admin/reports' },
    ],
    classes: classes.rows,
    attendanceTrend: weekly.rows,
    upcomingEvents: events,
    activities: activities.rows,
  };
}

function buildAdminReminders(attendance, notices) {
  const reminders = [];
  if (!attendance.total) {
    reminders.push({ text: 'Attendance is not marked for today', meta: 'Class teachers can still mark until 11:59 PM', tone: 'coral' });
  }
  const unread = notices.filter((notice) => !notice.is_read).length;
  if (unread > 0) reminders.push({ text: `${unread} notice(s) unread`, meta: 'Check announcements', tone: 'lavender' });
  if (reminders.length === 0) {
    reminders.push({ text: 'Nothing needs attention', meta: 'School data is up to date', tone: 'mint' });
  }
  return reminders;
}

// ---------------------------------------------------------------------------
// Teacher
// ---------------------------------------------------------------------------

async function teacherRow(userId) {
  const { rows } = await query(
    'SELECT id, first_name, last_name FROM teachers WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1',
    [userId],
  );
  return rows[0] || null;
}

export async function teacherDashboard(user) {
  const year = await currentAcademicYear();
  const now = await today();
  const teacher = await teacherRow(user.id);

  if (!teacher) {
    return {
      role: 'teacher',
      today: now,
      shell: {
        user: shellUser(user),
        calendar: await calendarFor({ classIds: [], role: 'teacher' }),
        notices: await noticesFor({ role: 'teacher', classIds: [], userId: user.id, limit: 4 }),
        unreadNotifications: await unreadNotifications(user.id),
        reminders: [{ text: 'No teacher record linked to this login', meta: 'Ask the admin office to link your profile', tone: 'coral' }],
      },
      cards: [],
      quickActions: [],
      classes: [],
      todaySchedule: [],
      upcomingExams: [],
      upcomingEvents: [],
      activities: [],
      missingProfile: true,
    };
  }

  const yearId = year?.id ?? 0;

  const classes = await query(
    `SELECT c.id AS class_id, c.name AS class_name,
            (SELECT count(*)::int FROM enrollments e
              WHERE e.class_id = c.id AND e.academic_year_id = $2 AND e.status = 'active') AS students,
            (SELECT string_agg(s.name, ', ' ORDER BY s.name)
               FROM sections s
               JOIN class_teachers ct ON ct.section_id = s.id AND ct.academic_year_id = $2
              WHERE s.class_id = c.id AND ct.teacher_id = $1) AS class_teacher_of
       FROM teacher_subjects ts
       JOIN classes c ON c.id = ts.class_id
      WHERE ts.teacher_id = $1 AND ts.academic_year_id = $2
      GROUP BY c.id, c.name, c.level_order
      ORDER BY c.level_order
      LIMIT 6`,
    [teacher.id, yearId],
  );

  const totals = await query(
    `SELECT count(DISTINCT e.student_id)::int AS students
       FROM teacher_subjects ts
       JOIN enrollments e ON e.class_id = ts.class_id AND e.academic_year_id = ts.academic_year_id
      WHERE ts.teacher_id = $1 AND ts.academic_year_id = $2 AND e.status = 'active'`,
    [teacher.id, yearId],
  );

  const attendance = await query(
    `SELECT count(*)::int AS total, coalesce(sum(${ATTENDANCE_VALUE}), 0)::numeric AS value
       FROM attendance a
       JOIN enrollments e ON e.student_id = a.student_id AND e.academic_year_id = a.academic_year_id
       JOIN teacher_subjects ts ON ts.class_id = e.class_id AND ts.academic_year_id = e.academic_year_id
      WHERE ts.teacher_id = $1 AND a.academic_year_id = $2`,
    [teacher.id, yearId],
  );

  const myClassIds = classes.rows.map((row) => row.class_id);

  const [schedule, exams, events, notices] = await Promise.all([
    query(
      `SELECT t.day_of_week, p.period_no, to_char(p.start_time, 'HH24:MI') AS start_time,
              to_char(p.end_time, 'HH24:MI') AS end_time,
              c.name AS class_name, s.name AS section_name, sub.name AS subject_name
         FROM timetable_slots t
         JOIN periods p ON p.id = t.period_id
         JOIN sections s ON s.id = t.section_id
         JOIN classes c ON c.id = s.class_id
         JOIN subjects sub ON sub.id = t.subject_id
        WHERE t.teacher_id = $1 AND t.academic_year_id = $2 AND t.day_of_week = $3
        ORDER BY p.start_time`,
      [teacher.id, yearId, now.iso_dow],
    ),
    query(
      `SELECT ex.name AS exam_name, sub.name AS subject_name, es.exam_date,
              to_char(es.exam_date, 'DD-MM-YYYY') AS date_label, c.name AS class_name
         FROM exam_schedules es
         JOIN examinations ex ON ex.id = es.exam_id
         JOIN subjects sub ON sub.id = es.subject_id
         JOIN classes c ON c.id = es.class_id
        WHERE es.class_id = ANY($1::int[])
          AND es.exam_date >= (now() AT TIME ZONE $2)::date
          AND ex.deleted_at IS NULL
        ORDER BY es.exam_date
        LIMIT 4`,
      [myClassIds.length ? myClassIds : [0], config.timezone],
    ),
    upcomingEvents({ role: 'teacher', classIds: myClassIds, limit: 3 }),
    noticesFor({ role: 'teacher', classIds: myClassIds, userId: user.id, limit: 4 }),
  ]);

  const isClassTeacher = classes.rows.some((row) => row.class_teacher_of !== null);
  const attendanceTotal = attendance.rows[0].total;

  return {
    role: 'teacher',
    today: now,
    shell: {
      user: shellUser(user, `${teacher.first_name} ${teacher.last_name}`),
      calendar: await calendarFor({ classIds: myClassIds, role: 'teacher' }),
      notices,
      unreadNotifications: await unreadNotifications(user.id),
      reminders: buildTeacherReminders(schedule.rows, isClassTeacher),
    },
    cards: [
      { key: 'classes', label: 'My Classes', value: classes.rows.length, icon: 'bi-grid-3x3-gap', tone: 'blue', to: '/teacher/classes' },
      { key: 'students', label: 'Assigned Students', value: totals.rows[0].students, icon: 'bi-people', tone: 'purple', to: '/teacher/students' },
      {
        key: 'attendance',
        label: 'Attendance',
        value: attendanceTotal ? `${percentage(attendance.rows[0].value, attendanceTotal)}%` : '—',
        hint: attendanceTotal ? `${attendanceTotal} records` : 'No attendance yet',
        icon: 'bi-calendar2-check',
        tone: 'mint',
        to: '/teacher/attendance',
      },
    ],
    quickActions: [
      ...(isClassTeacher
        ? [{ label: 'Mark Attendance', icon: 'bi-calendar2-check', to: '/teacher/attendance' }]
        : []),
      { label: 'Add Marks', icon: 'bi-journal-check', to: '/teacher/marks' },
      { label: 'Create Assignment', icon: 'bi-journal-plus', to: '/teacher/assignments' },
    ],
    classes: classes.rows,
    todaySchedule: schedule.rows,
    upcomingExams: exams.rows,
    upcomingEvents: events,
    activities: [],
    missingProfile: false,
  };
}

function buildTeacherReminders(schedule, isClassTeacher) {
  const reminders = [];
  if (schedule.length === 0) {
    reminders.push({ text: 'No classes scheduled today', meta: 'Check your weekly timetable', tone: 'lavender' });
  }
  if (isClassTeacher) {
    reminders.push({ text: 'Mark today’s attendance', meta: 'Your class can be marked until 11:59 PM', tone: 'coral' });
  }
  if (reminders.length === 0) {
    reminders.push({ text: 'You are up to date', meta: 'No pending actions', tone: 'mint' });
  }
  return reminders;
}

// ---------------------------------------------------------------------------
// Student / parent share most of the academic numbers
// ---------------------------------------------------------------------------

async function academicSnapshot(studentId, yearId) {
  const attendance = await query(
    `SELECT count(*)::int AS total, coalesce(sum(${ATTENDANCE_VALUE}), 0)::numeric AS value
       FROM attendance a
      WHERE a.student_id = $1 AND a.academic_year_id = $2`,
    [studentId, yearId],
  );

  const marks = await query(
    `SELECT coalesce(sum(m.marks_obtained), 0)::numeric AS obtained,
            coalesce(sum(es.max_marks), 0)::numeric AS maximum,
            count(*)::int AS papers
       FROM marks m
       JOIN exam_schedules es ON es.id = m.exam_schedule_id
       JOIN examinations ex ON ex.id = es.exam_id
      WHERE m.student_id = $1 AND m.status = 'submitted'
        AND ex.publish_status = 'published' AND ex.deleted_at IS NULL`,
    [studentId],
  );

  const results = await query(
    `SELECT ex.name AS exam_name, sub.name AS subject_name, m.marks_obtained, es.max_marks,
            g.code AS grade,
            to_char(ex.published_at, 'DD-MM-YYYY') AS published_on
       FROM marks m
       JOIN exam_schedules es ON es.id = m.exam_schedule_id
       JOIN examinations ex ON ex.id = es.exam_id
       JOIN subjects sub ON sub.id = es.subject_id
       LEFT JOIN grades g ON g.id = m.grade_id
      WHERE m.student_id = $1 AND m.status = 'submitted'
        AND ex.publish_status = 'published' AND ex.deleted_at IS NULL
      ORDER BY ex.published_at DESC NULLS LAST, sub.name
      LIMIT 6`,
    [studentId],
  );

  const attendanceTotal = attendance.rows[0].total;
  const markRow = marks.rows[0];

  return {
    attendance: {
      total: attendanceTotal,
      value: attendanceTotal ? percentage(attendance.rows[0].value, attendanceTotal) : 0,
      present: Math.round(Number(attendance.rows[0].value)),
    },
    marks: {
      obtained: Number(markRow.obtained),
      maximum: Number(markRow.maximum),
      papers: markRow.papers,
      percentage: markRow.maximum > 0 ? percentage(markRow.obtained, markRow.maximum) : 0,
    },
    results: results.rows,
  };
}

async function enrollmentFor(studentId, yearId) {
  const { rows } = await query(
    `SELECT e.class_id, e.section_id, c.name AS class_name, s.name AS section_name, e.roll_no
       FROM enrollments e
       JOIN classes c ON c.id = e.class_id
       JOIN sections s ON s.id = e.section_id
      WHERE e.student_id = $1 AND e.academic_year_id = $2
      LIMIT 1`,
    [studentId, yearId],
  );
  return rows[0] || null;
}

export async function studentDashboard(user) {
  const year = await currentAcademicYear();
  const now = await today();
  const yearId = year?.id ?? 0;

  const student = await query(
    `SELECT id, admission_id, first_name, last_name, date_of_birth, blood_group, photo_path
       FROM students WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [user.id],
  );

  if (!student.rows[0]) {
    return {
      role: 'student',
      today: now,
      shell: {
        user: shellUser(user),
        calendar: await calendarFor({ classIds: [], role: 'student' }),
        notices: await noticesFor({ role: 'student', classIds: [], userId: user.id, limit: 4 }),
        unreadNotifications: await unreadNotifications(user.id),
        reminders: [{ text: 'No student record linked to this login', meta: 'Contact the school office', tone: 'coral' }],
      },
      cards: [],
      profile: null,
      timetable: [],
      upcomingExams: [],
      recentResults: [],
      assignments: [],
      upcomingEvents: [],
      missingProfile: true,
    };
  }

  const row = student.rows[0];
  const enrollment = await enrollmentFor(row.id, yearId);
  const snapshot = await academicSnapshot(row.id, yearId);
  const classIds = enrollment ? [enrollment.class_id] : [];

  const [timetable, exams, assignments, events, notices] = await Promise.all([
    enrollment
      ? query(
          `SELECT p.period_no, to_char(p.start_time, 'HH24:MI') AS start_time,
                  to_char(p.end_time, 'HH24:MI') AS end_time,
                  sub.name AS subject_name, trim(concat(t.first_name, ' ', t.last_name)) AS teacher_name
             FROM timetable_slots ts
             JOIN periods p ON p.id = ts.period_id
             JOIN subjects sub ON sub.id = ts.subject_id
             LEFT JOIN teachers t ON t.id = ts.teacher_id
            WHERE ts.section_id = $1 AND ts.academic_year_id = $2 AND ts.day_of_week = $3
            ORDER BY p.start_time`,
          [enrollment.section_id, yearId, now.iso_dow],
        )
      : Promise.resolve({ rows: [] }),
    enrollment
      ? query(
          `SELECT ex.name AS exam_name, sub.name AS subject_name, es.exam_date,
                  to_char(es.exam_date, 'DD-MM-YYYY') AS date_label
             FROM exam_schedules es
             JOIN examinations ex ON ex.id = es.exam_id
             JOIN subjects sub ON sub.id = es.subject_id
            WHERE es.class_id = $1 AND es.exam_date >= (now() AT TIME ZONE $2)::date
              AND ex.deleted_at IS NULL
            ORDER BY es.exam_date LIMIT 4`,
          [enrollment.class_id, config.timezone],
        )
      : Promise.resolve({ rows: [] }),
    enrollment
      ? query(
          `SELECT a.id, a.title, a.due_date, to_char(a.due_date, 'DD-MM-YYYY') AS due_label,
                  sub.name AS subject_name
             FROM assignments a
             JOIN subjects sub ON sub.id = a.subject_id
            WHERE a.class_id = $1 AND (a.section_id IS NULL OR a.section_id = $2)
              AND a.deleted_at IS NULL
              AND a.due_date >= (now() AT TIME ZONE $3)::date - 30
            ORDER BY a.due_date DESC LIMIT 4`,
          [enrollment.class_id, enrollment.section_id, config.timezone],
        )
      : Promise.resolve({ rows: [] }),
    upcomingEvents({ role: 'student', classIds, limit: 3 }),
    noticesFor({ role: 'student', classIds, userId: user.id, limit: 4 }),
  ]);

  return {
    role: 'student',
    today: now,
    shell: {
      user: shellUser(user, `${row.first_name} ${row.last_name}`),
      calendar: await calendarFor({ classIds, role: 'student' }),
      notices,
      unreadNotifications: await unreadNotifications(user.id),
      reminders: buildStudentReminders(snapshot, exams.rows),
    },
    cards: [
      {
        key: 'attendance',
        label: 'Attendance',
        value: snapshot.attendance.total ? `${snapshot.attendance.value}%` : '—',
        hint: snapshot.attendance.total ? `${snapshot.attendance.total} days recorded` : 'Not marked yet',
        icon: 'bi-calendar2-check',
        tone: 'blue',
        to: '/student/attendance',
      },
      {
        key: 'marks',
        label: 'Total Marks',
        value: snapshot.marks.papers ? `${snapshot.marks.obtained} / ${snapshot.marks.maximum}` : '—',
        hint: snapshot.marks.papers ? `${snapshot.marks.papers} papers published` : 'Awaiting results',
        icon: 'bi-journal-text',
        tone: 'purple',
        to: '/student/results',
      },
      {
        key: 'performance',
        label: 'Academic Performance',
        value: snapshot.marks.maximum ? `${snapshot.marks.percentage}%` : '—',
        hint: 'Published exams only',
        icon: 'bi-graph-up-arrow',
        tone: 'pink',
        to: '/student/results',
      },
    ],
    quickActions: [],
    profile: {
      admissionId: row.admission_id,
      name: `${row.first_name} ${row.last_name}`,
      dateOfBirth: row.date_of_birth,
      bloodGroup: row.blood_group,
      className: enrollment?.class_name ?? null,
      section: enrollment?.section_name ?? null,
      rollNo: enrollment?.roll_no ?? null,
    },
    timetable: timetable.rows,
    upcomingExams: exams.rows,
    recentResults: snapshot.results,
    assignments: assignments.rows,
    upcomingEvents: events,
    missingProfile: false,
  };
}

function buildStudentReminders(snapshot, exams) {
  const reminders = [];
  if (exams.length > 0) {
    reminders.push({ text: `${exams[0].exam_name} · ${exams[0].subject_name}`, meta: `On ${exams[0].date_label}`, tone: 'coral' });
  }
  if (snapshot.marks.papers === 0) {
    reminders.push({ text: 'Results not published yet', meta: 'They appear here after the admin publishes them', tone: 'lavender' });
  }
  if (reminders.length === 0) {
    reminders.push({ text: 'No upcoming exams', meta: 'Check the calendar for events', tone: 'mint' });
  }
  return reminders;
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

async function childrenOf(userId, yearId) {
  const { rows } = await query(
    `SELECT st.id, st.admission_id, st.first_name, st.last_name, st.photo_path,
            c.name AS class_name, s.name AS section_name, (e.class_id IS NOT NULL) AS enrolled
       FROM parents p
       JOIN student_parents sp ON sp.parent_id = p.id
       JOIN students st ON st.id = sp.student_id AND st.deleted_at IS NULL
       LEFT JOIN enrollments e ON e.student_id = st.id AND e.academic_year_id = $2
       LEFT JOIN classes c ON c.id = e.class_id
       LEFT JOIN sections s ON s.id = e.section_id
      WHERE p.user_id = $1
      ORDER BY st.first_name`,
    [userId, yearId],
  );
  return rows;
}

async function feeSnapshot(studentId, yearId) {
  const { rows } = await query(
    `SELECT coalesce(sum(sf.payable_amount), 0)::numeric AS payable,
            coalesce((
              SELECT sum(fp.amount)
                FROM fee_payments fp
                JOIN student_fees sf2 ON sf2.id = fp.student_fee_id
               WHERE sf2.student_id = $1 AND sf2.academic_year_id = $2
            ), 0)::numeric AS paid
       FROM student_fees sf
      WHERE sf.student_id = $1 AND sf.academic_year_id = $2`,
    [studentId, yearId],
  );
  const payable = Number(rows[0]?.payable ?? 0);
  const paid = Number(rows[0]?.paid ?? 0);
  return { payable, paid, due: Math.max(0, Math.round((payable - paid) * 100) / 100) };
}

export async function parentDashboard(user, requestedChildId) {
  const year = await currentAcademicYear();
  const now = await today();
  const yearId = year?.id ?? 0;

  const children = await childrenOf(user.id, yearId);
  if (children.length === 0) {
    return {
      role: 'parent',
      today: now,
      shell: {
        user: shellUser(user),
        calendar: await calendarFor({ classIds: [], role: 'parent' }),
        notices: await noticesFor({ role: 'parent', classIds: [], userId: user.id, limit: 4 }),
        unreadNotifications: await unreadNotifications(user.id),
        reminders: [{ text: 'No children linked to this account', meta: 'Ask the school office to link your child', tone: 'coral' }],
      },
      cards: [],
      children: [],
      child: null,
      missingProfile: true,
    };
  }

  // IDOR guard: a parent may only open a child that is linked to their account.
  let child = null;
  if (requestedChildId) {
    const match = children.find((row) => row.id === Number(requestedChildId));
    if (!match) throw forbidden('You can only view your own children.', 'CHILD_FORBIDDEN');
    child = match;
  } else {
    // The default child must be one who is actually on the rolls this year. Picking children[0]
    // made the whole dashboard a 404 for a family whose eldest had graduated.
    child = children.find((row) => row.enrolled) ?? null;
  }

  if (!child) {
    return {
      role: 'parent',
      today: now,
      shell: {
        user: shellUser(user),
        calendar: await calendarFor({ classIds: [], role: 'parent' }),
        notices: await noticesFor({ role: 'parent', classIds: [], userId: user.id, limit: 4 }),
        unreadNotifications: await unreadNotifications(user.id),
        reminders: [{ text: 'No child is enrolled this year', meta: 'The office can place your child in a class', tone: 'coral' }],
      },
      cards: [],
      children: children.map((row) => ({
        id: row.id,
        name: `${row.first_name} ${row.last_name}`,
        admissionId: row.admission_id,
        className: row.class_name,
        section: row.section_name,
        enrolled: row.enrolled,
      })),
      child: null,
      missingProfile: true,
    };
  }

  const enrollment = await enrollmentFor(child.id, yearId);
  if (!enrollment) throw notFound('This child has no enrollment for the current academic year.');

  const parentRow = await query('SELECT full_name FROM parents WHERE user_id = $1 LIMIT 1', [user.id]);
  const parentName = parentRow.rows[0]?.full_name || null;

  const classIds = [enrollment.class_id];
  const [snapshot, fees, payments, exams, events, notices] = await Promise.all([
    academicSnapshot(child.id, yearId),
    feeSnapshot(child.id, yearId),
    query(
      `SELECT r.receipt_no, r.amount, to_char(r.issued_on, 'DD-MM-YYYY') AS issued_on,
              fp.payment_mode, r.is_reversed
         FROM fee_receipts r
         JOIN fee_payments fp ON fp.id = r.payment_id
        WHERE r.student_id = $1
        ORDER BY r.issued_on DESC
        LIMIT 4`,
      [child.id],
    ),
    query(
      `SELECT ex.name AS exam_name, sub.name AS subject_name, es.exam_date,
              to_char(es.exam_date, 'DD-MM-YYYY') AS date_label
         FROM exam_schedules es
         JOIN examinations ex ON ex.id = es.exam_id
         JOIN subjects sub ON sub.id = es.subject_id
        WHERE es.class_id = $1 AND es.exam_date >= (now() AT TIME ZONE $2)::date
          AND ex.deleted_at IS NULL
        ORDER BY es.exam_date LIMIT 4`,
      [enrollment.class_id, config.timezone],
    ),
    upcomingEvents({ role: 'parent', classIds, limit: 3 }),
    noticesFor({ role: 'parent', classIds, userId: user.id, limit: 4 }),
  ]);

  return {
    role: 'parent',
    today: now,
    shell: {
      user: shellUser(user, parentName),
      calendar: await calendarFor({ classIds, role: 'parent' }),
      notices,
      unreadNotifications: await unreadNotifications(user.id),
      reminders: buildParentReminders(fees, exams.rows),
    },
    cards: [
      {
        key: 'attendance',
        label: 'Child Attendance',
        value: snapshot.attendance.total ? `${snapshot.attendance.value}%` : '—',
        hint: `${child.first_name} · ${enrollment.class_name} ${enrollment.section_name}`,
        icon: 'bi-calendar2-check',
        tone: 'blue',
        to: '/parent/attendance',
      },
      {
        key: 'performance',
        label: 'Academic Performance',
        value: snapshot.marks.maximum ? `${snapshot.marks.percentage}%` : '—',
        hint: snapshot.marks.papers ? `${snapshot.marks.papers} papers published` : 'Awaiting results',
        icon: 'bi-graph-up-arrow',
        tone: 'purple',
        to: '/parent/results',
      },
      {
        key: 'fees',
        label: 'Fee Status',
        value: fees.due > 0 ? `₹${fees.due.toLocaleString('en-IN')} due` : 'Paid',
        hint: `₹${fees.paid.toLocaleString('en-IN')} of ₹${fees.payable.toLocaleString('en-IN')}`,
        icon: 'bi-receipt',
        tone: fees.due > 0 ? 'coral' : 'mint',
        to: '/parent/fees',
      },
    ],
    children: children.map((row) => ({
      id: row.id,
      name: `${row.first_name} ${row.last_name}`,
      admissionId: row.admission_id,
      className: row.class_name,
      section: row.section_name,
    })),
    child: {
      id: child.id,
      name: `${child.first_name} ${child.last_name}`,
      admissionId: child.admission_id,
      className: enrollment.class_name,
      section: enrollment.section_name,
      rollNo: enrollment.roll_no,
    },
    recentResults: snapshot.results,
    payments: payments.rows,
    fees,
    upcomingExams: exams.rows,
    upcomingEvents: events,
    missingProfile: false,
  };
}

function buildParentReminders(fees, exams) {
  const reminders = [];
  if (fees.due > 0) {
    reminders.push({
      text: `₹${fees.due.toLocaleString('en-IN')} fee pending`,
      meta: 'Pay at the school office',
      tone: 'coral',
    });
  }
  if (exams.length > 0) {
    reminders.push({ text: exams[0].exam_name, meta: `${exams[0].subject_name} on ${exams[0].date_label}`, tone: 'lavender' });
  }
  if (reminders.length === 0) {
    reminders.push({ text: 'Nothing pending', meta: 'Fees are settled', tone: 'mint' });
  }
  return reminders;
}

// ---------------------------------------------------------------------------

export async function dashboardFor(user, { childId } = {}) {
  switch (user.role) {
    case 'admin':
      return adminDashboard(user);
    case 'teacher':
      return teacherDashboard(user);
    case 'student':
      return studentDashboard(user);
    case 'parent':
      return parentDashboard(user, childId);
    default:
      throw forbidden('No dashboard for this role.');
  }
}

export default { dashboardFor };
