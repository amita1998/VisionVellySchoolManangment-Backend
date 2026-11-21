import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Uploads are restricted to PDF/JPG/PNG up to MAX_UPLOAD_MB (5 MB by default).
 * The original filename is never trusted: a random prefix is added and every
 * character outside [a-zA-Z0-9._-] is replaced.
 */
export const ALLOWED_MIME = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
]);

const MAX_BYTES = () => config.uploads.maxMb * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES(), files: 6 },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return callback(
        new AppError(400, 'UNSUPPORTED_FILE_TYPE', 'Only PDF, JPG and PNG files are allowed.'),
      );
    }
    return callback(null, true);
  },
});

/** Magic-number check — the browser's Content-Type is attacker-controlled. */
const SIGNATURES = [
  { mime: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
  { mime: 'image/png', ext: '.png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

export function sniffFileType(buffer) {
  return SIGNATURES.find((signature) => buffer && buffer.length >= 4 && signature.test(buffer)) ?? null;
}

/** Throws the same 400 the mimetype filter uses when the bytes disagree with the declared type. */
export function assertRealFileType(file) {
  const sniffed = sniffFileType(file.buffer);
  if (!sniffed || sniffed.mime !== file.mimetype) {
    throw new AppError(
      400,
      'UNSUPPORTED_FILE_TYPE',
      'That file is not a real PDF, JPG or PNG — its contents do not match its name.',
    );
  }
  return sniffed;
}

export function safeFileName(originalName) {
  const base = path
    .basename(originalName || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-80);
  return `${crypto.randomUUID()}-${base || 'file'}`;
}

export function absolutePath(relativePath) {
  return path.join(config.uploads.dir, relativePath);
}

/**
 * Writes a buffer under UPLOAD_DIR/<folder>/ and returns the metadata stored in
 * `documents` (path is relative so the storage root can move).
 */
export async function saveUpload({ file, folder }) {
  const sniffed = assertRealFileType(file);
  const directory = path.join(config.uploads.dir, folder);
  try {
    await fs.mkdir(directory, { recursive: true });
    const fileName = safeFileName(file.originalname).replace(/\.[^.]+$/, sniffed.ext);
    const relative = path.posix.join(folder, fileName);
    await fs.writeFile(path.join(directory, fileName), file.buffer, { mode: 0o640 });
    return {
      fileName: (file.originalname || 'file').slice(0, 200),
      filePath: relative,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    };
  } catch (error) {
    /**
     * Serverless platforms mount the bundle read-only — and often without the parent directory
     * at all, so `mkdir` fails with ENOENT rather than EROFS/EACCES. Say so plainly instead of
     * leaking a 500 from a mid-transaction filesystem call.
     */
    if (['EROFS', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) {
      throw new AppError(
        503,
        'UPLOADS_UNAVAILABLE',
        'Document storage is not configured on this deployment, so files cannot be attached here. Save the record without documents, or upload the file from the desktop install (UPLOAD_DIR is not writable).',
      );
    }
    throw error;
  }
}

export async function removeUploads(relativePaths = []) {
  await Promise.all(
    relativePaths.map((relative) => fs.unlink(absolutePath(relative)).catch(() => {})),
  );
}

export function ensurePdfOrImage(fileName) {
  const extension = path.extname(fileName || '').toLowerCase();
  if (!['.pdf', '.jpg', '.jpeg', '.png'].includes(extension)) {
    throw new AppError(400, 'UNSUPPORTED_FILE_TYPE', 'Only PDF, JPG and PNG files are allowed.');
  }
}

/** Guard for the multer error shape so callers get the standard envelope. */
export function mapUploadError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return new AppError(400, 'FILE_TOO_LARGE', `Each file must be at most ${config.uploads.maxMb} MB.`);
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return new AppError(400, 'TOO_MANY_FILES', 'You can upload at most 6 files at a time.');
    }
    return new AppError(400, 'UPLOAD_FAILED', error.message);
  }
  return error;
}
