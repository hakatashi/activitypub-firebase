export class HttpError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.name = 'HttpError';
		this.statusCode = statusCode;
	}
}

export class BadRequestError extends HttpError {
	constructor(message = 'Bad request') {
		super(400, message);
		this.name = 'BadRequestError';
	}
}

export class NotFoundError extends HttpError {
	constructor(message = 'Record not found') {
		super(404, message);
		this.name = 'NotFoundError';
	}
}

export class UnprocessableError extends HttpError {
	constructor(message: string) {
		super(422, message);
		this.name = 'UnprocessableError';
	}
}

export class ForbiddenError extends HttpError {
	constructor(message = 'Forbidden') {
		super(403, message);
		this.name = 'ForbiddenError';
	}
}
