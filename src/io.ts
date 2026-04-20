import { promises as fs } from "fs";
import * as path from "path";

export const ASSET_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tif", "tiff", "avif", "ico",
  "pdf",
  "mp3", "wav", "m4a", "ogg", "flac", "aac",
  "mp4", "mov", "webm", "mkv", "avi", "m4v",
  "excalidraw", "canvas", "base",
]);

export const CONTENT_ROOT_EXTENSIONS = new Set([
  "md", "canvas", "excalidraw", "base",
]);

export function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(0, dot) : name;
}

export function isAsset(name: string): boolean {
  return ASSET_EXTENSIONS.has(getExt(name));
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function allocUniqueDir(baseDir: string, name: string): Promise<string> {
  const safe = sanitizeSegment(name);
  let candidate = path.join(baseDir, safe);
  if (!(await pathExists(candidate))) return candidate;
  for (let i = 1; i < 10000; i++) {
    candidate = path.join(baseDir, `${safe}-${i}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error("Could not allocate unique export directory");
}

export function allocUniqueAssetName(
  taken: Set<string>,
  originalName: string,
): string {
  const safe = sanitizeSegment(originalName);
  if (!taken.has(safe.toLowerCase())) {
    taken.add(safe.toLowerCase());
    return safe;
  }
  const ext = getExt(safe);
  const stem = stripExt(safe);
  for (let i = 1; i < 10000; i++) {
    const candidate = ext ? `${stem}_${i}.${ext}` : `${stem}_${i}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new Error("Could not allocate unique asset name");
}

export function sanitizeSegment(name: string): string {
  // Replace characters illegal on Windows; keep unicode intact.
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "untitled";
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

export async function runLimited<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        while (index < items.length) {
          const my = index++;
          await worker(items[my]);
        }
      })(),
    );
  }
  await Promise.all(runners);
}
