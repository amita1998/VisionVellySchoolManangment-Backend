import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as academics from '../services/academicsService.js';
import {
  academicYearSchema,
  classSchema,
  classSubjectsSchema,
  sectionSchema,
  subjectSchema,
} from '../validators/peopleValidators.js';

export const options = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await academics.options() });
});

export const settings = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await academics.schoolProfile() });
});

// classes
export const classes = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { classes: await academics.listClasses() } });
});

export const createClass = asyncHandler(async (req, res) => {
  const payload = parseBody(classSchema, req.body);
  res.status(201).json({ success: true, data: await academics.createClass(payload) });
});

export const updateClass = asyncHandler(async (req, res) => {
  const payload = parseBody(classSchema, req.body);
  res.json({ success: true, data: await academics.updateClass(Number(req.params.id), payload) });
});

export const deleteClass = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await academics.deleteClass(Number(req.params.id)) });
});

// sections
export const createSection = asyncHandler(async (req, res) => {
  const payload = parseBody(sectionSchema, req.body);
  res.status(201).json({
    success: true,
    data: await academics.createSection(Number(req.params.classId), payload),
  });
});

export const updateSection = asyncHandler(async (req, res) => {
  const payload = parseBody(sectionSchema, req.body);
  res.json({ success: true, data: await academics.updateSection(Number(req.params.id), payload) });
});

export const deleteSection = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await academics.deleteSection(Number(req.params.id)) });
});

// subjects
export const subjects = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { subjects: await academics.listSubjects() } });
});

export const createSubject = asyncHandler(async (req, res) => {
  const payload = parseBody(subjectSchema, req.body);
  res.status(201).json({ success: true, data: await academics.createSubject(payload) });
});

export const updateSubject = asyncHandler(async (req, res) => {
  const payload = parseBody(subjectSchema, req.body);
  res.json({ success: true, data: await academics.updateSubject(Number(req.params.id), payload) });
});

export const deleteSubject = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await academics.deleteSubject(Number(req.params.id)) });
});

export const classSubjects = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { subjects: await academics.classSubjects(Number(req.params.id)) } });
});

export const setClassSubjects = asyncHandler(async (req, res) => {
  const payload = parseBody(classSubjectsSchema, req.body);
  res.json({
    success: true,
    data: { subjects: await academics.setClassSubjects(Number(req.params.id), payload.subjectIds) },
  });
});

// academic years
export const years = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { years: await academics.listAcademicYears() } });
});

export const createYear = asyncHandler(async (req, res) => {
  const payload = parseBody(academicYearSchema, req.body);
  res.status(201).json({ success: true, data: await academics.createAcademicYear(payload) });
});

export const setCurrentYear = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await academics.setCurrentYear(Number(req.params.id), req.user.id),
  });
});
