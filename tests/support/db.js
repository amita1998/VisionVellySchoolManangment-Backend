import './testEnv.js';
import { pool } from '../../src/config/db.js';

/**
 * Tables that hold business/test data. `roles` and `schema_migrations` are kept:
 * roles are reference data inserted by the migration itself.
 */
const TRUNCATE = [
  'audit_logs',
  'chat_reads',
  'chat_messages',
  'chat_threads',
  'syllabus_portions',
  'syllabus_chapters',
  'ptm_bookings',
  'ptm_slots',
  'leave_requests',
  'library_issues',
  'library_books',
  'refresh_tokens',
  'notifications',
  'announcement_reads',
  'announcement_attachments',
  'announcement_classes',
  'announcements',
  'event_classes',
  'events',
  'event_categories',
  'assignment_attachments',
  'assignments',
  'fee_receipts',
  'fee_payments',
  'student_fees',
  'fee_installments',
  'fee_structures',
  'fee_categories',
  'marks',
  'exam_schedules',
  'examinations',
  'grades',
  'attendance_corrections',
  'attendance',
  'timetable_slots',
  'class_teachers',
  'teacher_subjects',
  'enrollments',
  'student_status_history',
  'student_parents',
  'documents',
  'students',
  'parents',
  'teachers',
  'users',
  'sections',
  'classes',
  'subjects',
  'periods',
  'academic_years',
  'school_settings',
];

export async function resetDatabase() {
  await pool.query(`TRUNCATE ${TRUNCATE.join(', ')} RESTART IDENTITY CASCADE`);
  await pool.query("ALTER SEQUENCE admission_id_seq RESTART WITH 1");
  await pool.query("ALTER SEQUENCE employee_id_seq RESTART WITH 1");
  await pool.query("ALTER SEQUENCE receipt_no_seq RESTART WITH 1");
  // The singleton settings row is reference data: recreate it so tests exercise the
  // same defaults a fresh install has (fee visibility off, attendance closes at 23:59).
  await pool.query(
    `INSERT INTO school_settings (id, school_name, tagline, timezone, currency)
     VALUES (1, 'Vision Valley School', 'Nursery to Class 12', 'Asia/Kolkata', 'INR')
     ON CONFLICT (id) DO NOTHING`,
  );
}

export { pool };
