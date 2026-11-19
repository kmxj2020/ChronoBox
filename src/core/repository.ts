import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  ArchiveDiffResult,
  ArchiveRecord,
  DagGraphLayout,
  FileDiffItem,
  FileEntry,
  RepoManifest,
  StorageStats,
  TagColor,
  TextDiffResult
} from './types';
import { IgnoreMatcher, normalizeRelPath, REPO_DIR_NAME } from './ignore';
import { ObjectStore } from './objectStore';
import { TempHistoryEntry, TempHistoryStore } from './tempHistory';
import { scanWorkspaceFull, WorkspaceScanResult } from './scanner';
import { buildVisualSnapshot, computeFileDiffs, computeTextDiff, summarizeDiffs } from './diffEngine';
import { computeDagLayout } from './dagLayout';

export const WORKING_TREE_ID = '__WORKING__';
const MANIFEST_SCHEMA_VERSION = 2;

export interface CreateArchiveOptions {
  title?: string;
  note?: string;
  tags?: TagColor[];
  customTags?: string[];
  coverImageDataUrl?: string;
  isAuto?: boolean;
  allowEmpty?: boolean;
}

export interface SwitchArchiveOptions {
  autoBackupIfDirty?: boolean;
  force?: boolean;
}

/**
 * 时匣 ChronoBox v2.0 仓库核心引擎
 * - 完整支持空文件夹追踪与还原
 * - Windows 文件占用写锁预检（防 Word/Origin/CAD 打开文件时半途覆盖损坏）
 * - 软归档回收站（默认归档而非物理删除，彻底删除仅限设置危险区）
 * - 双模式安全恢复（覆盖恢复 vs 恢复到全新独立文件夹/副本文件）
 */
export class ChronoBoxRepository {
  public readonly rootPath: string;
  public readonly metaDir: string;
  public readonly manifestPath: string;
  public readonly manifestBackupPath: string;
  public readonly objectStore: ObjectStore;
  private readonly tempHistory: TempHistoryStore;

  /** 仓库元数据目录固定为项目根目录下的 .chronobox */
  public static resolveBestMetaDir(rootPath: string): string {
    return path.join(path.resolve(rootPath), REPO_DIR_NAME);
  }

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
    this.metaDir = ChronoBoxRepository.resolveBestMetaDir(this.rootPath);
    this.manifestPath = path.join(this.metaDir, 'manifest.json');
    this.manifestBackupPath = path.join(this.metaDir, 'manifest.json.bak');
    this.objectStore = new ObjectStore(this.metaDir);
    this.tempHistory = new TempHistoryStore(this.metaDir);
  }

  public isInitialized(): boolean {
    return fs.existsSync(this.manifestPath) || fs.existsSync(this.manifestBackupPath);
  }

  public init(name?: string): RepoManifest {
    if (!fs.existsSync(this.rootPath)) {
      throw new Error(`目标文件夹不存在: ${this.rootPath}`);
    }
    const stat = fs.statSync(this.rootPath);
    if (!stat.isDirectory()) {
      throw new Error(`目标路径不是文件夹: ${this.rootPath}`);
    }

    if (this.isInitialized()) {
      return this.loadManifest();
    }

    fs.mkdirSync(this.metaDir, { recursive: true });
    this.objectStore.init();

    const now = Date.now();
    const manifest: RepoManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      repoId: `repo_${crypto.randomBytes(6).toString('hex')}`,
      name: name?.trim() || path.basename(this.rootPath) || '未命名项目',
      createdAt: now,
      updatedAt: now,
      currentArchiveId: null,
      archives: {},
      ignorePatterns: [],
      autoArchive: {
        enabled: false,
        intervalMinutes: 30
      },
      docSaveAutoArchive: {
        enabled: false,
        extensions: ['.docx', '.doc', '.pdf', '.xlsx', '.pptx', '.opju', '.md'],
        cooldownMinutes: 5
      }
    };

    this.saveManifest(manifest);
    return manifest;
  }

  public loadManifest(): RepoManifest {
    const tryParse = (filePath: string): RepoManifest | null => {
      if (!fs.existsSync(filePath)) return null;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as RepoManifest;
        if (parsed && typeof parsed === 'object' && parsed.archives && typeof parsed.archives === 'object') {
          return parsed;
        }
      } catch {
        return null;
      }
      return null;
    };

    const primary = tryParse(this.manifestPath);
    if (primary) return primary;

    const backup = tryParse(this.manifestBackupPath);
    if (backup) {
      this.saveManifest(backup);
      return backup;
    }

    throw new Error(`仓库元数据损坏或尚未初始化: ${this.rootPath}`);
  }

  public saveManifest(manifest: RepoManifest): void {
    fs.mkdirSync(this.metaDir, { recursive: true });
    manifest.updatedAt = Date.now();
    const serialized = JSON.stringify(manifest, null, 2);

    if (fs.existsSync(this.manifestPath)) {
      try {
        fs.copyFileSync(this.manifestPath, this.manifestBackupPath);
      } catch { /* ignore */ }
    }

    const tmpPath = `${this.manifestPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, serialized, 'utf-8');
    try {
      fs.renameSync(tmpPath, this.manifestPath);
    } catch {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      fs.writeFileSync(this.manifestPath, serialized, 'utf-8');
    }
  }

  public getIgnoreMatcher(manifest?: RepoManifest): IgnoreMatcher {
    const m = manifest || this.loadManifest();
    return new IgnoreMatcher(m.ignorePatterns || []);
  }

  public scanCurrentFull(manifest?: RepoManifest): WorkspaceScanResult {
    const m = manifest || this.loadManifest();
    const currentArchive = m.currentArchiveId ? m.archives[m.currentArchiveId] : undefined;
    const matcher = this.getIgnoreMatcher(m);
    return scanWorkspaceFull(this.rootPath, matcher, currentArchive?.files);
  }

  public scanCurrentFiles(manifest?: RepoManifest): Record<string, FileEntry> {
    return this.scanCurrentFull(manifest).files;
  }

  public getWorkingChanges(): {
    currentArchiveId: string | null;
    changes: FileDiffItem[];
    summary: { added: number; modified: number; deleted: number };
    scannedFiles: Record<string, FileEntry>;
    scannedDirs: string[];
  } {
    const manifest = this.loadManifest();
    const scanned = this.scanCurrentFull(manifest);
    const curArc = manifest.currentArchiveId ? manifest.archives[manifest.currentArchiveId] : undefined;
    const baselineFiles = curArc ? curArc.files : {};
    const baselineDirs = curArc ? curArc.directories || [] : [];
    this.tempHistory.captureFromScan(scanned.files, baselineFiles, manifest.currentArchiveId, this.rootPath);
    const changes = computeFileDiffs(baselineFiles, scanned.files, baselineDirs, scanned.directories);
    return {
      currentArchiveId: manifest.currentArchiveId,
      changes,
      summary: summarizeDiffs(changes),
      scannedFiles: scanned.files,
      scannedDirs: scanned.directories
    };
  }

  private buildAutoTitle(
    summary: { added: number; modified: number; deleted: number },
    isFirst: boolean,
    isAuto: boolean
  ): string {
    if (isFirst) {
      return isAuto ? '初始自动存档' : '初始存档';
    }
    const parts: string[] = [];
    if (summary.added > 0) parts.push(`新增 ${summary.added} 项`);
    if (summary.modified > 0) parts.push(`修改 ${summary.modified} 项`);
    if (summary.deleted > 0) parts.push(`删除 ${summary.deleted} 项`);
    const body = parts.length > 0 ? parts.join('、') : '手动快照存档';
    return isAuto ? `[自动存档] ${body}` : body;
  }

  public createArchive(options: CreateArchiveOptions = {}): ArchiveRecord {
    const manifest = this.loadManifest();
    this.objectStore.init();

    const scanned = this.scanCurrentFull(manifest);
    const parentId =
      manifest.currentArchiveId &&
      manifest.archives[manifest.currentArchiveId] &&
      !manifest.archives[manifest.currentArchiveId].archived
        ? manifest.currentArchiveId
        : null;
    const parentArc = parentId ? manifest.archives[parentId] : undefined;
    const parentFiles = parentArc ? parentArc.files : {};
    const parentDirs = parentArc ? parentArc.directories || [] : [];

    const diffs = computeFileDiffs(parentFiles, scanned.files, parentDirs, scanned.directories);
    const diffSummary = summarizeDiffs(diffs);
    const isFirst = Object.keys(manifest.archives).length === 0;

    if (!isFirst && diffs.length === 0 && !options.allowEmpty) {
      throw new Error('当前文件夹没有检测到新的文件或目录变化，无需重复存档');
    }

    let totalSize = 0;
    const storedFiles: Record<string, FileEntry> = {};

    for (const relPath of Object.keys(scanned.files).sort((a, b) => a.localeCompare(b))) {
      const entry = scanned.files[relPath];
      const absPath = path.join(this.rootPath, ...relPath.split('/'));

      if (!this.objectStore.hasObject(entry.hash)) {
        const stored = this.objectStore.putFile(absPath, entry.hash);
        entry.hash = stored.hash;
        entry.size = stored.size;
        entry.isBinary = stored.isBinary;
      }

      storedFiles[relPath] = entry;
      totalSize += entry.size;
    }

    const now = Date.now();
    const id = `arc_${now}_${crypto.randomBytes(3).toString('hex')}`;
    const isAuto = Boolean(options.isAuto);
    const title = options.title?.trim() || this.buildAutoTitle(diffSummary, isFirst, isAuto);

    const record: ArchiveRecord = {
      id,
      parentId,
      title,
      note: options.note?.trim() || '',
      createdAt: now,
      tags: this.sanitizeTags(options.tags || []),
      customTags: this.sanitizeCustomTags(options.customTags || []),
      archived: false,
      isAuto,
      summary: {
        added: diffSummary.added,
        modified: diffSummary.modified,
        deleted: diffSummary.deleted,
        totalFiles: Object.keys(storedFiles).length,
        totalSize,
        totalDirs: scanned.directories.length
      },
      files: storedFiles,
      directories: scanned.directories,
      coverImageDataUrl: options.coverImageDataUrl
    };

    manifest.archives[id] = record;
    manifest.currentArchiveId = id;
    this.saveManifest(manifest);
    this.tempHistory.clear(id, storedFiles);

    return record;
  }

  /**
   * Windows 文件占用写锁预检：
   * 在切换存档修改任何文件前，探测所有将被覆盖或删除的文件是否正被 Word/Excel/Origin/CAD 独占打开
   */
  public checkLockedFiles(relPaths: string[]): string[] {
    const locked: string[] = [];
    for (const relPath of relPaths) {
      const absPath = this.resolveSafePath(relPath);
      if (!fs.existsSync(absPath)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      // 跳过仅因只读属性导致 r+ 拒绝的情况（只读属性在恢复前会自动 chmod 解除）
      const wasReadOnly = (stat.mode & 0o200) === 0;
      if (wasReadOnly) continue;

      try {
        const fd = fs.openSync(absPath, 'r+');
        fs.closeSync(fd);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          locked.push(relPath);
        }
      }
    }
    return locked;
  }

  /**
   * 覆盖恢复：将当前工作区切换到目标历史存档
   */
  public switchToArchive(
    targetArchiveId: string,
    options: SwitchArchiveOptions = {}
  ): { switchedTo: ArchiveRecord; backupArchive: ArchiveRecord | null } {
    const manifest = this.loadManifest();
    const target = manifest.archives[targetArchiveId];
    if (!target) {
      throw new Error(`目标存档不存在: ${targetArchiveId}`);
    }

    for (const entry of Object.values(target.files)) {
      if (!this.objectStore.hasObject(entry.hash)) {
        throw new Error(`无法恢复：文件 "${entry.path}" 的历史对象缺失`);
      }
    }

    const working = this.getWorkingChanges();
    // 1. 先执行文件占用写锁预检，防止半途失败破坏工作区
    const pathsToMutate: string[] = [];
    for (const relPath of Object.keys(working.scannedFiles)) {
      const targetEntry = target.files[relPath];
      if (!targetEntry || targetEntry.hash !== working.scannedFiles[relPath].hash) {
        pathsToMutate.push(relPath);
      }
    }
    const lockedFiles = this.checkLockedFiles(pathsToMutate);
    if (lockedFiles.length > 0) {
      throw new Error(
        `检测到以下文件正被其他软件（如 Word/Excel/Origin）占用，请先保存并关闭后再切换：\n${lockedFiles.slice(0, 5).join('、')}`
      );
    }

    let backupArchive: ArchiveRecord | null = null;
    if (working.changes.length > 0) {
      if (options.autoBackupIfDirty) {
        backupArchive = this.createArchive({
          title: `切换前自动保护 (${new Date().toLocaleTimeString('zh-CN', { hour12: false })})`,
          isAuto: true
        });
      } else if (!options.force) {
        throw new Error('工作区存在尚未存档的修改，请先存档或选择自动保护后再切换');
      }
    }

    const latestManifest = this.loadManifest();
    const latestTarget = latestManifest.archives[targetArchiveId];
    const currentScan = this.scanCurrentFull(latestManifest);

    // 删除目标存档中不存在的受跟踪文件
    for (const relPath of Object.keys(currentScan.files)) {
      if (!latestTarget.files[relPath]) {
        const absPath = this.resolveSafePath(relPath);
        if (fs.existsSync(absPath)) {
          try { fs.chmodSync(absPath, 0o666); } catch { /* ignore */ }
          fs.unlinkSync(absPath);
        }
      }
    }

    // 恢复或更新目标存档中的文件
    for (const [relPath, targetEntry] of Object.entries(latestTarget.files)) {
      const diskEntry = currentScan.files[relPath];
      if (!diskEntry || diskEntry.hash !== targetEntry.hash) {
        const absPath = this.resolveSafePath(relPath);
        this.objectStore.restoreToFile(targetEntry.hash, absPath, targetEntry.mtimeMs);
      }
    }

    // 清理目标存档中不存在的空目录，并精准重建目标存档记录的空文件夹
    const targetDirSet = new Set(latestTarget.directories || []);
    this.cleanupEmptyDirectories(this.rootPath, this.getIgnoreMatcher(latestManifest), '', targetDirSet);
    for (const dirPath of latestTarget.directories || []) {
      const absDir = this.resolveSafePath(dirPath);
      fs.mkdirSync(absDir, { recursive: true });
    }

    latestManifest.currentArchiveId = targetArchiveId;
    this.saveManifest(latestManifest);
    this.tempHistory.clear(targetArchiveId, latestTarget.files);

    return { switchedTo: latestTarget, backupArchive };
  }

  /**
   * 恢复到全新独立文件夹（不覆盖当前工作区任何内容）
   */
  public restoreArchiveToNewFolder(
    archiveId: string,
    destinationParentDir?: string
  ): { exportedFiles: number; destinationDir: string } {
    const manifest = this.loadManifest();
    const archive = manifest.archives[archiveId];
    if (!archive) {
      throw new Error(`存档不存在: ${archiveId}`);
    }

    const safeTitle = archive.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24) || '历史副本';
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    const baseParent = destinationParentDir ? path.resolve(destinationParentDir) : path.dirname(this.rootPath);
    const folderName = `${path.basename(this.rootPath)}_历史副本_${safeTitle}_${stamp}`;
    const targetDir = path.join(baseParent, folderName);

    return this.exportArchive(archiveId, targetDir);
  }

  /**
   * 单文件恢复（支持两种模式：overwrite 覆盖当前文件 / copy 恢复为全新副本文件不覆盖原稿）
   */
  public restoreSingleFile(
    archiveId: string,
    relPath: string,
    mode: 'overwrite' | 'copy' = 'overwrite'
  ): { entry: FileEntry; restoredPath: string } {
    const manifest = this.loadManifest();
    const archive = manifest.archives[archiveId];
    if (!archive) {
      throw new Error(`存档不存在: ${archiveId}`);
    }
    const normalized = normalizeRelPath(relPath);
    const entry = archive.files[normalized];
    if (!entry) {
      throw new Error(`存档 "${archive.title}" 中不包含文件: ${normalized}`);
    }

    let absPath = this.resolveSafePath(normalized);
    if (mode === 'copy') {
      const dir = path.dirname(absPath);
      const ext = path.extname(absPath);
      const stem = ext ? path.basename(absPath, ext) : path.basename(absPath);
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      let candidate = path.join(dir, `${stem}_历史副本_${stamp}${ext}`);
      let idx = 1;
      while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem}_历史副本_${stamp}_${idx}${ext}`);
        idx++;
      }
      absPath = candidate;
    }

    this.objectStore.restoreToFile(entry.hash, absPath, entry.mtimeMs);
    return { entry, restoredPath: absPath };
  }

  public exportArchive(archiveId: string, destinationDir: string): { exportedFiles: number; destinationDir: string } {
    const manifest = this.loadManifest();
    const archive = manifest.archives[archiveId];
    if (!archive) {
      throw new Error(`存档不存在: ${archiveId}`);
    }

    const resolvedDest = path.resolve(destinationDir);
    fs.mkdirSync(resolvedDest, { recursive: true });

    for (const dirPath of archive.directories || []) {
      fs.mkdirSync(path.join(resolvedDest, ...dirPath.split('/')), { recursive: true });
    }

    let exportedFiles = 0;
    for (const [relPath, entry] of Object.entries(archive.files)) {
      const outPath = path.join(resolvedDest, ...relPath.split('/'));
      this.objectStore.restoreToFile(entry.hash, outPath, entry.mtimeMs);
      exportedFiles++;
    }

    return { exportedFiles, destinationDir: resolvedDest };
  }

  public diffArchives(fromId: string | null, toId: string | null): ArchiveDiffResult {
    const manifest = this.loadManifest();

    const resolveSide = (
      id: string | null
    ): { title: string; files: Record<string, FileEntry>; dirs: string[] } => {
      if (!id) {
        return { title: '空初始状态', files: {}, dirs: [] };
      }
      if (id === WORKING_TREE_ID) {
        const scanned = this.scanCurrentFull(manifest);
        return { title: '当前工作区（实时）', files: scanned.files, dirs: scanned.directories };
      }
      const arc = manifest.archives[id];
      if (!arc) {
        throw new Error(`对比目标存档不存在: ${id}`);
      }
      return { title: arc.title, files: arc.files, dirs: arc.directories || [] };
    };

    const left = resolveSide(fromId);
    const right = resolveSide(toId);
    const items = computeFileDiffs(left.files, right.files, left.dirs, right.dirs);

    return {
      fromId,
      fromTitle: left.title,
      toId,
      toTitle: right.title,
      items,
      summary: summarizeDiffs(items),
      fromVisual: buildVisualSnapshot(left.files, left.dirs),
      toVisual: buildVisualSnapshot(right.files, right.dirs)
    };
  }

  public diffFileText(fromId: string | null, toId: string | null, relPath: string): TextDiffResult {
    const manifest = this.loadManifest();
    const normalized = normalizeRelPath(relPath);

    if (relPath.endsWith('/')) {
      return { path: normalized, isBinary: true, truncated: false, lines: [], additions: 0, deletions: 0 };
    }

    const readContent = (id: string | null): { exists: boolean; isBinary: boolean; text: string | null } => {
      if (!id) return { exists: false, isBinary: false, text: null };

      if (id === WORKING_TREE_ID) {
        const absPath = this.resolveSafePath(normalized);
        if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
          return { exists: false, isBinary: false, text: null };
        }
        const buf = fs.readFileSync(absPath);
        if (ObjectStore.detectBinary(buf)) return { exists: true, isBinary: true, text: null };
        return { exists: true, isBinary: false, text: buf.toString('utf-8') };
      }

      const arc = manifest.archives[id];
      if (!arc) throw new Error(`存档不存在: ${id}`);
      const entry = arc.files[normalized];
      if (!entry) return { exists: false, isBinary: false, text: null };
      if (entry.isBinary) return { exists: true, isBinary: true, text: null };

      const buf = this.objectStore.readObject(entry.hash);
      if (ObjectStore.detectBinary(buf)) return { exists: true, isBinary: true, text: null };
      return { exists: true, isBinary: false, text: buf.toString('utf-8') };
    };

    const left = readContent(fromId);
    const right = readContent(toId);

    if (left.isBinary || right.isBinary) {
      return { path: normalized, isBinary: true, truncated: false, lines: [], additions: 0, deletions: 0 };
    }

    return computeTextDiff(normalized, left.text, right.text);
  }

  public toggleTag(archiveId: string, color: TagColor): ArchiveRecord {
    const manifest = this.loadManifest();
    const archive = manifest.archives[archiveId];
    if (!archive) throw new Error(`存档不存在: ${archiveId}`);
    const valid = this.sanitizeTags([color]);
    if (valid.length === 0) throw new Error(`不支持的标签颜色: ${color}`);

    archive.tags = archive.tags.includes(color)
      ? archive.tags.filter((c) => c !== color)
      : [...archive.tags, color];
    this.saveManifest(manifest);
    return archive;
  }

  public updateArchiveMeta(
    archiveId: string,
    updates: { title?: string; note?: string; tags?: TagColor[]; customTags?: string[] }
  ): ArchiveRecord {
    const manifest = this.loadManifest();
    const archive = manifest.archives[archiveId];
    if (!archive) throw new Error(`存档不存在: ${archiveId}`);

    if (typeof updates.title === 'string') {
      const trimmed = updates.title.trim();
      if (!trimmed) throw new Error('存档标题不能为空');
      archive.title = trimmed;
    }
    if (typeof updates.note === 'string') {
      archive.note = updates.note.trim();
    }
    if (Array.isArray(updates.tags)) {
      archive.tags = this.sanitizeTags(updates.tags);
    }
    if (Array.isArray(updates.customTags)) {
      archive.customTags = this.sanitizeCustomTags(updates.customTags);
    }

    this.saveManifest(manifest);
    return archive;
  }

  /**
   * 软归档历史存档（默认安全操作，移入归档回收站，随时可还原）
   */
  public softArchiveRecord(archiveId: string): ArchiveRecord {
    const manifest = this.loadManifest();
    const target = manifest.archives[archiveId];
    if (!target) throw new Error(`存档不存在: ${archiveId}`);
    target.archived = true;
    target.archivedAt = Date.now();
    this.saveManifest(manifest);
    return target;
  }

  /**
   * 从归档回收站还原历史存档
   */
  public restoreSoftArchivedRecord(archiveId: string): ArchiveRecord {
    const manifest = this.loadManifest();
    const target = manifest.archives[archiveId];
    if (!target) throw new Error(`存档不存在: ${archiveId}`);
    target.archived = false;
    delete target.archivedAt;
    this.saveManifest(manifest);
    return target;
  }

  /**
   * 永久物理删除指定存档（仅在设置面板危险区二次确认后调用）
   */
  public deleteArchive(archiveId: string): { deletedId: string; newCurrentArchiveId: string | null } {
    const manifest = this.loadManifest();
    const target = manifest.archives[archiveId];
    if (!target) throw new Error(`存档不存在: ${archiveId}`);

    const parentId = target.parentId;
    for (const arc of Object.values(manifest.archives)) {
      if (arc.parentId === archiveId) {
        arc.parentId = parentId;
      }
    }

    delete manifest.archives[archiveId];

    if (manifest.currentArchiveId === archiveId) {
      if (parentId && manifest.archives[parentId]) {
        manifest.currentArchiveId = parentId;
      } else {
        const remaining = Object.values(manifest.archives)
          .filter((a) => !a.archived)
          .sort((a, b) => b.createdAt - a.createdAt);
        manifest.currentArchiveId = remaining.length > 0 ? remaining[0].id : null;
      }
    }

    this.saveManifest(manifest);
    return { deletedId: archiveId, newCurrentArchiveId: manifest.currentArchiveId };
  }

  public listArchives(filter?: {
    query?: string;
    tag?: TagColor | null;
    customTag?: string | null;
    includeArchived?: boolean;
    onlyArchived?: boolean;
    order?: 'desc' | 'asc';
  }): ArchiveRecord[] {
    const manifest = this.loadManifest();
    let list = Object.values(manifest.archives);

    if (filter?.onlyArchived) {
      list = list.filter((arc) => Boolean(arc.archived));
    } else if (!filter?.includeArchived) {
      list = list.filter((arc) => !arc.archived);
    }

    if (filter?.tag) {
      list = list.filter((arc) => arc.tags.includes(filter.tag!));
    }

    if (filter?.customTag) {
      const ct = filter.customTag.trim().toLowerCase();
      list = list.filter((arc) => (arc.customTags || []).some((x) => x.toLowerCase() === ct));
    }

    if (filter?.query && filter.query.trim()) {
      const q = filter.query.trim().toLowerCase();
      list = list.filter((arc) => {
        if (arc.title.toLowerCase().includes(q)) return true;
        if (arc.note.toLowerCase().includes(q)) return true;
        if ((arc.customTags || []).some((x) => x.toLowerCase().includes(q))) return true;
        return Object.keys(arc.files).some((fp) => fp.toLowerCase().includes(q));
      });
    }

    const dir = filter?.order === 'asc' ? 1 : -1;
    list.sort((a, b) => (a.createdAt - b.createdAt) * dir);
    return list;
  }

  public getDagLayout(): DagGraphLayout {
    const manifest = this.loadManifest();
    const activeOnly: Record<string, ArchiveRecord> = {};
    for (const [id, arc] of Object.entries(manifest.archives)) {
      if (!arc.archived) activeOnly[id] = arc;
    }
    return computeDagLayout(activeOnly, manifest.currentArchiveId);
  }

  public getStorageStats(): StorageStats {
    const manifest = this.loadManifest();
    const archives = Object.values(manifest.archives);
    let logicalBytes = 0;
    let softArchivedCount = 0;

    for (const arc of archives) {
      if (arc.archived) softArchivedCount++;
      for (const entry of Object.values(arc.files)) {
        logicalBytes += entry.size;
      }
    }

    const disk = this.objectStore.getDiskStats();
    const savedBytes = Math.max(0, logicalBytes - disk.compressedBytes);
    const dedupRatio = logicalBytes > 0 ? Number((savedBytes / logicalBytes).toFixed(4)) : 0;

    return {
      objectCount: disk.objectCount,
      compressedBytes: disk.compressedBytes,
      logicalBytes,
      savedBytes,
      dedupRatio,
      archiveCount: archives.length - softArchivedCount,
      softArchivedCount
    };
  }

  public runGarbageCollection(): { removedObjects: number; freedBytes: number } {
    const manifest = this.loadManifest();
    const referenced = new Set<string>();
    for (const arc of Object.values(manifest.archives)) {
      for (const entry of Object.values(arc.files)) {
        referenced.add(entry.hash);
      }
    }
    return this.objectStore.garbageCollect(referenced);
  }

  public updateIgnorePatterns(patterns: string[]): RepoManifest {
    const manifest = this.loadManifest();
    manifest.ignorePatterns = patterns.map((p) => p.trim()).filter((p) => p.length > 0);
    this.saveManifest(manifest);
    return manifest;
  }

  public updateDocSaveAutoArchive(enabled: boolean, extensions: string[], cooldownMinutes: number): RepoManifest {
    const manifest = this.loadManifest();
    const cleanedExts = extensions
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
      .map((e) => (e.startsWith('.') ? e : `.${e}`));
    manifest.docSaveAutoArchive = {
      enabled: Boolean(enabled),
      extensions: cleanedExts.length > 0 ? Array.from(new Set(cleanedExts)) : ['.docx', '.pdf', '.xlsx', '.opju'],
      cooldownMinutes: Math.max(0, Math.min(120, Math.round(Number(cooldownMinutes) || 0)))
    };
    this.saveManifest(manifest);
    return manifest;
  }

  public updateAutoArchive(enabled: boolean, intervalMinutes: number): RepoManifest {
    const manifest = this.loadManifest();
    manifest.autoArchive = {
      enabled: Boolean(enabled),
      intervalMinutes: Math.max(1, Math.min(1440, Math.round(intervalMinutes || 30)))
    };
    this.saveManifest(manifest);
    return manifest;
  }

  private sanitizeTags(tags: TagColor[]): TagColor[] {
    const allowed: TagColor[] = ['red', 'yellow', 'green'];
    const result: TagColor[] = [];
    for (const t of tags) {
      if (allowed.includes(t) && !result.includes(t)) result.push(t);
    }
    return result;
  }

  private sanitizeCustomTags(tags: string[]): string[] {
    const result: string[] = [];
    for (const raw of tags) {
      const cleaned = raw.trim().slice(0, 20);
      if (cleaned && !result.includes(cleaned)) result.push(cleaned);
    }
    return result.slice(0, 10);
  }

  private resolveSafePath(relPath: string): string {
    const normalized = normalizeRelPath(relPath);
    const target = path.resolve(this.rootPath, ...normalized.split('/'));
    const relative = path.relative(this.rootPath, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`非法文件路径越界: ${relPath}`);
    }
    return target;
  }

  private cleanupEmptyDirectories(
    dir: string,
    matcher: IgnoreMatcher,
    relPrefix = '',
    keepDirs?: Set<string>
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relPath = normalizeRelPath(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      if (matcher.isIgnored(relPath)) continue;

      const subDir = path.join(dir, entry.name);
      this.cleanupEmptyDirectories(subDir, matcher, relPath, keepDirs);

      if (keepDirs && keepDirs.has(relPath)) continue;

      try {
        if (fs.readdirSync(subDir).length === 0) {
          fs.rmdirSync(subDir);
        }
      } catch { /* ignore */ }
    }
  }

  public captureTempHistory(): TempHistoryEntry[] {
    if (!this.isInitialized()) return [];
    const manifest = this.loadManifest();
    const scanned = this.scanCurrentFull(manifest);
    const curArc = manifest.currentArchiveId ? manifest.archives[manifest.currentArchiveId] : undefined;
    const baselineFiles = curArc ? curArc.files : {};
    return this.tempHistory.captureFromScan(scanned.files, baselineFiles, manifest.currentArchiveId, this.rootPath);
  }

  public getFileTempHistory(relPath: string): TempHistoryEntry[] {
    if (!this.isInitialized()) return [];
    const manifest = this.loadManifest();
    const scanned = this.scanCurrentFull(manifest);
    const curArc = manifest.currentArchiveId ? manifest.archives[manifest.currentArchiveId] : undefined;
    const baselineFiles = curArc ? curArc.files : {};
    this.tempHistory.captureFromScan(scanned.files, baselineFiles, manifest.currentArchiveId, this.rootPath);
    return this.tempHistory.getFileHistory(relPath, manifest.currentArchiveId, baselineFiles, scanned.files);
  }

  public restoreTempHistoryEntry(entryId: string): { entry: TempHistoryEntry; restoredPath: string } {
    const manifest = this.loadManifest();
    const curArc = manifest.currentArchiveId ? manifest.archives[manifest.currentArchiveId] : undefined;
    const baselineFiles = curArc ? curArc.files : {};
    return this.tempHistory.restoreEntry(entryId, this.rootPath, manifest.currentArchiveId, baselineFiles);
  }
}
