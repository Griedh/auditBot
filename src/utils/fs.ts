import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  if (!(await exists(filePath))) {
    return undefined;
  }

  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

export function join(...parts: string[]): string {
  return path.join(...parts);
}
