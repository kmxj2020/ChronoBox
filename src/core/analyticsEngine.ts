import * as path from 'path';
import { ArchiveRecord, FileEntry } from './types';
import { ChronoBoxRepository, WORKING_TREE_ID } from './repository';
import { WorkspaceManager } from './workspaceManager';

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

export interface ProgressReportOptions {
  projectId?: string | null;
  days: number; // 1 = 今天, 7 = 周报, 30 = 月报, 0 = 全部
}

export interface ReportDailyPoint {
  date: string;       // MM-DD
  fullDate: string;   // YYYY-MM-DD
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

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateShort(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val < 10 && idx > 0 ? val.toFixed(1) : Math.round(val)} ${units[idx]}`;
}

function classifyExtCategory(relPath: string): { label: string; color: string } {
  const ext = path.extname(relPath).toLowerCase().replace(/^\./, '');
  if (['doc', 'docx', 'rtf'].includes(ext)) return { label: 'Word 文档', color: '#2563EB' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { label: 'Excel / 表格', color: '#10B981' };
  if (['opju', 'opj', 'ogwu'].includes(ext)) return { label: 'Origin 数据', color: '#F97316' };
  if (ext === 'pdf') return { label: 'PDF 文献', color: '#EC4899' };
  if (['ppt', 'pptx'].includes(ext)) return { label: 'PPT 演示', color: '#EF4444' };
  if (['png', 'jpg', 'jpeg', 'svg', 'tif', 'webp', 'bmp'].includes(ext)) return { label: '图片 / 图表', color: '#8B5CF6' };
  if (['md', 'txt', 'py', 'ts', 'js', 'json', 'c', 'cpp', 'm', 'tex'].includes(ext)) return { label: '代码 / 笔记', color: '#06B6D4' };
  return { label: '其他文件', color: '#64748B' };
}

/**
 * 1. 重复大文件体检：复用现成 SHA-256 内容哈希，零冗余 IO 找出项目内完全一致的重复副本
 */
export function findDuplicateFiles(repo: ChronoBoxRepository): DuplicateScanResult {
  const manifest = repo.loadManifest();
  const scan = repo.scanCurrentFull(manifest);
  const byHash = new Map<string, { size: number; paths: string[] }>();
  let totalWorkspaceBytes = 0;

  for (const entry of Object.values(scan.files)) {
    totalWorkspaceBytes += entry.size;
    if (entry.size <= 0) continue;
    const bucket = byHash.get(entry.hash);
    if (bucket) {
      bucket.paths.push(entry.path);
    } else {
      byHash.set(entry.hash, { size: entry.size, paths: [entry.path] });
    }
  }

  const groups: DuplicateFileGroup[] = [];
  let totalDuplicateFiles = 0;
  let totalWastedBytes = 0;

  for (const [hash, info] of byHash.entries()) {
    if (info.paths.length >= 2) {
      info.paths.sort((a, b) => a.localeCompare(b, 'zh-CN'));
      const wastedBytes = info.size * (info.paths.length - 1);
      groups.push({ hash, size: info.size, wastedBytes, paths: info.paths });
      totalDuplicateFiles += info.paths.length - 1;
      totalWastedBytes += wastedBytes;
    }
  }

  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || b.size - a.size);
  return { groups, totalDuplicateFiles, totalWastedBytes, totalWorkspaceBytes };
}

/**
 * 2. 单文件里程碑时间线：追踪某文件从诞生至今所有发生实质变更的版本（含重命名链路与实时未存档状态）
 */
export function getFileMilestoneTimeline(repo: ChronoBoxRepository, targetRelPath: string): FileMilestoneItem[] {
  const manifest = repo.loadManifest();
  const archives = Object.values(manifest.archives)
    .filter((a) => !a.archived)
    .sort((a, b) => a.createdAt - b.createdAt);

  const scan = repo.scanCurrentFull(manifest);
  const milestones: FileMilestoneItem[] = [];

  let trackedPath = targetRelPath;
  let prevEntry: FileEntry | null = null;
  let started = false;

  const aliasByCol = new Map<number, string>();
  const workingEntry = scan.files[targetRelPath];
  let curSearchPath: string | null = targetRelPath;
  let curSearchHash: string | null = workingEntry ? workingEntry.hash : null;

  for (let i = archives.length - 1; i >= 0; i--) {
    const arc = archives[i];
    if (curSearchPath && arc.files[curSearchPath]) {
      aliasByCol.set(i, curSearchPath);
      curSearchHash = arc.files[curSearchPath].hash;
    } else if (curSearchHash) {
      const sameHash = Object.values(arc.files).find((f) => f.hash === curSearchHash);
      if (sameHash) {
        curSearchPath = sameHash.path;
        aliasByCol.set(i, sameHash.path);
      }
    }
  }

  archives.forEach((arc, idx) => {
    const p = aliasByCol.get(idx) || trackedPath;
    const entry = arc.files[p] || null;
    const verLabel = `V${idx + 1}`;

    if (entry && !prevEntry) {
      milestones.push({
        archiveId: arc.id,
        versionLabel: verLabel,
        title: arc.title,
        createdAt: arc.createdAt,
        path: entry.path,
        action: !started && idx === 0 ? 'initial' : 'added',
        size: entry.size,
        deltaSize: entry.size,
        hash: entry.hash,
        isWorking: false
      });
      started = true;
      trackedPath = entry.path;
      prevEntry = entry;
    } else if (entry && prevEntry) {
      if (entry.path !== prevEntry.path) {
        milestones.push({
          archiveId: arc.id,
          versionLabel: verLabel,
          title: arc.title,
          createdAt: arc.createdAt,
          path: entry.path,
          previousPath: prevEntry.path,
          action: 'renamed',
          size: entry.size,
          deltaSize: entry.size - prevEntry.size,
          hash: entry.hash,
          isWorking: false
        });
        trackedPath = entry.path;
        prevEntry = entry;
      } else if (entry.hash !== prevEntry.hash) {
        milestones.push({
          archiveId: arc.id,
          versionLabel: verLabel,
          title: arc.title,
          createdAt: arc.createdAt,
          path: entry.path,
          action: 'modified',
          size: entry.size,
          deltaSize: entry.size - prevEntry.size,
          hash: entry.hash,
          isWorking: false
        });
        prevEntry = entry;
      }
    } else if (!entry && prevEntry) {
      milestones.push({
        archiveId: arc.id,
        versionLabel: verLabel,
        title: arc.title,
        createdAt: arc.createdAt,
        path: prevEntry.path,
        action: 'deleted',
        size: 0,
        deltaSize: -prevEntry.size,
        hash: null,
        isWorking: false
      });
      prevEntry = null;
    }
  });

  const live = scan.files[targetRelPath] || null;
  if (live && (!prevEntry || live.hash !== (prevEntry as FileEntry).hash || live.path !== (prevEntry as FileEntry).path)) {
    const prevSz = prevEntry ? (prevEntry as FileEntry).size : 0;
    milestones.push({
      archiveId: WORKING_TREE_ID,
      versionLabel: '实时',
      title: '当前工作区（未存档）',
      createdAt: live.mtimeMs || Date.now(),
      path: live.path,
      previousPath: prevEntry && live.path !== (prevEntry as FileEntry).path ? (prevEntry as FileEntry).path : undefined,
      action: !prevEntry ? 'added' : live.path !== (prevEntry as FileEntry).path ? 'renamed' : 'modified',
      size: live.size,
      deltaSize: live.size - prevSz,
      hash: live.hash,
      isWorking: true
    });
  }

  return milestones;
}

/**
 * 3. 跨项目全局快速检索 (Ctrl+K)
 */
export function globalSearchWorkspace(manager: WorkspaceManager, query: string, limit = 40): GlobalSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const cfg = manager.getConfig();
  const activeProjects = cfg.projects.filter((p) => !p.archived);
  const hits: GlobalSearchHit[] = [];

  for (const proj of activeProjects) {
    const tagMatch = (proj.customTags || []).some((t) => t.toLowerCase().includes(q));
    if (proj.name.toLowerCase().includes(q) || proj.rootPath.toLowerCase().includes(q) || tagMatch) {
      hits.push({
        kind: 'project',
        projectId: proj.id,
        projectName: proj.name,
        title: proj.name,
        subtitle: proj.rootPath,
        timestamp: proj.lastOpenedAt
      });
    }

    let repo: ChronoBoxRepository;
    try {
      repo = manager.getRepository(proj.id);
      if (!repo.isInitialized()) continue;
    } catch {
      continue;
    }

    const manifest = repo.loadManifest();
    const seenFiles = new Set<string>();
    const archives = Object.values(manifest.archives)
      .filter((a) => !a.archived)
      .sort((a, b) => b.createdAt - a.createdAt);

    for (const arc of archives) {
      const arcTagMatch = (arc.customTags || []).some((t) => t.toLowerCase().includes(q));
      if (arc.title.toLowerCase().includes(q) || (arc.note && arc.note.toLowerCase().includes(q)) || arcTagMatch) {
        hits.push({
          kind: 'archive',
          projectId: proj.id,
          projectName: proj.name,
          archiveId: arc.id,
          title: arc.title,
          subtitle: `${proj.name} · ${formatDateTime(arc.createdAt)}${arc.note ? ` · ${arc.note.slice(0, 32)}` : ''}`,
          timestamp: arc.createdAt
        });
      }

      for (const relPath of Object.keys(arc.files)) {
        if (seenFiles.has(relPath)) continue;
        if (relPath.toLowerCase().includes(q)) {
          seenFiles.add(relPath);
          hits.push({
            kind: 'file',
            projectId: proj.id,
            projectName: proj.name,
            archiveId: arc.id,
            relPath,
            title: path.basename(relPath),
            subtitle: `${proj.name} / ${relPath}`,
            timestamp: arc.files[relPath].mtimeMs || arc.createdAt
          });
        }
      }
    }
  }

  const weight: Record<GlobalSearchHit['kind'], number> = { project: 3, file: 2, archive: 1 };
  hits.sort((a, b) => weight[b.kind] - weight[a.kind] || b.timestamp - a.timestamp);
  return hits.slice(0, limit);
}

/**
 * 4. 项目周报 / 科研进展可视化汇总（同时输出结构化图表数据 + 可直接复制导出的完整 Markdown）
 */
export function generateProgressReport(manager: WorkspaceManager, options: ProgressReportOptions): ProgressReportResult {
  const cfg = manager.getConfig();
  const now = Date.now();
  const cutoff = options.days > 0 ? now - options.days * 24 * 60 * 60 * 1000 : 0;
  const periodLabel =
    options.days === 1
      ? '今日工作日报'
      : options.days === 7
        ? '近 7 天项目周报'
        : options.days === 30
          ? '近 30 天项目月报'
          : '项目全周期进展汇总';

  const targets = options.projectId
    ? cfg.projects.filter((p) => p.id === options.projectId)
    : cfg.projects.filter((p) => !p.archived);

  const lines: string[] = [
    `# ${periodLabel}`,
    '',
    `> 生成时间：${formatDateTime(now)} · 由时匣 ChronoBox 自动汇总`,
    ''
  ];

  let totalArchives = 0;
  let activeProjCount = 0;
  let totalAdded = 0;
  let totalModified = 0;
  let totalDeleted = 0;
  const globalTouched = new Set<string>();
  const dailyMap = new Map<string, { archives: number; changes: number }>();
  const typeMap = new Map<string, { count: number; color: string }>();
  const topFileAgg = new Map<string, ReportTopFile>();
  const milestones: ReportMilestoneRow[] = [];

  // 若选了 7 天或 30 天，预填充日期桶保证柱状图时间轴连续
  if (options.days === 7 || options.days === 14) {
    for (let i = options.days - 1; i >= 0; i--) {
      const dStr = formatDateShort(now - i * 86400000);
      dailyMap.set(dStr, { archives: 0, changes: 0 });
    }
  }

  for (const proj of targets) {
    let repo: ChronoBoxRepository;
    try {
      repo = manager.getRepository(proj.id);
      if (!repo.isInitialized()) continue;
    } catch {
      continue;
    }

    const manifest = repo.loadManifest();
    const allSorted = Object.values(manifest.archives)
      .filter((a) => !a.archived)
      .sort((a, b) => a.createdAt - b.createdAt);

    const inPeriod = allSorted.filter((a) => a.createdAt >= cutoff);
    if (inPeriod.length === 0) continue;

    activeProjCount++;
    totalArchives += inPeriod.length;

    const projFileHits = new Map<string, number>();
    for (const arc of inPeriod) {
      totalAdded += arc.summary.added;
      totalModified += arc.summary.modified;
      totalDeleted += arc.summary.deleted;

      const dKey = formatDateShort(arc.createdAt);
      const bucket = dailyMap.get(dKey) || { archives: 0, changes: 0 };
      bucket.archives += 1;
      bucket.changes += arc.summary.added + arc.summary.modified + arc.summary.deleted;
      dailyMap.set(dKey, bucket);

      const parentArc: ArchiveRecord | null = arc.parentId ? manifest.archives[arc.parentId] || null : null;
      const prevFiles = parentArc ? parentArc.files : {};
      for (const [rel, entry] of Object.entries(arc.files)) {
        if (!prevFiles[rel] || prevFiles[rel].hash !== entry.hash) {
          projFileHits.set(rel, (projFileHits.get(rel) || 0) + 1);
          const fKey = `${proj.id}:${rel}`;
          globalTouched.add(fKey);

          const prevTop = topFileAgg.get(fKey);
          if (prevTop) {
            prevTop.editCount += 1;
            prevTop.latestSize = entry.size;
          } else {
            topFileAgg.set(fKey, {
              name: path.basename(rel),
              relPath: rel,
              projectName: proj.name,
              editCount: 1,
              latestSize: entry.size
            });
          }

          const cat = classifyExtCategory(rel);
          const tb = typeMap.get(cat.label) || { count: 0, color: cat.color };
          tb.count += 1;
          typeMap.set(cat.label, tb);
        }
      }

      milestones.push({
        projectName: proj.name,
        date: formatDateTime(arc.createdAt),
        title: arc.title,
        added: arc.summary.added,
        modified: arc.summary.modified,
        deleted: arc.summary.deleted,
        totalFiles: arc.summary.totalFiles,
        totalSize: arc.summary.totalSize,
        note: arc.note || ''
      });
    }

    const topProjFiles = Array.from(projFileHits.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .slice(0, 8);

    lines.push(`## 📁 ${proj.name}`);
    lines.push(`- **周期内新增存档**：${inPeriod.length} 个（覆盖 ${projFileHits.size} 个核心变更文件）`);
    if (topProjFiles.length > 0) {
      lines.push(`- **高频推进文档**：${topProjFiles.map(([f, c]) => `\`${path.basename(f)}\`（${c} 次）`).join('、')}`);
    }
    lines.push('');
    lines.push('| 日期 | 里程碑存档 | 变更概览 | 备注 |');
    lines.push('| :--- | :--- | :--- | :--- |');

    for (const arc of [...inPeriod].reverse()) {
      const s = arc.summary;
      const diffStr = `+${s.added} ~${s.modified} -${s.deleted}（共 ${s.totalFiles} 文件 / ${formatBytes(s.totalSize)}）`;
      const noteStr = (arc.note || '-').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
      lines.push(`| ${formatDateShort(arc.createdAt)} | ${arc.title} | ${diffStr} | ${noteStr} |`);
    }
    lines.push('');
  }

  if (activeProjCount === 0) {
    lines.push(`> 在所选时间范围（${periodLabel}）内暂无新的正式时间盒子存档记录。`);
  }

  const dailyActivity: ReportDailyPoint[] = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-14)
    .map(([fullDate, val]) => ({
      date: fullDate.slice(5),
      fullDate,
      archives: val.archives,
      changes: val.changes
    }));

  const fileTypeBreakdown: ReportTypeSlice[] = Array.from(typeMap.entries())
    .map(([label, v]) => ({ label, count: v.count, color: v.color }))
    .sort((a, b) => b.count - a.count);

  const topFiles = Array.from(topFileAgg.values())
    .sort((a, b) => b.editCount - a.editCount || b.latestSize - a.latestSize)
    .slice(0, 8);

  milestones.sort((a, b) => b.date.localeCompare(a.date));

  return {
    periodLabel,
    generatedAt: now,
    markdown: lines.join('\n'),
    archiveCount: totalArchives,
    projectCount: activeProjCount,
    touchedFilesCount: globalTouched.size,
    totalAdded,
    totalModified,
    totalDeleted,
    dailyActivity,
    fileTypeBreakdown,
    topFiles,
    milestones
  };
}
