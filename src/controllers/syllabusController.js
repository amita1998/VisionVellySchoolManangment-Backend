import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as syllabus from '../services/syllabusService.js';
import { chapterSchema, chapterUpdateSchema, portionSchema } from '../validators/syllabusValidators.js';

const filters = (req) => ({
  classId: req.query.classId ? Number(req.query.classId) : null,
  subjectId: req.query.subjectId ? Number(req.query.subjectId) : null,
  childId: req.query.childId ? Number(req.query.childId) : null,
  examId: req.query.examId ? Number(req.query.examId) : null,
});

export const pairs = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await syllabus.teachingPairs(req.user) });
});

export const chapters = asyncHandler(async (req, res) => {
  const { classId, subjectId, childId } = filters(req);
  res.json({ success: true, data: await syllabus.listChapters(req.user, { classId, subjectId, childId }) });
});

export const createChapter = asyncHandler(async (req, res) => {
  const payload = parseBody(chapterSchema, req.body);
  res.status(201).json({ success: true, data: { chapter: await syllabus.createChapter(req.user, payload) } });
});

export const updateChapter = asyncHandler(async (req, res) => {
  const payload = parseBody(chapterUpdateSchema, req.body);
  res.json({ success: true, data: { chapter: await syllabus.updateChapter(req.user, Number(req.params.id), payload) } });
});

export const deleteChapter = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await syllabus.deleteChapter(req.user, Number(req.params.id)) });
});

export const portions = asyncHandler(async (req, res) => {
  const { examId, childId } = filters(req);
  res.json({ success: true, data: await syllabus.listPortions(req.user, { examId, childId }) });
});

export const setPortion = asyncHandler(async (req, res) => {
  const payload = parseBody(portionSchema, req.body);
  res.json({
    success: true,
    data: await syllabus.setPortion(req.user, Number(req.params.scheduleId), payload.chapterIds),
  });
});
