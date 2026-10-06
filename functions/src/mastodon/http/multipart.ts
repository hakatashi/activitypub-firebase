import Busboy from 'busboy';
import type express from 'express';
import { BadRequestError, UnprocessableError } from './errors.js';

export interface MultipartFile {
	fieldname: string;
	filename: string;
	encoding: string;
	mimeType: string;
	buffer: Buffer;
}

export interface ParsedMultipart {
	files: Record<string, MultipartFile>;
	fields: Record<string, string>;
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB (→ ADR-0091)

export const parseMultipart = (req: express.Request): Promise<ParsedMultipart> => {
	return new Promise((resolve, reject) => {
		const contentType = req.headers['content-type'];
		if (!contentType || !contentType.toLowerCase().includes('multipart/form-data')) {
			reject(new BadRequestError('Content-Type must be multipart/form-data'));
			return;
		}

		let busboy: Busboy.Busboy;
		try {
			busboy = Busboy({
				headers: req.headers,
				limits: {
					fileSize: MAX_FILE_SIZE,
					files: 5,
				},
			});
		} catch (error) {
			reject(new BadRequestError(error instanceof Error ? error.message : String(error)));
			return;
		}

		const files: Record<string, MultipartFile> = {};
		const fields: Record<string, string> = {};
		let fileLimitHit = false;

		busboy.on('file', (fieldname, stream, info) => {
			const chunks: Buffer[] = [];
			stream.on('data', (data: Buffer) => chunks.push(data));
			stream.on('limit', () => {
				fileLimitHit = true;
			});
			stream.on('end', () => {
				if (!fileLimitHit) {
					files[fieldname] = {
						fieldname,
						filename: info.filename,
						encoding: info.encoding,
						mimeType: info.mimeType,
						buffer: Buffer.concat(chunks),
					};
				}
			});
		});

		busboy.on('field', (name, val) => {
			fields[name] = val;
		});

		busboy.on('finish', () => {
			if (fileLimitHit) {
				reject(new UnprocessableError('Validation failed: File is too large'));
				return;
			}
			resolve({ files, fields });
		});

		busboy.on('error', (err) => {
			reject(new BadRequestError(err instanceof Error ? err.message : String(err)));
		});

		const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
		if (rawBody) {
			busboy.end(rawBody);
		} else {
			req.pipe(busboy);
		}
	});
};
