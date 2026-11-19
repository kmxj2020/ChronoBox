import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ArchiveBoxConfig, ArchiveBoxEntry, ArchiveBoxOperationResult, TrackedProject } from './types';

export const DEFAULT_ARCHIVE_BOX_CONFIG: ArchiveBoxConfig = {
  folderName: '00【Archive】',
  dateFormat: 'YYYY-MM-DD',
  preserveRelativePath: true,
  defaultAction: 'move',
  ignoreInSnapshots: true
};

const LOG_FILE_NAME = '.archive-box-log.json';

function formatDateFolder(date: Date, fmt: ArchiveBoxConfig['dateFormat']): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (fmt === 'YYYYMMDD') return `${y}${m}${d}`;
  if (fmt === 'YYYY-MM') return `${y}-${m}`;
  return `${y}-${m}-${d}`;
}

function formatTimeSuffix(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}${mm}${ss}`;
}

function isSubPath(parentDir: string, candidatePath: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 安全跨盘移动文件或文件夹（优先 rename，遇到 EXDEV 跨卷时自动 copy + rm）
 */
function movePathSafe(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EXDEV' || code === 'EPERM' || code === 'EACCES') {
      fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * 冲突避让命名：若目标已存在，则自动追加 _HHMMSS（或递增序号），绝不覆盖旧文件
 */
function resolveUniqueDest(destPath: string, now: Date): string {
  if (!fs.existsSync(destPath)) return destPath;

  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = ext ? path.basename(destPath, ext) : path.basename(destPath);
  const suffix = formatTimeSuffix(now);

  let candidate = path.join(dir, `${base}_${suffix}${ext}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${suffix}_${counter}${ext}`);
    counter++;
  }
  return candidate;
}

/**
 * 00【Archive】可视化归档箱引擎
 * - 拖拽任意文件/文件夹到悬浮球，自动归档至对应项目/当前文件夹的 `00【Archive】/YYYY-MM-DD/`
 * - 支持保留原始相对目录结构、同名冲突自动带时间戳避让、Move/Copy 双模式与一键放回原位 (Undo)
 */
export class ArchiveBoxEngine {
  /**
   * 智能定位拖入文件所属的目标基准目录：
   * 1. 若文件位于某个已跟踪项目内，归档到该项目根目录的 00【Archive】
   * 2. 否则，若开启就近归档（默认），归档到该文件所在父目录的 00【Archive】
   * 3. 兜底使用当前活动项目根目录
   */
  public static resolveTargetBaseDir(
    sourcePath: string,
    projects: TrackedProject[],
    fallbackActiveRoot: string | null
  ): { baseDir: string; matchedProjectId: string | null } {
    const resolvedSrc = path.resolve(sourcePath);

    // 优先匹配路径最深的已跟踪项目（处理嵌套项目）
    const matched = projects
      .filter((p) => isSubPath(p.rootPath, resolvedSrc))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];

    if (matched) {
      return { baseDir: path.resolve(matched.rootPath), matchedProjectId: matched.id };
    }

    const parentDir = path.dirname(resolvedSrc);
    if (fs.existsSync(parentDir)) {
      return { baseDir: parentDir, matchedProjectId: null };
    }

    if (fallbackActiveRoot) {
      return { baseDir: path.resolve(fallbackActiveRoot), matchedProjectId: null };
    }

    throw new Error(`无法确定归档目标目录: ${sourcePath}`);
  }

  /**
   * 批量归档文件或文件夹到 00【Archive】/YYYY-MM-DD/
   */
  public static archivePaths(
    sourcePaths: string[],
    options: {
      config: ArchiveBoxConfig;
      projects: TrackedProject[];
      activeProjectRoot: string | null;
      action?: 'move' | 'copy';
      now?: Date;
    }
  ): ArchiveBoxOperationResult {
    const cfg = { ...DEFAULT_ARCHIVE_BOX_CONFIG, ...options.config };
    const action = options.action || cfg.defaultAction || 'move';
    const now = options.now || new Date();
    const dateFolder = formatDateFolder(now, cfg.dateFormat);
    const folderName = cfg.folderName.trim() || DEFAULT_ARCHIVE_BOX_CONFIG.folderName;

    const succeeded: ArchiveBoxEntry[] = [];
    const skipped: Array<{ sourcePath: string; reason: string }> = [];

    for (const rawPath of sourcePaths) {
      if (!rawPath || !rawPath.trim()) continue;
      const resolvedSrc = path.resolve(rawPath);

      if (!fs.existsSync(resolvedSrc)) {
        skipped.push({ sourcePath: resolvedSrc, reason: '文件或文件夹不存在' });
        continue;
      }

      const { baseDir, matchedProjectId } = ArchiveBoxEngine.resolveTargetBaseDir(
        resolvedSrc,
        options.projects,
        options.activeProjectRoot
      );

      const archiveRoot = path.join(baseDir, folderName);

      // 安全防护：禁止将 00【Archive】本身或其任意层级子路径再次归档（兼容未跟踪目录防套娃）
      const pathSegments = resolvedSrc.split(path.sep).map((s) => s.toLowerCase());
      if (
        pathSegments.includes(folderName.toLowerCase()) ||
        resolvedSrc.toLowerCase() === archiveRoot.toLowerCase() ||
        isSubPath(archiveRoot, resolvedSrc)
      ) {
        skipped.push({ sourcePath: resolvedSrc, reason: `已在 ${folderName} 归档目录内，已跳过` });
        continue;
      }

      // 禁止将整个项目根目录本身拖进去
      if (resolvedSrc.toLowerCase() === baseDir.toLowerCase()) {
        skipped.push({ sourcePath: resolvedSrc, reason: '不能将项目根目录自身归档到内部' });
        continue;
      }

      const stat = fs.statSync(resolvedSrc);
      const isDir = stat.isDirectory();
      const relFromBase = path.relative(baseDir, resolvedSrc);
      const relParts = relFromBase.split(path.sep).filter(Boolean);

      const dateDir = path.join(archiveRoot, dateFolder);
      let rawDest: string;

      if (cfg.preserveRelativePath && relParts.length > 1) {
        rawDest = path.join(dateDir, ...relParts);
      } else {
        rawDest = path.join(dateDir, path.basename(resolvedSrc));
      }

      const finalDest = resolveUniqueDest(rawDest, now);

      try {
        if (action === 'copy') {
          fs.mkdirSync(path.dirname(finalDest), { recursive: true });
          fs.cpSync(resolvedSrc, finalDest, { recursive: true, preserveTimestamps: true });
        } else {
          movePathSafe(resolvedSrc, finalDest);
        }

        const entry: ArchiveBoxEntry = {
          id: `box_${now.getTime()}_${crypto.randomBytes(3).toString('hex')}`,
          projectId: matchedProjectId,
          baseDir,
          archiveRoot,
          dateFolder,
          originalPath: resolvedSrc,
          archivedPath: finalDest,
          fileName: path.basename(resolvedSrc),
          relativeOriginalPath: relFromBase.replace(/\\/g, '/'),
          isDirectory: isDir,
          size: isDir ? 0 : stat.size,
          action,
          archivedAt: now.getTime(),
          restored: false
        };

        ArchiveBoxEngine.appendLog(archiveRoot, entry);
        succeeded.push(entry);
      } catch (err: unknown) {
        skipped.push({
          sourcePath: resolvedSrc,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return { succeeded, skipped };
  }

  /**
   * 一键放回原位（撤销归档）
   */
  public static restoreEntry(archiveRoot: string, entryId: string): ArchiveBoxEntry {
    const entries = ArchiveBoxEngine.readLog(archiveRoot);
    const target = entries.find((e) => e.id === entryId);
    if (!target) {
      throw new Error(`未找到归档记录: ${entryId}`);
    }
    if (!fs.existsSync(target.archivedPath)) {
      throw new Error(`归档文件已不存在或被手动移动: ${target.archivedPath}`);
    }

    const finalRestorePath = resolveUniqueDest(target.originalPath, new Date());
    movePathSafe(target.archivedPath, finalRestorePath);

    target.restored = true;
    target.restoredAt = Date.now();
    target.restoredToPath = finalRestorePath;
    ArchiveBoxEngine.writeLog(archiveRoot, entries);

    // 清理可能变空的日期子目录（保留 00【Archive】根目录）
    ArchiveBoxEngine.cleanupEmptyParentDirs(path.dirname(target.archivedPath), archiveRoot);

    return target;
  }

  /**
   * 列出某个项目的 00【Archive】归档记录（按时间倒序）
   */
  public static listEntries(projectRoot: string, folderName: string): ArchiveBoxEntry[] {
    const archiveRoot = path.join(path.resolve(projectRoot), folderName.trim() || DEFAULT_ARCHIVE_BOX_CONFIG.folderName);
    const entries = ArchiveBoxEngine.readLog(archiveRoot);
    return entries
      .map((e) => ({
        ...e,
        existsOnDisk: fs.existsSync(e.archivedPath)
      }))
      .sort((a, b) => b.archivedAt - a.archivedAt);
  }

  private static getLogPath(archiveRoot: string): string {
    return path.join(archiveRoot, LOG_FILE_NAME);
  }

  private static readLog(archiveRoot: string): ArchiveBoxEntry[] {
    const logPath = ArchiveBoxEngine.getLogPath(archiveRoot);
    if (!fs.existsSync(logPath)) return [];
    try {
      const raw = fs.readFileSync(logPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ArchiveBoxEntry[]) : [];
    } catch {
      return [];
    }
  }

  private static writeLog(archiveRoot: string, entries: ArchiveBoxEntry[]): void {
    fs.mkdirSync(archiveRoot, { recursive: true });
    const logPath = ArchiveBoxEngine.getLogPath(archiveRoot);
    const tmp = `${logPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
    try {
      fs.renameSync(tmp, logPath);
    } catch {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf-8');
    }
  }

  private static appendLog(archiveRoot: string, entry: ArchiveBoxEntry): void {
    const entries = ArchiveBoxEngine.readLog(archiveRoot);
    entries.unshift(entry);
    ArchiveBoxEngine.writeLog(archiveRoot, entries);
  }

  private static cleanupEmptyParentDirs(dir: string, stopAt: string): void {
    let cur = path.resolve(dir);
    const stop = path.resolve(stopAt);
    while (cur !== stop && isSubPath(stop, cur)) {
      try {
        if (fs.readdirSync(cur).length === 0) {
          fs.rmdirSync(cur);
          cur = path.dirname(cur);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
}
