import PDFDocument from 'pdfkit';
import { query } from '../config/db.js';
import { forbidden, notFound } from '../utils/errors.js';

/**
 * Identity cards, generated on the fly.
 *
 * Why the server and not the browser: the office prints these at the counter and also mails the
 * PDF, so a real file is the deliverable. Nothing is written to disk — the document is streamed
 * back — which keeps it working on a read-only serverless filesystem (the uploads problem simply
 * does not apply here).
 *
 * Size: CR80 at 72 dpi is 242 x 153 pt (85.6 x 54 mm), the standard ID-card blank.
 */

const CARD = { width: 242, height: 153 };
const BRAND = '#5f6db0';
const INK = '#1f2430';
const MUTED = '#6b7280';

async function school() {
  const { rows } = await query(
    `SELECT school_name, tagline, address, phone, email, website
       FROM school_settings WHERE id = 1`,
  );
  return rows[0] || { school_name: 'School' };
}

const initialOf = (name) =>
  (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

const fmtDate = (value) => {
  if (!value) return '—';
  const [year, month, day] = String(value).split('-');
  return day && month && year ? `${day}-${month}-${year}` : String(value);
};

function render({ school: s, heading, name, code, lines, validTill, note }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [CARD.width, CARD.height], margin: 0 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // header band
    doc.rect(0, 0, CARD.width, 30).fill(BRAND);
    doc.fillColor('#ffffff').fontSize(10.5).text(s.school_name || 'School', 10, 7, { width: CARD.width - 20 });
    doc
      .fontSize(6.5)
      .fillColor('#e6e9f6')
      .text(s.tagline || s.address || '', 10, 19, { width: CARD.width - 20, lineBreak: false });

    // photo placeholder (initials), keeps the card honest without storing images
    doc.roundedRect(10, 40, 42, 52, 4).lineWidth(0.8).strokeColor('#c9cfdd').stroke();
    doc.fillColor(BRAND).fontSize(18).text(initialOf(name), 10, 57, { width: 42, align: 'center' });

    const left = 60;
    const width = CARD.width - left - 10;
    doc.fillColor(MUTED).fontSize(6.5).text(heading.toUpperCase(), left, 40, { width });
    doc.fillColor(INK).fontSize(11).text(name, left, 50, { width });
    doc.fillColor(MUTED).fontSize(7).text(code, left, 64, { width });

    let y = 76;
    for (const [label, value] of lines) {
      if (y > 126) break;
      doc.fillColor(MUTED).fontSize(6.2).text(label, left, y, { width: 46 });
      doc.fillColor(INK).fontSize(7).text(String(value ?? '—'), left + 46, y, { width: width - 46 });
      y += 9.5;
    }

    // footer
    doc.moveTo(0, 132).lineTo(CARD.width, 132).lineWidth(0.5).strokeColor('#e2e6f0').stroke();
    doc.fillColor(MUTED).fontSize(5.8).text(validTill, 10, 137, { width: 120 });
    doc.fillColor(MUTED).fontSize(5.8).text(note, CARD.width - 130, 137, { width: 120, align: 'right' });

    doc.end();
  });
}

/** A student may fetch their own card; a parent one of their children's. */
async function assertCanPrintStudent(actor, studentId) {
  if (actor.role === 'admin') return;
  if (actor.role === 'student') {
    const own = await query('SELECT 1 FROM students WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [
      studentId,
      actor.id,
    ]);
    if (own.rows[0]) return;
  }
  if (actor.role === 'parent') {
    const child = await query(
      `SELECT 1 FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
        WHERE sp.student_id = $1 AND p.user_id = $2`,
      [studentId, actor.id],
    );
    if (child.rows[0]) return;
  }
  if (actor.role === 'teacher') {
    const teaches = await query(
      `SELECT 1 FROM enrollments e
         JOIN class_teachers ct ON ct.section_id = e.section_id AND ct.academic_year_id = e.academic_year_id
         JOIN teachers t ON t.id = ct.teacher_id
        WHERE e.student_id = $1 AND t.user_id = $2
        UNION
       SELECT 1 FROM enrollments e
         JOIN teacher_subjects ts ON ts.class_id = e.class_id AND ts.academic_year_id = e.academic_year_id
         JOIN teachers t ON t.id = ts.teacher_id
        WHERE e.student_id = $1 AND t.user_id = $2`,
      [studentId, actor.id],
    );
    if (teaches.rows[0]) return;
  }
  throw forbidden('You cannot print this identity card.', 'ID_CARD_FORBIDDEN');
}

export async function studentIdCard(actor, studentId) {
  await assertCanPrintStudent(actor, studentId);
  const { rows } = await query(
    `SELECT st.id, st.admission_id, st.first_name, st.last_name, st.date_of_birth, st.blood_group,
            st.gender, st.status,
            c.name AS class_name, sec.name AS section_name,
            (SELECT p.mobile FROM student_parents sp JOIN parents p ON p.id = sp.parent_id
              WHERE sp.student_id = st.id ORDER BY sp.is_primary DESC, p.id LIMIT 1) AS guardian_mobile,
            (SELECT ay.end_date FROM academic_years ay WHERE ay.is_current AND ay.deleted_at IS NULL LIMIT 1) AS year_end
       FROM students st
       LEFT JOIN enrollments e ON e.student_id = st.id
         AND e.status = 'active'
         AND e.academic_year_id = (SELECT id FROM academic_years WHERE is_current AND deleted_at IS NULL LIMIT 1)
       LEFT JOIN sections sec ON sec.id = e.section_id
       LEFT JOIN classes c ON c.id = sec.class_id
      WHERE st.id = $1 AND st.deleted_at IS NULL`,
    [studentId],
  );
  const student = rows[0];
  if (!student) throw notFound('Student not found.');
  if (['withdrawn', 'transferred', 'graduated'].includes(student.status)) {
    throw conflict('This student has left the school — the identity card is not valid.', 'ID_CARD_NOT_VALID');
  }
  if (!student.class_name) {
    throw conflict('This student has no active class this year.', 'ID_CARD_NO_ENROLLMENT');
  }

  const s = await school();
  const name = `${student.first_name} ${student.last_name}`.trim();
  const buffer = await render({
    school: s,
    heading: 'Student identity card',
    name,
    code: `Admission no. ${student.admission_id}`,
    lines: [
      ['Class', `${student.class_name || '—'}${student.section_name ? ` · ${student.section_name}` : ''}`],
      ['Date of birth', fmtDate(student.date_of_birth)],
      ['Blood group', student.blood_group || '—'],
      ['Guardian', student.guardian_mobile || '—'],
    ],
    validTill: `Valid till ${fmtDate(student.year_end)}`,
    note: s.phone ? `Office ${s.phone}` : 'Property of the school',
  });
  return { buffer, filename: `id-card-${student.admission_id}.pdf` };
}

export async function teacherIdCard(actor, teacherId) {
  if (actor.role !== 'admin') {
    const own = await query('SELECT 1 FROM teachers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [
      teacherId,
      actor.id,
    ]);
    if (!own.rows[0]) throw forbidden('You cannot print this identity card.', 'ID_CARD_FORBIDDEN');
  }
  const { rows } = await query(
    `SELECT t.id, t.employee_id, t.first_name, t.last_name, t.qualification, t.mobile, t.joining_date,
            (SELECT count(*)::int FROM class_teachers ct WHERE ct.teacher_id = t.id) AS class_count
       FROM teachers t WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [teacherId],
  );
  const teacher = rows[0];
  if (!teacher) throw notFound('Teacher not found.');

  const s = await school();
  const name = `${teacher.first_name} ${teacher.last_name}`.trim();
  const buffer = await render({
    school: s,
    heading: 'Staff identity card',
    name,
    code: `Employee no. ${teacher.employee_id}`,
    lines: [
      ['Qualification', teacher.qualification || '—'],
      ['Joined', fmtDate(teacher.joining_date)],
      ['Mobile', teacher.mobile || '—'],
      ['Class teacher', `${teacher.class_count} section(s)`],
    ],
    validTill: 'Valid while in service',
    note: s.phone ? `Office ${s.phone}` : 'Property of the school',
  });
  return { buffer, filename: `id-card-${teacher.employee_id}.pdf` };
}
