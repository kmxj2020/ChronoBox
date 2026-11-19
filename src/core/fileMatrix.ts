import { ArchiveBoxEntry, ArchiveRecord, FileEntry, FileMatrixCell, FileMatrixCellStatus, FileMatrixColumn, FileMatrixResult, FileMatrixRow } from './types';

const WORKING_COL_ID = '__WORKING__';

interface ActiveLineage {
  rowId: string;
  currentPath: string;
  lastHash: string;
  lastSize: number;
}

/**
 * 构建文件级演进表格矩阵（ChronoBox 表格视图核心引擎）
 * - 每一列代表一个历史存档（按时间从左到右排列）+ 最右侧「当前工作区（实时）」
 * - 每一行代表一个文件的完整生命周期：
 *   - 初始存档文件标记为 `initial`
 *   - 后续新增文件自动追加新行并标记为 `added`
 *   - 发生内容修改标记为 `modified`（附带体积变化 deltaSize）
 *   - 同次存档中“旧路径消失 + 新路径出现且 SHA-256 哈希完全一致”自动识别为 `renamed` 并保持在同一行！
 *   - 文件消失后不删除行，保留全部历史；并结合 00【Archive】日志精准区分 `archived`（已归档）与 `deleted`（已删除）！
 */
export function buildFileEvolutionMatrix(
  archives: ArchiveRecord[],
  currentArchiveId: string | null,
  workingFiles?: Record<string, FileEntry>,
  archiveBoxEntries: ArchiveBoxEntry[] = [],
  onlyCurrentBranch = false
): FileMatrixResult {
  // 仅取未软归档的历史存档
  const activeArchives = archives.filter((a) => !a.archived);
  let ordered: ArchiveRecord[];

  if (onlyCurrentBranch && currentArchiveId) {
    const byId = new Map(activeArchives.map((a) => [a.id, a]));
    const chain: ArchiveRecord[] = [];
    const seen = new Set<string>();
    let curId: string | null = currentArchiveId;
    while (curId && !seen.has(curId)) {
      seen.add(curId);
      const rec = byId.get(curId);
      if (!rec) break;
      chain.push(rec);
      curId = rec.parentId;
    }
    ordered = chain.reverse();
  } else {
    ordered = activeArchives.sort((a, b) => a.createdAt - b.createdAt);
  }

  // 构建 00【Archive】已归档路径索引（用于精准区分“已归档”与“已删除”）
  const archivedPathMap = new Map<string, ArchiveBoxEntry[]>();
  for (const box of archiveBoxEntries) {
    if (box.restored) continue;
    const key = box.relativeOriginalPath.replace(/\\/g, '/').toLowerCase();
    const list = archivedPathMap.get(key) || [];
    list.push(box);
    archivedPathMap.set(key, list);
  }

  const columns: FileMatrixColumn[] = ordered.map((arc, idx) => ({
    id: arc.id,
    versionLabel: `V${idx + 1}`,
    title: arc.title,
    createdAt: arc.createdAt,
    isCurrent: arc.id === currentArchiveId,
    isWorking: false,
    tags: arc.tags
  }));

  // 若当前工作区与最新存档存在差异，在最右侧追加「当前工作区」实时列
  const snapshots: Array<{ colId: string; createdAt: number; files: Record<string, FileEntry>; isFirst: boolean }> =
    ordered.map((arc, idx) => ({
      colId: arc.id,
      createdAt: arc.createdAt,
      files: arc.files,
      isFirst: idx === 0
    }));

  if (workingFiles) {
    const latestFiles = ordered.length > 0 ? ordered[ordered.length - 1].files : {};
    const workingHasDiff = hasFileMapDiff(latestFiles, workingFiles);
    if (workingHasDiff || ordered.length === 0) {
      columns.push({
        id: WORKING_COL_ID,
        versionLabel: '实时',
        title: '当前工作区（未存档）',
        createdAt: Date.now(),
        isCurrent: false,
        isWorking: true,
        tags: []
      });
      snapshots.push({
        colId: WORKING_COL_ID,
        createdAt: Date.now(),
        files: workingFiles,
        isFirst: ordered.length === 0
      });
    }
  }

  const rows: FileMatrixRow[] = [];
  const rowById = new Map<string, FileMatrixRow>();
  // 当前活跃文件映射：relPath -> ActiveLineage
  let activeByPath = new Map<string, ActiveLineage>();
  let rowSeq = 0;

  const ensureRow = (initialPath: string, firstColIdx: number, isBinary: boolean): FileMatrixRow => {
    const id = `row_${++rowSeq}`;
    const extIdx = initialPath.lastIndexOf('.');
    const ext = extIdx > 0 ? initialPath.slice(extIdx + 1).toLowerCase() : '';
    const row: FileMatrixRow = {
      rowId: id,
      displayPath: initialPath,
      ext,
      isBinary,
      currentState: 'active',
      editCount: 0,
      firstColIndex: firstColIdx,
      lastModifiedAt: snapshots[firstColIdx]?.createdAt || 0,
      cells: new Array<FileMatrixCell>(columns.length)
    };
    // 前置列填充 absent
    for (let c = 0; c < firstColIdx; c++) {
      row.cells[c] = { colId: columns[c].id, status: 'absent' };
    }
    rows.push(row);
    rowById.set(id, row);
    return row;
  };

  for (let colIdx = 0; colIdx < snapshots.length; colIdx++) {
    const snap = snapshots[colIdx];
    const currFiles = snap.files;
    const nextActive = new Map<string, ActiveLineage>();

    // 1. 找出本列相对上一列消失的路径与新出现的路径
    const disappeared: Array<{ path: string; lineage: ActiveLineage }> = [];
    const appeared: Array<{ path: string; entry: FileEntry }> = [];

    for (const [prevPath, lineage] of activeByPath.entries()) {
      const currEntry = currFiles[prevPath];
      if (currEntry) {
        const row = rowById.get(lineage.rowId)!;
        const isModified = currEntry.hash !== lineage.lastHash;
        const status: FileMatrixCellStatus = isModified ? 'modified' : 'unchanged';
        if (isModified) { row.editCount++; row.lastModifiedAt = currEntry.mtimeMs || snap.createdAt; }
        row.displayPath = prevPath;
        row.currentState = 'active';
        row.cells[colIdx] = {
          colId: snap.colId,
          status,
          path: prevPath,
          size: currEntry.size,
          deltaSize: currEntry.size - lineage.lastSize,
          hash: currEntry.hash
        };
        nextActive.set(prevPath, {
          rowId: lineage.rowId,
          currentPath: prevPath,
          lastHash: currEntry.hash,
          lastSize: currEntry.size
        });
      } else {
        disappeared.push({ path: prevPath, lineage });
      }
    }

    for (const [currPath, entry] of Object.entries(currFiles)) {
      if (!activeByPath.has(currPath)) {
        appeared.push({ path: currPath, entry });
      }
    }

    // 2. 通过 SHA-256 哈希精确匹配「重命名（Rename）」，保持在同一行！
    const matchedDisappeared = new Set<string>();
    const matchedAppeared = new Set<string>();

    for (const d of disappeared) {
      const match = appeared.find(
        (a) => !matchedAppeared.has(a.path) && a.entry.hash === d.lineage.lastHash
      );
      if (match) {
        matchedDisappeared.add(d.path);
        matchedAppeared.add(match.path);

        const row = rowById.get(d.lineage.rowId)!;
        row.displayPath = match.path;
        row.currentState = 'active';
        row.editCount++;
        row.lastModifiedAt = match.entry.mtimeMs || snap.createdAt;

        // 内容哈希完全一致 → 文件没有变，只是「名字」或「位置」变了：
        //   · 父目录相同  → 重命名（Rename）
        //   · 父目录不同  → 移动（Move），例如从「新建文件夹/」搬到「新建文件夹 (2)/」
        const fromDir = dirOf(d.path);
        const toDir = dirOf(match.path);
        const isMove = fromDir !== toDir;
        row.cells[colIdx] = {
          colId: snap.colId,
          status: isMove ? 'moved' : 'renamed',
          path: match.path,
          previousPath: d.path,
          fromDir,
          toDir,
          size: match.entry.size,
          deltaSize: match.entry.size - d.lineage.lastSize,
          hash: match.entry.hash
        };
        nextActive.set(match.path, {
          rowId: d.lineage.rowId,
          currentPath: match.path,
          lastHash: match.entry.hash,
          lastSize: match.entry.size
        });
      }
    }

    // 3. 处理真正消失的文件：精准区分 `archived`（移入 00【Archive】）与 `deleted`（直接删除）
    for (const d of disappeared) {
      if (matchedDisappeared.has(d.path)) continue;
      const row = rowById.get(d.lineage.rowId)!;
      const boxHits = archivedPathMap.get(d.path.toLowerCase());
      const isArchived = Boolean(boxHits && boxHits.length > 0);
      const status: FileMatrixCellStatus = isArchived ? 'archived' : 'deleted';

      row.currentState = isArchived ? 'archived' : 'deleted';
      row.cells[colIdx] = {
        colId: snap.colId,
        status,
        path: d.path,
        size: d.lineage.lastSize,
        archivedDateFolder: isArchived ? boxHits![0].dateFolder : undefined
      };
    }

    // 3.5 建立「本列仍然存在的文件」的哈希索引，用于识别「复制」：
    //     新路径出现，但同内容的另一个文件仍然留在原处 —— 那说明用户复制了一份副本，
    //     而不是新建文件（新建不可能与已有文件字节级完全一致）。
    const preservedByHash = new Map<string, string>();
    for (const [p, lin] of nextActive.entries()) {
      if (!preservedByHash.has(lin.lastHash)) preservedByHash.set(lin.lastHash, p);
    }

    // 4. 处理本列全新出现的文件：追加新行（按文件名排序保证稳定）
    appeared
      .filter((a) => !matchedAppeared.has(a.path))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'))
      .forEach((a) => {
        const row = ensureRow(a.path, colIdx, a.entry.isBinary);
        row.lastModifiedAt = a.entry.mtimeMs || snap.createdAt;
        const copySource = snap.isFirst ? undefined : preservedByHash.get(a.entry.hash);
        const status: FileMatrixCellStatus = snap.isFirst ? 'initial' : copySource ? 'copied' : 'added';
        row.currentState = 'active';
        row.cells[colIdx] = {
          colId: snap.colId,
          status,
          path: a.path,
          size: a.entry.size,
          deltaSize: a.entry.size,
          hash: a.entry.hash,
          copiedFrom: copySource,
          fromDir: copySource ? dirOf(copySource) : undefined,
          toDir: copySource ? dirOf(a.path) : undefined
        };
        nextActive.set(a.path, {
          rowId: row.rowId,
          currentPath: a.path,
          lastHash: a.entry.hash,
          lastSize: a.entry.size
        });
      });

    // 5. 所有之前已删除/已归档的行在本列填充 `absent`（不删行，不再更新）
    for (const row of rows) {
      if (!row.cells[colIdx]) {
        row.cells[colIdx] = { colId: snap.colId, status: 'absent' };
      }
    }

    activeByPath = nextActive;
  }

  return {
    columns,
    rows,
    stats: {
      totalFilesTracked: rows.length,
      activeFiles: rows.filter((r) => r.currentState === 'active').length,
      archivedFiles: rows.filter((r) => r.currentState === 'archived').length,
      deletedFiles: rows.filter((r) => r.currentState === 'deleted').length
    }
  };
}

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function hasFileMapDiff(a: Record<string, FileEntry>, b: Record<string, FileEntry>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return true;
  for (const k of keysA) {
    if (!b[k] || b[k].hash !== a[k].hash) return true;
  }
  return false;
}
