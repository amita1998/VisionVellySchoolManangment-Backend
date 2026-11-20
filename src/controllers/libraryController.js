import { asyncHandler } from '../utils/errors.js';
import { parseBody } from '../utils/request.js';
import * as library from '../services/libraryService.js';
import { bookSchema, bookUpdateSchema, issueSchema, returnSchema } from '../validators/libraryValidators.js';

// catalogue
export const books = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await library.listBooks(req) });
});

export const createBook = asyncHandler(async (req, res) => {
  const payload = parseBody(bookSchema, req.body);
  res.status(201).json({ success: true, data: { book: await library.createBook(req.user.id, payload) } });
});

export const updateBook = asyncHandler(async (req, res) => {
  const payload = parseBody(bookUpdateSchema, req.body);
  res.json({
    success: true,
    data: { book: await library.updateBook(req.user.id, Number(req.params.id), payload) },
  });
});

export const deleteBook = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await library.deleteBook(req.user.id, Number(req.params.id)) });
});

// circulation
export const issues = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await library.listIssues(req) });
});

export const issue = asyncHandler(async (req, res) => {
  const payload = parseBody(issueSchema, req.body);
  res.status(201).json({ success: true, data: { issue: await library.issueBook(req.user.id, payload) } });
});

export const returnIssue = asyncHandler(async (req, res) => {
  const body = parseBody(returnSchema, req.body) || {};
  res.json({
    success: true,
    data: { issue: await library.returnBook(req.user.id, Number(req.params.id), body) },
  });
});

/** The caller's own loans (student/teacher), or one child's loans (parent). */
export const mine = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await library.myIssues(req) });
});
