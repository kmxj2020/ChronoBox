import { FileMatrixCell, FileMatrixColumn, FileMatrixResult, FileMatrixRow } from './types.js';
import { formatBytes, formatTime } from './i18n.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const EYE_OPEN_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.06 12.35a1 1 0 0 1 0-.7C3.6 7.6 7.5 5 12 5s8.4 2.6 9.94 6.65a1 1 0 0 1 0 .7C20.4 16.4 16.5 19 12 19s-8.4-2.6-9.94-6.65Z"/><circle cx="12" cy="12" r="3"/></svg>';

const EYE_OFF_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.2A9.9 9.9 0 0 1 12 5c4.5 0 8.4 2.6 9.94 6.65a1 1 0 0 1 0 .7 10.6 10.6 0 0 1-2.4 3.5"/><path d="M6.2 6.2A10.7 10.7 0 0 0 2.06 11.65a1 1 0 0 0 0 .7C3.6 16.4 7.5 19 12 19c1.6 0 3.1-.34 4.4-.94"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>';

function getExtBadge(ext: string): { label: string; bg: string; fg: string } {
  const e = ext.toLowerCase();
  if (['doc', 'docx'].includes(e)) return { label: 'W', bg: '#DBEAFE', fg: '#1D4ED8' };
  if (['xls', 'xlsx', 'csv'].includes(e)) return { label: 'X', bg: '#D1FAE5', fg: '#047857' };
  if (['opju', 'opj', 'ogwu'].includes(e)) return { label: 'O', bg: '#FFEDD5', fg: '#C2410C' };
  if (['ppt', 'pptx'].includes(e)) return { label: 'P', bg: '#FEE2E2', fg: '#B91C1C' };
  if (e === 'pdf') return { label: 'PDF', bg: '#FCE7F3', fg: '#BE185D' };
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'tif'].includes(e)) return { label: 'IMG', bg: '#F3E8FF', fg: '#7E22CE' };
  return { label: e ? e.toUpperCase().slice(0, 3) : 'F', bg: '#F1F5F9', fg: '#475569' };
}

function formatDelta(delta?: number): string {
  if (delta === undefined || delta === 0) return '';
  const sign = delta > 0 ? '+' : '-';
  return `${sign}${formatBytes(Math.abs(delta))}`;
}

export type MatrixSortMode = 'default' | 'name' | 'mtime' | 'edits';

export interface MatrixViewOptions {
  searchQuery: string;
  hideRetired: boolean;
  showCellFilenames: boolean;
  selectedArchiveId: string | null;
  sortMode: MatrixSortMode;
  selectedFolder: string;
  showAllFiles: boolean;
  onlyCurrentBranch: boolean;
  pinnedFiles: string[];
  highlightPath: string | null;
  /** 用户手动隐藏的文件相对路径（不参与渲染，可用「显示已隐藏」切回） */
  hiddenPaths: string[];
  /** 是否显示已隐藏文件（取消隐藏入口） */
  showHidden: boolean;
  /** 版本列显示模式：0 = 自动适配窗口，4/5/6/7/8 = 固定列数（挤压列宽而不裁列） */
  columnMode: number;
  /** 双击单元格后在右侧检视器中聚焦的文件（用于行高亮） */
  focusedCellKey?: string | null;
}

export interface MatrixCallbacks {
  onSelectColumn: (archiveId: string) => void;
  onInspectCellDiff: (colIdx: number, col: FileMatrixColumn, cell: FileMatrixCell, row: FileMatrixRow) => void;
  onTogglePinFile: (relPath: string) => void;
  onOpenFile: (relPath: string) => void;
  onFileContextMenu: (row: FileMatrixRow, isPinned: boolean) => void;
  onSelectFileTempHistory: (relPath: string) => void;
  onOptionsChange: (partial: Partial<MatrixViewOptions>) => void;
  /** 右键菜单里「隐藏 / 取消隐藏此文件」 */
  onToggleHiddenFile: (relPath: string) => void;
}

function getParentFolder(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/**
 * 渲染文件级演进表格视图（v2.4）：
 * - 视口内精准对齐 6 个版本列，隐藏滚动条
 * - 滚轮上下滚动文件，按住 Shift + 滚轮左右平滑切换历史版本
 * - 支持文件置顶、文件名/修改时间/变更次数排序、文件夹下拉筛选 +「显示全部文件」开关、以及联动高亮定位
 */
export function renderFileMatrixView(
  container: HTMLElement,
  matrix: FileMatrixResult,
  options: MatrixViewOptions,
  callbacks: MatrixCallbacks
): void {
  // 记住当前横向滚动状态：当新增「实时（未存档）」列或新存档列时自动滑到最右侧展示最新列
  const prevWrap = container.querySelector<HTMLElement>('.matrix-scroll-wrap');
  const prevScrollLeft = prevWrap ? prevWrap.scrollLeft : null;
  const prevScrollTop = prevWrap ? prevWrap.scrollTop : 0;
  const prevMaxScroll = prevWrap ? Math.max(0, prevWrap.scrollWidth - prevWrap.clientWidth) : 0;
  const wasNearRight = prevWrap ? prevMaxScroll - prevWrap.scrollLeft <= 28 : true;
  const hadWorkingCol = Boolean(container.querySelector('.working-col'));
  const prevColCount = Number(prevWrap?.dataset.colCount || '0');
  const hasWorkingColNow = matrix.columns.some((c) => c.isWorking);

  // 收集所有出现过的子文件夹供下拉菜单选择
  const folderSet = new Set<string>(['']);
  for (const r of matrix.rows) {
    const dir = getParentFolder(r.displayPath);
    if (dir) {
      const parts = dir.split('/');
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        folderSet.add(acc);
      }
    }
  }
  const allFolders = Array.from(folderSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (!folderSet.has(options.selectedFolder)) {
    options.selectedFolder = '';
  }

  const pinnedSet = new Set(options.pinnedFiles || []);
  const hiddenSet = new Set((options.hiddenPaths || []).map((h) => h.toLowerCase()));
  const q = options.searchQuery.trim().toLowerCase();
  const hiddenRowCount = matrix.rows.filter((r) => hiddenSet.has(r.displayPath.toLowerCase())).length;

  let filteredRows = matrix.rows.filter((r) => {
    if (!options.showHidden && hiddenSet.has(r.displayPath.toLowerCase())) return false;
    if (options.hideRetired && r.currentState !== 'active') return false;

    // 文件夹筛选逻辑：勾选「显示全部文件」时显示全部；不勾选时仅显示当前选中目录的直属文件
    if (!options.showAllFiles) {
      const parentDir = getParentFolder(r.displayPath);
      if (parentDir !== options.selectedFolder) return false;
    }

    if (q) {
      const hitDisplay = r.displayPath.toLowerCase().includes(q);
      const hitHistory = r.cells.some(
        (c) =>
          (c.path && c.path.toLowerCase().includes(q)) ||
          (c.previousPath && c.previousPath.toLowerCase().includes(q))
      );
      if (!hitDisplay && !hitHistory) return false;
    }
    return true;
  });

  // 排序：置顶文件永远在最上方，其余按用户选择的排序方式排列
  filteredRows = [...filteredRows].sort((a, b) => {
    const pinA = pinnedSet.has(a.displayPath) ? 1 : 0;
    const pinB = pinnedSet.has(b.displayPath) ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;

    if (options.sortMode === 'name') {
      return a.displayPath.localeCompare(b.displayPath, 'zh-CN');
    }
    if (options.sortMode === 'mtime') {
      return (b.lastModifiedAt || 0) - (a.lastModifiedAt || 0);
    }
    if (options.sortMode === 'edits') {
      return b.editCount - a.editCount || a.displayPath.localeCompare(b.displayPath, 'zh-CN');
    }
    return a.firstColIndex - b.firstColIndex;
  });

  const folderOptsHtml = allFolders
    .map((f, idx) => {
      if (f === '') {
        return `<option value="" ${'' === options.selectedFolder ? 'selected' : ''}>📁 根目录 (/)</option>`;
      }
      const parts = f.split('/');
      const depth = parts.length;
      const leaf = parts[parts.length - 1];
      const parent = parts.slice(0, -1).join('/');
      const hasNextSibling = allFolders.slice(idx + 1).some((other) => {
        const op = other.split('/');
        return op.length === depth && op.slice(0, -1).join('/') === parent;
      });
      const indent = '\u00A0\u00A0\u00A0'.repeat(Math.max(0, depth - 1));
      const branch = hasNextSibling ? '├─ ' : '└─ ';
      const label = `${indent}${branch}📁 ${leaf}`;
      return `<option value="${escapeHtml(f)}" ${f === options.selectedFolder ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    })
    .join('');

  // 版本列宽计算：
  //   · 自动模式（columnMode = 0）：按可用宽度尽量多显示，单列不小于 128px 保证标题可读；
  //   · 固定模式（N = 4~8）：严格把视口切成 N 列，列宽随面板宽度「挤压」，不再因为
  //     展开右侧栏就少显示几列（这是用户最直接的诉求）。
  const FILE_COL_W = 236;
  const AUTO_MIN_COL_W = 128;
  const AUTO_MAX_COL_W = 232;
  const FIXED_MIN_COL_W = 72;
  const wrapWidth = Math.max(container.clientWidth || 0, 720);
  const available = Math.max(wrapWidth - FILE_COL_W, 320);
  const fixedN = Math.max(0, Math.min(8, Number(options.columnMode) || 0));

  let visibleCols: number;
  let verColW: number;
  if (fixedN > 0) {
    // 固定列数时优先保证「列数不变」：把可用宽度平均切开即可，宽度不足就继续挤压，
    // 只有挤到 72px 仍放不下时才横向滚动（此时用户选的就是列数优先）。
    visibleCols = fixedN;
    verColW = Math.max(FIXED_MIN_COL_W, Math.floor(available / fixedN));
  } else {
    visibleCols = Math.max(2, Math.min(matrix.columns.length || 2, Math.floor(available / AUTO_MIN_COL_W)));
    verColW = Math.min(AUTO_MAX_COL_W, Math.max(AUTO_MIN_COL_W, Math.floor(available / visibleCols)));
  }
  const colStyle = `width:${verColW}px;min-width:${verColW}px;max-width:${verColW}px;`;
  // 固定列数模式：视口里始终放 N 列，历史列比 N 多时仍然需要横向浏览
  const overflows =
    fixedN > 0
      ? matrix.columns.length > fixedN
      : matrix.columns.length * verColW + FILE_COL_W > wrapWidth + 2;

  const toolbarHtml = `
    <div class="matrix-toolbar">
      <div class="matrix-legend">
        <span class="matrix-stat-summary">共 <strong>${matrix.stats.totalFilesTracked}</strong> 文件 · 活跃 ${matrix.stats.activeFiles} · 归档 ${matrix.stats.archivedFiles} · 删除 ${matrix.stats.deletedFiles}</span>
        <span class="m-pill initial">初始</span>
        <span class="m-pill added">新增</span>
        <span class="m-pill modified">编辑</span>
        <span class="m-pill renamed">重命名</span>
        <span class="m-pill moved">移动</span>
        <span class="m-pill copied">复制</span>
        <span class="m-pill archived">已归档</span>
        <span class="m-pill deleted">删除</span>
        <span class="m-legend-quiet"><span class="m-dot-quiet"></span> 未变</span>
      </div>
      <div class="matrix-controls">
        <select id="selMatrixFolder" class="select-input" style="padding:4px 8px;font-size:12px;" title="选择要查看的文件夹" ${options.showAllFiles ? 'disabled' : ''}>
          ${folderOptsHtml}
        </select>
        <label class="matrix-toggle" title="勾选显示全部层级文件；取消勾选仅显示左侧下拉选中的文件夹">
          <input id="chkMatrixShowAll" type="checkbox" ${options.showAllFiles ? 'checked' : ''} />
          <span>全部文件</span>
        </label>
        <select id="selMatrixSort" class="select-input" style="padding:4px 8px;font-size:12px;" title="文件排序方式">
          <option value="default" ${options.sortMode === 'default' ? 'selected' : ''}>默认排序</option>
          <option value="name" ${options.sortMode === 'name' ? 'selected' : ''}>按文件名</option>
          <option value="mtime" ${options.sortMode === 'mtime' ? 'selected' : ''}>按修改时间</option>
          <option value="edits" ${options.sortMode === 'edits' ? 'selected' : ''}>按变更次数</option>
        </select>
        <input id="matrixSearchInput" type="search" class="search-input" style="width:140px;padding:4px 8px;" placeholder="筛选文件名..." value="${escapeHtml(options.searchQuery)}" />
        <label class="matrix-toggle" title="仅显示从初始存档到当前存档所在分支路径上的时间盒子，避免其他旁支文件造成误判删除">
          <input id="chkMatrixOnlyBranch" type="checkbox" ${options.onlyCurrentBranch ? 'checked' : ''} />
          <span>当前分支</span>
        </label>
        <label class="matrix-toggle">
          <input id="chkMatrixHideRetired" type="checkbox" ${options.hideRetired ? 'checked' : ''} />
          <span>仅活跃</span>
        </label>
        <label class="matrix-toggle">
          <input id="chkMatrixShowNames" type="checkbox" ${options.showCellFilenames ? 'checked' : ''} />
          <span>格内文件名</span>
        </label>
        <button id="btnMatrixToggleHidden" class="btn btn-ghost btn-sm matrix-eye-btn ${options.showHidden ? 'is-on' : ''}" title="${options.showHidden ? '当前【显示】已隐藏文件 · 点击收起' : `当前已隐藏 ${hiddenRowCount} 个文件 · 点击显示`}" aria-pressed="${options.showHidden ? 'true' : 'false'}">
          ${options.showHidden ? EYE_OPEN_SVG : EYE_OFF_SVG}
          <span class="matrix-eye-count">${hiddenRowCount}</span>
        </button>
      </div>
    </div>
    <div class="matrix-wheel-hint">
      <span>提示：<strong>双击左侧文件名直接打开编辑</strong> · 右键文件更多操作 · 按住 <strong>Shift + 滚轮</strong> 左右查看更多版本</span>
      ${overflows ? `<span style="display:flex;align-items:center;gap:8px;"><span style="color:var(--accent);font-weight:600;">共 ${matrix.columns.length} 个版本 · 按住 Shift + 滚轮横向浏览</span><button id="btnMatrixJumpLatest" class="btn btn-ghost btn-sm" style="padding:1px 7px;font-size:11px;white-space:nowrap;flex-shrink:0;">跳到最新 →</button></span>` : `<span style="color:var(--text-muted);">共 ${matrix.columns.length} 个版本 · 已全部显示</span>`}
      <span class="matrix-colmode-hint">${fixedN > 0 ? `列数固定 ${fixedN} 列` : '列数自动'} · 在「设置 → 表格视图显示」中调整</span>
    </div>
  `;

  if (matrix.columns.length === 0 || matrix.rows.length === 0) {
    container.innerHTML = `${toolbarHtml}<div style="padding:36px;text-align:center;color:var(--text-muted);">暂无文件演进记录，创建第一个存档后即可在此追踪每个文件的完整生命周期。</div>`;
    bindToolbar(container, callbacks);
    return;
  }

  const headerCells = matrix.columns
    .map((col, idx) => {
      const activeCls = col.id === options.selectedArchiveId ? 'selected-col' : '';
      const curCls = col.isCurrent ? 'current-col' : col.isWorking ? 'working-col' : '';
      return `
        <th class="matrix-th-ver ${activeCls} ${curCls}" style="${colStyle}" data-col-id="${escapeHtml(col.id)}" data-col-idx="${idx}" title="${escapeHtml(col.title)} · ${formatTime(col.createdAt)}">
          <div class="matrix-ver-top">
            <span class="matrix-ver-code">${escapeHtml(col.versionLabel)}</span>
            ${col.isCurrent ? '<span class="matrix-ver-cur">当前</span>' : ''}
            ${col.isWorking ? '<span class="matrix-ver-live">未存档</span>' : ''}
          </div>
          <div class="matrix-ver-title">${escapeHtml(col.title)}</div>
          <div class="matrix-ver-time">${formatTime(col.createdAt).slice(5)}</div>
        </th>
      `;
    })
    .join('');

  const bodyRows = filteredRows
    .map((row) => {
      const badge = getExtBadge(row.ext);
      const baseName = row.displayPath.split('/').pop() || row.displayPath;
      const dirPart = getParentFolder(row.displayPath);
      const isPinned = pinnedSet.has(row.displayPath);
      const isHighlighted = options.highlightPath && options.highlightPath === row.displayPath;
      const stateCls = `${row.currentState !== 'active' ? `row-${row.currentState}` : ''} ${isPinned ? 'row-pinned' : ''} ${isHighlighted ? 'row-highlight-flash' : ''}`;
      const stateTag =
        row.currentState === 'archived'
          ? '<span class="m-row-tag archived">已归档</span>'
          : row.currentState === 'deleted'
            ? '<span class="m-row-tag deleted">已删除</span>'
            : '';

      const cellsHtml = row.cells
        .map((cell, cIdx) => renderMatrixCell(cell, cIdx, options.showCellFilenames, row.rowId, colStyle))
        .join('');

      return `
        <tr class="matrix-row ${stateCls}" data-file-path="${escapeHtml(row.displayPath)}">
          <td class="matrix-td-file" style="cursor:pointer;" data-open-path="${escapeHtml(row.displayPath)}" data-row-id="${escapeHtml(row.rowId)}" title="${escapeHtml(row.displayPath)}\n双击直接打开文档编辑 · 右键弹出快捷菜单">
            <div class="matrix-file-main">
              <button class="m-pin-btn ${isPinned ? 'pinned' : ''}" data-pin-path="${escapeHtml(row.displayPath)}" title="${isPinned ? '取消置顶' : '置顶关注此文件'}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>
              </button>
              <span class="visual-mini-badge" style="background:${badge.bg};color:${badge.fg};">${escapeHtml(badge.label)}</span>
              <span class="matrix-file-name">${escapeHtml(baseName)}</span>
              ${stateTag}
            </div>
            <div class="matrix-file-sub">
              ${dirPart ? `<span>${escapeHtml(dirPart)}/</span> · ` : ''}
              <span>${row.editCount > 0 ? `${row.editCount} 次变更` : '尚未修改'}</span>
            </div>
          </td>
          ${cellsHtml}
        </tr>
      `;
    })
    .join('');

  container.innerHTML = `
    ${toolbarHtml}
    <div class="matrix-scroll-wrap no-scrollbar ${overflows ? 'is-overflowing' : ''}" data-col-count="${matrix.columns.length}">
      <table class="matrix-table">
        <thead>
          <tr>
            <th class="matrix-th-file">文件生命周期（共 ${filteredRows.length} 行）</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>
          ${bodyRows || `<tr><td colspan="${matrix.columns.length + 1}" style="padding:28px;text-align:center;color:var(--text-muted);">当前筛选条件下暂无匹配文件</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  bindToolbar(container, callbacks);

  const scrollWrap = container.querySelector<HTMLElement>('.matrix-scroll-wrap');
  if (scrollWrap) {
    // 首次进入、刚产生未存档「实时」列、或原本在最右侧且列数增加时，自动滚到最右侧直接展示最新/实时列
    const shouldStickRight =
      prevScrollLeft === null ||
      (hasWorkingColNow && !hadWorkingCol) ||
      (wasNearRight && matrix.columns.length > prevColCount);

    if (shouldStickRight) {
      scrollWrap.scrollLeft = Math.max(0, scrollWrap.scrollWidth - scrollWrap.clientWidth);
    } else {
      scrollWrap.scrollLeft = prevScrollLeft;
    }
    scrollWrap.scrollTop = prevScrollTop;

    container.querySelector('#btnMatrixJumpLatest')?.addEventListener('click', () => {
      scrollWrap.scrollTo({ left: scrollWrap.scrollWidth, behavior: 'smooth' });
    });

    // Shift + 滚轮 = 左右平移历史版本；普通滚轮 = 上下滚动文件列表
    scrollWrap.addEventListener(
      'wheel',
      (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
          scrollWrap.scrollLeft += delta * 1.15;
        }
      },
      { passive: false }
    );

    // 若有联动高亮目标文件，平滑滚动至该行
    if (options.highlightPath) {
      const targetRow = scrollWrap.querySelector<HTMLElement>(`tr.row-highlight-flash`);
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  // 置顶文件按钮
  container.querySelectorAll<HTMLButtonElement>('.m-pin-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fp = btn.dataset.pinPath;
      if (fp) callbacks.onTogglePinFile(fp);
    });
  });

  // 左侧文件名：双击直接调用系统默认程序打开编辑，右键弹出快捷菜单
  const rowById = new Map(filteredRows.map((r) => [r.rowId, r]));
  container.querySelectorAll<HTMLElement>('.matrix-td-file').forEach((td) => {
    td.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.m-pin-btn')) return;
      const fp = td.dataset.openPath;
      if (fp) callbacks.onSelectFileTempHistory(fp);
    });
    td.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.m-pin-btn')) return;
      const fp = td.dataset.openPath;
      if (fp) callbacks.onOpenFile(fp);
    });
    td.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rid = td.dataset.rowId || '';
      const row = rowById.get(rid);
      if (row) callbacks.onFileContextMenu(row, pinnedSet.has(row.displayPath));
    });
  });

  // 点击版本列头选中该存档
  container.querySelectorAll<HTMLElement>('.matrix-th-ver').forEach((th) => {
    th.addEventListener('click', () => {
      const colId = th.dataset.colId;
      if (colId && colId !== '__WORKING__') {
        callbacks.onSelectColumn(colId);
      }
    });
  });

  const rowMap = new Map(filteredRows.map((r) => [r.rowId, r]));
  container.querySelectorAll<HTMLElement>('.matrix-cell-clickable').forEach((td) => {
    td.addEventListener('click', () => {
      const colId = td.dataset.colId;
      const rowId = td.dataset.rowId || '';
      const row = rowMap.get(rowId);
      if (colId === '__WORKING__' && row) {
        callbacks.onSelectFileTempHistory(row.displayPath);
      } else if (colId && colId !== '__WORKING__') {
        callbacks.onSelectColumn(colId);
      }
    });
    td.addEventListener('dblclick', () => {
      const colIdx = Number(td.dataset.colIdx);
      const rowId = td.dataset.rowId || '';
      const row = rowMap.get(rowId);
      if (!row || Number.isNaN(colIdx)) return;
      const col = matrix.columns[colIdx];
      const cell = row.cells[colIdx];
      if (col && cell) {
        callbacks.onInspectCellDiff(colIdx, col, cell, row);
      }
    });
  });
}

function renderMatrixCell(
  cell: FileMatrixCell,
  colIdx: number,
  showFilename: boolean,
  rowId: string,
  colStyle: string
): string {
  if (cell.status === 'absent') {
    return `<td class="matrix-td-cell cell-absent" style="${colStyle}"></td>`;
  }

  const baseName = (cell.path || '').split('/').pop() || '';
  const deltaStr = formatDelta(cell.deltaSize);

  if (cell.status === 'unchanged') {
    const tip = `${cell.path || ''}\n状态：无变化 · 大小：${formatBytes(cell.size || 0)}\n单击选中版本 · 双击查看该文件的操作详情`;
    return `
      <td class="matrix-td-cell matrix-cell-clickable cell-unchanged" style="${colStyle}" data-col-id="${escapeHtml(cell.colId)}" data-col-idx="${colIdx}" data-row-id="${escapeHtml(rowId)}" title="${escapeHtml(tip)}">
        ${showFilename ? `<span class="m-quiet-name">${escapeHtml(baseName)}</span>` : '<span class="m-dot-quiet"></span>'}
      </td>
    `;
  }

  const labelMap: Record<string, string> = {
    initial: '初始',
    added: '新增',
    modified: '编辑',
    renamed: '重命名',
    moved: '移动',
    copied: '复制',
    archived: '已归档',
    deleted: '删除'
  };
  const label = labelMap[cell.status] || cell.status;

  let subInfo = '';
  if (cell.status === 'renamed' && cell.previousPath) {
    const oldBase = cell.previousPath.split('/').pop() || cell.previousPath;
    subInfo = `${oldBase} → ${baseName}`;
  } else if (cell.status === 'moved') {
    // 只显示目录变化，文件名通常不变，写全反而更长
    const from = cell.fromDir ? `${cell.fromDir}/` : '根目录/';
    const to = cell.toDir ? `${cell.toDir}/` : '根目录/';
    subInfo = `${from} → ${to}`;
  } else if (cell.status === 'copied') {
    const src = cell.copiedFrom ? cell.copiedFrom.split('/').pop() || cell.copiedFrom : '';
    subInfo = src ? `来自 ${src}` : '副本';
  } else if (cell.status === 'archived' && cell.archivedDateFolder) {
    subInfo = `00【Archive】/${cell.archivedDateFolder}`;
  } else if (cell.status === 'modified' && deltaStr) {
    subInfo = deltaStr;
  } else if (showFilename && baseName) {
    subInfo = baseName;
  }

  const tipParts = [
    cell.path || '',
    `状态：${label}`,
    cell.previousPath ? `原路径：${cell.previousPath}` : '',
    cell.copiedFrom ? `复制来源：${cell.copiedFrom}` : '',
    cell.archivedDateFolder ? `归档位置：00【Archive】/${cell.archivedDateFolder}` : '',
    cell.size !== undefined ? `大小：${formatBytes(cell.size)}${deltaStr ? ` (${deltaStr})` : ''}` : '',
    '单击选中版本 · 双击查看该文件的操作详情'
  ].filter(Boolean);

  return `
    <td class="matrix-td-cell matrix-cell-clickable cell-${cell.status}" style="${colStyle}" data-col-id="${escapeHtml(cell.colId)}" data-col-idx="${colIdx}" data-row-id="${escapeHtml(rowId)}" title="${escapeHtml(tipParts.join('\n'))}">
      <div class="m-cell-content">
        <span class="m-pill ${cell.status}">${label}</span>
        ${subInfo ? `<span class="m-cell-sub">${escapeHtml(subInfo)}</span>` : ''}
      </div>
    </td>
  `;
}

function bindToolbar(container: HTMLElement, callbacks: MatrixCallbacks): void {
  container.querySelector<HTMLSelectElement>('#selMatrixFolder')?.addEventListener('change', (e) => {
    callbacks.onOptionsChange({ selectedFolder: (e.target as HTMLSelectElement).value, highlightPath: null });
  });
  container.querySelector<HTMLInputElement>('#chkMatrixShowAll')?.addEventListener('change', (e) => {
    callbacks.onOptionsChange({ showAllFiles: (e.target as HTMLInputElement).checked, highlightPath: null });
  });
  container.querySelector<HTMLSelectElement>('#selMatrixSort')?.addEventListener('change', (e) => {
    callbacks.onOptionsChange({ sortMode: (e.target as HTMLSelectElement).value as MatrixSortMode });
  });
  container.querySelector<HTMLInputElement>('#matrixSearchInput')?.addEventListener('input', (e) => {
    callbacks.onOptionsChange({ searchQuery: (e.target as HTMLInputElement).value, highlightPath: null });
  });
  container.querySelector<HTMLInputElement>('#chkMatrixOnlyBranch')?.addEventListener('change', (e) => {
    callbacks.onOptionsChange({ onlyCurrentBranch: (e.target as HTMLInputElement).checked });
  });
  container.querySelector<HTMLInputElement>('#chkMatrixHideRetired')?.addEventListener('change', (e) => {
    callbacks.onOptionsChange({ hideRetired: (e.target as HTMLInputElement).checked });
  });
  container.querySelector<HTMLButtonElement>('#btnMatrixToggleHidden')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const next = btn.getAttribute('aria-pressed') !== 'true';
    callbacks.onOptionsChange({ showHidden: next });
  });
  container.querySelector<HTMLInputElement>('#chkMatrixShowNames')?.addEventListener('change', (e) => {
    callbacks.onOptionsChange({ showCellFilenames: (e.target as HTMLInputElement).checked });
  });
}
