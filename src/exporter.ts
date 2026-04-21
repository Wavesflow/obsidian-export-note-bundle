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
import { Ref, extractRefs } from "./resolve";

export interface ExportResult {
  outDir: string;
  assetCount: number;
  missing: string[];
  renamed: number;
}

interface SourceContent {
  bytes: Uint8Array;
  text: string;
}

interface AssetCopyPlan {
  file: TFile;
  name: string;
  linkPath: string;
}

interface RewrittenLink {
  fileName: string;
  markdownPath: string;
  canvasPath: string;
}

async function readContent(app: App, file: TFile): Promise<SourceContent> {
  const text = await app.vault.cachedRead(file);
  return {
    bytes: new TextEncoder().encode(text),
    text,
  };
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function buildCopyPlan(
  refs: Ref[],
  taken: Set<string>,
  linkForName: (name: string) => RewrittenLink,
) {
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

  let renamed = 0;
  const plan: AssetCopyPlan[] = [];
  const linkMap = new Map<string, RewrittenLink>();

  for (const target of targets.values()) {
    const name = allocUniqueAssetName(taken, target.name);
    if (name.toLowerCase() !== target.name.toLowerCase()) {
      renamed++;
    }
    const link = linkForName(name);
    plan.push({ file: target, name, linkPath: link.markdownPath });
    linkMap.set(target.path, link);
  }

  return { missing, renamed, plan, linkMap };
}

function replaceLinkpath(raw: string, oldPath: string, newPath: string): string {
  if (raw.includes(`[[${oldPath}`) || raw.includes(`![[${oldPath}`)) {
    return raw.replace(oldPath, newPath);
  }
  if (raw.includes(`<${oldPath}>`)) {
    return raw.replace(`<${oldPath}>`, `<${newPath}>`);
  }
  return raw.replace(oldPath, newPath);
}

function normalizeLinkKey(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function rewriteLinkTargetPreservingSubpath(originalTarget: string, rewrittenBase: string): string {
  const hashIndex = originalTarget.indexOf("#");
  if (hashIndex === -1) {
    return rewrittenBase;
  }
  return `${rewrittenBase}${originalTarget.slice(hashIndex)}`;
}

function rewriteCanvasByBundleAssets(
  content: string,
  canvasRootDir: string,
  assetPaths: string[],
): string {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return content;
  }

  if (!data || typeof data !== "object") {
    return content;
  }

  const canvas = data as { nodes?: Array<Record<string, unknown>> };
  if (!Array.isArray(canvas.nodes) || assetPaths.length === 0) {
    return content;
  }

  const basenameMap = new Map<string, string[]>();
  for (const assetPath of assetPaths) {
    const relativePath = toPosixPath(path.relative(canvasRootDir, assetPath));
    const basename = path.posix.basename(relativePath).toLowerCase();
    const matches = basenameMap.get(basename);
    if (matches) {
      matches.push(relativePath);
    } else {
      basenameMap.set(basename, [relativePath]);
    }
  }

  for (const node of canvas.nodes) {
    if (node.type !== "file" || typeof node.file !== "string") {
      continue;
    }

    const currentPath = normalizeLinkKey(node.file);
    const basename = path.posix.basename(currentPath).toLowerCase();
    const matches = basenameMap.get(basename);
    if (matches?.length === 1 && normalizeLinkKey(matches[0]) !== currentPath) {
      node.file = matches[0];
    }
  }

  return JSON.stringify(canvas, null, 2);
}

function rewriteMarkdownContent(
  content: string,
  refs: Ref[],
  linkMap: Map<string, RewrittenLink>,
): string {
  const rangedRefs = refs
    .filter(
      (ref): ref is Ref & { start: number; end: number; target: TFile } =>
        ref.start !== undefined &&
        ref.end !== undefined &&
        ref.target !== undefined &&
        linkMap.has(ref.target.path),
    )
    .sort((a, b) => a.start - b.start);

  if (rangedRefs.length === 0) {
    return content;
  }

  let out = "";
  let cursor = 0;
  for (const ref of rangedRefs) {
    if (ref.start < cursor) continue;

    out += content.slice(cursor, ref.start);
    const rewrittenBase = ref.raw.includes("[[")
      ? linkMap.get(ref.target.path)!.fileName
      : linkMap.get(ref.target.path)!.markdownPath;
    const replacement = rewriteLinkTargetPreservingSubpath(ref.linkpath, rewrittenBase);
    out += replaceLinkpath(ref.raw, ref.linkpath, replacement);
    cursor = ref.end;
  }
  out += content.slice(cursor);
  return out;
}

function resolveTargetFromLinkpath(app: App, sourcePath: string, linkpath: string): TFile | undefined {
  const direct = app.vault.getAbstractFileByPath(linkpath);
  if (direct instanceof TFile) {
    return direct;
  }
  return app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) ?? undefined;
}

function rewriteWikilinks(
  app: App,
  file: TFile,
  content: string,
  linkMap: Map<string, RewrittenLink>,
): string {
  const wikilinkRe = /(!?)\[\[([^\[\]\r\n|]+?)(\|[^\[\]\r\n]*)?\]\]/g;
  return content.replace(wikilinkRe, (raw, bang, linkTarget, alias = "") => {
    const trimmedTarget = String(linkTarget).trim();
    const target = resolveTargetFromLinkpath(app, file.path, trimmedTarget);
    if (!target) return raw;

    const rewrittenBase = linkMap.get(target.path)?.fileName;
    if (!rewrittenBase) return raw;

    const rewritten = rewriteLinkTargetPreservingSubpath(trimmedTarget, rewrittenBase);
    return `${bang}[[${rewritten}${alias ?? ""}]]`;
  });
}

function rewriteCanvasContent(
  app: App,
  file: TFile,
  content: string,
  refs: Ref[],
  linkMap: Map<string, RewrittenLink>,
): string {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return content;
  }

  if (!data || typeof data !== "object") {
    return content;
  }

  const canvas = data as { nodes?: Array<Record<string, unknown>> };
  if (!Array.isArray(canvas.nodes)) {
    return content;
  }

  const canvasFileMap = new Map<string, string>();
  for (const ref of refs) {
    if (!ref.target || ref.raw !== ref.linkpath) {
      continue;
    }

    const rewritten = linkMap.get(ref.target.path)?.canvasPath;
    if (!rewritten) {
      continue;
    }

    canvasFileMap.set(normalizeLinkKey(ref.raw), rewritten);
  }

  for (const node of canvas.nodes) {
    if (node.type === "file" && typeof node.file === "string") {
      const directRewrite = canvasFileMap.get(normalizeLinkKey(node.file));
      if (directRewrite) {
        node.file = directRewrite;
        continue;
      }

      const target = resolveTargetFromLinkpath(app, file.path, node.file);
      const fallbackRewrite = target ? linkMap.get(target.path)?.canvasPath : undefined;
      if (fallbackRewrite) {
        node.file = fallbackRewrite;
      }
    }

    if (node.type === "text" && typeof node.text === "string") {
      node.text = rewriteWikilinks(app, file, node.text, linkMap);
    }
  }

  return JSON.stringify(canvas, null, 2);
}

function rewriteContent(
  app: App,
  file: TFile,
  content: string,
  refs: Ref[],
  linkMap: Map<string, RewrittenLink>,
): string {
  switch (file.extension.toLowerCase()) {
    case "md":
      return rewriteMarkdownContent(content, refs, linkMap);
    case "canvas":
      return rewriteCanvasContent(app, file, content, refs, linkMap);
    case "excalidraw":
    case "base":
      return rewriteWikilinks(app, file, content, linkMap);
    default:
      return content;
  }
}

async function copyAssets(
  app: App,
  plan: AssetCopyPlan[],
  attachDir: string,
  onProgress?: (msg: string) => void,
) {
  const total = plan.length;
  let done = 0;

  await runLimited(plan, 4, async (item) => {
    const bytes = await app.vault.readBinary(item.file);
    await writeFileAtomic(path.join(attachDir, item.name), Buffer.from(bytes));
    onProgress?.(`${++done}/${total}`);
  });
}

export async function exportFile(
  app: App,
  file: TFile,
  destBase: string,
  attachDirName: string,
  onProgress?: (msg: string) => void,
  canvasRootDir?: string,
): Promise<ExportResult> {
  const ext = file.extension.toLowerCase();
  if (!CONTENT_ROOT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported: .${file.extension}`);
  }

  onProgress?.("Reading...");
  const { text } = await readContent(app, file);

  onProgress?.("Scanning...");
  const refs = await extractRefs(app, file, text);

  const outDir = await allocUniqueDir(destBase, file.basename);
  const attachDir = path.join(outDir, sanitizeSegment(attachDirName));
  const attachDirRel = sanitizeSegment(attachDirName);
  const canvasRoot = canvasRootDir ?? destBase;
  const { missing, renamed, plan, linkMap } = buildCopyPlan(
    refs,
    new Set<string>(),
    (name) => ({
      fileName: name,
      markdownPath: toPosixPath(path.join(attachDirRel, name)),
      canvasPath: toPosixPath(path.relative(canvasRoot, path.join(attachDir, name))),
    }),
  );

  const rewritten = rewriteContent(app, file, text, refs, linkMap);
  const finalized = ext === "canvas"
    ? rewriteCanvasByBundleAssets(
        rewritten,
        canvasRoot,
        plan.map((item) => path.join(attachDir, item.name)),
      )
    : rewritten;
  await writeFileAtomic(path.join(outDir, file.name), Buffer.from(finalized, "utf8"));

  await copyAssets(app, plan, attachDir, onProgress);

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
      const result = await exportFile(
        app,
        file,
        fileDestBase,
        attachDirName,
        (message) => onProgress?.(`${prefix} - ${message}`),
        destBase,
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
      const { text } = await readContent(app, file);
      const refs = await extractRefs(app, file, text);

      const noteOutDir = path.join(rootOut, ...getRelativeParentSegments(file, hierarchyRoot));
      const noteTaken = getOrCreateTakenSet(noteTakenByDir, noteOutDir);
      const noteName = allocUniqueAssetName(noteTaken, file.name);
      const markdownPathForName = (name: string) =>
        toPosixPath(path.relative(noteOutDir, path.join(attachDir, name)));
      const canvasPathForName = (name: string) =>
        toPosixPath(path.relative(destBase, path.join(attachDir, name)));

      const missing: string[] = [];
      let renamedForFile = 0;
      const linkMap = new Map<string, RewrittenLink>();
      const toCopy: AssetCopyPlan[] = [];

      for (const ref of refs) {
        if (!ref.target) {
          missing.push(ref.raw);
          continue;
        }

        let assignedName = attachMap.get(ref.target.path);
        if (!assignedName) {
          assignedName = allocUniqueAssetName(attachTaken, ref.target.name);
          if (assignedName.toLowerCase() !== ref.target.name.toLowerCase()) {
            renamedForFile++;
            totalRenamed++;
          }
          attachMap.set(ref.target.path, assignedName);
          toCopy.push({
            file: ref.target,
            name: assignedName,
            linkPath: markdownPathForName(assignedName),
          });
        }

        linkMap.set(ref.target.path, {
          fileName: assignedName,
          markdownPath: markdownPathForName(assignedName),
          canvasPath: canvasPathForName(assignedName),
        });
      }

      const rewritten = rewriteContent(app, file, text, refs, linkMap);
      const finalized = file.extension.toLowerCase() === "canvas"
        ? rewriteCanvasByBundleAssets(
            rewritten,
            destBase,
            Array.from(new Set(Array.from(attachMap.values()).map((name) => path.join(attachDir, name)))),
          )
        : rewritten;
      await writeFileAtomic(path.join(noteOutDir, noteName), Buffer.from(finalized, "utf8"));

      const total = toCopy.length;
      let done = 0;
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
