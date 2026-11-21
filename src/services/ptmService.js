import { query, withTransaction } from '../config/db.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { pagedMeta } from '../utils/request.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';
import { notify } from './commsService.js';

/**
 * Parent–teacher meetings.
 *
 * Who may do what:
 *   admin    — publish slots for any teacher, see every booking, cancel, mark attendance
 *   teacher  — publish slots for themselves, see and mark the bookings of their own slots
 *   parent   — see open slots and book one for their own child; cancel their own booking
 *   student  — see the bookings made for them
 *
 * The parent→child relation is always resolved from the token, never from the payload: a parent
 * can only ever book for a child that `student_parents` says is theirs.
 */

const SLOT_SELECT = `
  SELECT s.id, s.slot_date, to_char(s.slot_date, 'DD-MM-YYYY') AS date_label,
         to_char(s.start_time, 'HH24:MI') AS start_label,
         to_char(s.end_time, 'HH24:MI') AS end_label,
         s.mode, s.location, s.capacity, s.notes, s.status,
         t.id AS teacher_id, t.first_name || ' ' || t.last_name AS teacher_name,
         t.employee_id,
         (SELECT count(*)::int FROM ptm_bookings b
           WHERE b.slot_id = s.id AND b.status IN ('booked', 'attended')) AS booked
    FROM ptm_slots s
    JOIN teachers t ON t.id = s.teacher_id`;

/**
 * The caller's visibility window as a SQL predicate. The placeholder index is passed in so the
 * fragment composes with whatever params the caller has already collected.
 */
function scopeFor(user, index) {
  if (user.role === 'admin') return { where: 'TRUE', params: [] };
  if (user.role === 'teacher') {
    return {
      where: `s.teacher_id IN (SELECT id FROM teachers WHERE user_id = $${index} AND deleted_at IS NULL)`,
      params: [user.id],
    };
  }
  // parent / student: every open slot, plus anything already booked for one of their children
  return {
    where: `(s.status = 'open' OR s.id IN (
               SELECT b.slot_id FROM ptm_bookings b
                 JOIN students st ON st.id = b.student_id
                 LEFT JOIN student_parents sp ON sp.student_id = st.id
                 LEFT JOIN parents pa ON pa.id = sp.parent_id
                WHERE st.user_id = $${index} OR pa.user_id = $${index}))`,
    params: [user.id],
  };
}

export async function listSlots(user, { from = null, to = null, teacherId = null, status = null, page = 1, limit = 50 } = {}) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');

  const scope = scopeFor(user, 2);
  const params = [year.id, ...scope.params];
  const clauses = ['s.academic_year_id = $1', 's.deleted_at IS NULL', scope.where];

  if (from) {
    params.push(from);
    clauses.push(`s.slot_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    clauses.push(`s.slot_date <= $${params.length}::date`);
  }
  if (teacherId) {
    params.push(teacherId);
    clauses.push(`s.teacher_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`s.status = $${params.length}`);
  }

  const where = clauses.join(' AND ');
  const [rows, total] = await Promise.all([
    query(
      `${SLOT_SELECT}
        WHERE ${where}
        ORDER BY s.slot_date, s.start_time
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    ),
    query(`SELECT count(*)::int AS total FROM ptm_slots s WHERE ${where}`, params),
  ]);

  return { rows: rows.rows, meta: pagedMeta({ page, limit, total: total.rows[0].total }) };
}

async function assertTeacherOwnership(actor, teacherId) {
  if (actor.role === 'admin') return;
  if (actor.role !== 'teacher') throw forbidden('Only a teacher or the admin can publish slots.', 'PTM_FORBIDDEN');
  const own = await query('SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL', [actor.id]);
  if (!own.rows[0] || own.rows[0].id !== teacherId) {
    throw forbidden('You can only publish slots for yourself.', 'PTM_FORBIDDEN');
  }
}

/**
 * The teacher a NEW slot belongs to. The admin names one; a teacher is always themselves, so the
 * screen does not have to know its own teachers.id (and cannot publish for a colleague).
 */
async function resolveSlotTeacher(actor, teacherId) {
  if (actor.role === 'admin') {
    if (!teacherId) throw badRequest('Choose the teacher whose slot this is.', { teacherId: 'Required' });
    return teacherId;
  }
  if (actor.role !== 'teacher') throw forbidden('Only a teacher or the admin can publish slots.', 'PTM_FORBIDDEN');
  const own = await query('SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL', [actor.id]);
  if (!own.rows[0]) throw forbidden('No teacher record is linked to your account.', 'PTM_NO_TEACHER_PROFILE');
  if (teacherId && own.rows[0].id !== teacherId) {
    throw forbidden('You can only publish slots for yourself.', 'PTM_FORBIDDEN');
  }
  return own.rows[0].id;
}

export async function createSlot(actor, payload) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_CURRENT_YEAR');
  const teacherId = await resolveSlotTeacher(actor, payload.teacherId);

  const clash = await query(
    `SELECT id FROM ptm_slots
      WHERE teacher_id = $1 AND deleted_at IS NULL AND status <> 'cancelled'
        AND tsrange(slot_date + start_time, slot_date + end_time, '[)')
            && tsrange($2::date + $3::time, $2::date + $4::time, '[)')
      LIMIT 1`,
    [teacherId, payload.slotDate, payload.startTime, payload.endTime],
  );
  if (clash.rows[0]) throw conflict('That time overlaps another slot for this teacher.', 'PTM_SLOT_OVERLAP');

  const { rows } = await query(
    `INSERT INTO ptm_slots
       (academic_year_id, teacher_id, slot_date, start_time, end_time, mode, location, capacity, notes, created_by)
     VALUES ($1, $2, $3::date, $4::time, $5::time, $6, $7, $8, $9, $10)
     RETURNING id`,
    [year.id, teacherId, payload.slotDate, payload.startTime, payload.endTime,
      payload.mode ?? 'in_person', payload.location ?? null, payload.capacity ?? 1, payload.notes ?? null, actor.id],
  );

  await audit({
    actorUserId: actor.id,
    actorRole: actor.role,
    action: 'ptm.slot.created',
    entityType: 'ptm_slot',
    entityId: rows[0].id,
    newValues: { teacherId, date: payload.slotDate, from: payload.startTime, to: payload.endTime },
  });
  return rows[0];
}

export async function updateSlot(actor, slotId, payload) {
  const current = await query('SELECT * FROM ptm_slots WHERE id = $1 AND deleted_at IS NULL', [slotId]);
  const slot = current.rows[0];
  if (!slot) throw notFound('Slot not found.');
  await assertTeacherOwnership(actor, slot.teacher_id);

  const { rows } = await query(
    `UPDATE ptm_slots
        SET status = coalesce($2, status), notes = coalesce($3, notes),
            location = coalesce($4, location), capacity = coalesce($5, capacity)
      WHERE id = $1
      RETURNING id, status, capacity, notes`,
    [slotId, payload.status ?? null, payload.notes ?? null, payload.location ?? null, payload.capacity ?? null],
  );

  if (payload.status === 'cancelled') {
    await notifyBookedParents(slotId, {
      title: 'Meeting cancelled',
      body: 'The parent–teacher meeting slot you booked was cancelled by the school.',
    });
  }

  await audit({
    actorUserId: actor.id, actorRole: actor.role, action: 'ptm.slot.updated',
    entityType: 'ptm_slot', entityId: slotId, newValues: payload,
  });
  return rows[0];
}

export async function deleteSlot(actor, slotId) {
  const current = await query('SELECT * FROM ptm_slots WHERE id = $1 AND deleted_at IS NULL', [slotId]);
  const slot = current.rows[0];
  if (!slot) throw notFound('Slot not found.');
  await assertTeacherOwnership(actor, slot.teacher_id);
  const booked = await query(
    `SELECT count(*)::int AS n FROM ptm_bookings WHERE slot_id = $1 AND status = 'booked'`,
    [slotId],
  );
  if (booked.rows[0].n > 0) {
    throw conflict('Parents have booked this slot — cancel it instead of deleting.', 'PTM_SLOT_BOOKED');
  }
  await query('UPDATE ptm_slots SET deleted_at = now() WHERE id = $1', [slotId]);
  return { id: slotId, deleted: true };
}

/** Every parent with a live booking on the slot. */
async function notifyBookedParents(slotId, { title, body }) {
  const { rows } = await query(
    `SELECT DISTINCT b.booked_by AS user_id
       FROM ptm_bookings b
      WHERE b.slot_id = $1 AND b.status IN ('booked', 'attended') AND b.booked_by IS NOT NULL`,
    [slotId],
  );
  for (const row of rows) {
    await notify({ userId: row.user_id, type: 'ptm', title, body, link: '/parent/ptm', entityType: 'ptm_slot', entityId: slotId });
  }
}

/** Resolve which student a parent is allowed to touch (their own child). */
async function resolveChild(user, studentId) {
  if (['admin', 'teacher'].includes(user.role)) return studentId;
  const { rows } = await query(
    `SELECT st.id FROM students st
       LEFT JOIN student_parents sp ON sp.student_id = st.id
       LEFT JOIN parents pa ON pa.id = sp.parent_id
      WHERE st.id = $1 AND (st.user_id = $2 OR pa.user_id = $2)`,
    [studentId, user.id],
  );
  if (!rows[0]) throw forbidden('That student is not linked to your account.', 'PTM_NOT_YOUR_CHILD');
  return studentId;
}

export async function bookSlot(user, slotId, payload) {
  return withTransaction(async (client) => {
    const slot = await client.query(
      `SELECT s.*, t.user_id AS teacher_user_id, t.first_name || ' ' || t.last_name AS teacher_name
         FROM ptm_slots s JOIN teachers t ON t.id = s.teacher_id
        WHERE s.id = $1 AND s.deleted_at IS NULL FOR UPDATE`,
      [slotId],
    );
    const row = slot.rows[0];
    if (!row) throw notFound('Slot not found.');
    if (row.status !== 'open') throw conflict('This slot is not open for booking.', 'PTM_SLOT_CLOSED');

    const studentId = await resolveChild(user, payload.studentId);

    // "already booked" is checked before capacity: the same child asking twice deserves the
    // clearer message, not "this slot is full".
    const duplicate = await client.query(
      `SELECT 1 FROM ptm_bookings WHERE slot_id = $1 AND student_id = $2
        AND status IN ('booked', 'attended')`,
      [slotId, studentId],
    );
    if (duplicate.rows[0]) throw conflict('That child already has a place in this slot.', 'PTM_ALREADY_BOOKED');

    const taken = await client.query(
      `SELECT count(*)::int AS n FROM ptm_bookings WHERE slot_id = $1 AND status IN ('booked', 'attended')`,
      [slotId],
    );
    if (taken.rows[0].n >= row.capacity) {
      throw conflict('This slot is full.', 'PTM_SLOT_FULL');
    }

    let booking;
    try {
      booking = await client.query(
        `INSERT INTO ptm_bookings (slot_id, student_id, booked_by, note)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [slotId, studentId, user.id, payload.note ?? null],
      );
    } catch (error) {
      if (error.code === '23505') throw conflict('That child already has a place in this slot.', 'PTM_ALREADY_BOOKED');
      throw error;
    }

    await notify({
      client,
      userId: row.teacher_user_id,
      type: 'ptm',
      title: 'New meeting booking',
      body: `A parent booked your slot on ${String(row.slot_date).slice(0, 10)} at ${String(row.start_time).slice(0, 5)}.`,
      link: '/teacher/ptm',
      entityType: 'ptm_booking',
      entityId: booking.rows[0].id,
    });

    await audit({
      client, actorUserId: user.id, actorRole: user.role, action: 'ptm.booking.created',
      entityType: 'ptm_booking', entityId: booking.rows[0].id, newValues: { slotId, studentId },
    });
    return booking.rows[0];
  });
}

export async function decideBooking(actor, bookingId, status) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT b.*, s.teacher_id, t.user_id AS teacher_user_id
         FROM ptm_bookings b
         JOIN ptm_slots s ON s.id = b.slot_id
         JOIN teachers t ON t.id = s.teacher_id
        WHERE b.id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = current.rows[0];
    if (!booking) throw notFound('Booking not found.');

    if (actor.role !== 'admin') {
      const own = await client.query('SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL', [actor.id]);
      if (!own.rows[0] || own.rows[0].id !== booking.teacher_id) {
        throw forbidden('Only this teacher or the admin can update the booking.', 'PTM_FORBIDDEN');
      }
    }

    const { rows } = await client.query(
      'UPDATE ptm_bookings SET status = $2 WHERE id = $1 RETURNING *',
      [bookingId, status],
    );

    if (booking.booked_by) {
      const label = status === 'attended' ? 'marked as attended' : status === 'no_show' ? 'marked as not attended' : 'cancelled';
      await notify({
        client,
        userId: booking.booked_by,
        type: 'ptm',
        title: 'Meeting booking updated',
        body: `Your parent–teacher meeting booking was ${label}.`,
        link: '/parent/ptm',
        entityType: 'ptm_booking',
        entityId: bookingId,
      });
    }

    await audit({
      client, actorUserId: actor.id, actorRole: actor.role, action: `ptm.booking.${status}`,
      entityType: 'ptm_booking', entityId: bookingId, newValues: { status },
    });
    return rows[0];
  });
}

/** Bookings of one slot (admin, or the teacher who owns it) or of one student (parent/student). */
export async function listBookings(user, { slotId = null, studentId = null, page = 1, limit = 100 } = {}) {
  const params = [];
  const clauses = [];

  if (slotId) {
    params.push(slotId);
    clauses.push(`b.slot_id = $${params.length}`);
  }

  if (user.role === 'teacher') {
    params.push(user.id);
    clauses.push(`s.teacher_id IN (SELECT id FROM teachers WHERE user_id = $${params.length})`);
  } else if (user.role === 'admin') {
    // everything
  } else {
    const id = studentId ? await resolveChild(user, studentId) : null;
    params.push(user.id);
    clauses.push(`(st.user_id = $${params.length} OR pa.user_id = $${params.length})`);
    if (id) {
      params.push(id);
      clauses.push(`b.student_id = $${params.length}`);
    }
  }

  const where = clauses.length ? clauses.join(' AND ') : 'TRUE';
  const [rows, total] = await Promise.all([
    query(
      `SELECT b.id, b.status, b.note, b.created_at,
              st.admission_id, st.first_name || ' ' || st.last_name AS student_name,
              s.id AS slot_id, to_char(s.slot_date, 'DD-MM-YYYY') AS date_label,
              to_char(s.start_time, 'HH24:MI') AS start_label,
              t.first_name || ' ' || t.last_name AS teacher_name, s.mode
         FROM ptm_bookings b
         JOIN ptm_slots s ON s.id = b.slot_id
         JOIN teachers t ON t.id = s.teacher_id
         JOIN students st ON st.id = b.student_id
         LEFT JOIN student_parents sp ON sp.student_id = st.id
         LEFT JOIN parents pa ON pa.id = sp.parent_id
        WHERE ${where}
        ORDER BY s.slot_date DESC, s.start_time DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    ),
    query(
      `SELECT count(DISTINCT b.id)::int AS total
         FROM ptm_bookings b
         JOIN ptm_slots s ON s.id = b.slot_id
         JOIN students st ON st.id = b.student_id
         LEFT JOIN student_parents sp ON sp.student_id = st.id
         LEFT JOIN parents pa ON pa.id = sp.parent_id
        WHERE ${where}`,
      params,
    ),
  ]);

  return { rows: rows.rows, meta: pagedMeta({ page, limit, total: total.rows[0].total }) };
}

export async function cancelBooking(user, bookingId) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT b.*, s.teacher_id, t.user_id AS teacher_user_id
         FROM ptm_bookings b
         JOIN ptm_slots s ON s.id = b.slot_id
         JOIN teachers t ON t.id = s.teacher_id
        WHERE b.id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = current.rows[0];
    if (!booking) throw notFound('Booking not found.');

    if (['parent', 'student'].includes(user.role)) {
      const mine = booking.booked_by === user.id;
      if (!mine) {
        const own = await client.query(
          `SELECT 1 FROM students st
             LEFT JOIN student_parents sp ON sp.student_id = st.id
             LEFT JOIN parents pa ON pa.id = sp.parent_id
            WHERE st.id = $1 AND (st.user_id = $2 OR pa.user_id = $2)`,
          [booking.student_id, user.id],
        );
        if (!own.rows[0]) throw forbidden('That booking is not yours.', 'PTM_FORBIDDEN');
      }
    }

    const { rows } = await client.query(
      `UPDATE ptm_bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [bookingId],
    );

    await notify({
      client,
      userId: booking.teacher_user_id,
      type: 'ptm',
      title: 'Meeting booking cancelled',
      body: 'A parent cancelled their parent–teacher meeting booking.',
      link: '/teacher/ptm',
      entityType: 'ptm_booking',
      entityId: bookingId,
    });

    await audit({
      client, actorUserId: user.id, actorRole: user.role, action: 'ptm.booking.cancelled',
      entityType: 'ptm_booking', entityId: bookingId,
    });
    return rows[0];
  });
}
