import { query, withTransaction } from '../config/db.js';
import { conflict, forbidden, notFound, badRequest } from '../utils/errors.js';
import { pagedMeta } from '../utils/request.js';
import { audit } from './auditService.js';

/**
 * Library service — catalogue, issues, returns and fines.
 *
 * Every mutation runs in a transaction and locks the book row, because two counters move at
 * once (`available_copies` and the issue row): issuing without the lock lets two clerks hand
 * out the last copy twice.
 */

const today = () => "((now() AT TIME ZONE 'Asia/Kolkata')::date)";

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export async function listBooks(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const category = (req.query.category || '').trim();

  const params = [];
  const where = ['b.deleted_at IS NULL'];
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(
      `(lower(b.title) LIKE $${params.length} OR lower(coalesce(b.author, '')) LIKE $${params.length}
        OR lower(coalesce(b.isbn, '')) LIKE $${params.length})`,
    );
  }
  if (category) {
    params.push(category.toLowerCase());
    where.push(`lower(b.category) = $${params.length}`);
  }
  const filter = where.join(' AND ');

  const [rows, total] = await Promise.all([
    query(
      `SELECT b.id, b.title, b.author, b.isbn, b.category, b.publisher, b.published_year,
              b.total_copies, b.available_copies, b.shelf, b.is_active,
              (SELECT count(*)::int FROM library_issues li
                WHERE li.book_id = b.id AND li.status = 'issued') AS on_loan
         FROM library_books b
        WHERE ${filter}
        ORDER BY lower(b.title)
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(`SELECT count(*)::int AS total FROM library_books b WHERE ${filter}`, params),
  ]);

  // DISTINCT + ORDER BY needs the expression in the select list in PostgreSQL.
  const categories = await query(
    `SELECT DISTINCT lower(category) AS category
       FROM library_books WHERE deleted_at IS NULL ORDER BY lower(category)`,
  );

  return {
    rows: rows.rows,
    meta: pagedMeta({ page, limit, total: total.rows[0].total }),
    categories: categories.rows.map((row) => row.category),
  };
}

export async function createBook(actorId, payload) {
  try {
    const { rows } = await query(
      `INSERT INTO library_books
         (title, author, isbn, category, publisher, published_year, total_copies, available_copies, shelf)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
       RETURNING *`,
      [
        payload.title,
        payload.author ?? null,
        payload.isbn ?? null,
        payload.category ?? 'General',
        payload.publisher ?? null,
        payload.publishedYear ?? null,
        payload.totalCopies ?? 1,
        payload.shelf ?? null,
      ],
    );
    await audit({
      actorUserId: actorId,
      action: 'library.book_created',
      entityType: 'library_book',
      entityId: rows[0].id,
      newValues: { title: rows[0].title },
    });
    return rows[0];
  } catch (error) {
    if (error.code === '23505') throw conflict('A book with this ISBN already exists.', 'BOOK_EXISTS');
    throw error;
  }
}

/**
 * Copies can be added or removed, but never below what is currently on loan — otherwise
 * `available_copies` would go negative and the register would lie.
 */
export async function updateBook(actorId, bookId, payload) {
  return withTransaction(async (client) => {
    const current = await client.query('SELECT * FROM library_books WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [
      bookId,
    ]);
    const book = current.rows[0];
    if (!book) throw notFound('Book not found.');

    const onLoan = (
      await client.query(`SELECT count(*)::int AS n FROM library_issues WHERE book_id = $1 AND status = 'issued'`, [
        bookId,
      ])
    ).rows[0].n;

    const totalCopies = payload.totalCopies ?? book.total_copies;
    if (totalCopies < onLoan) {
      throw conflict(
        `${onLoan} cop${onLoan === 1 ? 'y is' : 'ies are'} currently on loan — reduce after they are returned.`,
        'COPIES_IN_USE',
      );
    }
    const available = totalCopies - onLoan;

    try {
      const { rows } = await client.query(
        `UPDATE library_books
            SET title = $2, author = $3, isbn = $4, category = $5, publisher = $6,
                published_year = $7, total_copies = $8, available_copies = $9,
                shelf = $10, is_active = $11
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *`,
        [
          bookId,
          payload.title ?? book.title,
          payload.author === undefined ? book.author : payload.author,
          payload.isbn === undefined ? book.isbn : payload.isbn,
          payload.category ?? book.category,
          payload.publisher === undefined ? book.publisher : payload.publisher,
          payload.publishedYear === undefined ? book.published_year : payload.publishedYear,
          totalCopies,
          available,
          payload.shelf === undefined ? book.shelf : payload.shelf,
          payload.isActive === undefined ? book.is_active : payload.isActive,
        ],
      );
      await audit({
        client,
        actorUserId: actorId,
        action: 'library.book_updated',
        entityType: 'library_book',
        entityId: bookId,
        newValues: { title: rows[0].title },
      });
      return rows[0];
    } catch (error) {
      if (error.code === '23505') throw conflict('A book with this ISBN already exists.', 'BOOK_EXISTS');
      throw error;
    }
  });
}

export async function deleteBook(actorId, bookId) {
  const onLoan = await query(
    `SELECT count(*)::int AS n FROM library_issues WHERE book_id = $1 AND status = 'issued'`,
    [bookId],
  );
  if (onLoan.rows[0].n > 0) {
    throw conflict('Copies of this book are still on loan.', 'BOOK_IN_USE');
  }
  const { rows } = await query(
    'UPDATE library_books SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
    [bookId],
  );
  if (!rows[0]) throw notFound('Book not found.');
  await audit({
    actorUserId: actorId,
    action: 'library.book_removed',
    entityType: 'library_book',
    entityId: bookId,
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Issues and returns
// ---------------------------------------------------------------------------

export async function issueBook(actorId, payload) {
  return withTransaction(async (client) => {
    const book = await client.query(
      'SELECT id, title, available_copies FROM library_books WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [payload.bookId],
    );
    const row = book.rows[0];
    if (!row) throw notFound('Book not found.');
    if (row.available_copies < 1) throw conflict('Every copy of this book is already on loan.', 'NO_COPIES_LEFT');

    if (payload.studentId) {
      const student = await client.query('SELECT id FROM students WHERE id = $1 AND deleted_at IS NULL', [
        payload.studentId,
      ]);
      if (!student.rows[0]) throw notFound('Student not found.');
    } else {
      const teacher = await client.query('SELECT id FROM teachers WHERE id = $1 AND deleted_at IS NULL', [
        payload.teacherId,
      ]);
      if (!teacher.rows[0]) throw notFound('Teacher not found.');
    }

    let issue;
    try {
      issue = await client.query(
        `INSERT INTO library_issues (book_id, student_id, teacher_id, issued_on, due_on, notes, issued_by)
         VALUES ($1, $2, $3, ${today()}, ${today()} + $4::int, $5, $6)
         RETURNING *`,
        [
          payload.bookId,
          payload.studentId ?? null,
          payload.teacherId ?? null,
          payload.loanDays ?? 14,
          payload.notes ?? null,
          actorId,
        ],
      );
    } catch (error) {
      if (error.code === '23505') {
        throw conflict('This member already has a copy of this book.', 'ALREADY_ISSUED');
      }
      throw error;
    }

    await client.query('UPDATE library_books SET available_copies = available_copies - 1 WHERE id = $1', [
      payload.bookId,
    ]);
    await audit({
      client,
      actorUserId: actorId,
      action: 'library.book_issued',
      entityType: 'library_issue',
      entityId: issue.rows[0].id,
      newValues: { book: row.title },
    });
    return issue.rows[0];
  });
}

/**
 * Return: the fine is overdue days × the school's daily rate, frozen onto the row.
 * `finePaid` may be sent with the return (cash at the counter) and defaults to false.
 */
export async function returnBook(actorId, issueId, { finePaid = false, lost = false, notes } = {}) {
  return withTransaction(async (client) => {
    const current = await client.query('SELECT * FROM library_issues WHERE id = $1 FOR UPDATE', [issueId]);
    const issue = current.rows[0];
    if (!issue) throw notFound('Loan not found.');
    if (issue.status !== 'issued') throw conflict('This loan is already closed.', 'LOAN_CLOSED');

    const settings = await client.query('SELECT library_fine_per_day FROM school_settings WHERE id = 1');
    const rate = Number(settings.rows[0]?.library_fine_per_day ?? 2);

    const { rows } = await client.query(
      `UPDATE library_issues
          SET status = $2,
              returned_on = ${today()},
              fine_amount = CASE WHEN $2 = 'lost' THEN fine_amount
                                 ELSE greatest(0, (${today()} - due_on)) * $3::numeric END,
              fine_paid = $4,
              notes = coalesce($5, notes),
              returned_by = $6
        WHERE id = $1
        RETURNING *`,
      [issueId, lost ? 'lost' : 'returned', rate, finePaid, notes ?? null, actorId],
    );

    // A lost copy never comes back to the shelf.
    await client.query(
      `UPDATE library_books
          SET available_copies = available_copies + $2
        WHERE id = $1`,
      [issue.book_id, lost ? 0 : 1],
    );
    await audit({
      client,
      actorUserId: actorId,
      action: lost ? 'library.book_lost' : 'library.book_returned',
      entityType: 'library_issue',
      entityId: issueId,
      newValues: { fine: rows[0].fine_amount },
    });
    return rows[0];
  });
}

export async function listIssues(req) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const status = req.query.status || null;
  const overdueOnly = req.query.overdue === 'true';

  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`li.status = $${params.length}`);
  }
  if (overdueOnly) where.push(`li.status = 'issued' AND li.due_on < ${today()}`);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, total] = await Promise.all([
    query(
      `SELECT li.id, li.status, li.issued_on, li.due_on, li.returned_on, li.fine_amount, li.fine_paid,
              to_char(li.issued_on, 'DD-MM-YYYY') AS issued_label,
              to_char(li.due_on, 'DD-MM-YYYY') AS due_label,
              to_char(li.returned_on, 'DD-MM-YYYY') AS returned_label,
              greatest(0, (${today()} - li.due_on)) AS days_overdue,
              b.id AS book_id, b.title, b.author,
              coalesce(st.admission_id, t.employee_id) AS member_code,
              coalesce(st.first_name || ' ' || st.last_name, t.first_name || ' ' || t.last_name) AS member_name,
              CASE WHEN li.student_id IS NOT NULL THEN 'student' ELSE 'teacher' END AS member_type,
              c.name AS class_name, sec.name AS section_name
         FROM library_issues li
         JOIN library_books b ON b.id = li.book_id
         LEFT JOIN students st ON st.id = li.student_id
         LEFT JOIN teachers t ON t.id = li.teacher_id
         LEFT JOIN enrollments e ON e.student_id = st.id AND e.status = 'active'
         LEFT JOIN sections sec ON sec.id = e.section_id
         LEFT JOIN classes c ON c.id = sec.class_id
        ${filter}
        ORDER BY (li.status = 'issued') DESC, li.due_on, lower(b.title)
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    query(`SELECT count(*)::int AS total FROM library_issues li ${filter}`, params),
  ]);

  return { rows: rows.rows, meta: pagedMeta({ page, limit, total: total.rows[0].total }) };
}

/**
 * The caller's own loans. `studentId` may be passed by a parent for one of their children;
 * the scope is re-checked here, never trusted from the client.
 */
export async function myIssues(req) {
  const { role, id: userId } = req.user;
  let studentId = null;
  let teacherId = null;

  if (role === 'student') {
    const own = await query('SELECT id FROM students WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
    if (!own.rows[0]) return { rows: [] };
    studentId = own.rows[0].id;
  } else if (role === 'parent') {
    const requested = Number(req.query.childId) || null;
    const allowed = await query(
      `SELECT st.id FROM students st
         JOIN student_parents sp ON sp.student_id = st.id
         JOIN parents p ON p.id = sp.parent_id
        WHERE p.user_id = $1 AND st.deleted_at IS NULL ${requested ? 'AND st.id = $2' : ''}
        ORDER BY st.id`,
      requested ? [userId, requested] : [userId],
    );
    if (!allowed.rows[0]) throw forbidden('No child of yours matches that selection.', 'CHILD_NOT_FOUND');
    studentId = allowed.rows[0].id;
  } else if (role === 'teacher') {
    const own = await query('SELECT id FROM teachers WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
    if (!own.rows[0]) return { rows: [] };
    teacherId = own.rows[0].id;
  } else {
    throw forbidden('Use the library register for the whole school.', 'USE_REGISTER');
  }

  const params = [studentId, teacherId];
  const result = await query(
    `SELECT li.id, li.status, li.issued_on, li.due_on, li.returned_on, li.fine_amount, li.fine_paid,
            to_char(li.issued_on, 'DD-MM-YYYY') AS issued_label,
            to_char(li.due_on, 'DD-MM-YYYY') AS due_label,
            greatest(0, (${today()} - li.due_on)) AS days_overdue,
            b.title, b.author, b.category
       FROM library_issues li
       JOIN library_books b ON b.id = li.book_id
      WHERE ($1::int IS NOT NULL AND li.student_id = $1) OR ($2::int IS NOT NULL AND li.teacher_id = $2)
      ORDER BY (li.status = 'issued') DESC, li.due_on DESC`,
    params,
  );
  return { rows: result.rows };
}

