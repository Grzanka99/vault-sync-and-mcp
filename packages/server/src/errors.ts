/** An error with an HTTP status, safe to show to the client. */
export class VaultError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "VaultError";
    this.status = status;
  }
}
