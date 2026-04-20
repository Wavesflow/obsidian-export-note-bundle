import {
  App,
  TFile,
  parseLinktext,
} from "obsidian";
import { isAsset } from "./io";

export type RefKind = "embed" | "link";

export interface Ref {
  kind: RefKind;
  // Exact substring in source content (used by string-replace rewriters).
  raw: string;
  // Parsed vault path / linkpath portion (no subpath, no display).
  linkpath: string;
  // Optional display text (for markdown [alt](x) rewriting).
  display?: string;
  // For markdown only: byte offsets in the source content.
  start?: number;
  end?: number;
  // Resolved target file (undefined if unresolved).
  target?: TFile;
}

function resolveLinkpath(
  app: App,
  sourcePath: string,
  linkpath: string,
): TFile | undefined {
  const { path: p } = parseLinktext(linkpath);
  const dest = app.metadataCache.getFirstLinkpathDest(p, sourcePath);
  return dest ?? undefined;
}

function resolveDirectPath(app: App, vaultPath: string): TFile | undefined {
  const f = app.vault.getAbstractFileByPath(vaultPath);
  return f instanceof TFile ? f : undefined;
}

// ---------- Markdown ----------

export function extractMarkdownRefs(app: App, file: TFile): Ref[] {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return [];
  const refs: Ref[] = [];

  // Embeds: `![[foo.png]]` / `![alt](foo.png)`. Keep unresolved ones — an
  // unresolved embed is almost always a broken asset reference the user cares
  // about. Resolved-but-not-asset (e.g. `![[Other Note]]` transclusion) is
  // dropped since we don't bundle note transclusions.
  for (const e of cache.embeds ?? []) {
    const target = resolveLinkpath(app, file.path, e.link);
    if (target && !isAsset(target.name)) continue;
    refs.push({
      kind: "embed",
      raw: e.original,
      linkpath: e.link,
      display: e.displayText,
      start: e.position.start.offset,
      end: e.position.end.offset,
      target,
    });
  }

  // Links: `[[Note]]` / `[text](foo.pdf)`. Only keep ones that resolve to an
  // asset — unresolved note links are noise (often just not-yet-created notes).
  for (const l of cache.links ?? []) {
    const target = resolveLinkpath(app, file.path, l.link);
    if (!target || !isAsset(target.name)) continue;
    refs.push({
      kind: "link",
      raw: l.original,
      linkpath: l.link,
      display: l.displayText,
      start: l.position.start.offset,
      end: l.position.end.offset,
      target,
    });
  }

  return refs;
}

// ---------- Canvas ----------

export function extractCanvasRefs(app: App, file: TFile, content: string): Ref[] {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }
  const refs: Ref[] = [];
  const nodes: any[] = Array.isArray(data?.nodes) ? data.nodes : [];

  for (const node of nodes) {
    if (node && typeof node === "object" && node.type === "file" && typeof node.file === "string") {
      const vaultPath = node.file;
      const target = resolveDirectPath(app, vaultPath) ?? resolveLinkpath(app, file.path, vaultPath);
      // Canvas file nodes always mean "embed this specific file" — keep
      // unresolved ones so they surface in the missing count. Note targets
      // (canvas page embeds) we drop since we don't bundle notes transitively.
      if (target && !isAsset(target.name)) continue;
      refs.push({
        kind: "embed",
        raw: vaultPath,
        linkpath: vaultPath,
        target,
      });
    }
    // text nodes may contain wikilinks — scan their markdown text
    if (node && typeof node === "object" && node.type === "text" && typeof node.text === "string") {
      for (const r of scanWikilinks(app, file.path, node.text)) refs.push(r);
    }
  }
  return refs;
}

// ---------- Excalidraw (.excalidraw pure JSON) ----------

export function extractExcalidrawRefs(app: App, file: TFile, content: string): Ref[] {
  // Excalidraw files are JSON; embedded images live in `files` as base64 dataURLs,
  // so there are usually no external asset references. We still scan all string
  // values for wikilink patterns, which some workflows use inside text elements.
  return scanWikilinks(app, file.path, content);
}

// ---------- Base (.base) ----------

export function extractBaseRefs(app: App, file: TFile, content: string): Ref[] {
  // .base files are YAML-ish; treat as text and scan for wikilinks + raw paths
  // that happen to be asset files. Conservative on purpose.
  return scanWikilinks(app, file.path, content);
}

// ---------- Shared: scan wikilinks in arbitrary text ----------

const WIKILINK_RE = /!?\[\[([^\[\]\r\n|]+?)(?:\|([^\[\]\r\n]*))?\]\]/g;

function scanWikilinks(app: App, sourcePath: string, text: string): Ref[] {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const raw = m[0];
    const inner = m[1].trim();
    const display = m[2];
    const target = resolveLinkpath(app, sourcePath, inner);
    if (!target) continue;
    if (!isAsset(target.name)) continue;
    const key = `${raw}|${m.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      kind: raw.startsWith("!") ? "embed" : "link",
      raw,
      linkpath: inner,
      display,
      target,
    });
  }
  return refs;
}

// ---------- Dispatcher ----------

export async function extractRefs(
  app: App,
  file: TFile,
  content: string,
): Promise<Ref[]> {
  const ext = file.extension.toLowerCase();
  switch (ext) {
    case "md":
      return extractMarkdownRefs(app, file);
    case "canvas":
      return extractCanvasRefs(app, file, content);
    case "excalidraw":
      return extractExcalidrawRefs(app, file, content);
    case "base":
      return extractBaseRefs(app, file, content);
    default:
      return [];
  }
}
