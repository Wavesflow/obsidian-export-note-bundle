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

## Local layout

The cleanest setup is to keep two separate folders:

- `plugin-dev/export-note-bundle/`: source repository
- `.obsidian/plugins/export-note-bundle/`: runtime plugin folder used by Obsidian

The runtime folder only needs:

- `main.js`
- `manifest.json`
- `versions.json`
- `data.json` (local settings, optional)

## Build and deploy

```bash
npm install
npm run build
npm run deploy
```

`npm run deploy` copies the runtime files into the Obsidian plugin folder. If the repository is not located under the same vault, run the PowerShell script manually and pass a target path.
