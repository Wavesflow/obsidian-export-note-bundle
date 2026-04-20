# Export Note Bundle

Export Note Bundle is an Obsidian desktop plugin for exporting notes, folders, and their referenced assets into portable bundles.

Author: Negative Boson (负性玻色子)

## Features

- Export the current note with all referenced assets.
- Export a whole folder recursively.
- Preserve nested folder structure when exporting folders.
- Export a custom export list.
- Export supported files by tag.
- Support Markdown, Canvas, Excalidraw, and `.base` files.
- Choose between per-note attachments and a shared attachment folder.

## Attachment layouts

- `per-note`: each exported note gets its own attachment folder.
- `shared`: the whole batch shares one attachment folder.

## Supported workflows

- Command palette export for the active file.
- File explorer context menu export for folders.
- Batch export from the plugin's export list.
- Batch export by tag.

## Settings

- `Export base directory`: absolute output directory for exports.
- `Open folder after export`: reveal the result in the system file manager.
- `Attachment layout`: choose `per-note` or `shared`.
- `Attachment folder name`: customize the attachment directory name.

## Example output

```text
Project Notes_20260420-193000/
  Chapter 1/
    Note A/
      Note A.md
      Attachment/
        image-1.png
  Chapter 2/
    Note B/
      Note B.md
      Attachment/
        chart.pdf
```

## Development

```bash
npm install
npm run build
```

Important runtime files:

- `manifest.json`
- `main.js`
- `versions.json`

Repository-only development files:

- `src/`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `esbuild.config.mjs`

Local files such as `node_modules/` and `data.json` should not be committed.

## Release notes

- `0.1.1`: preserve nested folder structure during folder export and clean up repository metadata.
