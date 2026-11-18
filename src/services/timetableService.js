import { query, withTransaction } from '../config/db.js';
import { conflict, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';

/** Timetable (BRD 16): admin builds it, everyone else reads. A teacher cannot be in two rooms. */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function listPeriods() {
  const { rows } = await query(
    `SELECT id, period_no, label, to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time, 'HH24:MI') AS end_time, is_break
       FROM periods ORDER BY start_time`,
  );
  return rows;
}

export async function createPeriod(payload, actor, ip, userAgent) {
  let periodNo = payload.periodNo ?? null;
  if (!payload.isBreak && !periodNo) {
    const next = await query('SELECT coalesce(max(period_no), 0) + 1 AS next FROM periods');
    periodNo = next.rows[0].next;
  }
  try {
    const { rows } = await query(
      `INSERT INTO periods (period_no, label, start_time, end_time, is_break)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [periodNo, payload.label, payload.startTime, payload.endTime, Boolean(payload.isBreak)],
    );
    await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'period.created', entityType: 'periods', entityId: rows[0].id, newValues: payload, ip, userAgent });
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw conflict('That period number or start time already exists.', 'PERIOD_EXISTS');
    throw error;
  }
}

export async function deletePeriod(periodId, actor, ip, userAgent) {
  const used = await query('SELECT count(*)::int AS total FROM timetable_slots WHERE period_id = $1', [periodId]);
  if (used.rows[0].total > 0) throw conflict('This period is used in a timetable.', 'PERIOD_IN_USE');
  const { rowCount } = await query('DELETE FROM periods WHERE id = $1', [periodId]);
  if (rowCount === 0) throw notFound('Period not found.');
  await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'period.deleted', entityType: 'periods', entityId: periodId, ip, userAgent });
  return { deleted: true };
}

export async function sectionTimetable(sectionId) {
  const year = await currentYear();
  const section = await query(
    `SELECT s.id, s.name AS section_name, c.name AS class_name, c.id AS class_id
       FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
    [sectionId],
  );
  if (!section.rows[0]) throw notFound('Section not found.');

  const { rows } = await query(
    `SELECT t.id, t.day_of_week, t.room, p.id AS period_id, p.period_no, p.label,
            to_char(p.start_time, 'HH24:MI') AS start_time, to_char(p.end_time, 'HH24:MI') AS end_time,
            p.is_break, sub.name AS subject_name, sub.id AS subject_id,
            trim(concat(te.first_name, ' ', te.last_name)) AS teacher_name, te.id AS teacher_id
       FROM timetable_slots t
       JOIN periods p ON p.id = t.period_id
       JOIN subjects sub ON sub.id = t.subject_id
       JOIN teachers te ON te.id = t.teacher_id
      WHERE t.section_id = $1 AND t.academic_year_id = $2
      ORDER BY t.day_of_week, p.start_time`,
    [sectionId, year?.id ?? 0],
  );

  return {
    section: section.rows[0],
    days: DAYS,
    slots: rows,
    periods: await listPeriods(),
  };
}

export async function teacherTimetable(userId) {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT t.id, t.day_of_week, t.room, p.id AS period_id, p.period_no, p.label,
            to_char(p.start_time, 'HH24:MI') AS start_time, to_char(p.end_time, 'HH24:MI') AS end_time,
            c.name AS class_name, s.name AS section_name, sub.name AS subject_name
       FROM timetable_slots t
       JOIN periods p ON p.id = t.period_id
       JOIN sections s ON s.id = t.section_id
       JOIN classes c ON c.id = s.class_id
       JOIN subjects sub ON sub.id = t.subject_id
       JOIN teachers te ON te.id = t.teacher_id
      WHERE te.user_id = $1 AND t.academic_year_id = $2
      ORDER BY t.day_of_week, p.start_time`,
    [userId, year?.id ?? 0],
  );
  // The grid draws its rows from `periods` and matches cells on `period_id`; a teacher view
  // without both renders as "No periods are defined yet" even when slots exist.
  return { days: DAYS, slots: rows, periods: await listPeriods() };
}

export async function setSlot(payload, actor, ip, userAgent) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO timetable_slots (academic_year_id, section_id, day_of_week, period_id, subject_id,
           teacher_id, room, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date, CURRENT_DATE))
         ON CONFLICT (academic_year_id, section_id, day_of_week, period_id)
         DO UPDATE SET subject_id = EXCLUDED.subject_id, teacher_id = EXCLUDED.teacher_id,
                       room = EXCLUDED.room
         RETURNING id`,
        [
          year.id,
          payload.sectionId,
          payload.dayOfWeek,
          payload.periodId,
          payload.subjectId,
          payload.teacherId,
          payload.room ?? null,
          payload.effectiveFrom ?? null,
        ],
      );

      const breakSlot = await client.query('SELECT is_break FROM periods WHERE id = $1', [payload.periodId]);
      if (breakSlot.rows[0]?.is_break) {
        throw conflict('A break cannot hold a lesson.', 'PERIOD_IS_BREAK');
      }

      await audit({
        client,
        actorUserId: actor?.id,
        actorRole: actor?.role,
        action: 'timetable.slot_saved',
        entityType: 'timetable_slots',
        entityId: rows[0].id,
        newValues: payload,
        ip,
        userAgent,
      });
      return rows[0];
    });
  } catch (error) {
    if (error.code === '23505') {
      throw conflict(
        'That teacher is already teaching another class in this period.',
        'TEACHER_BUSY',
      );
    }
    throw error;
  }
}

export async function deleteSlot(slotId, actor, ip, userAgent) {
  const { rowCount } = await query('DELETE FROM timetable_slots WHERE id = $1', [slotId]);
  if (rowCount === 0) throw notFound('Slot not found.');
  await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'timetable.slot_removed', entityType: 'timetable_slots', entityId: slotId, ip, userAgent });
  return { deleted: true };
}

export async function sectionForUser(user) {
  const year = await currentYear();
  if (user.role === 'student') {
    const { rows } = await query(
      `SELECT e.section_id FROM enrollments e JOIN students s ON s.id = e.student_id
        WHERE s.user_id = $1 AND e.academic_year_id = $2 LIMIT 1`,
      [user.id, year?.id ?? 0],
    );
    return rows[0]?.section_id ?? null;
  }
  if (user.role === 'parent') {
    const { rows } = await query(
      `SELECT e.section_id FROM student_parents sp
         JOIN parents p ON p.id = sp.parent_id
         JOIN enrollments e ON e.student_id = sp.student_id AND e.academic_year_id = $2
        WHERE p.user_id = $1 ORDER BY e.student_id LIMIT 1`,
      [user.id, year?.id ?? 0],
    );
    return rows[0]?.section_id ?? null;
  }
  return null;
}

export { DAYS };
