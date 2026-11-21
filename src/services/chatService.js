import { query, withTransaction } from '../config/db.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';
import { notify } from './commsService.js';

/**
 * Parent–teacher chat board.
 *
 * One thread per (child, teacher). Who may do what:
 *   teacher — see and answer the threads of their own students
 *   parent  — see and answer the threads of their own children; start one with a teacher who
 *             actually teaches that child
 *   admin   — oversight only (reads and may answer as "School office"); the UI has no admin board
 *   student — no access at all
 *
 * Every thread lookup goes through `loadThread`, which answers 404 — not 403 — to a caller who is
 * not in the thread, so the endpoint does not confirm that a conversation exists.
 */

const THREAD_SELECT = `
  SELECT th.id, th.student_id, th.teacher_id, th.last_message_at,
         th.academic_year_id,
         CASE WHEN th.last_message_at IS NULL THEN NULL
              ELSE to_char(th.last_message_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI') END AS last_label,
         st.admission_id,
         trim(concat(st.first_name, ' ', st.last_name)) AS student_name,
         c.name AS class_name, sec.name AS section_name,
         trim(concat(t.first_name, ' ', t.last_name)) AS teacher_name,
         t.user_id AS teacher_user_id,
         (SELECT m.body FROM chat_messages m WHERE m.thread_id = th.id ORDER BY m.id DESC LIMIT 1) AS last_body,
         (SELECT count(*)::int FROM chat_messages m
           WHERE m.thread_id = th.id
             AND m.sender_user_id <> $1
             AND m.created_at > coalesce(
                   (SELECT r.last_read_at FROM chat_reads r WHERE r.thread_id = th.id AND r.user_id = $1),
                   th.created_at)) AS unread
    FROM chat_threads th
    JOIN students st ON st.id = th.student_id
    JOIN teachers t ON t.id = th.teacher_id
    LEFT JOIN enrollments en ON en.student_id = th.student_id AND en.academic_year_id = th.academic_year_id
    LEFT JOIN classes c ON c.id = en.class_id
    LEFT JOIN sections sec ON sec.id = en.section_id`;

function asStudent(user) {
  if (user.role === 'student') throw forbidden('The chat board is for parents and teachers.', 'CHAT_FORBIDDEN');
}

/** The signed-in teacher's own `teachers.id`, or a 403. */
export async function ownTeacherId(user, client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner('SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL', [user.id]);
  if (!rows[0]) throw forbidden('No teacher record is linked to your account.', 'CHAT_NO_TEACHER_PROFILE');
  return rows[0].id;
}

/** A parent's own child (or any student, for staff). */
async function resolveChild(user, studentId, client = null) {
  const runner = client ? client.query.bind(client) : query;
  if (['admin', 'teacher'].includes(user.role)) {
    const { rows } = await runner('SELECT id FROM students WHERE id = $1 AND deleted_at IS NULL', [studentId]);
    if (!rows[0]) throw notFound('Student not found.');
    return studentId;
  }
  const { rows } = await runner(
    `SELECT 1 FROM student_parents sp
       JOIN parents p ON p.id = sp.parent_id
      WHERE sp.student_id = $1 AND p.user_id = $2`,
    [studentId, user.id],
  );
  if (!rows[0]) throw forbidden('That student is not linked to your account.', 'CHAT_NOT_YOUR_CHILD');
  return studentId;
}

/** Does this teacher teach that child this year (class teacher of the section, or a subject of the class)? */
async function teacherTeachesStudent(teacherId, studentId, client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT 1
       FROM enrollments e
      WHERE e.student_id = $1
        AND (
          EXISTS (SELECT 1 FROM class_teachers ct
                   WHERE ct.academic_year_id = e.academic_year_id
                     AND ct.section_id = e.section_id AND ct.teacher_id = $2)
          OR EXISTS (SELECT 1 FROM teacher_subjects ts
                      WHERE ts.academic_year_id = e.academic_year_id
                        AND ts.class_id = e.class_id AND ts.teacher_id = $2)
        )
      LIMIT 1`,
    [studentId, teacherId],
  );
  return Boolean(rows[0]);
}

async function canAccess(user, thread, client = null) {
  if (user.role === 'admin') return true;
  if (user.role === 'teacher') return thread.teacher_id === (await ownTeacherId(user, client));
  if (user.role !== 'parent') return false;
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT 1 FROM student_parents sp
       JOIN parents p ON p.id = sp.parent_id
      WHERE sp.student_id = $1 AND p.user_id = $2`,
    [thread.student_id, user.id],
  );
  return Boolean(rows[0]);
}

async function loadThread(user, threadId, client = null) {
  asStudent(user);
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner('SELECT * FROM chat_threads WHERE id = $1', [threadId]);
  const thread = rows[0];
  if (!thread || !(await canAccess(user, thread, client))) throw notFound('Conversation not found.');
  return thread;
}

async function guardianUserIds(studentId, client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT DISTINCT p.user_id
       FROM student_parents sp
       JOIN parents p ON p.id = sp.parent_id
       JOIN users u ON u.id = p.user_id AND u.is_active
      WHERE sp.student_id = $1`,
    [studentId],
  );
  return rows.map((row) => row.user_id);
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export async function listThreads(user) {
  asStudent(user);
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  const params = [user.id];
  let scope;
  if (user.role === 'admin') {
    scope = 'TRUE';
  } else if (user.role === 'teacher') {
    params.push(await ownTeacherId(user));
    scope = `th.teacher_id = $2`;
  } else if (user.role === 'parent') {
    params.push(user.id);
    scope = `EXISTS (SELECT 1 FROM student_parents sp
                       JOIN parents p ON p.id = sp.parent_id
                      WHERE sp.student_id = th.student_id AND p.user_id = $2)`;
  } else {
    throw forbidden('The chat board is for parents and teachers.', 'CHAT_FORBIDDEN');
  }

  const { rows } = await query(
    `${THREAD_SELECT}
      WHERE th.academic_year_id = $${params.length + 1} AND ${scope}
      ORDER BY coalesce(th.last_message_at, th.created_at) DESC, th.id DESC
      LIMIT 200`,
    [...params, year.id],
  );
  return { rows, unread: rows.reduce((total, row) => total + row.unread, 0) };
}

export async function unreadCount(user) {
  const { unread } = await listThreads(user);
  return { unread };
}

// ---------------------------------------------------------------------------
// Starting a thread
// ---------------------------------------------------------------------------

export async function startThread(user, payload) {
  asStudent(user);
  if (!['parent', 'teacher', 'admin'].includes(user.role)) {
    throw forbidden('The chat board is for parents and teachers.', 'CHAT_FORBIDDEN');
  }
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  return withTransaction(async (client) => {
    const studentId = await resolveChild(user, payload.studentId, client);
    let teacherId;
    if (user.role === 'teacher') {
      teacherId = await ownTeacherId(user, client);
      if (payload.teacherId && payload.teacherId !== teacherId) {
        throw forbidden('You can only open your own conversations.', 'CHAT_FORBIDDEN');
      }
    } else {
      if (!payload.teacherId) throw badRequest('Choose the teacher to write to.', { teacherId: 'Required' });
      teacherId = payload.teacherId;
      const teacher = await client.query('SELECT id FROM teachers WHERE id = $1 AND deleted_at IS NULL', [teacherId]);
      if (!teacher.rows[0]) throw notFound('Teacher not found.');
    }

    if (!(await teacherTeachesStudent(teacherId, studentId, client))) {
      throw badRequest(
        'That teacher does not teach this child this year.',
        { teacherId: 'Pick a teacher of this child' },
      );
    }

    const existing = await client.query(
      'SELECT id FROM chat_threads WHERE student_id = $1 AND teacher_id = $2',
      [studentId, teacherId],
    );
    if (existing.rows[0]) {
      const { rows } = await client.query(`${THREAD_SELECT} WHERE th.id = $2`, [user.id, existing.rows[0].id]);
      return { thread: rows[0], created: false };
    }

    const inserted = await client.query(
      `INSERT INTO chat_threads (academic_year_id, student_id, teacher_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [year.id, studentId, teacherId, user.id],
    );

    await audit({
      client,
      actorUserId: user.id,
      actorRole: user.role,
      action: 'chat.thread.created',
      entityType: 'chat_thread',
      entityId: inserted.rows[0].id,
      newValues: { studentId, teacherId },
    });

    const { rows } = await client.query(`${THREAD_SELECT} WHERE th.id = $2`, [user.id, inserted.rows[0].id]);
    return { thread: rows[0], created: true };
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(user, threadId, { before = null, limit = 100 } = {}) {
  const thread = await loadThread(user, threadId);
  const params = [user.id, threadId];
  let beforeClause = '';
  if (before) {
    params.push(before);
    beforeClause = `AND m.id < $${params.length}`;
  }
  params.push(limit);

  const { rows } = await query(
    `SELECT m.id, m.body, m.sender_role, m.sender_user_id, m.created_at,
            to_char(m.created_at AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI') AS sent_label,
            CASE m.sender_role
              WHEN 'teacher' THEN trim(concat(t.first_name, ' ', t.last_name))
              WHEN 'parent' THEN (SELECT p.full_name FROM parents p WHERE p.user_id = m.sender_user_id LIMIT 1)
              ELSE 'School office'
            END AS sender_name,
            (m.sender_user_id = $1) AS mine
       FROM chat_messages m
       JOIN chat_threads th ON th.id = m.thread_id
       JOIN teachers t ON t.id = th.teacher_id
      WHERE m.thread_id = $2 ${beforeClause}
      ORDER BY m.id DESC
      LIMIT $${params.length}`,
    params,
  );

  // Oldest-first is what a conversation reads like; the LIMIT above took the newest page.
  const messages = rows.reverse();
  const mine = await query(`${THREAD_SELECT} WHERE th.id = $2`, [user.id, thread.id]);
  return { thread: mine.rows[0], messages };
}

export async function sendMessage(user, threadId, body) {
  asStudent(user);
  return withTransaction(async (client) => {
    const thread = await loadThread(user, threadId, client);
    const senderRole = user.role === 'admin' ? 'admin' : user.role;
    const inserted = await client.query(
      `INSERT INTO chat_messages (thread_id, sender_user_id, sender_role, body)
       VALUES ($1, $2, $3, $4) RETURNING id, body, created_at`,
      [threadId, user.id, senderRole, body],
    );
    await client.query('UPDATE chat_threads SET last_message_at = $2 WHERE id = $1', [
      threadId,
      inserted.rows[0].created_at,
    ]);

    const fromTeacherSide = senderRole !== 'parent';
    const recipients = fromTeacherSide
      ? await guardianUserIds(thread.student_id, client)
      : [thread.teacher_id ? (await client.query('SELECT user_id FROM teachers WHERE id = $1', [thread.teacher_id])).rows[0]?.user_id : null];

    const preview = body.length > 120 ? `${body.slice(0, 117)}…` : body;
    for (const userId of recipients.filter(Boolean)) {
      if (userId === user.id) continue;
      await notify({
        client,
        userId,
        type: 'chat',
        title: fromTeacherSide ? 'New message from the teacher' : 'New message from a parent',
        body: preview,
        link: fromTeacherSide ? '/parent/chat' : '/teacher/chat',
        entityType: 'chat_thread',
        entityId: threadId,
      });
    }

    await audit({
      client,
      actorUserId: user.id,
      actorRole: user.role,
      action: 'chat.message.sent',
      entityType: 'chat_thread',
      entityId: threadId,
      newValues: { messageId: inserted.rows[0].id },
    });

    return inserted.rows[0];
  });
}

export async function markRead(user, threadId) {
  const thread = await loadThread(user, threadId);
  await query(
    `INSERT INTO chat_reads (thread_id, user_id, last_read_at) VALUES ($1, $2, now())
     ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = now()`,
    [thread.id, user.id],
  );
  return { threadId: thread.id, read: true };
}

// ---------------------------------------------------------------------------
// Who can be written to
// ---------------------------------------------------------------------------

/** A parent's teachers for one child, and a teacher's students. */
export async function contacts(user, { studentId = null } = {}) {
  asStudent(user);
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  if (user.role === 'parent') {
    if (!studentId) throw badRequest('Choose the child first.', { studentId: 'Required' });
    const child = await resolveChild(user, studentId);

    const classTeachers = await query(
      `SELECT DISTINCT t.id, trim(concat(t.first_name, ' ', t.last_name)) AS name
         FROM enrollments e
         JOIN class_teachers ct ON ct.academic_year_id = e.academic_year_id AND ct.section_id = e.section_id
         JOIN teachers t ON t.id = ct.teacher_id AND t.deleted_at IS NULL
        WHERE e.student_id = $1 AND e.academic_year_id = $2`,
      [child, year.id],
    );
    const subjectTeachers = await query(
      `SELECT t.id, trim(concat(t.first_name, ' ', t.last_name)) AS name,
              string_agg(DISTINCT sub.name, ', ' ORDER BY sub.name) AS subjects
         FROM enrollments e
         JOIN teacher_subjects ts ON ts.academic_year_id = e.academic_year_id AND ts.class_id = e.class_id
         JOIN teachers t ON t.id = ts.teacher_id AND t.deleted_at IS NULL
         JOIN subjects sub ON sub.id = ts.subject_id
        WHERE e.student_id = $1 AND e.academic_year_id = $2
        GROUP BY t.id, t.first_name, t.last_name`,
      [child, year.id],
    );

    const byId = new Map();
    for (const row of classTeachers.rows) {
      byId.set(row.id, { id: row.id, name: row.name, label: 'Class teacher', subjects: [] });
    }
    for (const row of subjectTeachers.rows) {
      const existing = byId.get(row.id);
      if (existing) existing.subjects = row.subjects ? row.subjects.split(', ') : [];
      else byId.set(row.id, { id: row.id, name: row.name, label: 'Subject teacher', subjects: row.subjects ? row.subjects.split(', ') : [] });
    }
    return { rows: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  if (user.role === 'teacher') {
    const teacherId = await ownTeacherId(user);
    const { rows } = await query(
      `SELECT e.student_id, st.admission_id,
              trim(concat(st.first_name, ' ', st.last_name)) AS name,
              c.name AS class_name, sec.name AS section_name,
              (SELECT count(*)::int FROM chat_threads th
                WHERE th.student_id = e.student_id AND th.teacher_id = $3) AS threads,
              (SELECT count(DISTINCT p.user_id)::int
                 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
                WHERE sp.student_id = e.student_id) AS guardians
         FROM enrollments e
         JOIN students st ON st.id = e.student_id AND st.deleted_at IS NULL
         JOIN classes c ON c.id = e.class_id
         JOIN sections sec ON sec.id = e.section_id
        WHERE e.academic_year_id = $1 AND e.status = 'active'
          AND (
            EXISTS (SELECT 1 FROM class_teachers ct
                     WHERE ct.academic_year_id = e.academic_year_id
                       AND ct.section_id = e.section_id AND ct.teacher_id = $2)
            OR EXISTS (SELECT 1 FROM teacher_subjects ts
                        WHERE ts.academic_year_id = e.academic_year_id
                          AND ts.class_id = e.class_id AND ts.teacher_id = $2)
          )
        ORDER BY c.level_order, sec.name, st.first_name`,
      [year.id, teacherId, teacherId],
    );
    return { rows };
  }

  if (user.role === 'admin') {
    const { rows } = await query(
      `SELECT th.id, st.admission_id, trim(concat(st.first_name, ' ', st.last_name)) AS student_name,
              trim(concat(t.first_name, ' ', t.last_name)) AS teacher_name, th.last_message_at
         FROM chat_threads th
         JOIN students st ON st.id = th.student_id
         JOIN teachers t ON t.id = th.teacher_id
        WHERE th.academic_year_id = $1
        ORDER BY coalesce(th.last_message_at, th.created_at) DESC LIMIT 200`,
      [year.id],
    );
    return { rows };
  }

  throw forbidden('The chat board is for parents and teachers.', 'CHAT_FORBIDDEN');
}

export default {
  listThreads, unreadCount, startThread, listMessages, sendMessage, markRead, contacts,
};
