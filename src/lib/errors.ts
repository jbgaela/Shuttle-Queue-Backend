export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(422, "VALIDATION_ERROR", message, details);
export const unauthorized = (message = "Authentication is required.") => new AppError(401, "AUTH_REQUIRED", message);
export const forbidden = (message = "This action is not allowed.") => new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "The requested resource was not found.") => new AppError(404, "NOT_FOUND", message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

export const assert = (condition: unknown, error: AppError): asserts condition => {
  if (!condition) throw error;
};

