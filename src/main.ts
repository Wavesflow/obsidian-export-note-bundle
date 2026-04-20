import {
  App,
  FuzzySuggestModal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import {
  BatchResult,
  collectSupportedFiles,
  exportBatchPerNote,
  exportBatchShared,
  exportFile,
  filesByTag,
  listAllTags,
} from "./exporter";
import { CONTENT_ROOT_EXTENSIONS } from "./io";

type AttachmentMode = "per-note" | "shared";

interface ExportSettings {
  exportBaseDir: string;
  openFolderAfterExport: boolean;
  attachmentMode: AttachmentMode;
  attachmentDirName: string;
}

const DEFAULTS: ExportSettings = {
  exportBaseDir: "",
  openFolderAfterExport: true,
  attachmentMode: "per-note",
  attachmentDirName: "Attachment",
};

type Lang = "en" | "zh";

function detectLang(): Lang {
  try {
    const raw = window.localStorage.getItem("language") ?? "";
    return raw.startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

const I18N = {
  en: {
    cmdExport: "Export current file with attachments",
    cmdAdd: "Add current file to export list",
    cmdRemove: "Remove current file from export list",
    cmdRunList: "Export the export list",
    cmdByTag: "Export files by tag",
    menuExport: "Export with attachments",
    menuAdd: "Add to export list",
    menuRemove: "Remove from export list",
    menuFolder: (count: number) => `Export folder with attachments (${count})`,
    exporting: "Exporting...",
    batchStart: "Batch export starting...",
    exported: (outDir: string) => `Exported to: ${outDir}`,
    countAttach: (count: number) => `${count} attachment${count === 1 ? "" : "s"}`,
    countRenamed: (count: number) => `${count} renamed (name collision)`,
    countUnresolved: (count: number) => `${count} unresolved (see console)`,
    countFailed: (count: number) => `${count} failed (see console)`,
    countSkipped: (count: number) => `${count} list entries skipped`,
    batchDone: (outDir: string) => `Batch export finished: ${outDir}`,
    stats: (ok: number, total: number, assets: number) =>
      `${ok}/${total} files, ${assets} attachments`,
    added: (filePath: string, count: number) =>
      `Added: ${filePath}\n(${count} in export list)`,
    removed: (filePath: string, count: number) =>
      `Removed: ${filePath}\n(${count} in export list)`,
    addedShort: (count: number) => `Added (${count} in export list)`,
    removedShort: (count: number) => `Removed (${count} in export list)`,
    emptyFolder: "Folder has no supported files.",
    emptyList: "Export list has no resolvable files.",
    emptyTag: (tag: string) => `No files found with tag ${tag}.`,
    exportFailed: (message: string) => `Export failed: ${message}`,
    batchFailed: (message: string) => `Batch export failed: ${message}`,
    pleaseConfigure:
      'Set the export base directory in "Export Note Bundle" settings.',
    pickTag: "Pick a tag to export",
    settingTitle: "Export Note Bundle",
    settingBaseDir: "Export base directory",
    settingBaseDirDesc:
      "Absolute path where exports are written. Leave blank to pick each time.",
    settingOpen: "Open folder after export",
    settingOpenDesc: "Reveal the exported folder in the OS file manager.",
    settingMode: "Attachment layout",
    settingModeDesc:
      "Per-note keeps each note in its own bundle. Shared keeps one attachment folder for the whole batch.",
    modePerNote: "Per-note (each file has its own Attachment folder)",
    modeShared: "Shared (all attachments in one folder)",
    settingDirName: "Attachment folder name",
    settingDirNameDesc:
      'Folder name used for attachments, for example "Attachment" or "Attachments".',
  },
  zh: {
    cmdExport: "导出当前文件及附件",
    cmdAdd: "加入导出列表",
    cmdRemove: "从导出列表移除当前文件",
    cmdRunList: "导出当前导出列表",
    cmdByTag: "按标签导出文件",
    menuExport: "导出并打包附件",
    menuAdd: "加入导出列表",
    menuRemove: "从导出列表移除",
    menuFolder: (count: number) => `导出整个文件夹及附件（${count} 个文件）`,
    exporting: "导出中...",
    batchStart: "批量导出开始...",
    exported: (outDir: string) => `已导出到：${outDir}`,
    countAttach: (count: number) => `附件 ${count} 个`,
    countRenamed: (count: number) => `重名自动改名 ${count} 个`,
    countUnresolved: (count: number) => `未解析引用 ${count} 个（详见控制台）`,
    countFailed: (count: number) => `失败 ${count} 个（详见控制台）`,
    countSkipped: (count: number) => `列表中有 ${count} 个条目被跳过`,
    batchDone: (outDir: string) => `批量导出完成：${outDir}`,
    stats: (ok: number, total: number, assets: number) =>
      `共 ${ok}/${total} 个文件，附件 ${assets} 个`,
    added: (filePath: string, count: number) =>
      `已加入：${filePath}\n（列表中 ${count} 个）`,
    removed: (filePath: string, count: number) =>
      `已移除：${filePath}\n（列表中 ${count} 个）`,
    addedShort: (count: number) => `已加入（列表中 ${count} 个）`,
    removedShort: (count: number) => `已移除（列表中 ${count} 个）`,
    emptyFolder: "该文件夹下没有可导出的文件。",
    emptyList: "导出列表中没有可用文件。",
    emptyTag: (tag: string) => `没有带标签 ${tag} 的文件。`,
    exportFailed: (message: string) => `导出失败：${message}`,
    batchFailed: (message: string) => `批量导出失败：${message}`,
    pleaseConfigure: '请先在“Export Note Bundle”设置中填写导出根目录。',
    pickTag: "选择要导出的标签",
    settingTitle: "Export Note Bundle",
    settingBaseDir: "导出根目录",
    settingBaseDirDesc: "所有导出内容都会写到这里。留空则每次弹窗选择。",
    settingOpen: "导出后打开文件夹",
    settingOpenDesc: "导出完成后在系统文件管理器中定位输出目录。",
    settingMode: "附件布局",
    settingModeDesc:
      "每笔记模式会为每个文件创建独立导出包；共享模式会把整个批次的附件集中到一个文件夹。",
    modePerNote: "每笔记（每个文件有独立 Attachment 文件夹）",
    modeShared: "共享（所有附件放在同一个文件夹）",
    settingDirName: "附件文件夹名称",
    settingDirNameDesc: '附件目录名称，例如 “Attachment”、“Attachments” 或 “附件”。',
  },
} as const;

const T = I18N[detectLang()];

export default class ExportNoteBundlePlugin extends Plugin {
  settings: ExportSettings = DEFAULTS;
  private exportList = new Set<string>();

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "export-current-file-with-attachments",
      name: T.cmdExport,
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isSupported(file)) return false;
        if (checking) return true;
        void this.runSingle(file);
        return true;
      },
    });

    this.addCommand({
      id: "add-to-export-list",
      name: T.cmdAdd,
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isSupported(file)) return false;
        if (this.exportList.has(file.path)) return false;
        if (checking) return true;
        this.exportList.add(file.path);
        new Notice(T.added(file.path, this.exportList.size), 3000);
        return true;
      },
    });

    this.addCommand({
      id: "remove-from-export-list",
      name: T.cmdRemove,
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.exportList.has(file.path)) return false;
        if (checking) return true;
        this.exportList.delete(file.path);
        new Notice(T.removed(file.path, this.exportList.size), 3000);
        return true;
      },
    });

    this.addCommand({
      id: "export-the-export-list",
      name: T.cmdRunList,
      checkCallback: (checking) => {
        if (this.exportList.size === 0) return false;
        if (checking) return true;
        void this.runList();
        return true;
      },
    });

    this.addCommand({
      id: "export-by-tag",
      name: T.cmdByTag,
      callback: () => {
        new TagSuggestModal(this.app, (tag) => void this.runByTag(tag)).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target: TAbstractFile) => {
        if (target instanceof TFile && isSupported(target)) {
          menu.addItem((item) =>
            item
              .setTitle(T.menuExport)
              .setIcon("package")
              .onClick(() => void this.runSingle(target)),
          );

          if (this.exportList.has(target.path)) {
            menu.addItem((item) =>
              item
                .setTitle(T.menuRemove)
                .setIcon("minus-circle")
                .onClick(() => {
                  this.exportList.delete(target.path);
                  new Notice(T.removedShort(this.exportList.size));
                }),
            );
          } else {
            menu.addItem((item) =>
              item
                .setTitle(T.menuAdd)
                .setIcon("plus-circle")
                .onClick(() => {
                  this.exportList.add(target.path);
                  new Notice(T.addedShort(this.exportList.size));
                }),
            );
          }
        }

        if (target instanceof TFolder) {
          const count = collectSupportedFiles(target).length;
          if (count === 0) return;
          menu.addItem((item) =>
            item
              .setTitle(T.menuFolder(count))
              .setIcon("package")
              .onClick(() => void this.runFolder(target)),
          );
        }
      }),
    );

    this.addSettingTab(new ExportSettingTab(this.app, this));
  }

  async runSingle(file: TFile) {
    const dest = await this.resolveDestBase();
    if (!dest) return;

    const notice = new Notice(T.exporting, 0);
    try {
      const result = await exportFile(
        this.app,
        file,
        dest,
        this.settings.attachmentDirName,
        (message) => notice.setMessage(`${T.exporting} ${message}`),
      );
      notice.hide();

      const lines = [T.exported(result.outDir), T.countAttach(result.assetCount)];
      if (result.renamed) lines.push(T.countRenamed(result.renamed));
      if (result.missing.length) {
        lines.push(T.countUnresolved(result.missing.length));
        console.warn("[export-note-bundle] unresolved:", result.missing);
      }
      new Notice(lines.join("\n"), 8000);

      if (this.settings.openFolderAfterExport) openInOs(result.outDir);
    } catch (error) {
      notice.hide();
      console.error("[export-note-bundle] single export failed", error);
      new Notice(T.exportFailed((error as Error).message));
    }
  }

  async runFolder(folder: TFolder) {
    const files = collectSupportedFiles(folder);
    if (files.length === 0) {
      new Notice(T.emptyFolder);
      return;
    }

    const dest = await this.resolveDestBase();
    if (!dest) return;

    await this.runBatch(files, dest, `${folder.name || "Vault"}_${stamp()}`, 0, folder);
  }

  async runList() {
    const dest = await this.resolveDestBase();
    if (!dest) return;

    const resolved: TFile[] = [];
    const missingPaths: string[] = [];

    for (const filePath of this.exportList) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile && isSupported(file)) {
        resolved.push(file);
      } else {
        missingPaths.push(filePath);
      }
    }

    if (resolved.length === 0) {
      new Notice(T.emptyList);
      if (missingPaths.length) {
        console.warn("[export-note-bundle] list not found:", missingPaths);
      }
      return;
    }

    const result = await this.runBatch(
      resolved,
      dest,
      `ExportList_${stamp()}`,
      missingPaths.length,
    );
    if (result && result.failed === 0 && missingPaths.length === 0) {
      this.exportList.clear();
    }
    if (missingPaths.length) {
      console.warn("[export-note-bundle] list not found:", missingPaths);
    }
  }

  async runByTag(tag: string) {
    const files = filesByTag(this.app, tag);
    if (files.length === 0) {
      new Notice(T.emptyTag(tag));
      return;
    }

    const dest = await this.resolveDestBase();
    if (!dest) return;

    const safeTag = tag.replace(/^#/, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    await this.runBatch(files, dest, `Tag_${safeTag}_${stamp()}`);
  }

  private async runBatch(
    files: TFile[],
    dest: string,
    label: string,
    skipped = 0,
    hierarchyRoot?: TFolder,
  ): Promise<BatchResult | null> {
    const notice = new Notice(T.batchStart, 0);
    const progress = (message: string) => notice.setMessage(`${T.exporting} ${message}`);

    try {
      const result =
        this.settings.attachmentMode === "shared"
          ? await exportBatchShared(
              this.app,
              files,
              dest,
              label,
              this.settings.attachmentDirName,
              progress,
              hierarchyRoot,
            )
          : await exportBatchPerNote(
              this.app,
              files,
              dest,
              label,
              this.settings.attachmentDirName,
              progress,
              hierarchyRoot,
            );

      notice.hide();

      const lines = [
        T.batchDone(result.rootOut),
        T.stats(result.succeeded, result.total, result.totalAssets),
      ];
      if (result.totalRenamed) lines.push(T.countRenamed(result.totalRenamed));
      if (result.failed) lines.push(T.countFailed(result.failed));
      if (result.totalMissing) lines.push(T.countUnresolved(result.totalMissing));
      if (skipped) lines.push(T.countSkipped(skipped));
      new Notice(lines.join("\n"), 10000);

      const failedItems = result.items.filter((item) => !item.ok);
      if (failedItems.length) {
        console.warn("[export-note-bundle] batch failures:", failedItems);
      }

      const unresolvedItems = result.items.filter(
        (item) => item.ok && (item.missing?.length ?? 0) > 0,
      );
      if (unresolvedItems.length) {
        console.warn("[export-note-bundle] batch unresolved:", unresolvedItems);
      }

      if (this.settings.openFolderAfterExport) openInOs(result.rootOut);
      return result;
    } catch (error) {
      notice.hide();
      console.error("[export-note-bundle] batch failed", error);
      new Notice(T.batchFailed((error as Error).message));
      return null;
    }
  }

  async resolveDestBase(): Promise<string | null> {
    const configured = this.settings.exportBaseDir?.trim();
    if (configured) return configured;

    const picked = await pickDirectoryViaDialog();
    if (picked) return picked;

    new Notice(T.pleaseConfigure, 6000);
    return null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

function isSupported(file: TFile): boolean {
  return CONTENT_ROOT_EXTENSIONS.has(file.extension.toLowerCase());
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

async function pickDirectoryViaDialog(): Promise<string | null> {
  const req = (window as unknown as { require?: (module: string) => unknown }).require;
  if (!req) return null;

  for (const moduleName of ["@electron/remote", "electron"]) {
    try {
      const mod = req(moduleName) as {
        dialog?: {
          showOpenDialog?: (options: {
            title: string;
            properties: string[];
          }) => Promise<{ canceled?: boolean; filePaths?: string[] }>;
        };
        remote?: {
          dialog?: {
            showOpenDialog?: (options: {
              title: string;
              properties: string[];
            }) => Promise<{ canceled?: boolean; filePaths?: string[] }>;
          };
        };
      };
      const dialog = mod.dialog ?? mod.remote?.dialog;
      if (!dialog?.showOpenDialog) continue;

      const result = await dialog.showOpenDialog({
        title: "Choose export base directory",
        properties: ["openDirectory", "createDirectory"],
      });

      if (!result.canceled && result.filePaths?.[0]) {
        return result.filePaths[0];
      }
      return null;
    } catch {
      // Try the next module.
    }
  }

  return null;
}

function openInOs(dir: string) {
  try {
    const req = (window as unknown as { require?: (module: string) => unknown }).require;
    if (!req) return;

    const electron = req("electron") as {
      shell?: { openPath?: (target: string) => Promise<string> | string };
      remote?: { shell?: { openPath?: (target: string) => Promise<string> | string } };
    };
    const shell = electron.shell ?? electron.remote?.shell;
    shell?.openPath?.(dir);
  } catch {
    // Non-fatal.
  }
}

class TagSuggestModal extends FuzzySuggestModal<string> {
  constructor(app: App, private onPick: (tag: string) => void) {
    super(app);
    this.setPlaceholder(T.pickTag);
  }

  getItems(): string[] {
    return listAllTags(this.app);
  }

  getItemText(tag: string): string {
    return tag;
  }

  onChooseItem(tag: string): void {
    this.onPick(tag);
  }
}

class ExportSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ExportNoteBundlePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(T.settingBaseDir)
      .setDesc(T.settingBaseDirDesc)
      .addText((text) =>
        text
          .setPlaceholder("D:\\Exports")
          .setValue(this.plugin.settings.exportBaseDir)
          .onChange(async (value) => {
            this.plugin.settings.exportBaseDir = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(T.settingOpen)
      .setDesc(T.settingOpenDesc)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openFolderAfterExport)
          .onChange(async (value) => {
            this.plugin.settings.openFolderAfterExport = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(T.settingMode)
      .setDesc(T.settingModeDesc)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("per-note", T.modePerNote)
          .addOption("shared", T.modeShared)
          .setValue(this.plugin.settings.attachmentMode)
          .onChange(async (value) => {
            this.plugin.settings.attachmentMode = value as AttachmentMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(T.settingDirName)
      .setDesc(T.settingDirNameDesc)
      .addText((text) =>
        text
          .setPlaceholder("Attachment")
          .setValue(this.plugin.settings.attachmentDirName)
          .onChange(async (value) => {
            const trimmed = (value ?? "").trim();
            this.plugin.settings.attachmentDirName = trimmed || "Attachment";
            await this.plugin.saveSettings();
          }),
      );
  }
}
