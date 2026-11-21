import { query, pool } from '../src/config/db.js';

/**
 * Put every sequence ahead of the data it feeds.
 *
 * Why this exists: moving the rows into another database with explicit ids (scripts/pg-data-transfer.mjs,
 * a CSV import, a restored dump) writes the rows but does not advance the sequences. The next INSERT
 * then hands out an id that is already taken and every "Add student" answers `23505` — which the API
 * reports as "already exists". The same breakage hits classes, receipts, marks, teachers, parents…
 *
 * Run once on any database that was filled by an import:
 *   node scripts/repair-sequences.mjs          # apply
 *   node scripts/repair-sequences.mjs --dry    # report only
 *
 * Idempotent: it only ever moves a sequence forward, never back.
 */

/** Sequences that feed a formatted text column (the DEFAULT is an expression, so pg_get_serial_sequence misses them). */
const TEXT_SEQUENCES = [
  {
    sequence: 'admission_id_seq',
    label: 'students.admission_id',
    sql: "SELECT coalesce(max(nullif(regexp_replace(admission_id, '\\D', '', 'g'), '')::bigint), 0) AS mx FROM students",
  },
  {
    sequence: 'employee_id_seq',
    label: 'teachers.employee_id',
    sql: "SELECT coalesce(max(nullif(regexp_replace(employee_id, '\\D', '', 'g'), '')::bigint), 0) AS mx FROM teachers",
  },
  {
    sequence: 'receipt_no_seq',
    label: 'fee_receipts.receipt_no',
    sql: "SELECT coalesce(max(nullif(regexp_replace(receipt_no, '\\D', '', 'g'), '')::bigint), 0) AS mx FROM fee_receipts",
  },
];

async function sequenceState(sequence) {
  const { rows } = await query(
    'SELECT last_value FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2',
    ['public', sequence],
  );
  if (!rows[0]) return { exists: false, last: null };
  return { exists: true, last: rows[0].last_value === null ? null : Number(rows[0].last_value) };
}

async function identitySequences() {
  const { rows } = await query(
    `SELECT c.relname AS tbl, a.attname AS col,
            pg_get_serial_sequence('public.' || c.relname, a.attname) AS seq
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_get_serial_sequence('public.' || c.relname, a.attname) IS NOT NULL
      ORDER BY c.relname`,
  );
  return rows;
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const db = (await query('SELECT current_database() AS name, inet_server_addr()::text AS host')).rows[0];
  console.log(`[repair-sequences] database=${db.name} host=${db.host ?? 'local'}`);
  console.log(dryRun ? '[repair-sequences] dry run — nothing is changed' : '[repair-sequences] applying');

  let moved = 0;
  let alreadyOk = 0;

  for (const row of await identitySequences()) {
    const sequence = row.seq.split('.').pop();
    const { rows } = await query(`SELECT coalesce(max("${row.col}"), 0)::bigint AS mx FROM "${row.tbl}"`);
    const max = Number(rows[0].mx);
    const state = await sequenceState(sequence);
    const last = state.last ?? 0;
    if (max <= last) {
      alreadyOk += 1;
      continue;
    }
    moved += 1;
    console.log(`  ${dryRun ? 'would set' : 'set'} ${sequence}: ${last} -> ${max}  (${row.tbl}.${row.col})`);
    if (!dryRun) {
      await query('SELECT setval($1::regclass, $2, true)', [`public.${sequence}`, max]);
    }
  }

  for (const item of TEXT_SEQUENCES) {
    const { rows } = await query(item.sql);
    const max = Number(rows[0].mx);
    const state = await sequenceState(item.sequence);
    const last = state.last ?? 0;
    if (max <= last) {
      alreadyOk += 1;
      continue;
    }
    moved += 1;
    console.log(`  ${dryRun ? 'would set' : 'set'} ${item.sequence}: ${last} -> ${max}  (${item.label})`);
    if (!dryRun) {
      await query('SELECT setval($1::regclass, $2, true)', [`public.${item.sequence}`, max]);
    }
  }

  console.log(`[repair-sequences] ${moved} sequence(s) behind, ${alreadyOk} already ahead`);
  await pool.end();
}

main().catch(async (error) => {
  console.error('[repair-sequences] failed:', error.message);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
