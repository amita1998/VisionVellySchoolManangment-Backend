import { asyncHandler, badRequest, notFound } from '../utils/errors.js';
import { parseBody, parsePagination } from '../utils/request.js';
import * as adminService from '../services/adminService.js';
import { settingsSchema } from '../validators/adminValidators.js';
import { config } from '../config/env.js';

const meta = (req) => [req.user, req.ip, req.headers['user-agent']];

// A CSV named with the UTC date says "yesterday" until 05:30 IST; stamp it in school time.
const dateStamp = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const localDateStamp = () => dateStamp.format(new Date());

export const getSettings = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await adminService.getSettings() });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const payload = parseBody(settingsSchema, req.body);
  res.json({ success: true, data: await adminService.updateSettings(payload, ...meta(req)) });
});

export const auditLogs = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req);
  const result = await adminService.listAudit({
    action: req.query.action || null,
    entityType: req.query.entityType || null,
    from: req.query.from || null,
    to: req.query.to || null,
    actor: req.query.actor || null,
    page,
    limit,
    offset,
  });
  res.json({ success: true, data: result });
});

const PARAM_KEYS = {
  students: ['classId', 'status'],
  attendance: ['from', 'to', 'classId'],
  results: ['examId'],
  fees: ['from', 'to'],
};
const TEXT_PARAMS = new Set(['from', 'to', 'status']);

export const report = (name) =>
  asyncHandler(async (req, res) => {
    const params = {};
    for (const key of PARAM_KEYS[name] || []) {
      const value = req.query[key];
      if (value === undefined || value === '') continue;
      if (TEXT_PARAMS.has(key)) {
        params[key] = value;
        continue;
      }
      // Ids arrive as strings; reject a non-numeric one here so the SQL never sees NaN.
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        throw badRequest('That filter is not valid.', { [key]: `Invalid ${key}` });
      }
      params[key] = numeric;
    }
    const data = await adminService.buildReport(name, params, req.user);
    if (!data) throw notFound('Unknown report.');

    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vvs-${name}-${localDateStamp()}.csv"`,
      );
      res.send(adminService.toCsv(data));
      return;
    }

    res.json({
      success: true,
      data: {
        columns: data.columns.map(([key, label]) => ({ key, label })),
        rows: data.rows,
        total: data.rows.length,
      },
    });
  });
