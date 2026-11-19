/**
 * 时匣 ChronoBox v2.0 核心类型定义
 */

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
  /** 跟踪的非忽略子文件夹总数（包含空文件夹） */
  totalDirs?: number;
}

/**
 * 视觉目录快照条目（用于在时间轴、检视器、差异对比中以 Windows 大图标网格直观还原存档状态）
 */
export interface VisualSnapshotItem {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  ext: string;
  size: number;
  status?: FileChangeStatus;
}

/**
 * 时间盒子（存档 / Snapshot）
 */
export interface ArchiveRecord {
  id: string;
  parentId: string | null;
  title: string;
  note: string;
  createdAt: number;
  /** 3色极简标记（红/黄/绿） */
  tags: TagColor[];
  /** 自定义文字标签（如「导师审阅」「投稿版」「实验数据」） */
  customTags?: string[];
  /** 是否已软归档（移入归档回收站，而非直接物理删除） */
  archived?: boolean;
  archivedAt?: number;
  isAuto: boolean;
  summary: ChangeSummary;
  files: Record<string, FileEntry>;
  /** 完整记录的所有子目录相对路径（含空文件夹） */
  directories?: string[];
  /** 可选附加视觉截图（Data URL，如粘贴的 Origin 图表或 Word 截屏） */
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
  /** 区分文件与文件夹（含空文件夹变更） */
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
  summary: {
    added: number;
    modified: number;
    deleted: number;
  };
  /** 存档前后的视觉目录快照，便于直观对比文件图标网格 */
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
  /** 自定义文字标签（用于左侧栏分类筛选与识别） */
  customTags?: string[];
  /** 软归档标记：暂停跟踪，但保留全部本地文件与历史存档 */
  archived?: boolean;
  archivedAt?: number;
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

/** 文件浏览器（资源管理器视图）中的一条目录/文件记录 */
export interface BrowserEntry {
  name: string;
  relPath: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  ext: string;
  /** 该文件是否已被 00【Archive】接管 / 是否在隐藏清单中（由渲染层补充） */
  archived?: boolean;
}

export interface BrowserListResult {
  relDir: string;
  entries: BrowserEntry[];
  /** 父目录相对路径，根目录为 null */
  parentRel: string | null;
  /** 该项目下出现过的全部子目录（供左侧树使用） */
  allDirs: string[];
}

export interface ArchiveBoxOperationResult {
  succeeded: ArchiveBoxEntry[];
  skipped: Array<{ sourcePath: string; reason: string }>;
}


export type FileMatrixCellStatus =
  | 'initial'
  | 'added'
  | 'modified'
  | 'renamed'
  /** 同内容但父目录发生变化 —— 文件被移动到别的文件夹（跨目录搬移） */
  | 'moved'
  /** 内容与快照中另一个仍然存在的文件完全一致 —— 被复制出来的一份副本 */
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
  /** 本列中该文件的复制来源路径（仅 status === 'copied'） */
  copiedFrom?: string;
  /** 移动/重命名前所在目录 */
  fromDir?: string;
  /** 移动/重命名后所在目录 */
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
