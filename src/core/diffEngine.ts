import { FileDiffItem, FileEntry, TextDiffLine, TextDiffResult, VisualSnapshotItem } from './types';

/**
 * 构建目录视觉快照清单（顶层文件与文件夹，用于大图标网格直观展示）
 */
export function buildVisualSnapshot(
  files: Record<string, FileEntry>,
  directories: string[] = []
): VisualSnapshotItem[] {
  const topMap = new Map<string, VisualSnapshotItem>();

  for (const dirPath of directories) {
    const topName = dirPath.split('/')[0];
    if (!topName) continue;
    if (!topMap.has(topName)) {
      topMap.set(topName, {
        name: topName,
        path: topName,
        kind: 'directory',
        ext: '',
        size: 0
      });
    }
  }

  for (const entry of Object.values(files)) {
    const parts = entry.path.split('/');
    if (parts.length === 1) {
      const name = parts[0];
      const dotIdx = name.lastIndexOf('.');
      const ext = dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : '';
      topMap.set(name, {
        name,
        path: entry.path,
        kind: 'file',
        ext,
        size: entry.size
      });
    } else {
      const topDir = parts[0];
      const existing = topMap.get(topDir);
      if (existing) {
        existing.size += entry.size;
      } else {
        topMap.set(topDir, {
          name: topDir,
          path: topDir,
          kind: 'directory',
          ext: '',
          size: entry.size
        });
      }
    }
  }

  // 文件夹排前，文件按名称排序（与 Windows 资源管理器一致）
  return Array.from(topMap.values()).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

/**
 * 计算两个快照之间的文件与文件夹差异清单（完整支持空文件夹的新增与删除）
 */
export function computeFileDiffs(
  fromFiles: Record<string, FileEntry>,
  toFiles: Record<string, FileEntry>,
  fromDirs: string[] = [],
  toDirs: string[] = []
): FileDiffItem[] {
  const allPaths = new Set<string>([
    ...Object.keys(fromFiles),
    ...Object.keys(toFiles)
  ]);

  const sortedPaths = Array.from(allPaths).sort((a, b) => a.localeCompare(b));
  const items: FileDiffItem[] = [];

  for (const filePath of sortedPaths) {
    const oldEntry = fromFiles[filePath];
    const newEntry = toFiles[filePath];

    if (!oldEntry && newEntry) {
      items.push({
        path: filePath,
        status: 'added',
        entryType: 'file',
        newSize: newEntry.size,
        newHash: newEntry.hash,
        newMtimeMs: newEntry.mtimeMs,
        isBinary: newEntry.isBinary
      });
    } else if (oldEntry && !newEntry) {
      items.push({
        path: filePath,
        status: 'deleted',
        entryType: 'file',
        oldSize: oldEntry.size,
        oldHash: oldEntry.hash,
        oldMtimeMs: oldEntry.mtimeMs,
        isBinary: oldEntry.isBinary
      });
    } else if (oldEntry && newEntry && oldEntry.hash !== newEntry.hash) {
      items.push({
        path: filePath,
        status: 'modified',
        entryType: 'file',
        oldSize: oldEntry.size,
        newSize: newEntry.size,
        oldHash: oldEntry.hash,
        newHash: newEntry.hash,
        oldMtimeMs: oldEntry.mtimeMs,
        newMtimeMs: newEntry.mtimeMs,
        isBinary: oldEntry.isBinary || newEntry.isBinary
      });
    }
  }

  // 对比文件夹变更（确保仅新建/删除空文件夹时也能被清晰检测到）
  const fromDirSet = new Set(fromDirs);
  const toDirSet = new Set(toDirs);
  const allDirs = Array.from(new Set([...fromDirs, ...toDirs])).sort((a, b) => a.localeCompare(b));

  for (const dirPath of allDirs) {
    const inFrom = fromDirSet.has(dirPath);
    const inTo = toDirSet.has(dirPath);
    if (!inFrom && inTo) {
      items.push({
        path: `${dirPath}/`,
        status: 'added',
        entryType: 'directory',
        isBinary: false
      });
    } else if (inFrom && !inTo) {
      items.push({
        path: `${dirPath}/`,
        status: 'deleted',
        entryType: 'directory',
        isBinary: false
      });
    }
  }

  return items;
}

export function summarizeDiffs(items: FileDiffItem[]): { added: number; modified: number; deleted: number } {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const item of items) {
    if (item.status === 'added') added++;
    else if (item.status === 'modified') modified++;
    else if (item.status === 'deleted') deleted++;
  }
  return { added, modified, deleted };
}

export function computeTextDiff(
  filePath: string,
  oldText: string | null,
  newText: string | null,
  maxLines = 1500
): TextDiffResult {
  const splitLines = (text: string | null): string[] => {
    if (text === null || text === '') return [];
    return text.replace(/\r\n/g, '\n').split('\n');
  };

  let a = splitLines(oldText);
  let b = splitLines(newText);
  let truncated = false;

  if (a.length > maxLines) {
    a = a.slice(0, maxLines);
    truncated = true;
  }
  if (b.length > maxLines) {
    b = b.slice(0, maxLines);
    truncated = true;
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  const lines: TextDiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < prefix; i++) {
    lines.push({
      type: 'equal',
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
      content: a[i]
    });
  }

  const m = aMid.length;
  const n = bMid.length;

  if (m === 0 && n === 0) {
    // no middle diff
  } else if (m * n > 250000) {
    for (let i = 0; i < m; i++) {
      lines.push({ type: 'remove', oldLineNumber: prefix + i + 1, newLineNumber: null, content: aMid[i] });
      deletions++;
    }
    for (let j = 0; j < n; j++) {
      lines.push({ type: 'add', oldLineNumber: null, newLineNumber: prefix + j + 1, content: bMid[j] });
      additions++;
    }
  } else {
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (aMid[i] === bMid[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        lines.push({ type: 'equal', oldLineNumber: prefix + i + 1, newLineNumber: prefix + j + 1, content: aMid[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({ type: 'remove', oldLineNumber: prefix + i + 1, newLineNumber: null, content: aMid[i] });
        deletions++;
        i++;
      } else {
        lines.push({ type: 'add', oldLineNumber: null, newLineNumber: prefix + j + 1, content: bMid[j] });
        additions++;
        j++;
      }
    }
    while (i < m) {
      lines.push({ type: 'remove', oldLineNumber: prefix + i + 1, newLineNumber: null, content: aMid[i] });
      deletions++;
      i++;
    }
    while (j < n) {
      lines.push({ type: 'add', oldLineNumber: null, newLineNumber: prefix + j + 1, content: bMid[j] });
      additions++;
      j++;
    }
  }

  for (let s = 0; s < suffix; s++) {
    const oldIdx = a.length - suffix + s;
    const newIdx = b.length - suffix + s;
    lines.push({ type: 'equal', oldLineNumber: oldIdx + 1, newLineNumber: newIdx + 1, content: a[oldIdx] });
  }

  return { path: filePath, isBinary: false, truncated, lines, additions, deletions };
}
