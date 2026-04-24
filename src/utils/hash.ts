import { createHash } from "node:crypto";

export function stableId(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("|");
  }
  return hash.digest("hex").slice(0, 16);
}
