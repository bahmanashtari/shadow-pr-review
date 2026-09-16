import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Absolute path of the repository (or installed package) root.
 * Works from `src/` under tsx and from `dist/` after build, since both sit one level below root.
 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Absolute path of a file inside the package root. */
export function fromRoot(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}
