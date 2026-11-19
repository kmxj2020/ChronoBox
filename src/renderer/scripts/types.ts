export type TagColor = 'red' | 'yellow' | 'green';
export type WindowMode = 'full' | 'mini-bar' | 'mini-dot';
export type LanguageCode = 'zh-CN' | 'en-US';
export type ThemeMode = 'light' | 'dark' | 'spring' | 'summer' | 'autumn' | 'winter' | 'system';
export type FileChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileEntry {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  isBinary: boolean;
}

export interface ChangeSummary {
  added: number;
  modified: number;
  deleted: number;
  totalFiles: number;
  totalSize: number;
  totalDirs?: number;
}

export interface VisualSnapshotItem {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  ext: string;
  size: number;
  status?: FileChangeStatus;
}

export interface ArchiveRecord {
  id: string;
  parentId: string | null;
  title: string;
  note: string;
  createdAt: number;
  tags: TagColor[];
  customTags?: string[];
  archived?: boolean;
  archivedAt?: number;
  isAuto: boolean;
  summary: ChangeSummary;
  files: Record<string, FileEntry>;
  directories?: string[];
  coverImageDataUrl?: string;
}

export interface RepoManifest {
  schemaVersion: number;
  repoId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  currentArchiveId: string | null;
  archives: Record<string, ArchiveRecord>;
  ignorePatterns: string[];
  autoArchive: {
    enabled: boolean;
    intervalMinutes: number;
  };
  /** 常用文档（Word/PDF/Excel/Origin等）保存时自动存档与冷却合并配置 */
  docSaveAutoArchive?: {
    enabled: boolean;
    extensions: string[];
    cooldownMinutes: number;
  };
}

export interface FileDiffItem {
  path: string;
  status: FileChangeStatus;
  entryType?: 'file' | 'directory';
  oldSize?: number;
  newSize?: number;
  oldHash?: string;
  newHash?: string;
  oldMtimeMs?: number;
  newMtimeMs?: number;
  isBinary: boolean;
}

export interface ArchiveDiffResult {
  fromId: string | null;
  fromTitle: string;
  toId: string | null;
  toTitle: string;
  items: FileDiffItem[];
  summary: { added: number; modified: number; deleted: number };
  fromVisual?: VisualSnapshotItem[];
  toVisual?: VisualSnapshotItem[];
}

export interface TextDiffLine {
  type: 'equal' | 'add' | 'remove';
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

export interface TextDiffResult {
  path: string;
  isBinary: boolean;
  truncated: boolean;
  lines: TextDiffLine[];
  additions: number;
  deletions: number;
}

export interface WorkspaceStatus {
  projectId: string;
  rootPath: string;
  name: string;
  exists: boolean;
  archived?: boolean;
  customTags?: string[];
  pinned?: boolean;
  currentArchiveId: string | null;
  archiveCount: number;
  changes: FileDiffItem[];
  hasChanges: boolean;
  lastCheckedAt: number;
}

export interface TrackedProject {
  id: string;
  /** 绑定仓库唯一 ID，用于文件夹被外部重命名后自动识别并无损重连 */
  repoId?: string;
  name: string;
  rootPath: string;
  addedAt: number;
  lastOpenedAt: number;
  pinned?: boolean;
  customTags?: string[];
  archived?: boolean;
  archivedAt?: number;
}

export interface ArchiveBoxConfig {
  folderName: string;
  dateFormat: 'YYYY-MM-DD' | 'YYYYMMDD' | 'YYYY-MM';
  preserveRelativePath: boolean;
  defaultAction: 'move' | 'copy';
  ignoreInSnapshots: boolean;
}

export interface ArchiveBoxEntry {
  id: string;
  projectId: string | null;
  baseDir: string;
  archiveRoot: string;
  dateFolder: string;
  originalPath: string;
  archivedPath: string;
  fileName: string;
  relativeOriginalPath: string;
  isDirectory: boolean;
  size: number;
  action: 'move' | 'copy';
  archivedAt: number;
  restored: boolean;
  restoredAt?: number;
  restoredToPath?: string;
  existsOnDisk?: boolean;
}

export interface ArchiveBoxOperationResult {
  succeeded: ArchiveBoxEntry[];
  skipped: Array<{ sourcePath: string; reason: string }>;
}

export interface AppConfig {
  language: LanguageCode;
  theme: ThemeMode;
  projects: TrackedProject[];
  activeProjectId: string | null;
  windowMode: WindowMode;
  /** 悬浮窗独立开关：开启后无论主窗口打开/关闭/后台，始终显示悬浮球或 Mini 条 */
  floatingEnabled: boolean;
  /** 悬浮窗形态：悬浮球 (mini-dot) 或 迷你条 (mini-bar) */
  floatingStyle: 'mini-dot' | 'mini-bar';
  miniPosition?: { x: number; y: number };
  shortcuts: {
    quickArchive: string;
    toggleMini: string;
  };
  archiveBox: ArchiveBoxConfig;
  closeBehavior: 'tray' | 'quit';
  launchAtLogin: boolean;
  beyondComparePath: string;
  restrictNestedFolders: boolean;
  pinnedFiles?: Record<string, string[]>;
}

export interface StorageStats {
  objectCount: number;
  compressedBytes: number;
  logicalBytes: number;
  savedBytes: number;
  dedupRatio: number;
  archiveCount: number;
  softArchivedCount?: number;
}

export interface DagNodeLayout {
  id: string;
  parentId: string | null;
  title: string;
  createdAt: number;
  tags: TagColor[];
  customTags?: string[];
  isAuto: boolean;
  isCurrent: boolean;
  summary: ChangeSummary;
  depth: number;
  lane: number;
  x: number;
  y: number;
  branchColor: string;
}

export interface DagEdgeLayout {
  fromId: string;
  toId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: string;
  isBranch: boolean;
}

export interface DagGraphLayout {
  nodes: DagNodeLayout[];
  edges: DagEdgeLayout[];
  width: number;
  height: number;
}

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
  createArchive: (
    projectId: string,
    options: {
      title?: string;
      note?: string;
      tags?: TagColor[];
      customTags?: string[];
      coverImageDataUrl?: string;
      isAuto?: boolean;
      allowEmpty?: boolean;
    }
  ) => Promise<ArchiveRecord>;
  switchArchive: (
    projectId: string,
    archiveId: string,
    options?: { autoBackupIfDirty?: boolean; force?: boolean }
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

declare global {
  interface Window {
    chronoboxApi: ChronoBoxApi;
  }
}

export const WORKING_TREE_ID = '__WORKING__';


export interface BrowserEntry {
  name: string;
  relPath: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  ext: string;
}

export interface BrowserListResult {
  relDir: string;
  entries: BrowserEntry[];
  parentRel: string | null;
  allDirs: string[];
}

export type FileMatrixCellStatus =
  | 'initial'
  | 'added'
  | 'modified'
  | 'renamed'
  /** 同内容但父目录变化 → 移动 */
  | 'moved'
  /** 与另一份仍存在的文件字节级一致 → 复制出来的副本 */
  | 'copied'
  | 'unchanged'
  | 'archived'
  | 'deleted'
  | 'absent';

export interface FileMatrixColumn {
  id: string;
  versionLabel: string;
  title: string;
  createdAt: number;
  isCurrent: boolean;
  isWorking: boolean;
  tags: TagColor[];
}

export interface FileMatrixCell {
  colId: string;
  status: FileMatrixCellStatus;
  path?: string;
  previousPath?: string;
  size?: number;
  deltaSize?: number;
  hash?: string;
  archivedDateFolder?: string;
  copiedFrom?: string;
  fromDir?: string;
  toDir?: string;
}

export interface FileMatrixRow {
  rowId: string;
  displayPath: string;
  ext: string;
  isBinary: boolean;
  currentState: 'active' | 'archived' | 'deleted';
  editCount: number;
  firstColIndex: number;
  lastModifiedAt: number;
  cells: FileMatrixCell[];
}

export interface FileMatrixResult {
  columns: FileMatrixColumn[];
  rows: FileMatrixRow[];
  stats: {
    totalFilesTracked: number;
    activeFiles: number;
    archivedFiles: number;
    deletedFiles: number;
  };
}


export interface ActiveContextStatus {
  state: 'synced' | 'dirty' | 'untracked' | 'idle';
  matchedProjectId: string | null;
  folderPath: string | null;
  filePath: string | null;
  displayName: string;
  changeCount: number;
  archiveCount: number;
  sourceKind: 'explorer' | 'word' | 'excel' | 'powerpoint' | 'other';
}

export type TempHistoryOpType = 'modified' | 'renamed' | 'created' | 'deleted';

export interface TempHistoryEntry {
  id: string;
  seq: number;
  path: string;
  previousPath?: string;
  opType: TempHistoryOpType;
  hash: string | null;
  size: number;
  timestamp: number;
  isCurrentOnDisk?: boolean;
}

export type BundleHistoryScope = 'current-branch' | 'all' | 'compressed-only';

export interface ExportBundleResult {
  bundleDir: string;
  descriptorPath: string;
  finalFilesCount: number;
  exportedHistoryCount: number;
  copiedArchiveBox: boolean;
  autoArchivedFinal: boolean;
}

export interface ImportBundleResult {
  project: TrackedProject;
  restoredPath: string;
  archiveCount: number;
}

export interface DuplicateFileGroup {
  hash: string;
  size: number;
  wastedBytes: number;
  paths: string[];
}

export interface DuplicateScanResult {
  groups: DuplicateFileGroup[];
  totalDuplicateFiles: number;
  totalWastedBytes: number;
  totalWorkspaceBytes: number;
}

export interface FileMilestoneItem {
  archiveId: string;
  versionLabel: string;
  title: string;
  createdAt: number;
  path: string;
  previousPath?: string;
  action: 'initial' | 'added' | 'modified' | 'renamed' | 'deleted';
  size: number;
  deltaSize: number;
  hash: string | null;
  isWorking: boolean;
}

export interface GlobalSearchHit {
  kind: 'project' | 'archive' | 'file';
  projectId: string;
  projectName: string;
  title: string;
  subtitle: string;
  archiveId?: string;
  relPath?: string;
  timestamp: number;
}

export interface ReportDailyPoint {
  date: string;
  fullDate: string;
  archives: number;
  changes: number;
}

export interface ReportTypeSlice {
  label: string;
  count: number;
  color: string;
}

export interface ReportTopFile {
  name: string;
  relPath: string;
  projectName: string;
  editCount: number;
  latestSize: number;
}

export interface ReportMilestoneRow {
  projectName: string;
  date: string;
  title: string;
  added: number;
  modified: number;
  deleted: number;
  totalFiles: number;
  totalSize: number;
  note: string;
}

export interface ProgressReportResult {
  periodLabel: string;
  generatedAt: number;
  markdown: string;
  archiveCount: number;
  projectCount: number;
  touchedFilesCount: number;
  totalAdded: number;
  totalModified: number;
  totalDeleted: number;
  dailyActivity: ReportDailyPoint[];
  fileTypeBreakdown: ReportTypeSlice[];
  topFiles: ReportTopFile[];
  milestones: ReportMilestoneRow[];
}
