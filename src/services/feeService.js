import { query, withTransaction } from '../config/db.js';
import { conflict, forbidden, notFound } from '../utils/errors.js';
import { audit } from './auditService.js';
import { currentYear } from './academicsService.js';
import { pagedMeta } from '../utils/request.js';

/**
 * Offline fee ledger (BRD 11):
 *  - fee categories -> structures (per class/year) -> installments;
 *  - a student is assigned a structure once, with an optional concession;
 *  - payments are rows; a receipt number comes from a database sequence;
 *  - a mistake is corrected by a REVERSAL payment, never by deleting;
 *  - parents see their own children; students see nothing unless the school enables it.
 */

async function studentFeeRows(studentId, yearId, client = null) {
  const runner = client ? client.query.bind(client) : query;
  const { rows } = await runner(
    `SELECT sf.id, sf.gross_amount, sf.concession_amount, sf.concession_reason, sf.payable_amount,
            fs.name AS structure_name, fs.installment_plan,
            fc.name AS category, c.name AS class_name,
            coalesce((SELECT sum(p.amount) FROM fee_payments p WHERE p.student_fee_id = sf.id), 0)::numeric AS paid
       FROM student_fees sf
       JOIN fee_structures fs ON fs.id = sf.fee_structure_id
       JOIN fee_categories fc ON fc.id = fs.category_id
       JOIN classes c ON c.id = fs.class_id
      WHERE sf.student_id = $1 AND sf.academic_year_id = $2
      ORDER BY fc.name`,
    [studentId, yearId],
  );
  return rows;
}

export async function studentSummary(studentId, yearIdParam) {
  const year = yearIdParam ? { id: yearIdParam } : await currentYear();
  const yearId = year?.id ?? 0;
  const rows = await studentFeeRows(studentId, yearId);

  const receipts = await query(
    `SELECT r.id, r.receipt_no, r.amount, to_char(r.issued_on, 'DD-MM-YYYY') AS issued_on,
            r.is_reversed, fp.payment_mode, fp.reference_no,
            (SELECT p2.id FROM fee_payments p2 WHERE p2.reversal_of_payment_id = fp.id LIMIT 1) AS reversal_id
       FROM fee_receipts r
       JOIN fee_payments fp ON fp.id = r.payment_id
      WHERE r.student_id = $1
      ORDER BY r.issued_on DESC, r.id DESC`,
    [studentId],
  );

  const totals = rows.reduce(
    (accumulator, row) => {
      accumulator.payable += Number(row.payable_amount);
      accumulator.paid += Number(row.paid);
      return accumulator;
    },
    { payable: 0, paid: 0 },
  );
  totals.due = Math.max(0, Math.round((totals.payable - totals.paid) * 100) / 100);

  const installments = await query(
    `SELECT fi.seq, fi.label, to_char(fi.due_date, 'DD-MM-YYYY') AS due_label, fi.amount,
            fs.name AS structure_name
       FROM student_fees sf
       JOIN fee_structures fs ON fs.id = sf.fee_structure_id
       JOIN fee_installments fi ON fi.fee_structure_id = fs.id
      WHERE sf.student_id = $1 AND sf.academic_year_id = $2
      ORDER BY fi.due_date`,
    [studentId, yearId],
  );

  return { rows, receipts: receipts.rows, totals, installments: installments.rows };
}

// ---------------------------------------------------------------------------
// Categories and structures
// ---------------------------------------------------------------------------

export async function listCategories() {
  const { rows } = await query(
    `SELECT id, name, code, is_active FROM fee_categories WHERE deleted_at IS NULL ORDER BY name`,
  );
  return rows;
}

export async function createCategory({ name, code }, actor, ip, userAgent) {
  try {
    const { rows } = await query(
      'INSERT INTO fee_categories (name, code) VALUES ($1, $2) RETURNING id, name, code',
      [name, code.toUpperCase()],
    );
    await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'fee_category.created', entityType: 'fee_categories', entityId: rows[0].id, newValues: { name, code }, ip, userAgent });
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw conflict('That fee category already exists.', 'CATEGORY_EXISTS');
    throw error;
  }
}

export async function listStructures() {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT fs.id, fs.name, fs.total_amount, fs.installment_plan, fs.is_active,
            fc.name AS category, c.name AS class_name, c.id AS class_id,
            (SELECT count(*)::int FROM student_fees sf WHERE sf.fee_structure_id = fs.id) AS assigned,
            COALESCE((SELECT json_agg(json_build_object('seq', fi.seq, 'label', fi.label,
                     'due', to_char(fi.due_date, 'DD-MM-YYYY'), 'amount', fi.amount) ORDER BY fi.seq)
                        FROM fee_installments fi WHERE fi.fee_structure_id = fs.id), '[]'::json) AS installments
       FROM fee_structures fs
       JOIN fee_categories fc ON fc.id = fs.category_id
       JOIN classes c ON c.id = fs.class_id
      WHERE fs.academic_year_id = $1 AND fs.deleted_at IS NULL
      ORDER BY c.level_order, fc.name`,
    [year?.id ?? 0],
  );
  return rows;
}

/** How many installments a plan produces, and how far apart they fall. */
const PLAN_STEPS = {
  monthly: { count: 12, months: 1 },
  quarterly: { count: 4, months: 3 },
  half_yearly: { count: 2, months: 6 },
  term: { count: 3, months: 4 },
  one_time: { count: 1, months: 0 },
};

/** Writes the installment rows for a structure; split is equal except the last row, which carries the remainder. */
async function writeInstallments(client, structureId, totalAmount, plan, yearStart) {
  const { count, months } = PLAN_STEPS[plan];
  const per = Math.round((Number(totalAmount) / count) * 100) / 100;
  const start = new Date(`${yearStart}T00:00:00Z`);
  for (let index = 0; index < count; index += 1) {
    const due = new Date(start);
    if (months) due.setUTCMonth(due.getUTCMonth() + index * months);
    await client.query(
      `INSERT INTO fee_installments (fee_structure_id, seq, label, due_date, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        structureId,
        index + 1,
        plan === 'one_time' ? 'Full payment' : `${index + 1}/${count}`,
        due.toISOString().slice(0, 10),
        index === count - 1
          ? Math.round((Number(totalAmount) - per * (count - 1)) * 100) / 100
          : per,
      ],
    );
  }
  return count;
}

export async function createStructure(payload, actor, ip, userAgent) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');
  const planCount = { monthly: 12, quarterly: 4, half_yearly: 2, term: 3, one_time: 1 }[payload.installmentPlan];
  if (!planCount) throw conflict('Unknown installment plan.', 'BAD_PLAN');

  try {
    return await withTransaction(async (client) => {
      const structure = await client.query(
        `INSERT INTO fee_structures (academic_year_id, class_id, category_id, name, total_amount, installment_plan)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, total_amount`,
        [year.id, payload.classId, payload.categoryId, payload.name, payload.totalAmount, payload.installmentPlan],
      );
      const per = Math.round((Number(payload.totalAmount) / planCount) * 100) / 100;
      const start = new Date(`${year.start_date}T00:00:00Z`);
      for (let index = 0; index < planCount; index += 1) {
        const due = new Date(start);
        if (payload.installmentPlan === 'monthly') due.setUTCMonth(due.getUTCMonth() + index);
        else if (payload.installmentPlan === 'quarterly') due.setUTCMonth(due.getUTCMonth() + index * 3);
        else if (payload.installmentPlan === 'half_yearly') due.setUTCMonth(due.getUTCMonth() + index * 6);
        else if (payload.installmentPlan === 'term') due.setUTCMonth(due.getUTCMonth() + index * 4);
        await client.query(
          `INSERT INTO fee_installments (fee_structure_id, seq, label, due_date, amount)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            structure.rows[0].id,
            index + 1,
            payload.installmentPlan === 'one_time' ? 'Full payment' : `${index + 1}/${planCount}`,
            due.toISOString().slice(0, 10),
            index === planCount - 1
              ? Math.round((Number(payload.totalAmount) - per * (planCount - 1)) * 100) / 100
              : per,
          ],
        );
      }
      await audit({
        client,
        actorUserId: actor?.id,
        actorRole: actor?.role,
        action: 'fee_structure.created',
        entityType: 'fee_structures',
        entityId: structure.rows[0].id,
        newValues: payload,
        ip,
        userAgent,
      });
      return structure.rows[0];
    });
  } catch (error) {
    if (error.code === '23505') {
      throw conflict('This class already has a structure for that category.', 'STRUCTURE_EXISTS');
    }
    throw error;
  }
}

/**
 * Class-wise fee setup: one category + plan, one amount per class.
 *
 * Existing structures are updated in place — but only while nobody owes against them. Once a
 * `student_fees` row exists the amount is already part of a student's ledger, so rewriting it
 * would change what a family was told; that case is refused instead of silently re-priced.
 * An amount of 0 means "this class does not pay this category": nothing is created, and an
 * unused structure is removed.
 */
export async function bulkStructures(payload, actor, ip, userAgent) {
  const year = await currentYear();
  if (!year) throw conflict('No current academic year is configured.', 'NO_ACADEMIC_YEAR');
  if (!PLAN_STEPS[payload.installmentPlan]) throw conflict('Unknown installment plan.', 'BAD_PLAN');

  return withTransaction(async (client) => {
    const results = [];
    for (const entry of payload.entries) {
      const klass = await client.query('SELECT id, name FROM classes WHERE id = $1 AND deleted_at IS NULL', [
        entry.classId,
      ]);
      if (!klass.rows[0]) throw notFound('Class not found.');

      const existing = await client.query(
        `SELECT fs.id, fs.total_amount, fs.installment_plan,
                (SELECT count(*)::int FROM student_fees sf WHERE sf.fee_structure_id = fs.id) AS assigned
           FROM fee_structures fs
          WHERE fs.academic_year_id = $1 AND fs.class_id = $2 AND fs.category_id = $3
            AND fs.deleted_at IS NULL
          FOR UPDATE`,
        [year.id, entry.classId, payload.categoryId],
      );
      const current = existing.rows[0];
      const amount = Math.round(Number(entry.totalAmount) * 100) / 100;
      const name = payload.name || `${klass.rows[0].name} fees`;

      if (amount === 0) {
        if (!current) {
          results.push({ classId: entry.classId, className: klass.rows[0].name, action: 'skipped' });
          continue;
        }
        if (current.assigned > 0) {
          throw conflict(
            `${klass.rows[0].name}: ${current.assigned} student(s) already owe this fee — it cannot be cleared.`,
            'STRUCTURE_IN_USE',
          );
        }
        await client.query('UPDATE fee_structures SET deleted_at = now() WHERE id = $1', [current.id]);
        results.push({ classId: entry.classId, className: klass.rows[0].name, action: 'removed' });
        continue;
      }

      if (!current) {
        const created = await client.query(
          `INSERT INTO fee_structures (academic_year_id, class_id, category_id, name, total_amount, installment_plan)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [year.id, entry.classId, payload.categoryId, name, amount, payload.installmentPlan],
        );
        const installments = await writeInstallments(
          client,
          created.rows[0].id,
          amount,
          payload.installmentPlan,
          year.start_date,
        );
        results.push({
          classId: entry.classId,
          className: klass.rows[0].name,
          structureId: created.rows[0].id,
          totalAmount: amount,
          installments,
          action: 'created',
        });
        continue;
      }

      const changed =
        Number(current.total_amount) !== amount || current.installment_plan !== payload.installmentPlan;
      if (changed && current.assigned > 0) {
        if (!payload.recostExisting) {
          throw conflict(
            `${klass.rows[0].name}: ${current.assigned} student(s) already owe ₹${Number(current.total_amount).toFixed(2)} — ` +
              'changing the amount now would rewrite their ledger. Send recostExisting to re-price them as well.',
            'STRUCTURE_IN_USE',
          );
        }
        /**
         * Re-costing an assigned structure is allowed, but never into a negative balance:
         * if any student already paid more than the new amount, their ledger would go below zero,
         * so that class is refused instead of silently producing a credit.
         */
        const overpaid = await client.query(
          `SELECT count(*)::int AS n FROM student_fees sf
            WHERE sf.fee_structure_id = $1
              AND (SELECT coalesce(sum(p.amount), 0) FROM fee_payments p WHERE p.student_fee_id = sf.id) > $2`,
          [current.id, amount],
        );
        if (overpaid.rows[0].n > 0) {
          throw conflict(
            `${klass.rows[0].name}: ${overpaid.rows[0].n} student(s) have already paid more than ₹${amount.toFixed(2)} — ` +
              'a re-price would push their balance below zero. Refund/reverse first, then re-cost.',
            'RECOST_NEGATIVE',
          );
        }
        await client.query('UPDATE student_fees SET gross_amount = $2 WHERE fee_structure_id = $1', [
          current.id,
          amount,
        ]);
      }
      if (changed) {
        await client.query(
          `UPDATE fee_structures SET total_amount = $2, installment_plan = $3, name = $4 WHERE id = $1`,
          [current.id, amount, payload.installmentPlan, name],
        );
        await client.query('DELETE FROM fee_installments WHERE fee_structure_id = $1', [current.id]);
        await writeInstallments(client, current.id, amount, payload.installmentPlan, year.start_date);
      }
      results.push({
        classId: entry.classId,
        className: klass.rows[0].name,
        structureId: current.id,
        totalAmount: amount,
        installments: PLAN_STEPS[payload.installmentPlan].count,
        action: changed ? 'updated' : 'unchanged',
      });
    }

    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'fee_structure.bulk_saved',
      entityType: 'fee_structures',
      newValues: { categoryId: payload.categoryId, plan: payload.installmentPlan, entries: results },
      ip,
      userAgent,
    });
    return results;
  });
}

export async function deleteStructure(structureId, actor, ip, userAgent) {
  const used = await query('SELECT count(*)::int AS total FROM student_fees WHERE fee_structure_id = $1', [
    structureId,
  ]);
  if (used.rows[0].total > 0) {
    throw conflict('Students are already assigned to this structure.', 'STRUCTURE_IN_USE');
  }
  const { rowCount } = await query(
    'UPDATE fee_structures SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
    [structureId],
  );
  if (rowCount === 0) throw notFound('Structure not found.');
  await audit({ actorUserId: actor?.id, actorRole: actor?.role, action: 'fee_structure.deleted', entityType: 'fee_structures', entityId: structureId, ip, userAgent });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export async function assignFees({ structureId, studentIds = [], classId, concession, reason }, actor, ip, userAgent) {
  const year = await currentYear();
  const structure = await query(
    'SELECT id, class_id, total_amount FROM fee_structures WHERE id = $1 AND deleted_at IS NULL',
    [structureId],
  );
  if (!structure.rows[0]) throw notFound('Fee structure not found.');
  if (classId && Number(classId) !== structure.rows[0].class_id) {
    throw conflict('The structure belongs to another class.', 'CLASS_MISMATCH');
  }

  let targets = studentIds;
  if (!targets.length && classId) {
    const enrolled = await query(
      "SELECT student_id FROM enrollments WHERE class_id = $1 AND academic_year_id = $2 AND status = 'active'",
      [structure.rows[0].class_id, year?.id ?? 0],
    );
    targets = enrolled.rows.map((row) => row.student_id);
  }
  if (!targets.length) throw conflict('No students to assign.', 'NO_STUDENTS');

  const concessionValue = Number(concession || 0);
  const gross = Number(structure.rows[0].total_amount);
  if (concessionValue < 0 || concessionValue > gross) {
    throw conflict('The concession must be between 0 and the total amount.', 'BAD_CONCESSION');
  }

  const inserted = await withTransaction(async (client) => {
    let count = 0;
    for (const studentId of targets) {
      const { rowCount } = await client.query(
        `INSERT INTO student_fees (student_id, academic_year_id, fee_structure_id, gross_amount,
           concession_amount, concession_reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (student_id, fee_structure_id) DO NOTHING`,
        [studentId, year?.id ?? 0, structureId, gross, concessionValue, reason ?? null],
      );
      count += rowCount;
    }
    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'fees.assigned',
      entityType: 'fee_structures',
      entityId: structureId,
      newValues: { students: targets.length, created: count, concession: concessionValue },
      ip,
      userAgent,
    });
    return count;
  });

  return { assigned: inserted, requested: targets.length };
}

// ---------------------------------------------------------------------------
// Payments and reversals
// ---------------------------------------------------------------------------

export async function recordPayment({ studentFeeId, amount, paymentMode, referenceNo, paidOn, remarks }, actor, ip, userAgent) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) throw conflict('Enter a positive amount.', 'BAD_AMOUNT');
  if (paymentMode !== 'cash' && !referenceNo) {
    throw conflict(`A ${paymentMode.replace('_', ' ')} payment needs a reference number.`, 'REFERENCE_REQUIRED');
  }

  return withTransaction(async (client) => {
    const fee = await client.query(
      `SELECT sf.id, sf.student_id, sf.payable_amount,
              coalesce((SELECT sum(p.amount) FROM fee_payments p WHERE p.student_fee_id = sf.id), 0)::numeric AS paid
         FROM student_fees sf WHERE sf.id = $1 FOR UPDATE`,
      [studentFeeId],
    );
    if (!fee.rows[0]) throw notFound('Fee record not found.');

    /**
     * Never let a ledger go negative: a payment larger than what is due is refused outright
     * (the old 1-paisa slack could leave the balance at -0.01 after rounding).
     */
    const due = Math.round((Number(fee.rows[0].payable_amount) - Number(fee.rows[0].paid)) * 100) / 100;
    if (due <= 0) {
      throw conflict('This fee is already fully paid — nothing is outstanding.', 'ALREADY_PAID');
    }
    if (value - due > 0.004) {
      throw conflict(
        `A payment cannot exceed the outstanding amount (₹${due.toFixed(2)}).`,
        'OVERPAYMENT',
      );
    }

    const payment = await client.query(
      `INSERT INTO fee_payments (student_fee_id, amount, payment_mode, reference_no, paid_on, remarks, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, amount, payment_mode, to_char(paid_on, 'DD-MM-YYYY') AS paid_on`,
      [studentFeeId, value, paymentMode, referenceNo ?? null, paidOn, remarks ?? null, actor?.id ?? null],
    );

    const receipt = await client.query(
      `INSERT INTO fee_receipts (payment_id, student_fee_id, student_id, amount, issued_on, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, receipt_no, amount, to_char(issued_on, 'DD-MM-YYYY') AS issued_on`,
      [payment.rows[0].id, studentFeeId, fee.rows[0].student_id, value, paidOn, actor?.id ?? null],
    );

    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'fee.payment_recorded',
      entityType: 'fee_payments',
      entityId: payment.rows[0].id,
      newValues: { amount: value, mode: paymentMode, receipt: receipt.rows[0].receipt_no },
      ip,
      userAgent,
    });

    return { payment: payment.rows[0], receipt: receipt.rows[0] };
  });
}

export async function reversePayment({ paymentId, reason }, actor, ip, userAgent) {
  if (!reason || reason.trim().length < 5) throw conflict('A reversal needs a reason.', 'REASON_REQUIRED');

  return withTransaction(async (client) => {
    const payment = await client.query(
      `SELECT p.id, p.student_fee_id, p.amount, p.is_reversal
         FROM fee_payments p
        WHERE p.id = $1 FOR UPDATE`,
      [paymentId],
    );
    if (!payment.rows[0]) throw notFound('Payment not found.');
    if (payment.rows[0].is_reversal) throw conflict('A reversal cannot be reversed.', 'IS_REVERSAL');

    // Locked separately: a LEFT JOIN cannot be locked on its nullable side.
    const receipt = await client.query(
      'SELECT id, is_reversed FROM fee_receipts WHERE payment_id = $1 FOR UPDATE',
      [paymentId],
    );
    if (receipt.rows[0]?.is_reversed) throw conflict('This receipt is already reversed.', 'ALREADY_REVERSED');
    if (!receipt.rows[0]) throw conflict('This payment has no receipt to reverse.', 'NO_RECEIPT');

    const reversal = await client.query(
      `INSERT INTO fee_payments (student_fee_id, amount, payment_mode, paid_on, remarks, recorded_by,
         is_reversal, reversal_of_payment_id, reversal_reason)
       VALUES ($1, $2, (SELECT payment_mode FROM fee_payments WHERE id = $3),
               (now() AT TIME ZONE 'Asia/Kolkata')::date, $4, $5, TRUE, $3, $4)
       RETURNING id, amount`,
      [payment.rows[0].student_fee_id, -Number(payment.rows[0].amount), paymentId, reason, actor?.id ?? null],
    );

    await client.query(
      `UPDATE fee_receipts
          SET is_reversed = TRUE, reversed_on = (now() AT TIME ZONE 'Asia/Kolkata')::date,
              reversed_by_payment_id = $2
        WHERE id = $1`,
      [receipt.rows[0].id, reversal.rows[0].id],    );

    await audit({
      client,
      actorUserId: actor?.id,
      actorRole: actor?.role,
      action: 'fee.payment_reversed',
      entityType: 'fee_payments',
      entityId: reversal.rows[0].id,
      oldValues: { paymentId, amount: Number(payment.rows[0].amount) },
      newValues: { reversalOf: paymentId },
      reason,
      ip,
      userAgent,
    });

    return { reversalId: reversal.rows[0].id, amount: Number(reversal.rows[0].amount) };
  });
}

// ---------------------------------------------------------------------------
// Collections / receipts list
// ---------------------------------------------------------------------------

export async function listPayments({ from, to, search, page, limit, offset }) {
  const term = search ? `%${search.trim()}%` : null;
  const filters = `
    ($1::date IS NULL OR p.paid_on >= $1::date)
    AND ($2::date IS NULL OR p.paid_on <= $2::date)
    AND ($3::text IS NULL OR r.receipt_no ILIKE $3 OR st.admission_id ILIKE $3
         OR (st.first_name || ' ' || st.last_name) ILIKE $3)
  `;
  const params = [from ?? null, to ?? null, term];

  const [rows, total, summary] = await Promise.all([
    query(
      `SELECT p.id, p.amount, p.payment_mode, p.reference_no, p.is_reversal, p.reversal_reason,
              to_char(p.paid_on, 'DD-MM-YYYY') AS paid_on,
              r.receipt_no, r.is_reversed,
              st.admission_id, st.first_name || ' ' || st.last_name AS student_name,
              fs.name AS structure_name, fc.name AS category,
              (SELECT u.username FROM users u WHERE u.id = p.recorded_by) AS recorded_by
         FROM fee_payments p
         JOIN student_fees sf ON sf.id = p.student_fee_id
         JOIN students st ON st.id = sf.student_id
         JOIN fee_structures fs ON fs.id = sf.fee_structure_id
         JOIN fee_categories fc ON fc.id = fs.category_id
         LEFT JOIN fee_receipts r ON r.payment_id = p.id
        WHERE ${filters}
        ORDER BY p.paid_on DESC, p.id DESC
        LIMIT $4 OFFSET $5`,
      [...params, limit, offset],
    ),
    query(
      `SELECT count(*)::int AS total
         FROM fee_payments p
         JOIN student_fees sf ON sf.id = p.student_fee_id
         JOIN students st ON st.id = sf.student_id
         LEFT JOIN fee_receipts r ON r.payment_id = p.id
        WHERE ${filters}`,
      params,
    ),
    query(
      `SELECT coalesce(sum(p.amount), 0)::numeric AS collected,
              count(*) FILTER (WHERE p.is_reversal)::int AS reversals
         FROM fee_payments p
         JOIN student_fees sf ON sf.id = p.student_fee_id
         JOIN students st ON st.id = sf.student_id
         LEFT JOIN fee_receipts r ON r.payment_id = p.id
        WHERE ${filters}`,
      params,
    ),
  ]);

  return {
    rows: rows.rows,
    meta: pagedMeta({ page, limit, total: total.rows[0].total }),
    summary: { collected: Number(summary.rows[0].collected), reversals: summary.rows[0].reversals },
  };
}

export async function receivableSummary() {
  const year = await currentYear();
  const { rows } = await query(
    `SELECT coalesce(sum(sf.payable_amount), 0)::numeric AS payable,
            coalesce((SELECT sum(p.amount) FROM fee_payments p
                        JOIN student_fees sf2 ON sf2.id = p.student_fee_id
                       WHERE sf2.academic_year_id = $1), 0)::numeric AS paid,
            count(*)::int AS records
       FROM student_fees sf WHERE sf.academic_year_id = $1`,
    [year?.id ?? 0],
  );
  const payable = Number(rows[0].payable);
  const paid = Number(rows[0].paid);
  return { payable, paid, due: Math.max(0, Math.round((payable - paid) * 100) / 100), records: rows[0].records };
}

export async function studentFeeAccess(userRole, studentId, userId) {
  if (userRole === 'admin') return true;
  if (userRole === 'parent') {
    const linked = await query(
      `SELECT 1 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = $1 AND p.user_id = $2`,
      [studentId, userId],
    );
    return Boolean(linked.rows[0]);
  }
  if (userRole === 'student') {
    // A student may only ever ask about their own record, never another student's id.
    const own = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
    if (!own.rows[0] || Number(own.rows[0].id) !== Number(studentId)) {
      throw forbidden('You can only view your own fees.', 'FEE_FORBIDDEN');
    }
    const settings = await query('SELECT fee_visible_to_students FROM school_settings WHERE id = 1');
    return Boolean(settings.rows[0]?.fee_visible_to_students);
  }
  throw forbidden('Fees are not available to your role.', 'FEE_FORBIDDEN');
}

export default {
  studentSummary,
  listCategories,
  createCategory,
  listStructures,
  createStructure,
  deleteStructure,
  assignFees,
  recordPayment,
  reversePayment,
  listPayments,
  receivableSummary,
  studentFeeAccess,
};
