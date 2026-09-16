import { createHash } from "node:crypto";

/** Lowercase hex sha256 of a string (UTF-8) or raw bytes. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
