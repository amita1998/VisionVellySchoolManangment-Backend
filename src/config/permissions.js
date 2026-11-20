/**
 * Role permission matrix — the single source of truth for authorization.
 * Mirrors the BRD 3.5 table and the build prompt's permission table.
 *
 * Rules of use:
 *  - Every route that returns school data declares the permission it needs.
 *  - The check is on the SERVER. The frontend only uses this list to hide links.
 *  - Teacher scopes ("assigned classes/subjects") are still enforced per record in
 *    the service layer; a permission only opens the endpoint, never a specific row.
 */
export const PERMISSIONS = {
  // students
  STUDENT_VIEW_ALL: 'student.view.all',
  STUDENT_VIEW_ASSIGNED: 'student.view.assigned',
  STUDENT_VIEW_OWN: 'student.view.own',
  STUDENT_VIEW_CHILDREN: 'student.view.children',
  STUDENT_MANAGE: 'student.manage',

  // teachers
  TEACHER_VIEW_ALL: 'teacher.view.all',
  TEACHER_VIEW_OWN: 'teacher.view.own',
  TEACHER_MANAGE: 'teacher.manage',

  // academic structure (classes, sections, subjects, academic years)
  ACADEMIC_VIEW: 'academic.view',
  ACADEMIC_MANAGE: 'academic.manage',

  // attendance
  ATTENDANCE_MARK: 'attendance.mark',
  ATTENDANCE_VIEW_ALL: 'attendance.view.all',
  ATTENDANCE_VIEW_ASSIGNED: 'attendance.view.assigned',
  ATTENDANCE_VIEW_OWN: 'attendance.view.own',
  ATTENDANCE_VIEW_CHILDREN: 'attendance.view.children',
  ATTENDANCE_CORRECTION_REQUEST: 'attendance.correction.request',
  ATTENDANCE_CORRECTION_REVIEW: 'attendance.correction.review',

  // library
  LIBRARY_VIEW: 'library.view',
  LIBRARY_MANAGE: 'library.manage',
  LIBRARY_VIEW_OWN: 'library.view.own',
  LIBRARY_VIEW_CHILDREN: 'library.view.children',

  // examinations and results
  EXAM_VIEW: 'exam.view',
  EXAM_MANAGE: 'exam.manage',
  MARKS_ENTER: 'marks.enter',
  MARKS_OVERRIDE: 'marks.override',
  RESULT_VIEW_ALL: 'result.view.all',
  RESULT_VIEW_ASSIGNED: 'result.view.assigned',
  RESULT_VIEW_OWN: 'result.view.own',
  RESULT_VIEW_CHILDREN: 'result.view.children',
  RESULT_PUBLISH: 'result.publish',

  // fees
  FEE_MANAGE: 'fee.manage',
  FEE_VIEW_ALL: 'fee.view.all',
  FEE_VIEW_OWN: 'fee.view.own',
  FEE_VIEW_CHILDREN: 'fee.view.children',

  // communication
  EVENT_VIEW: 'event.view',
  EVENT_MANAGE: 'event.manage',
  ANNOUNCEMENT_VIEW: 'announcement.view',
  ANNOUNCEMENT_MANAGE: 'announcement.manage',
  ASSIGNMENT_VIEW: 'assignment.view',
  ASSIGNMENT_MANAGE: 'assignment.manage',

  // timetable and reports
  TIMETABLE_VIEW: 'timetable.view',
  TIMETABLE_MANAGE: 'timetable.manage',
  REPORT_VIEW_ALL: 'report.view.all',
  REPORT_VIEW_CLASS: 'report.view.class',

  // administration
  USER_MANAGE: 'user.manage',
  SETTINGS_MANAGE: 'settings.manage',
  AUDIT_VIEW: 'audit.view',
};

const P = PERMISSIONS;

/** '*' means every permission. */
export const ROLE_PERMISSIONS = {
  admin: ['*'],

  teacher: [
    P.STUDENT_VIEW_ASSIGNED,
    P.TEACHER_VIEW_OWN,
    P.ACADEMIC_VIEW,
    P.LIBRARY_VIEW,
    P.LIBRARY_VIEW_OWN,
    P.ATTENDANCE_MARK,
    P.ATTENDANCE_VIEW_ASSIGNED,
    P.ATTENDANCE_CORRECTION_REQUEST,
    P.EXAM_VIEW,
    P.MARKS_ENTER,
    P.RESULT_VIEW_ASSIGNED,
    P.EVENT_VIEW,
    P.ANNOUNCEMENT_VIEW,
    P.ASSIGNMENT_VIEW,
    P.ASSIGNMENT_MANAGE,
    P.TIMETABLE_VIEW,
    P.REPORT_VIEW_CLASS,
  ],

  student: [
    P.STUDENT_VIEW_OWN,
    P.ACADEMIC_VIEW,
    P.LIBRARY_VIEW,
    P.LIBRARY_VIEW_OWN,
    P.ATTENDANCE_VIEW_OWN,
    P.EXAM_VIEW,
    P.RESULT_VIEW_OWN,
    P.FEE_VIEW_OWN,
    P.EVENT_VIEW,
    P.ANNOUNCEMENT_VIEW,
    P.ASSIGNMENT_VIEW,
    P.TIMETABLE_VIEW,
  ],

  parent: [
    P.STUDENT_VIEW_CHILDREN,
    P.ACADEMIC_VIEW,
    P.LIBRARY_VIEW,
    P.LIBRARY_VIEW_CHILDREN,
    P.ATTENDANCE_VIEW_CHILDREN,
    P.EXAM_VIEW,
    P.RESULT_VIEW_CHILDREN,
    P.FEE_VIEW_CHILDREN,
    P.EVENT_VIEW,
    P.ANNOUNCEMENT_VIEW,
    P.ASSIGNMENT_VIEW,
    P.TIMETABLE_VIEW,
  ],
};

/** Human labels for the read-only permission screen in Settings. */
export const PERMISSION_LABELS = {
  [P.STUDENT_VIEW_ALL]: 'View all student records',
  [P.STUDENT_VIEW_ASSIGNED]: 'View students of assigned classes',
  [P.STUDENT_VIEW_OWN]: 'View own student record',
  [P.STUDENT_VIEW_CHILDREN]: "View own children's records",
  [P.STUDENT_MANAGE]: 'Admit, edit and change student status',
  [P.TEACHER_VIEW_ALL]: 'View all teacher records',
  [P.TEACHER_VIEW_OWN]: 'View own teacher record',
  [P.TEACHER_MANAGE]: 'Add, edit and assign teachers',
  [P.ACADEMIC_VIEW]: 'View classes, sections and subjects',
  [P.ACADEMIC_MANAGE]: 'Manage classes, sections, subjects and academic years',
  [P.ATTENDANCE_MARK]: 'Mark daily attendance (class teacher only)',
  [P.ATTENDANCE_VIEW_ALL]: 'View school-wide attendance',
  [P.ATTENDANCE_VIEW_ASSIGNED]: 'View attendance of assigned classes',
  [P.ATTENDANCE_VIEW_OWN]: 'View own attendance',
  [P.ATTENDANCE_VIEW_CHILDREN]: "View children's attendance",
  [P.ATTENDANCE_CORRECTION_REQUEST]: 'Request an attendance correction',
  [P.ATTENDANCE_CORRECTION_REVIEW]: 'Approve or reject attendance corrections',
  [P.EXAM_VIEW]: 'View examinations and schedules',
  [P.EXAM_MANAGE]: 'Create examinations and schedules',
  [P.MARKS_ENTER]: 'Enter marks for assigned subjects',
  [P.MARKS_OVERRIDE]: 'Override submitted marks (audit logged)',
  [P.RESULT_VIEW_ALL]: 'View all results and report cards',
  [P.RESULT_VIEW_ASSIGNED]: 'View results of assigned subjects',
  [P.RESULT_VIEW_OWN]: 'View own results after publishing',
  [P.RESULT_VIEW_CHILDREN]: "View children's results after publishing",
  [P.RESULT_PUBLISH]: 'Publish or unpublish examination results',
  [P.FEE_MANAGE]: 'Manage fee structures, payments and receipts',
  [P.FEE_VIEW_ALL]: 'View all fee records',
  [P.FEE_VIEW_OWN]: 'View own fees (if enabled by Admin)',
  [P.FEE_VIEW_CHILDREN]: "View children's fees and receipts",
  [P.EVENT_VIEW]: 'View events and calendar',
  [P.EVENT_MANAGE]: 'Create and manage events',
  [P.ANNOUNCEMENT_VIEW]: 'View announcements',
  [P.ANNOUNCEMENT_MANAGE]: 'Create and publish announcements',
  [P.ASSIGNMENT_VIEW]: 'View assignments',
  [P.ASSIGNMENT_MANAGE]: 'Create and manage own assignments',
  [P.TIMETABLE_VIEW]: 'View timetable',
  [P.TIMETABLE_MANAGE]: 'Build class timetables',
  [P.REPORT_VIEW_ALL]: 'View all reports and exports',
  [P.REPORT_VIEW_CLASS]: 'View class-level reports',
  [P.USER_MANAGE]: 'Manage user accounts',
  [P.SETTINGS_MANAGE]: 'Manage school settings',
  [P.AUDIT_VIEW]: 'View the audit log',
  [P.LIBRARY_VIEW]: 'View the library catalogue',
  [P.LIBRARY_MANAGE]: 'Manage books, issues and returns',
  [P.LIBRARY_VIEW_OWN]: 'View own borrowed books',
  [P.LIBRARY_VIEW_CHILDREN]: "View a child's borrowed books",
};

export function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] ? [...ROLE_PERMISSIONS[role]] : [];
}

export function roleHasPermission(role, permission) {
  const list = ROLE_PERMISSIONS[role];
  if (!list) return false;
  return list.includes('*') || list.includes(permission);
}

export default { PERMISSIONS, ROLE_PERMISSIONS, PERMISSION_LABELS, permissionsFor, roleHasPermission };
