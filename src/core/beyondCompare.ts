import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { ChronoBoxRepository, WORKING_TREE_ID } from './repository';

const COMMON_WINDOWS_BC_PATHS = [
  'C:\\Program Files\\Beyond Compare 5\\BCompare.exe',
  'C:\\Program Files\\Beyond Compare 4\\BCompare.exe',
  'C:\\Program Files (x86)\\Beyond Compare 4\\BCompare.exe',
  'C:\\Program Files\\Beyond Compare 3\\BCompare.exe',
  'D:\\Program Files\\Beyond Compare 5\\BCompare.exe',
  'D:\\Program Files\\Beyond Compare 4\\BCompare.exe'
];

/**
 * 自动探测 Windows 常见安装目录中的 Beyond Compare (BCompare.exe)
 */
export function detectBeyondComparePath(): string {
  const candidates = [...COMMON_WINDOWS_BC_PATHS];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Programs', 'Beyond Compare 5', 'BCompare.exe'),
      path.join(localAppData, 'Programs', 'Beyond Compare 4', 'BCompare.exe')
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function sanitizeLabel(text: string): string {
  return text.replace(/[\\/:*?"<>|]/g, '_').slice(0, 32) || 'snapshot';
}

export interface PreparedComparePair {
  leftPath: string;
  rightPath: string;
  leftTitle: string;
  rightTitle: string;
}

/**
 * 准备两个版本中单个文件的对比路径：
 * - 若某侧为当前工作区，直接使用真实磁盘路径
 * - 若某侧为历史存档，自动解包到系统临时对比目录
 */
export function prepareCompareFilePair(
  repo: ChronoBoxRepository,
  fromId: string | null,
  toId: string | null,
  relPath: string
): PreparedComparePair {
  const manifest = repo.loadManifest();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronobox-bc-file-'));

  const resolveSide = (id: string | null, side: 'left' | 'right'): { filePath: string; title: string } => {
    const fileName = path.basename(relPath);
    if (!id) {
      const emptyFile = path.join(sessionDir, `${side}_empty_${fileName}`);
      fs.writeFileSync(emptyFile, '');
      return { filePath: emptyFile, title: '空初始状态' };
    }
    if (id === WORKING_TREE_ID) {
      const livePath = path.join(repo.rootPath, ...relPath.split('/'));
      if (fs.existsSync(livePath)) {
        return { filePath: livePath, title: '当前工作区（实时）' };
      }
      const emptyFile = path.join(sessionDir, `${side}_deleted_${fileName}`);
      fs.writeFileSync(emptyFile, '');
      return { filePath: emptyFile, title: '当前工作区（已删除）' };
    }

    const arc = manifest.archives[id];
    if (!arc) throw new Error(`对比存档不存在: ${id}`);
    const entry = arc.files[relPath];
    const outFile = path.join(sessionDir, `${side}_${sanitizeLabel(arc.title)}_${fileName}`);
    if (!entry) {
      fs.writeFileSync(outFile, '');
      return { filePath: outFile, title: `${arc.title}（无此文件）` };
    }
    repo.objectStore.restoreToFile(entry.hash, outFile, entry.mtimeMs);
    return { filePath: outFile, title: arc.title };
  };

  const left = resolveSide(fromId, 'left');
  const right = resolveSide(toId, 'right');

  return {
    leftPath: left.filePath,
    rightPath: right.filePath,
    leftTitle: left.title,
    rightTitle: right.title
  };
}

/**
 * 准备两个版本整目录的对比路径（供 Beyond Compare 文件夹对比视图直接打开）
 */
export function prepareCompareFolderPair(
  repo: ChronoBoxRepository,
  fromId: string | null,
  toId: string | null
): PreparedComparePair {
  const manifest = repo.loadManifest();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronobox-bc-dir-'));

  const resolveDir = (id: string | null, side: 'left' | 'right'): { dirPath: string; title: string } => {
    if (!id) {
      const emptyDir = path.join(sessionDir, `${side}_empty`);
      fs.mkdirSync(emptyDir, { recursive: true });
      return { dirPath: emptyDir, title: '空初始状态' };
    }
    if (id === WORKING_TREE_ID) {
      return { dirPath: repo.rootPath, title: '当前工作区（实时）' };
    }
    const arc = manifest.archives[id];
    if (!arc) throw new Error(`对比存档不存在: ${id}`);
    const outDir = path.join(sessionDir, `${side}_${sanitizeLabel(arc.title)}`);
    repo.exportArchive(id, outDir);
    return { dirPath: outDir, title: arc.title };
  };

  const left = resolveDir(fromId, 'left');
  const right = resolveDir(toId, 'right');

  return {
    leftPath: left.dirPath,
    rightPath: right.dirPath,
    leftTitle: left.title,
    rightTitle: right.title
  };
}

/**
 * 启动 Beyond Compare 执行双栏内容/目录对比
 */
export function launchBeyondCompare(bcExePath: string, pair: PreparedComparePair): void {
  const exe = bcExePath.trim();
  if (!exe || !fs.existsSync(exe)) {
    throw new Error('未找到 Beyond Compare 可执行文件（BCompare.exe），请在「设置与关于」中配置路径');
  }

  const child = spawn(
    exe,
    [
      pair.leftPath,
      pair.rightPath,
      `/title1=${pair.leftTitle}`,
      `/title2=${pair.rightTitle}`
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }
  );
  child.unref();
}
