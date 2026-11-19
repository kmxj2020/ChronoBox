import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  AppConfig,
  ArchiveBoxConfig,
  BrowserListResult,
  ArchiveBoxEntry,
  ArchiveBoxOperationResult,
  ArchiveDiffResult,
  ArchiveRecord,
  DagGraphLayout,
  FileEntry,
  FileMatrixResult,
  LanguageCode,
  RepoManifest,
  StorageStats,
  TagColor,
  TextDiffResult,
  ThemeMode,
  TrackedProject,
  WindowMode,
  WorkspaceStatus
} from '../core/types';
import { CreateArchiveOptions, SwitchArchiveOptions } from '../core/repository';
import { ActiveContextStatus } from '../core/activeContext';
import { TempHistoryEntry } from '../core/tempHistory';
import { BundleHistoryScope, ExportBundleResult, ImportBundleResult } from '../core/projectBundle';
import { DuplicateScanResult, FileMilestoneItem, GlobalSearchHit, ProgressReportResult } from '../core/analyticsEngine';

export interface ChronoBoxApi {
  getConfig: () => Promise<AppConfig>;
  setLanguage: (lang: LanguageCode) => Promise<AppConfig>;
  setTheme: (theme: ThemeMode) => Promise<AppConfig>;
  updateGeneralSettings: (partial: { closeBehavior?: 'tray' | 'quit'; launchAtLogin?: boolean; beyondComparePath?: string; restrictNestedFolders?: boolean; shortcuts?: { quickArchive?: string; toggleMini?: string } }) => Promise<AppConfig>;
  togglePinFile: (projectId: string, relPath: string) => Promise<string[]>;
  openManualMarkdown: () => Promise<boolean>;
  showMiniContextMenu: () => void;
  getActiveContextStatus: () => Promise<ActiveContextStatus>;
  detectBeyondCompare: () => Promise<string>;
  pickBeyondCompareExe: () => Promise<string | null>;
  bcCompareFile: (projectId: string, fromId: string | null, toId: string | null, relPath: string) => Promise<{ launched: boolean; needsPath: boolean; message?: string }>;
  bcCompareFolder: (projectId: string, fromId: string | null, toId: string | null) => Promise<{ launched: boolean; needsPath: boolean; message?: string }>;
  setWindowMode: (mode: WindowMode) => Promise<WindowMode>;
  showMainWindow: () => Promise<void>;
  toggleMainWindow: () => Promise<boolean>;
  setFloatingEnabled: (enabled: boolean) => Promise<AppConfig>;
  setFloatingStyle: (style: 'mini-dot' | 'mini-bar') => Promise<AppConfig>;
  dragMiniWindow: (dx: number, dy: number) => void;
  snapMiniToEdge: () => Promise<'left' | 'right' | 'none'>;

  pickFolder: () => Promise<string | null>;
  pickExportFolder: () => Promise<string | null>;
  pickBundleFile: () => Promise<string | null>;
  openFolder: (folderPath: string) => Promise<void>;
  statPath: (targetPath: string) => Promise<{ exists: boolean; isDirectory: boolean; resolved: string; name: string; parentDir: string }>;
  showFileInExplorer: (projectId: string, relPath: string) => Promise<void>;
  openFileInDefaultApp: (projectId: string, relPath: string) => Promise<{ ok: boolean; error?: string }>;
  showMatrixFileMenu: (payload: {
    projectId: string;
    relPath: string;
    isPinned: boolean;
    currentState: string;
    isHidden?: boolean;
  }) => void;

  listProjectStatuses: () => Promise<WorkspaceStatus[]>;
  getProjectStatus: (projectId: string) => Promise<WorkspaceStatus>;
  findNestedChildProjects: (folderPath: string) => Promise<TrackedProject[]>;
  upgradeToParentProject: (parentFolderPath: string, customName?: string) => Promise<{ project: TrackedProject; archivedChildren: TrackedProject[] }>;
  addParentExcludingChildren: (parentFolderPath: string, customName?: string) => Promise<{ project: TrackedProject; excludedChildren: TrackedProject[]; addedPatterns: string[] }>;
  relocateProject: (projectId: string, newFolderPath: string) => Promise<TrackedProject>;
  exportProjectBundle: (projectId: string, options: { destinationParentDir: string; historyScope: BundleHistoryScope; autoArchiveFinalIfDirty: boolean; softArchiveAfterExport?: boolean }) => Promise<ExportBundleResult>;
  importProjectBundle: (bundleFileOrDir: string, targetDir: string) => Promise<ImportBundleResult>;
  showProjectSidebarMenu: (projectId: string, name: string) => void;
  addProject: (folderPath: string, customName?: string) => Promise<TrackedProject>;
  archiveProject: (projectId: string) => Promise<AppConfig>;
  unarchiveProject: (projectId: string) => Promise<AppConfig>;
  removeProject: (projectId: string, deleteHistoryData?: boolean) => Promise<AppConfig>;
  setActiveProject: (projectId: string | null) => Promise<AppConfig>;
  renameProject: (projectId: string, newName: string, syncDiskFolder?: boolean) => Promise<TrackedProject>;
  updateProjectTags: (projectId: string, tags: string[]) => Promise<TrackedProject>;
  togglePinProject: (projectId: string) => Promise<TrackedProject>;

  getManifest: (projectId: string) => Promise<RepoManifest>;
  listArchives: (
    projectId: string,
    filter?: {
      query?: string;
      tag?: TagColor | null;
      customTag?: string | null;
      includeArchived?: boolean;
      onlyArchived?: boolean;
      order?: 'desc' | 'asc';
    }
  ) => Promise<ArchiveRecord[]>;
  createArchive: (projectId: string, options: CreateArchiveOptions) => Promise<ArchiveRecord>;
  switchArchive: (
    projectId: string,
    archiveId: string,
    options?: SwitchArchiveOptions
  ) => Promise<{ switchedTo: ArchiveRecord; backupArchive: ArchiveRecord | null }>;
  restoreToNewFolder: (
    projectId: string,
    archiveId: string,
    destParentDir?: string
  ) => Promise<{ exportedFiles: number; destinationDir: string }>;
  restoreSingleFile: (
    projectId: string,
    archiveId: string,
    relPath: string,
    mode?: 'overwrite' | 'copy'
  ) => Promise<{ entry: FileEntry; restoredPath: string }>;
  exportArchive: (
    projectId: string,
    archiveId: string,
    destDir: string
  ) => Promise<{ exportedFiles: number; destinationDir: string }>;
  diffArchives: (projectId: string, fromId: string | null, toId: string | null) => Promise<ArchiveDiffResult>;
  diffFileText: (
    projectId: string,
    fromId: string | null,
    toId: string | null,
    relPath: string
  ) => Promise<TextDiffResult>;
  toggleTag: (projectId: string, archiveId: string, color: TagColor) => Promise<ArchiveRecord>;
  updateArchiveMeta: (
    projectId: string,
    archiveId: string,
    updates: { title?: string; note?: string; tags?: TagColor[]; customTags?: string[] }
  ) => Promise<ArchiveRecord>;
  softArchiveRecord: (projectId: string, archiveId: string) => Promise<ArchiveRecord>;
  restoreSoftArchivedRecord: (projectId: string, archiveId: string) => Promise<ArchiveRecord>;
  deleteArchive: (projectId: string, archiveId: string) => Promise<{ deletedId: string; newCurrentArchiveId: string | null }>;
  getDagLayout: (projectId: string) => Promise<DagGraphLayout>;
  getFileMatrix: (projectId: string, onlyCurrentBranch?: boolean) => Promise<FileMatrixResult>;
  getFileTempHistory: (projectId: string, relPath: string) => Promise<TempHistoryEntry[]>;
  restoreTempHistoryEntry: (projectId: string, entryId: string) => Promise<{ entry: TempHistoryEntry; restoredPath: string }>;
  getStorageStats: (projectId: string) => Promise<StorageStats>;
  runGC: (projectId: string) => Promise<{ removedObjects: number; freedBytes: number }>;
  updateIgnorePatterns: (projectId: string, patterns: string[]) => Promise<RepoManifest>;
  updateAutoArchive: (projectId: string, enabled: boolean, intervalMinutes: number) => Promise<RepoManifest>;
  updateDocSaveAutoArchive: (projectId: string, enabled: boolean, extensions: string[], cooldownMinutes: number) => Promise<RepoManifest>;

  /* 文件浏览器（资源管理器视图） */
  browserList: (projectId: string, relDir?: string) => Promise<BrowserListResult>;
  browserNewFolder: (projectId: string, relDir: string, name: string) => Promise<boolean>;
  browserRename: (projectId: string, relPath: string, newName: string) => Promise<boolean>;
  browserMoveInto: (projectId: string, relPath: string, targetRelDir: string) => Promise<string>;
  browserDuplicate: (projectId: string, relPath: string) => Promise<string>;
  browserTrash: (projectId: string, relPath: string) => Promise<boolean>;
  browserReveal: (projectId: string, relPath: string) => Promise<void>;
  browserImport: (
    projectId: string,
    sourcePaths: string[],
    targetRelDir?: string
  ) => Promise<{ imported: string[]; skipped: Array<{ path: string; reason: string }> }>;

  getPathForFile: (file: File) => string;
  archiveBoxDropPaths: (sourcePaths: string[], action?: 'move' | 'copy') => Promise<ArchiveBoxOperationResult>;
  archiveBoxList: (projectId: string) => Promise<ArchiveBoxEntry[]>;
  archiveBoxRestore: (archiveRoot: string, entryId: string) => Promise<ArchiveBoxEntry>;
  archiveBoxUpdateConfig: (partial: Partial<ArchiveBoxConfig>) => Promise<AppConfig>;
  archiveBoxOpenFolder: (projectId: string) => Promise<void>;

  onWorkspaceUpdated: (cb: (payload: { projectId: string }) => void) => () => void;
  onConfigChanged: (cb: (config: AppConfig) => void) => () => void;
  onWindowModeChanged: (cb: (mode: WindowMode) => void) => () => void;
  onActiveContextChanged: (cb: (ctx: ActiveContextStatus) => void) => () => void;
  onToast: (cb: (toast: { type: 'success' | 'info' | 'error'; message: string }) => void) => () => void;
  findDuplicateFiles: (projectId: string) => Promise<DuplicateScanResult>;
  archiveDuplicateFile: (projectId: string, relPath: string) => Promise<ArchiveBoxOperationResult>;
  getFileMilestones: (projectId: string, relPath: string) => Promise<FileMilestoneItem[]>;
  globalSearch: (query: string) => Promise<GlobalSearchHit[]>;
  generateProgressReport: (options: { projectId?: string | null; days: number }) => Promise<ProgressReportResult>;
  exportReportMarkdown: (markdown: string, defaultName?: string) => Promise<string | null>;
  onUiAction: (cb: (payload: { action: string; projectId?: string; relPath?: string }) => void) => () => void;
}

const api: ChronoBoxApi = {
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  setLanguage: (lang) => ipcRenderer.invoke('app:set-language', lang),
  setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
  updateGeneralSettings: (partial) => ipcRenderer.invoke('app:update-general-settings', partial),
  togglePinFile: (projectId, relPath) => ipcRenderer.invoke('project:toggle-pin-file', projectId, relPath),
  openManualMarkdown: () => ipcRenderer.invoke('app:open-manual-md'),
  showMiniContextMenu: () => ipcRenderer.send('mini:show-context-menu'),
  getActiveContextStatus: () => ipcRenderer.invoke('context:get-active-status'),
  detectBeyondCompare: () => ipcRenderer.invoke('bc:detect-path'),
  pickBeyondCompareExe: () => ipcRenderer.invoke('bc:pick-exe'),
  bcCompareFile: (projectId, fromId, toId, relPath) => ipcRenderer.invoke('bc:compare-file', projectId, fromId, toId, relPath),
  bcCompareFolder: (projectId, fromId, toId) => ipcRenderer.invoke('bc:compare-folder', projectId, fromId, toId),
  setWindowMode: (mode) => ipcRenderer.invoke('window:set-mode', mode),
  showMainWindow: () => ipcRenderer.invoke('window:show-main'),
  toggleMainWindow: () => ipcRenderer.invoke('window:toggle-main'),
  setFloatingEnabled: (enabled) => ipcRenderer.invoke('floating:set-enabled', enabled),
  setFloatingStyle: (style) => ipcRenderer.invoke('floating:set-style', style),
  dragMiniWindow: (dx, dy) => ipcRenderer.send('window:mini-drag', { dx, dy }),
  snapMiniToEdge: () => ipcRenderer.invoke('window:mini-snap-edge'),

  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  pickExportFolder: () => ipcRenderer.invoke('dialog:pick-export-folder'),
  pickBundleFile: () => ipcRenderer.invoke('dialog:pick-bundle'),
  openFolder: (folderPath) => ipcRenderer.invoke('shell:open-folder', folderPath),
  statPath: (targetPath) => ipcRenderer.invoke('fs:stat-path', targetPath),
  showFileInExplorer: (projectId, relPath) => ipcRenderer.invoke('shell:show-file', projectId, relPath),
  openFileInDefaultApp: (projectId, relPath) => ipcRenderer.invoke('shell:open-file', projectId, relPath),
  showMatrixFileMenu: (payload) => ipcRenderer.send('matrix:show-file-menu', payload),

  listProjectStatuses: () => ipcRenderer.invoke('project:list-statuses'),
  getProjectStatus: (projectId) => ipcRenderer.invoke('project:get-status', projectId),
  findNestedChildProjects: (folderPath) => ipcRenderer.invoke('project:find-nested-children', folderPath),
  upgradeToParentProject: (parentFolderPath, customName) => ipcRenderer.invoke('project:upgrade-to-parent', parentFolderPath, customName),
  addParentExcludingChildren: (parentFolderPath, customName) => ipcRenderer.invoke('project:add-parent-excluding-children', parentFolderPath, customName),
  relocateProject: (projectId, newFolderPath) => ipcRenderer.invoke('project:relocate', projectId, newFolderPath),
  exportProjectBundle: (projectId, options) => ipcRenderer.invoke('project:export-bundle', projectId, options),
  importProjectBundle: (bundleFileOrDir, targetDir) => ipcRenderer.invoke('project:import-bundle', bundleFileOrDir, targetDir),
  showProjectSidebarMenu: (projectId, name) => ipcRenderer.send('project:show-sidebar-menu', { projectId, name }),
  addProject: (folderPath, customName) => ipcRenderer.invoke('project:add', folderPath, customName),
  archiveProject: (projectId) => ipcRenderer.invoke('project:archive', projectId),
  unarchiveProject: (projectId) => ipcRenderer.invoke('project:unarchive', projectId),
  removeProject: (projectId, deleteHistoryData = false) =>
    ipcRenderer.invoke('project:remove', projectId, deleteHistoryData),
  setActiveProject: (projectId) => ipcRenderer.invoke('project:set-active', projectId),
  renameProject: (projectId, newName, syncDiskFolder = false) =>
    ipcRenderer.invoke('project:rename', projectId, newName, syncDiskFolder),
  updateProjectTags: (projectId, tags) => ipcRenderer.invoke('project:update-tags', projectId, tags),
  togglePinProject: (projectId) => ipcRenderer.invoke('project:toggle-pin', projectId),

  getManifest: (projectId) => ipcRenderer.invoke('repo:get-manifest', projectId),
  listArchives: (projectId, filter) => ipcRenderer.invoke('repo:list-archives', projectId, filter),
  createArchive: (projectId, options) => ipcRenderer.invoke('repo:create-archive', projectId, options),
  switchArchive: (projectId, archiveId, options = { autoBackupIfDirty: true }) =>
    ipcRenderer.invoke('repo:switch-archive', projectId, archiveId, options),
  restoreToNewFolder: (projectId, archiveId, destParentDir) =>
    ipcRenderer.invoke('repo:restore-to-new-folder', projectId, archiveId, destParentDir),
  restoreSingleFile: (projectId, archiveId, relPath, mode = 'overwrite') =>
    ipcRenderer.invoke('repo:restore-file', projectId, archiveId, relPath, mode),
  exportArchive: (projectId, archiveId, destDir) =>
    ipcRenderer.invoke('repo:export-archive', projectId, archiveId, destDir),
  diffArchives: (projectId, fromId, toId) => ipcRenderer.invoke('repo:diff-archives', projectId, fromId, toId),
  diffFileText: (projectId, fromId, toId, relPath) =>
    ipcRenderer.invoke('repo:diff-file-text', projectId, fromId, toId, relPath),
  toggleTag: (projectId, archiveId, color) => ipcRenderer.invoke('repo:toggle-tag', projectId, archiveId, color),
  updateArchiveMeta: (projectId, archiveId, updates) =>
    ipcRenderer.invoke('repo:update-meta', projectId, archiveId, updates),
  softArchiveRecord: (projectId, archiveId) => ipcRenderer.invoke('repo:soft-archive', projectId, archiveId),
  restoreSoftArchivedRecord: (projectId, archiveId) => ipcRenderer.invoke('repo:restore-soft-archived', projectId, archiveId),
  deleteArchive: (projectId, archiveId) => ipcRenderer.invoke('repo:delete-archive', projectId, archiveId),
  getDagLayout: (projectId) => ipcRenderer.invoke('repo:get-dag', projectId),
  getFileMatrix: (projectId, onlyCurrentBranch = true) => ipcRenderer.invoke('repo:get-file-matrix', projectId, onlyCurrentBranch),
  getFileTempHistory: (projectId, relPath) => ipcRenderer.invoke('repo:get-temp-history', projectId, relPath),
  restoreTempHistoryEntry: (projectId, entryId) => ipcRenderer.invoke('repo:restore-temp-history', projectId, entryId),
  getStorageStats: (projectId) => ipcRenderer.invoke('repo:get-storage-stats', projectId),
  runGC: (projectId) => ipcRenderer.invoke('repo:run-gc', projectId),
  updateIgnorePatterns: (projectId, patterns) => ipcRenderer.invoke('repo:update-ignore', projectId, patterns),
  updateAutoArchive: (projectId, enabled, intervalMinutes) =>
    ipcRenderer.invoke('repo:update-auto-archive', projectId, enabled, intervalMinutes),
  updateDocSaveAutoArchive: (projectId, enabled, extensions, cooldownMinutes) =>
    ipcRenderer.invoke('repo:update-doc-save-archive', projectId, enabled, extensions, cooldownMinutes),

  browserList: (projectId, relDir = '') => ipcRenderer.invoke('browser:list', projectId, relDir),
  browserNewFolder: (projectId, relDir, name) => ipcRenderer.invoke('browser:new-folder', projectId, relDir, name),
  browserRename: (projectId, relPath, newName) => ipcRenderer.invoke('browser:rename', projectId, relPath, newName),
  browserMoveInto: (projectId, relPath, targetRelDir) => ipcRenderer.invoke('browser:move-into', projectId, relPath, targetRelDir),
  browserDuplicate: (projectId, relPath) => ipcRenderer.invoke('browser:duplicate', projectId, relPath),
  browserTrash: (projectId, relPath) => ipcRenderer.invoke('browser:trash', projectId, relPath),
  browserReveal: (projectId, relPath) => ipcRenderer.invoke('browser:reveal', projectId, relPath),
  browserImport: (projectId, sourcePaths, targetRelDir = '') =>
    ipcRenderer.invoke('browser:import', projectId, sourcePaths, targetRelDir),

  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return (file as unknown as { path?: string }).path || '';
    }
  },
  archiveBoxDropPaths: (sourcePaths, action) => ipcRenderer.invoke('archiveBox:drop-paths', sourcePaths, action),
  archiveBoxList: (projectId) => ipcRenderer.invoke('archiveBox:list', projectId),
  archiveBoxRestore: (archiveRoot, entryId) => ipcRenderer.invoke('archiveBox:restore', archiveRoot, entryId),
  archiveBoxUpdateConfig: (partial) => ipcRenderer.invoke('archiveBox:update-config', partial),
  archiveBoxOpenFolder: (projectId) => ipcRenderer.invoke('archiveBox:open-folder', projectId),

  onWorkspaceUpdated: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { projectId: string }) => cb(payload);
    ipcRenderer.on('workspace:updated', handler);
    return () => ipcRenderer.removeListener('workspace:updated', handler);
  },
  onConfigChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, config: AppConfig) => cb(config);
    ipcRenderer.on('app:config-changed', handler);
    return () => ipcRenderer.removeListener('app:config-changed', handler);
  },
  onActiveContextChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, ctx: ActiveContextStatus) => cb(ctx);
    ipcRenderer.on('context:active-changed', handler);
    return () => ipcRenderer.removeListener('context:active-changed', handler);
  },
  onWindowModeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, mode: WindowMode) => cb(mode);
    ipcRenderer.on('window:mode-changed', handler);
    return () => ipcRenderer.removeListener('window:mode-changed', handler);
  },
  onToast: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, toast: { type: 'success' | 'info' | 'error'; message: string }) =>
      cb(toast);
    ipcRenderer.on('app:toast', handler);
    return () => ipcRenderer.removeListener('app:toast', handler);
  },
  findDuplicateFiles: (projectId) => ipcRenderer.invoke('analytics:find-duplicates', projectId),
  archiveDuplicateFile: (projectId, relPath) => ipcRenderer.invoke('analytics:archive-duplicate-file', projectId, relPath),
  getFileMilestones: (projectId, relPath) => ipcRenderer.invoke('analytics:file-milestones', projectId, relPath),
  globalSearch: (query) => ipcRenderer.invoke('analytics:global-search', query),
  generateProgressReport: (options) => ipcRenderer.invoke('analytics:progress-report', options),
  exportReportMarkdown: (markdown, defaultName) => ipcRenderer.invoke('analytics:export-report-md', markdown, defaultName),
  onUiAction: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { action: string; projectId?: string; relPath?: string }) => cb(payload);
    ipcRenderer.on('ui:action', handler);
    return () => ipcRenderer.removeListener('ui:action', handler);
  }
};

contextBridge.exposeInMainWorld('chronoboxApi', api);
