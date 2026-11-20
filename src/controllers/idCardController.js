import { asyncHandler } from '../utils/errors.js';
import { studentIdCard, teacherIdCard } from '../services/idCardService.js';

/** Streams the PDF straight to the client: no disk, no object storage needed. */
function sendPdf(res, { buffer, filename }) {
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="${filename}"`);
  res.setHeader('cache-control', 'private, max-age=0, no-store');
  res.send(buffer);
}

export const student = asyncHandler(async (req, res) => {
  sendPdf(res, await studentIdCard(req.user, Number(req.params.id)));
});

export const teacher = asyncHandler(async (req, res) => {
  sendPdf(res, await teacherIdCard(req.user, Number(req.params.id)));
});
