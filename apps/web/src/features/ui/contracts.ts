/**
 * Client-safe contract for control-plane read models.
 *
 * A read model never returns a driver error, a request value or a payload:
 * failures collapse to a bounded code and a fixed operator-facing message.
 */
export type UiFailureCode =
	| "AUTH_REQUIRED"
	| "FORBIDDEN"
	| "INVALID_INPUT"
	| "NOT_FOUND"
	| "UNAVAILABLE";

export type UiError = {
	code: UiFailureCode;
	message: string;
};

export type UiResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: UiError };

export class UiNotFoundError extends Error {
	constructor(message = "The requested record was not found.") {
		super(message);
		this.name = "UiNotFoundError";
	}
}

export class UiInvalidInputError extends Error {
	constructor(message = "The request is invalid.") {
		super(message);
		this.name = "UiInvalidInputError";
	}
}
