export function workerClientError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" && error ? error : fallbackMessage);
}
