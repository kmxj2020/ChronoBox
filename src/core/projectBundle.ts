import * as fs from 'fs';
import * as path from 'path';
import { ArchiveRecord, TrackedProject } from './types';
import { ChronoBoxRepository } from './repository';
import { WorkspaceManager } from './workspaceManager';
import { REPO_DIR_NAME } from './ignore';

export type BundleHistoryScope = 'current-branch' | 'all' | 'compressed-only';

export interface ExportBundleOptions {
  destinationParentDir: string;
  historyScope?: BundleHistoryScope;
  archiveBoxFolderName?: string;
  autoArchiveFinalIfDirty?: boolean;
  finalArchiveTitle?: string;
}

export interface ProjectBundleManifest {
  bundleVersion: number;
  app: 'ChronoBox';
  projectName: string;
  repoId: string;
  exportedAt: number;
  historyScope: BundleHistoryScope;
  archiveCount: number;
  exportedHistoryCount: number;
  archiveBoxFolderName: string;
  customTags: string[];
  finalDir: string;
  historyDir: string;
  archiveBoxDir: string;
  metaDir: string;
}

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

export const BUNDLE_DESCRIPTOR_FILENAME = '重新加载项目.chronobox.json';

function sanitizeName(name: string, maxLen = 36): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || '项目').slice(0, maxLen);
}

function formatDateYmd(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function formatDateDash(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytesSimple(bytes: number): string {
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

function copyDirRecursive(srcDir: string, destDir: string, skipDirNames: Set<string> = new Set()): void {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirNames.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, skipDirNames);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function isSameOrSubPath(parentDir: string, candidateDir: string): boolean {
  const p = path.resolve(parentDir).toLowerCase();
  const c = path.resolve(candidateDir).toLowerCase();
  if (p === c) return true;
  const rel = path.relative(p, c);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 结项导出：将项目打包为“脱离软件可直接阅读 + 日后可一键加载续上”的自包含目录包
 */
export function exportProjectBundle(
  repo: ChronoBoxRepository,
  project: TrackedProject,
  options: ExportBundleOptions
): ExportBundleResult {
  const destParent = path.resolve(options.destinationParentDir);
  if (!fs.existsSync(destParent) || !fs.statSync(destParent).isDirectory()) {
    throw new Error(`导出目标目录不存在: ${destParent}`);
  }
  if (isSameOrSubPath(project.rootPath, destParent)) {
    throw new Error('不能将结项包导出到当前项目文件夹内部（会造成嵌套循环），请选择桌面或其他目录');
  }

  let autoArchivedFinal = false;
  if (options.autoArchiveFinalIfDirty !== false) {
    const working = repo.getWorkingChanges();
    if (working.changes.length > 0) {
      repo.createArchive({ title: options.finalArchiveTitle?.trim() || '结项最终定稿' });
      autoArchivedFinal = true;
    }
  }

  const manifest = repo.loadManifest();
  const allActiveArchives = Object.values(manifest.archives)
    .filter((a) => !a.archived)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (allActiveArchives.length === 0) {
    throw new Error('当前项目尚无任何时间盒子存档，请先创建至少一个存档后再结项导出');
  }

  const now = Date.now();
  const safeProjName = sanitizeName(project.name || manifest.name, 32);
  let bundleDir = path.join(destParent, `${safeProjName}_结项归档_${formatDateYmd(now)}`);
  if (fs.existsSync(bundleDir)) {
    const hms = new Date(now).toTimeString().slice(0, 8).replace(/:/g, '');
    bundleDir = path.join(destParent, `${safeProjName}_结项归档_${formatDateYmd(now)}_${hms}`);
  }
  fs.mkdirSync(bundleDir, { recursive: true });

  // 1. 导出 01_最终版本/
  const finalArchiveId =
    manifest.currentArchiveId && manifest.archives[manifest.currentArchiveId]
      ? manifest.currentArchiveId
      : allActiveArchives[allActiveArchives.length - 1].id;
  const finalDir = path.join(bundleDir, '01_最终版本');
  const finalExport = repo.exportArchive(finalArchiveId, finalDir);

  // 2. 按所选策略导出 02_历史版本/
  const historyScope: BundleHistoryScope = options.historyScope || 'current-branch';
  let historyTargets: ArchiveRecord[] = [];
  if (historyScope === 'current-branch') {
    const chain: ArchiveRecord[] = [];
    const seen = new Set<string>();
    let cur: string | null = finalArchiveId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const rec: ArchiveRecord | undefined = manifest.archives[cur];
      if (!rec) break;
      if (!rec.archived) chain.push(rec);
      cur = rec.parentId;
    }
    historyTargets = chain.reverse();
  } else if (historyScope === 'all') {
    historyTargets = allActiveArchives;
  }

  const historyDir = path.join(bundleDir, '02_历史版本');
  if (historyTargets.length > 0) {
    fs.mkdirSync(historyDir, { recursive: true });
    historyTargets.forEach((arc, idx) => {
      const verCode = `V${String(idx + 1).padStart(2, '0')}`;
      const folderTitle = `${verCode}_${formatDateDash(arc.createdAt)}_${sanitizeName(arc.title, 24)}`;
      const verDir = path.join(historyDir, folderTitle);
      repo.exportArchive(arc.id, verDir);
    });
  }

  // 3. 复制 03_Archive归档箱/（若存在）
  const boxName = options.archiveBoxFolderName || '00【Archive】';
  const srcBoxDir = path.join(project.rootPath, boxName);
  const destBoxDir = path.join(bundleDir, '03_Archive归档箱');
  let copiedArchiveBox = false;
  if (fs.existsSync(srcBoxDir) && fs.statSync(srcBoxDir).isDirectory()) {
    const items = fs.readdirSync(srcBoxDir);
    if (items.length > 0) {
      copyDirRecursive(srcBoxDir, destBoxDir);
      copiedArchiveBox = true;
    }
  }

  // 4. 完整复制 .chronobox/ 原始历史仓库（排除 temp_history），用于日后一键加载无缝续上
  const destMetaDir = path.join(bundleDir, REPO_DIR_NAME);
  copyDirRecursive(repo.metaDir, destMetaDir, new Set(['temp_history']));

  // 5. 生成可读的《结项清单.md》
  const mdLines: string[] = [
    `# ${project.name} — 项目结项归档清单`,
    '',
    `- **导出时间**：${formatDateTime(now)}`,
    `- **总存档数**：${allActiveArchives.length} 个时间盒子（本次展开 ${historyTargets.length} 个原生历史目录）`,
    `- **历史展开策略**：${historyScope === 'current-branch' ? '仅展开当前分支历史' : historyScope === 'all' ? '展开全部历史版本' : '仅保留 .chronobox 压缩历史库'}`,
    `- **日后继续修改**：打开「时匣 ChronoBox」→ 设置与关于 → 点击「加载结项包恢复项目」并选中本目录下的 \`${BUNDLE_DESCRIPTOR_FILENAME}\` 即可 100% 续上全部历史。`,
    '',
    '## 目录结构说明',
    '- `01_最终版本/`：项目最终定稿文件，可直接发送或打开使用。',
    historyTargets.length > 0 ? '- `02_历史版本/`：按时间顺序展开的原生历史快照，脱离软件也能直接查看。' : '- （未展开原生历史目录，全部完整历史保存在 `.chronobox/` 压缩库中）',
    copiedArchiveBox ? `- \`03_Archive归档箱/\`：原项目 \`${boxName}\` 中的旧文件归档。` : '',
    '- `.chronobox/`：时匣原始增量历史库（请勿手动修改，供一键加载续上）。',
    '',
    '## 历史版本履历',
    '| 序号 | 时间 | 标题 | 文件数 | 大小 | 备注 |',
    '| :--- | :--- | :--- | ---: | ---: | :--- |'
  ].filter((l) => l !== '');

  allActiveArchives.forEach((arc, i) => {
    const isFinal = arc.id === finalArchiveId ? ' **[最终]**' : '';
    const noteClean = (arc.note || '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
    mdLines.push(
      `| V${i + 1} | ${formatDateTime(arc.createdAt)} | ${arc.title}${isFinal} | ${arc.summary.totalFiles} | ${formatBytesSimple(arc.summary.totalSize)} | ${noteClean} |`
    );
  });
  fs.writeFileSync(path.join(bundleDir, '结项清单.md'), mdLines.join('\n') + '\n', 'utf-8');

  // 6. 生成一键加载凭证《重新加载项目.chronobox.json》
  const descriptor: ProjectBundleManifest = {
    bundleVersion: 1,
    app: 'ChronoBox',
    projectName: project.name || manifest.name,
    repoId: manifest.repoId,
    exportedAt: now,
    historyScope,
    archiveCount: allActiveArchives.length,
    exportedHistoryCount: historyTargets.length,
    archiveBoxFolderName: boxName,
    customTags: project.customTags || [],
    finalDir: '01_最终版本',
    historyDir: '02_历史版本',
    archiveBoxDir: '03_Archive归档箱',
    metaDir: REPO_DIR_NAME
  };
  const descriptorPath = path.join(bundleDir, BUNDLE_DESCRIPTOR_FILENAME);
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), 'utf-8');

  return {
    bundleDir,
    descriptorPath,
    finalFilesCount: finalExport.exportedFiles,
    exportedHistoryCount: historyTargets.length,
    copiedArchiveBox,
    autoArchivedFinal
  };
}

/**
 * 一键加载结项包：将此前导出的结项归档重新还原为活跃的时匣项目，无缝续上全部历史！
 */
export function importProjectBundle(
  bundleFileOrDir: string,
  targetParentOrEmptyDir: string,
  manager: WorkspaceManager
): ImportBundleResult {
  const inputResolved = path.resolve(bundleFileOrDir);
  if (!fs.existsSync(inputResolved)) {
    throw new Error(`找不到结项包路径: ${inputResolved}`);
  }

  const stat = fs.statSync(inputResolved);
  const bundleDir = stat.isDirectory() ? inputResolved : path.dirname(inputResolved);
  const descriptorPath = stat.isDirectory()
    ? path.join(bundleDir, BUNDLE_DESCRIPTOR_FILENAME)
    : inputResolved;

  if (!fs.existsSync(descriptorPath)) {
    throw new Error(`未在目录中找到结项恢复凭证文件（${BUNDLE_DESCRIPTOR_FILENAME}）`);
  }

  let descriptor: ProjectBundleManifest;
  try {
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')) as ProjectBundleManifest;
  } catch {
    throw new Error('结项恢复凭证文件格式损坏，无法解析');
  }

  const srcMetaDir = path.join(bundleDir, descriptor.metaDir || REPO_DIR_NAME);
  const srcFinalDir = path.join(bundleDir, descriptor.finalDir || '01_最终版本');
  if (!fs.existsSync(srcMetaDir) || !fs.existsSync(path.join(srcMetaDir, 'manifest.json'))) {
    throw new Error('结项包内缺少 .chronobox 历史仓库目录，无法恢复历史记录');
  }

  const targetBase = path.resolve(targetParentOrEmptyDir);
  fs.mkdirSync(targetBase, { recursive: true });
  const existingEntries = fs.readdirSync(targetBase);

  // 若用户选择的目标目录非空，自动在其下新建同名子目录，绝不覆盖用户原有文件
  let restoredPath = targetBase;
  if (existingEntries.length > 0) {
    const safeName = sanitizeName(descriptor.projectName || '恢复的项目', 32);
    restoredPath = path.join(targetBase, safeName);
    if (fs.existsSync(restoredPath) && fs.readdirSync(restoredPath).length > 0) {
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      restoredPath = path.join(targetBase, `${safeName}_恢复_${stamp}`);
    }
    fs.mkdirSync(restoredPath, { recursive: true });
  }

  // 1. 还原 01_最终版本/ 到工作区根目录
  if (fs.existsSync(srcFinalDir) && fs.statSync(srcFinalDir).isDirectory()) {
    copyDirRecursive(srcFinalDir, restoredPath);
  }

  // 2. 还原 .chronobox/ 完整历史仓库
  copyDirRecursive(srcMetaDir, path.join(restoredPath, REPO_DIR_NAME));

  // 3. 若包含 03_Archive归档箱/，还原到原归档箱目录名
  const srcBoxDir = path.join(bundleDir, descriptor.archiveBoxDir || '03_Archive归档箱');
  if (fs.existsSync(srcBoxDir) && fs.statSync(srcBoxDir).isDirectory()) {
    const boxName = descriptor.archiveBoxFolderName || '00【Archive】';
    copyDirRecursive(srcBoxDir, path.join(restoredPath, boxName));
  }

  // 4. 注册为活跃项目（保留原历史，不重复创建初始存档）
  const project = manager.addProject(restoredPath, descriptor.projectName, false, true);
  if (Array.isArray(descriptor.customTags) && descriptor.customTags.length > 0) {
    manager.updateProjectTags(project.id, descriptor.customTags);
  }

  const repo = manager.getRepository(project.id);
  const archiveCount = Object.values(repo.loadManifest().archives).filter((a) => !a.archived).length;

  return {
    project: manager.getProject(project.id) || project,
    restoredPath,
    archiveCount
  };
}
