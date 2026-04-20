import {
  App,
  TAbstractFile,
  TFile,
  TFolder,
  getAllTags,
} from "obsidian";
import * as path from "path";
import {
  CONTENT_ROOT_EXTENSIONS,
  allocUniqueAssetName,
  allocUniqueDir,
  runLimited,
  sanitizeSegment,
  writeFileAtomic,
} from "./io";
import { extractRefs } from "./resolve";

export interface ExportResult {
  outDir: string;
  assetCount: number;
  missing: string[];
  renamed: number;
}

async function readContent(app: App, file: TFile) {
  const bytes = await app.vault.readBinary(file);
  const text =
    file.extension.toLowerCase() === "md"
      ? ""
      : new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  return { bytes, text };
}

export async function exportFile(
  app: App,
  file: TFile,
  destBase: string,
  attachDirName: string,
  onProgress?: (msg: string) => void,
): Promise<ExportResult> {
  const ext = file.extension.toLowerCase();
  if (!CONTENT_ROOT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported: .${file.extension}`);
  }

  onProgress?.("Reading...");
  const { bytes, text } = await readContent(app, file);

  onProgress?.("Scanning...");
  const refs = await extractRefs(app, file, text);

  const outDir = await allocUniqueDir(destBase, file.basename);
  const attachDir = path.join(outDir, sanitizeSegment(attachDirName));

  await writeFileAtomic(path.join(outDir, file.name), Buffer.from(bytes));

  const targets = new Map<string, TFile>();
  const missing: string[] = [];
  for (const ref of refs) {
    if (!ref.target) {
      missing.push(ref.raw);
      continue;
    }
    if (!targets.has(ref.target.path)) {
      targets.set(ref.target.path, ref.target);
    }
  }

  const taken = new Set<string>();
  let renamed = 0;
  const plan: { file: TFile; name: string }[] = [];

  for (const target of targets.values()) {
    const name = allocUniqueAssetName(taken, target.name);
    if (name.toLowerCase() !== target.name.toLowerCase()) {
      renamed++;
    }
    plan.push({ file: target, name });
  }

  const total = plan.length;
  let done = 0;
  await runLimited(plan, 4, async (item) => {
    const bytes = await app.vault.readBinary(item.file);
    await writeFileAtomic(path.join(attachDir, item.name), Buffer.from(bytes));
    onProgress?.(`${++done}/${total}`);
  });

  return { outDir, assetCount: plan.length, missing, renamed };
}

export interface BatchItemResult {
  filePath: string;
  ok: boolean;
  outDir?: string;
  assetCount?: number;
  missing?: string[];
  renamed?: number;
  error?: string;
}

export interface BatchResult {
  rootOut: string;
  total: number;
  succeeded: number;
  failed: number;
  totalAssets: number;
  totalMissing: number;
  totalRenamed: number;
  items: BatchItemResult[];
}

export function collectSupportedFiles(folder: TFolder): TFile[] {
  const out: TFile[] = [];

  const walk = (node: TAbstractFile) => {
    if (node instanceof TFile) {
      if (CONTENT_ROOT_EXTENSIONS.has(node.extension.toLowerCase())) {
        out.push(node);
      }
      return;
    }

    if (node instanceof TFolder) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };

  walk(folder);
  return out;
}

export async function exportBatchPerNote(
  app: App,
  files: TFile[],
  destBase: string,
  label: string,
  attachDirName: string,
  onProgress?: (msg: string) => void,
  hierarchyRoot?: TFolder,
): Promise<BatchResult> {
  const rootOut = await allocUniqueDir(destBase, sanitizeSegment(label));
  const items: BatchItemResult[] = [];
  let totalAssets = 0;
  let totalMissing = 0;
  let totalRenamed = 0;

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const prefix = `[${index + 1}/${files.length}] ${file.path}`;
    onProgress?.(prefix);

    try {
      const fileDestBase = path.join(rootOut, ...getRelativeParentSegments(file, hierarchyRoot));
      const result = await exportFile(app, file, fileDestBase, attachDirName, (message) =>
        onProgress?.(`${prefix} - ${message}`),
      );
      totalAssets += result.assetCount;
      totalMissing += result.missing.length;
      totalRenamed += result.renamed;
      items.push({
        filePath: file.path,
        ok: true,
        outDir: result.outDir,
        assetCount: result.assetCount,
        missing: result.missing,
        renamed: result.renamed,
      });
    } catch (error) {
      items.push({
        filePath: file.path,
        ok: false,
        error: (error as Error).message,
      });
    }
  }

  return finalize(rootOut, files.length, items, totalAssets, totalMissing, totalRenamed);
}

export async function exportBatchShared(
  app: App,
  files: TFile[],
  destBase: string,
  label: string,
  sharedAttachDirName: string,
  onProgress?: (msg: string) => void,
  hierarchyRoot?: TFolder,
): Promise<BatchResult> {
  const rootOut = await allocUniqueDir(destBase, sanitizeSegment(label));
  const attachDir = path.join(rootOut, sanitizeSegment(sharedAttachDirName));

  const items: BatchItemResult[] = [];
  let totalAssets = 0;
  let totalMissing = 0;
  let totalRenamed = 0;

  const attachTaken = new Set<string>();
  const attachMap = new Map<string, string>();
  const noteTakenByDir = new Map<string, Set<string>>();

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const prefix = `[${index + 1}/${files.length}] ${file.path}`;
    onProgress?.(prefix);

    try {
      const { bytes, text } = await readContent(app, file);
      const refs = await extractRefs(app, file, text);

      const noteOutDir = path.join(rootOut, ...getRelativeParentSegments(file, hierarchyRoot));
      const noteTaken = getOrCreateTakenSet(noteTakenByDir, noteOutDir);
      const noteName = allocUniqueAssetName(noteTaken, file.name);
      await writeFileAtomic(path.join(noteOutDir, noteName), Buffer.from(bytes));

      const missing: string[] = [];
      const toCopy: { file: TFile; name: string }[] = [];
      let renamedForFile = 0;

      for (const ref of refs) {
        if (!ref.target) {
          missing.push(ref.raw);
          continue;
        }

        if (attachMap.has(ref.target.path)) {
          continue;
        }

        const name = allocUniqueAssetName(attachTaken, ref.target.name);
        if (name.toLowerCase() !== ref.target.name.toLowerCase()) {
          renamedForFile++;
          totalRenamed++;
        }
        attachMap.set(ref.target.path, name);
        toCopy.push({ file: ref.target, name });
      }

      let done = 0;
      const total = toCopy.length;
      await runLimited(toCopy, 4, async (item) => {
        const bytes = await app.vault.readBinary(item.file);
        await writeFileAtomic(path.join(attachDir, item.name), Buffer.from(bytes));
        onProgress?.(`${prefix} - ${++done}/${total}`);
      });

      totalAssets += toCopy.length;
      totalMissing += missing.length;
      items.push({
        filePath: file.path,
        ok: true,
        outDir: noteOutDir,
        assetCount: toCopy.length,
        missing,
        renamed: renamedForFile,
      });
    } catch (error) {
      items.push({
        filePath: file.path,
        ok: false,
        error: (error as Error).message,
      });
    }
  }

  return finalize(rootOut, files.length, items, totalAssets, totalMissing, totalRenamed);
}

function normalizeVaultPath(vaultPath: string): string {
  return vaultPath.replace(/^\/+|\/+$/g, "");
}

function getRelativeParentSegments(file: TFile, hierarchyRoot?: TFolder): string[] {
  if (!hierarchyRoot) return [];

  const rootPath = normalizeVaultPath(hierarchyRoot.path);
  const parentParts = file.path.split("/").slice(0, -1);

  if (!rootPath) {
    return parentParts.map(sanitizeSegment);
  }

  const rootParts = rootPath.split("/");
  for (let index = 0; index < rootParts.length; index++) {
    if (parentParts[index] !== rootParts[index]) {
      return [];
    }
  }

  return parentParts.slice(rootParts.length).map(sanitizeSegment);
}

function getOrCreateTakenSet(map: Map<string, Set<string>>, dirPath: string): Set<string> {
  const key = dirPath.toLowerCase();
  let taken = map.get(key);
  if (!taken) {
    taken = new Set<string>();
    map.set(key, taken);
  }
  return taken;
}

function finalize(
  rootOut: string,
  total: number,
  items: BatchItemResult[],
  totalAssets: number,
  totalMissing: number,
  totalRenamed: number,
): BatchResult {
  return {
    rootOut,
    total,
    succeeded: items.filter((item) => item.ok).length,
    failed: items.filter((item) => !item.ok).length,
    totalAssets,
    totalMissing,
    totalRenamed,
    items,
  };
}

export function listAllTags(app: App): string[] {
  const raw = (app.metadataCache as { getTags?: () => Record<string, unknown> }).getTags?.() ?? {};
  return Object.keys(raw).sort((a, b) => a.localeCompare(b));
}

export function filesByTag(app: App, tag: string): TFile[] {
  const needle = tag.replace(/^#+/, "").toLowerCase();
  if (!needle) return [];

  const out: TFile[] = [];
  for (const file of app.vault.getFiles()) {
    if (!CONTENT_ROOT_EXTENSIONS.has(file.extension.toLowerCase())) continue;

    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;

    const tags = getAllTags(cache) ?? [];
    const hit = tags.some((candidate) => {
      const bare = candidate.replace(/^#+/, "").toLowerCase();
      return bare === needle || bare.startsWith(`${needle}/`);
    });

    if (hit) {
      out.push(file);
    }
  }

  return out;
}
