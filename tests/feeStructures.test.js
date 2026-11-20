import './support/testEnv.js';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { seedAcademicFixtures, ACCOUNTS, TEST_PASSWORD } from './support/academicFixtures.js';

/**
 * Fee structure by class + payment frequency, and the "never negative" rule.
 *
 * Covered here:
 *   - half-yearly (2 installments, six months apart) and yearly (1 installment) plans
 *   - class-wise bulk save: one category, one plan, an amount per class
 *   - an existing structure that students already owe against is NOT re-priced silently
 *   - a payment can never exceed the outstanding amount (balance stays >= 0)
 */

let server;
let base;
let ids;
let token;
let categoryId;

async function call(method, path, { body, tok } = {}) {
  const headers = {};
  if (tok ?? token) headers.authorization = `Bearer ${tok ?? token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login(identifier, password = TEST_PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  return (await res.json())?.data?.accessToken;
}

before(async () => {
  ids = await seedAcademicFixtures();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  token = await login(ACCOUNTS.admin.username);

  const other = await pool.query(`INSERT INTO classes (name, level_order) VALUES ('Class 6', 4) RETURNING id`);
  ids.otherClassId = other.rows[0].id;

  // one total fee per class: no category involved
  categoryId = null;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

describe('class-wise fee structure', () => {
  it('saves a different amount for each class in one call', async () => {
    const res = await call('POST', '/api/fees/structures/bulk', {
      body: {
        installmentPlan: 'quarterly',
        entries: [
          { classId: ids.classId, totalAmount: 18000 },
          { classId: ids.otherClassId, totalAmount: 24000 },
        ],
      },
    });
    assert.equal(res.status, 200);
    const byClass = Object.fromEntries(res.body.data.results.map((row) => [row.className, row]));
    assert.equal(byClass['Class 5'].totalAmount, 18000);
    assert.equal(byClass['Class 6'].totalAmount, 24000);
    assert.equal(byClass['Class 5'].action, 'created');
    assert.equal(byClass['Class 5'].installments, 4);
    ids.structure = byClass['Class 5'].structureId;
  });

  it('creates four quarterly installments that add up to the total', async () => {
    const { rows } = await pool.query(
      'SELECT seq, amount, due_date FROM fee_installments WHERE fee_structure_id = $1 ORDER BY seq',
      [ids.structure],
    );
    assert.equal(rows.length, 4);
    const sum = rows.reduce((total, row) => total + Number(row.amount), 0);
    assert.equal(Math.round(sum * 100) / 100, 18000);
    // three months between consecutive installments
    const first = new Date(rows[0].due_date);
    const second = new Date(rows[1].due_date);
    assert.equal(second.getMonth() - first.getMonth(), 3);
  });

  it('supports half-yearly (2) and yearly (1) plans', async () => {
    const half = await call('POST', '/api/fees/structures/bulk', {
      body: { installmentPlan: 'half_yearly', entries: [{ classId: ids.classId, totalAmount: 12000 }] },
    });
    assert.equal(half.status, 200);
    assert.equal(half.body.data.results[0].action, 'updated');
    const halfRows = await pool.query(
      'SELECT seq, amount, due_date FROM fee_installments WHERE fee_structure_id = $1 ORDER BY seq',
      [ids.structure],
    );
    assert.equal(halfRows.rows.length, 2);
    const gap = new Date(halfRows.rows[1].due_date).getMonth() - new Date(halfRows.rows[0].due_date).getMonth();
    assert.equal(gap, 6);
    assert.equal(Number(halfRows.rows[0].amount) + Number(halfRows.rows[1].amount), 12000);

    const yearly = await call('POST', '/api/fees/structures/bulk', {
      body: { installmentPlan: 'one_time', entries: [{ classId: ids.classId, totalAmount: 9000 }] },
    });
    assert.equal(yearly.status, 200);
    const yearlyRows = await pool.query(
      'SELECT label, amount FROM fee_installments WHERE fee_structure_id = $1',
      [ids.structure],
    );
    assert.equal(yearlyRows.rows.length, 1);
    assert.equal(yearlyRows.rows[0].label, 'Full payment');
    assert.equal(Number(yearlyRows.rows[0].amount), 9000);
  });

  it('refuses to re-price a structure once a student owes against it', async () => {
    // assign the class-5 structure to the fixture student, which creates the ledger row
    const assigned = await call('POST', '/api/fees/assign', {
      body: { structureId: ids.structure, classId: ids.classId },
    });
    assert.ok([200, 201].includes(assigned.status), JSON.stringify(assigned.body));

    const res = await call('POST', '/api/fees/structures/bulk', {
      body: { installmentPlan: 'quarterly', entries: [{ classId: ids.classId, totalAmount: 30000 }] },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STRUCTURE_IN_USE');

    // Explicit re-cost is allowed and rewrites the student's payable amount with it.
    const recost = await call('POST', '/api/fees/structures/bulk', {
      body: {
        installmentPlan: 'half_yearly',
        recostExisting: true,
        entries: [{ classId: ids.classId, totalAmount: 30000 }],
      },
    });
    assert.equal(recost.status, 200, JSON.stringify(recost.body));
    const summary = await call('GET', `/api/fees/summary/${ids.studentId}`);
    const rows = summary.body.data.rows;
    assert.equal(Number(rows[0].payable_amount), 30000);
    const installments = await pool.query(
      'SELECT count(*)::int AS n FROM fee_installments WHERE fee_structure_id = $1',
      [ids.structure],
    );
    assert.equal(installments.rows[0].n, 2, 'half-yearly regenerates two installments');
  });
});

describe('payments can never go negative', () => {
  it('records a partial payment, refuses an overpayment and never leaves a negative balance', async () => {
    const summary = await call('GET', `/api/fees/summary/${ids.studentId}`);
    assert.equal(summary.status, 200);
    const feeRow = summary.body.data.rows[0];
    assert.ok(feeRow, 'the fixture student must have a fee row');

    const payable = Number(feeRow.payable_amount);
    assert.ok(payable > 0, 'payable must be positive');
    const studentFeeId = feeRow.id;

    const partial = await call('POST', '/api/fees/payments', {
      body: { studentFeeId, amount: 1000, paymentMode: 'cash', paidOn: '2026-06-01' },
    });
    assert.ok([200, 201].includes(partial.status), JSON.stringify(partial.body));

    const over = await call('POST', '/api/fees/payments', {
      body: { studentFeeId, amount: payable + 500, paymentMode: 'cash', paidOn: '2026-06-02' },
    });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'OVERPAYMENT');

    // Paying off exactly the remainder is allowed, and the balance lands on zero (never below).
    const rest = await call('POST', '/api/fees/payments', {
      body: { studentFeeId, amount: payable - 1000, paymentMode: 'cash', paidOn: '2026-06-03' },
    });
    assert.ok([200, 201].includes(rest.status), JSON.stringify(rest.body));

    const settled = await call('GET', `/api/fees/summary/${ids.studentId}`);
    assert.equal(settled.body.data.totals.due, 0);
    assert.ok(settled.body.data.totals.due >= 0);

    const extra = await call('POST', '/api/fees/payments', {
      body: { studentFeeId, amount: 100, paymentMode: 'cash', paidOn: '2026-06-04' },
    });
    assert.equal(extra.status, 409);
    assert.equal(extra.body.error.code, 'ALREADY_PAID');
  });
});
