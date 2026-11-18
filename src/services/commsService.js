import { query, withTransaction } from '../config/db.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';
import { pagedMeta } from '../utils/request.js';

/**
 * Events, announcements, in-app notifications and assignments (BRD 12–15).
 * Audience rules live here so every reader sees exactly one interpretation:
 * all / selected classes / teachers / students / parents.
 */

async function classIdsForUser(user) {
  if (user.role === 'student') {
    const year = await currentYear();
    const { rows } = await query(
      'SELECT class_id FROM enrollments WHERE student_id = (SELECT id FROM students WHERE user_id = $1) AND academic_year_id = $2',
      [user.id, year?.id ?? 0],
    );
    return rows.map((row) => row.class_id);
  }
  if (user.role === 'parent') {
    const year = await currentYear();
    const { rows } = await query(
      `SELECT DISTINCT e.class_id FROM student_parents sp
         JOIN parents p ON p.id = sp.parent_id
         JOIN enrollments e ON e.student_id = sp.student_id AND e.academic_year_id = $2
        WHERE p.user_id = $1`,
      [user.id, year?.id ?? 0],
    );
    return rows.map((row) => row.class_id);
  }
  if (user.role === 'teacher') {
    const year = await currentYear();
    const { rows } = await query(
      `SELECT DISTINCT ts.class_id FROM teacher_subjects ts JOIN teachers t ON t.id = ts.teacher_id
        WHERE t.user_id = $1 AND ts.academic_year_id = $2`,
      [user.id, year?.id ?? 0],
    );
    return rows.map((row) => row.class_id);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function listEvents(user) {
  const classIds = await classIdsForUser(user);
  const audiences =
    user.role === 'admin'
      ? ['teachers', 'students', 'parents']
      : user.role === 'teacher'
        ? ['teachers']
        : user.role === 'student'
          ? ['students']
          : ['parents'];

  const { rows } = await query(
    `SELECT e.id, e.title, e.description, e.event_date, to_char(e.event_date, 'DD-MM-YYYY') AS date_label,
            to_char(e.start_time, 'HH24:MI') AS start_time, to_char(e.end_time, 'HH24:MI') AS end_time,
            e.location, e.audience, e.is_published, ec.name AS category
       FROM events e
       LEFT JOIN event_categories ec ON ec.id = e.category_id
      WHERE e.deleted_at IS NULL
        AND ($1 = 'admin' OR e.is_published)
        AND (
              $1 = 'admin'
           OR e.audience = 'all'
           OR (e.audience = 'classes' AND EXISTS (
                 SELECT 1 FROM event_classes x WHERE x.event_id = e.id AND x.class_id = ANY($2::int[])))
           OR e.audience::text = ANY($3::text[])
        )
      ORDER BY e.event_date DESC, e.start_time NULLS LAST
      LIMIT 100`,
    [user.role, classIds, audiences],
  );
  return rows;
}

export async function createEvent(payload, actor, ip, userAgent) {
  const { rows } = await query(
    `INSERT INTO events (title, description, category_id, event_date, start_time, end_time, location,
       audience, is_published, published_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $9 THEN now() ELSE NULL END, $10)
     RETURNING id, title, is_published`,
    [
      payload.title,
      payload.description ?? null,
      payload.categoryId ?? null,
      payload.eventDate,
      payload.startTime || null,
      payload.endTime || null,
      payload.location ?? null,
      payload.audience || 'all',
      Boolean(payload.publish),
      actor?.id ?? null,
    ],
  );
  if (payload.audience === 'classes' && payload.classIds?.length) {
    for (const classId of payload.classIds) {
      await query('INSERT INTO event_classes (event_id, class_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        rows[0].id,
        classId,
      ]);
    }
  }
  await audit({
    actorUserId: actor?.id,
    actorRole: actor?.role,
    action: 'event.created',
    entityType: 'events',
    entityId: rows[0].id,
    newValues: payload,
    ip,
    userAgent,
  });
  return rows[0];
}

export async function updateEvent(eventId, payload, actor, ip, userAgent) {
  const { rows } = await query(
    `UPDATE events SET title = $2, description = $3, category_id = $4, event_date = $5,
       start_time = $6, end_time = $7, location = $8, audience = $9,
       is_published = $10, published_at = CASE WHEN $10 AND published_at IS NULL THEN now() ELSE published_at END
     WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [
      eventId,
      payload.title,
      payload.description ?? null,
      payload.categoryId ?? null,
      payload.eventDate,
      payload.startTime || null,
      payload.endTime || null,
      payload.location ?? null,
      payload.audience || 'all',
      Boolean(payload.publish),
    ],
  );
  if (!rows[0]) throw notFound('Event not found.');
  await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'event.updated', entityType: 'events', entityId: eventId, newValues: payload, ip, userAgent });
  return { id: eventId };
}

export async function deleteEvent(eventId, actor, ip, userAgent) {
  const { rowCount } = await query('UPDATE events SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [eventId]);
  if (rowCount === 0) throw notFound('Event not found.');
  await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'event.deleted', entityType: 'events', entityId: eventId, ip, userAgent });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

async function announcementFilter(user) {
  const classIds = await classIdsForUser(user);
  const audiences =
    user.role === 'teacher' ? ['teachers'] : user.role === 'student' ? ['students'] : user.role === 'parent' ? ['parents'] : [];
  return { classIds, audiences };
}

export async function listAnnouncements(user) {
  const { classIds, audiences } = await announcementFilter(user);
  const { rows } = await query(
    `SELECT a.id, a.title, a.body, a.type, a.status, a.audience,
            to_char(a.published_at, 'DD-MM-YYYY') AS published_on, a.published_at,
            (ar.user_id IS NOT NULL) AS is_read,
            (SELECT count(*)::int FROM announcement_reads r2 WHERE r2.announcement_id = a.id) AS read_count,
            (SELECT count(*)::int FROM announcement_attachments at WHERE at.announcement_id = a.id) AS attachments
       FROM announcements a
       LEFT JOIN announcement_reads ar ON ar.announcement_id = a.id AND ar.user_id = $4
      WHERE a.deleted_at IS NULL
        AND ($1 = 'admin' OR a.status = 'published')
        AND (
              $1 = 'admin'
           OR a.audience = 'all'
           OR (a.audience = 'classes' AND EXISTS (
                 SELECT 1 FROM announcement_classes ac WHERE ac.announcement_id = a.id AND ac.class_id = ANY($2::int[])))
           OR a.audience::text = ANY($3::text[])
        )
      ORDER BY a.published_at DESC NULLS LAST, a.id DESC
      LIMIT 100`,
    [user.role, classIds, audiences, user.id],
  );
  return rows;
}

export async function createAnnouncement(payload, actor, ip, userAgent) {
  const publishedAt = payload.status === 'published' ? new Date().toISOString() : null;
  const created = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO announcements (title, body, type, status, audience, published_at, created_by)
       VALUES ($1::text, $2::text, $3::announcement_type, $4::announcement_status, $5::audience_scope, $6::timestamptz, $7)
       RETURNING id, title, status`,
      [
        payload.title,
        payload.body,
        payload.type || 'general',
        payload.status || 'draft',
        payload.audience || 'all',
        publishedAt,
        actor?.id ?? null,
      ],
    );
    if (payload.audience === 'classes' && payload.classIds?.length) {
      for (const classId of payload.classIds) {
        await client.query(
          'INSERT INTO announcement_classes (announcement_id, class_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [rows[0].id, classId],
        );
      }
    }

    if (rows[0].status === 'published') {
      await notifyAnnouncement(client, rows[0], payload);
    }

    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'announcement.created',
      entityType: 'announcements',
      entityId: rows[0].id,
      newValues: { title: payload.title, audience: payload.audience, status: rows[0].status },
      ip,
      userAgent,
    });
    return rows[0];
  });
  return created;
}

async function notifyAnnouncement(client, announcement, payload) {
  const roles =
    payload.audience === 'teachers'
      ? ['teacher']
      : payload.audience === 'students'
        ? ['student']
        : payload.audience === 'parents'
          ? ['parent']
          : ['teacher', 'student', 'parent'];

  const recipients = await client.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.code = ANY($1::text[]) AND u.is_active AND u.deleted_at IS NULL`,
    [roles],
  );
  for (const row of recipients.rows) {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body, link, entity_type, entity_id)
       VALUES ($1, 'announcement', $2, $3, '/notices', 'announcements', $4)`,
      [row.id, announcement.title, 'New announcement published', announcement.id],
    );
  }
}

export async function publishAnnouncement(announcementId, publish, actor, ip, userAgent) {
  const { rows } = await query(
    `UPDATE announcements
        SET status = $2::announcement_status,
            published_at = CASE WHEN $2::announcement_status::text = 'published' THEN coalesce(published_at, now()) ELSE NULL END,
            archived_at = CASE WHEN $2::announcement_status::text = 'archived' THEN now() ELSE archived_at END
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, title, status, audience`,
    [announcementId, publish],
  );
  if (!rows[0]) throw notFound('Announcement not found.');
  await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'announcement.status_changed', entityType: 'announcements', entityId: announcementId, newValues: { status: publish }, ip, userAgent });
  return rows[0];
}

export async function deleteAnnouncement(announcementId, actor, ip, userAgent) {
  const { rowCount } = await query('UPDATE announcements SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [announcementId]);
  if (rowCount === 0) throw notFound('Announcement not found.');
  await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'announcement.deleted', entityType: 'announcements', entityId: announcementId, ip, userAgent });
  return { deleted: true };
}

export async function markAnnouncementRead(announcementId, userId) {
  await query(
    `INSERT INTO announcement_reads (announcement_id, user_id) VALUES ($1, $2)
     ON CONFLICT (announcement_id, user_id) DO NOTHING`,
    [announcementId, userId],
  );
  return { read: true };
}

export async function readReport(announcementId) {
  const { rows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ar.user_id IS NOT NULL)::int AS read
       FROM announcement_reads ar WHERE ar.announcement_id = $1`,
    [announcementId],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function listNotifications(userId, { unreadOnly = false, limit = 30 }) {
  const { rows } = await query(
    `SELECT id, type, title, body, link, entity_type, entity_id, read_at,
            to_char(created_at, 'DD-MM-YYYY HH24:MI') AS created_label
       FROM notifications
      WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  const { rows: counts } = await query(
    'SELECT count(*)::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread FROM notifications WHERE user_id = $1',
    [userId],
  );
  return { notifications: rows, counts: counts[0] };
}

export async function markNotification(userId, notificationId, read) {
  const { rowCount } = await query(
    'UPDATE notifications SET read_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1 AND user_id = $2',
    [notificationId, userId, read],
  );
  if (rowCount === 0) throw notFound('Notification not found.');
  return { id: notificationId, read };
}

/** Used by other modules (attendance decision, exam publish). */
export async function notify({ client = null, userId, type, title, body, link, entityType, entityId }) {
  const runner = client ? client.query.bind(client) : query;
  await runner(
    `INSERT INTO notifications (user_id, type, title, body, link, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, type, title, body ?? null, link ?? null, entityType ?? null, entityId ?? null],
  );
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function listAssignments(user) {
  const year = await currentYear();
  if (user.role === 'teacher') {
    const { rows } = await query(
      `SELECT a.id, a.title, a.description, a.due_date, to_char(a.due_date, 'DD-MM-YYYY') AS due_label,
              c.name AS class_name, s.name AS section_name, sub.name AS subject_name
         FROM assignments a
         JOIN classes c ON c.id = a.class_id
         LEFT JOIN sections s ON s.id = a.section_id
         JOIN subjects sub ON sub.id = a.subject_id
         JOIN teachers t ON t.id = a.teacher_id
        WHERE t.user_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.due_date DESC LIMIT 100`,
      [user.id],
    );
    return rows;
  }

  const classIds = await classIdsForUser(user);
  const { rows } = await query(
    `SELECT a.id, a.title, a.description, a.due_date, to_char(a.due_date, 'DD-MM-YYYY') AS due_label,
            c.name AS class_name, s.name AS section_name, sub.name AS subject_name,
            trim(concat(t.first_name, ' ', t.last_name)) AS teacher_name
       FROM assignments a
       JOIN classes c ON c.id = a.class_id
       LEFT JOIN sections s ON s.id = a.section_id
       JOIN subjects sub ON sub.id = a.subject_id
       JOIN teachers t ON t.id = a.teacher_id
      WHERE a.deleted_at IS NULL AND a.class_id = ANY($1::int[])
      ORDER BY a.due_date DESC LIMIT 100`,
    [classIds.length ? classIds : [0]],
  );
  void year;
  return rows;
}

export async function createAssignment(payload, actor, ip, userAgent) {
  const year = await currentYear();
  const teacher = await query(
    'SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL',
    [actor.id],
  );
  if (!teacher.rows[0]) throw forbidden('Only teachers can create assignments.', 'NOT_A_TEACHER');

  const allowed = await query(
    `SELECT 1 FROM teacher_subjects ts
      WHERE ts.teacher_id = $1 AND ts.class_id = $2 AND ts.subject_id = $4
        AND ts.academic_year_id = $3`,
    [teacher.rows[0].id, payload.classId, year?.id ?? 0, payload.subjectId],
  );
  if (!allowed.rows[0]) {
    throw forbidden('You can only set assignments for subjects you teach in that class.', 'NOT_YOUR_SUBJECT');
  }

  const { rows } = await query(
    `INSERT INTO assignments (title, description, class_id, section_id, subject_id, teacher_id, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, due_date`,
    [
      payload.title,
      payload.description ?? null,
      payload.classId,
      payload.sectionId ?? null,
      payload.subjectId,
      teacher.rows[0].id,
      payload.dueDate,
      actor.id,
    ],
  );
  await audit({ actorUserId: actor.id, actorRole: actor.role, action: 'assignment.created', entityType: 'assignments', entityId: rows[0].id, newValues: payload, ip, userAgent });
  return rows[0];
}

export async function deleteAssignment(assignmentId, actor, ip, userAgent) {
  const owner = await query(
    `SELECT a.id FROM assignments a JOIN teachers t ON t.id = a.teacher_id
      WHERE a.id = $1 AND a.deleted_at IS NULL AND (t.user_id = $2 OR $3 = 'admin')`,
    [assignmentId, actor.id, actor.role],
  );
  if (!owner.rows[0]) throw notFound('Assignment not found.');
  await query('UPDATE assignments SET deleted_at = now() WHERE id = $1', [assignmentId]);
  await audit({ actorUserId: actor.id, actorRole: actor.role, action: 'assignment.deleted', entityType: 'assignments', entityId: assignmentId, ip, userAgent });
  return { deleted: true };
}

export { classIdsForUser, pagedMeta };
