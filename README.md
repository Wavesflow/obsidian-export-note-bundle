# Export Note Bundle

Export Note Bundle is an Obsidian desktop plugin for exporting notes and their referenced assets into portable bundles.

Author: Negative Boson (负性玻色子)

## What it does

- Export the current note with attachments.
- Export a whole folder recursively.
- Keep nested folder structure during folder export.
- Export a custom list of files.
- Export supported files by tag.
- Support Markdown, Canvas, Excalidraw, and `.base` files.

## Install

The easiest way is to download the latest release from GitHub:

[Latest release](https://github.com/Wavesflow/obsidian-export-note-bundle/releases/latest)

Then:

1. Download `export-note-bundle.zip` from the release assets.
2. Unzip it.
3. Drag the `export-note-bundle` folder into your vault's `.obsidian/plugins/` folder.
4. Restart Obsidian or reload community plugins.
5. Enable `Export Note Bundle`.

## Files needed by Obsidian

- `main.js`
- `manifest.json`
- `versions.json`

## Development files

- `src/`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `esbuild.config.mjs`

## Build

```bash
npm install
npm run build
```
