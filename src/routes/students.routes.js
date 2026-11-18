import { Router } from 'express';
import * as students from '../controllers/studentController.js';
import * as documents from '../controllers/studentController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS } from '../config/permissions.js';
import { mapUploadError, upload } from '../utils/uploads.js';

const router = Router();

// Multer errors must land in the standard error envelope instead of crashing.
function files(field = 'documents', max = 5) {
  const middleware = upload.array(field, max);
  return (req, res, next) => middleware(req, res, (error) => next(error ? mapUploadError(error) : undefined));
}

router.use(authenticate());

router.get('/', requirePermission(PERMISSIONS.STUDENT_VIEW_ALL, PERMISSIONS.STUDENT_VIEW_ASSIGNED), students.list);
router.post('/', requirePermission(PERMISSIONS.STUDENT_MANAGE), files(), students.create);

// Literal paths before parameterised ones.
router.get('/documents/:docId', documents.downloadDocument);
router.delete('/documents/:docId', requirePermission(PERMISSIONS.STUDENT_MANAGE), students.deleteDocument);

router.get('/:id', students.detail);
router.put('/:id', requirePermission(PERMISSIONS.STUDENT_MANAGE), students.update);
router.post('/:id/status', requirePermission(PERMISSIONS.STUDENT_MANAGE), students.changeStatus);
router.post('/:id/reset-password', requirePermission(PERMISSIONS.STUDENT_MANAGE), students.resetPassword);
router.post('/:id/guardians/:parentId/reset-password', requirePermission(PERMISSIONS.STUDENT_MANAGE), students.resetGuardianPassword);
router.post('/:id/documents', requirePermission(PERMISSIONS.STUDENT_MANAGE), files(), students.addDocuments);
router.delete('/:id', requirePermission(PERMISSIONS.STUDENT_MANAGE), students.remove);

export default router;
