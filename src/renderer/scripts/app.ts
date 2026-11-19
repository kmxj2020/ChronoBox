import {
  AppConfig,
  ArchiveDiffResult,
  ArchiveRecord,
  BrowserEntry,
  BrowserListResult,
  FileDiffItem,
  FileMatrixCell,
  FileMatrixColumn,
  FileMatrixResult,
  FileMatrixRow,
  RepoManifest,
  StorageStats,
  TagColor,
  TempHistoryEntry,
  WORKING_TREE_ID,
  WorkspaceStatus
} from './types.js';
import { formatBytes, formatTime, setCurrentLanguage, t } from './i18n.js';
import { ICONS } from './icons.js';
import { buildArchiveVisualItems, mountInteractiveVisualBrowser, renderCompactVisualStrip, renderVisualTileGrid } from './visualSnapshot.js';
import { DagGraphRenderer } from './graphRenderer.js';
import { renderDiffFileList, renderDiffSummaryBar, renderTextDiffViewer } from './diffRenderer.js';
import { MatrixViewOptions, renderFileMatrixView } from './matrixRenderer.js';
import { renderDuplicateWasteBanner, renderFileSizeSparklineSvg, renderVisualProgressReport } from './analyticsRenderer.js';

interface AppState {
  config: AppConfig | null;
  statuses: WorkspaceStatus[];
  activeProjectId: string | null;
  manifest: RepoManifest | null;
  archives: ArchiveRecord[];
  selectedArchiveId: string | null;
  activeView: 'timeline' | 'graph' | 'matrix' | 'diff' | 'archivebox' | 'settings' | 'browser';
  browserRelDir: string;
  browserSelected: string | null;
  tagFilter: TagColor | null;
  searchQuery: string;
  diffFromId: string | null;
  diffToId: string | null;
  currentDiff: ArchiveDiffResult | null;
  selectedDiffFile: FileDiffItem | null;
  modalSelectedTags: TagColor[];
  pendingSwitchArchiveId: string | null;
}

const state: AppState = {
  config: null,
  statuses: [],
  activeProjectId: null,
  manifest: null,
  archives: [],
  selectedArchiveId: null,
  activeView: 'matrix',
  browserRelDir: '',
  browserSelected: null,
  tagFilter: null,
  searchQuery: '',
  diffFromId: null,
  diffToId: WORKING_TREE_ID,
  currentDiff: null,
  selectedDiffFile: null,
  modalSelectedTags: [],
  pendingSwitchArchiveId: null
};

const api = window.chronoboxApi;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const projectListEl = $<HTMLDivElement>('projectList');
const archivedProjectsSectionEl = $<HTMLDivElement>('archivedProjectsSection');
const archivedProjectListEl = $<HTMLDivElement>('archivedProjectList');
const diffVisualCompareEl = $<HTMLDivElement>('diffVisualCompare');
const archiveCustomTagsInputEl = $<HTMLInputElement>('archiveCustomTagsInput');
const projectEditModalEl = $<HTMLDivElement>('projectEditModal');
const inpEditProjectNameEl = $<HTMLInputElement>('inpEditProjectName');
const chkSyncDiskRenameEl = $<HTMLInputElement>('chkSyncDiskRename');
const inpEditProjectTagsEl = $<HTMLInputElement>('inpEditProjectTags');
let editingProjectId: string | null = null;
let selectedTempFilePath: string | null = null;
let pendingNestedFolder: string | null = null;
let exportingBundleProjectId: string | null = null;
let activeSettingsSection: 'general' | 'themes' | 'shortcuts' | 'bc' | 'automation' | 'storage' | 'bundle' | 'about' = 'general';
let dagBranchColorMap = new Map<string, string>();
const emptyStateEl = $<HTMLElement>('emptyState');
const workspaceShellEl = $<HTMLElement>('workspaceShell');
const activeProjectNameEl = $<HTMLHeadingElement>('activeProjectName');
const activeProjectPathEl = $<HTMLButtonElement>('activeProjectPath');
const statusBadgeEl = $<HTMLSpanElement>('statusBadge');
const workingChangesCardEl = $<HTMLDivElement>('workingChangesCard');
const timelineListEl = $<HTMLDivElement>('timelineList');
const inspectorContentEl = $<HTMLDivElement>('inspectorContent');
const searchInputEl = $<HTMLInputElement>('searchInput');
const filterBarEl = $<HTMLDivElement>('filterBar');
const diffFromSelectEl = $<HTMLDivElement>('diffFromSelect');
const diffToSelectEl = $<HTMLDivElement>('diffToSelect');
const diffSummaryBarEl = $<HTMLDivElement>('diffSummaryBar');
const diffFileListEl = $<HTMLDivElement>('diffFileList');
const diffCodeViewerEl = $<HTMLDivElement>('diffCodeViewer');
const settingsContainerEl = $<HTMLDivElement>('settingsContainer');
const archiveBoxContainerEl = $<HTMLDivElement>('archiveBoxContainer');
const matrixContainerEl = $<HTMLDivElement>('matrixContainer');
const matrixOptions: MatrixViewOptions = {
  searchQuery: '',
  hideRetired: false,
  showCellFilenames: false,
  selectedArchiveId: null,
  sortMode: 'default',
  selectedFolder: '',
  showAllFiles: true,
  onlyCurrentBranch: true,
  pinnedFiles: [],
  highlightPath: null,
  hiddenPaths: [],
  showHidden: false,
  columnMode: 0,
  focusedCellKey: null
};

/* ============================ 用户隐藏的文件（按项目隔离） ============================ */

function hiddenKey(projectId: string): string {
  return `chronobox_hidden_files_${projectId}`;
}

function loadHiddenFiles(projectId: string | null): string[] {
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(hiddenKey(projectId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveHiddenFiles(projectId: string | null, list: string[]): void {
  if (!projectId) return;
  try {
    localStorage.setItem(hiddenKey(projectId), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

function toggleHiddenPath(relPath: string): void {
  if (!state.activeProjectId) return;
  const cur = loadHiddenFiles(state.activeProjectId);
  const lower = relPath.toLowerCase();
  const exists = cur.some((x) => x.toLowerCase() === lower);
  const next = exists ? cur.filter((x) => x.toLowerCase() !== lower) : [...cur, relPath];
  saveHiddenFiles(state.activeProjectId, next);
  matrixOptions.hiddenPaths = next;
  if (next.length === 0) matrixOptions.showHidden = false;
  void renderMatrixView();
  showToast(exists ? `已取消隐藏：${relPath}` : `已隐藏：${relPath}（可在表格工具栏「显示已隐藏」找回）`, 'info');
}

/** 表格视口列数偏好（全局，不随项目变化） */
function loadColumnMode(): number {
  try {
    const v = Number(localStorage.getItem('chronobox_matrix_col_mode'));
    return [0, 4, 5, 6, 7, 8].includes(v) ? v : 0;
  } catch {
    return 0;
  }
}

function saveColumnMode(n: number): void {
  try {
    localStorage.setItem('chronobox_matrix_col_mode', String(n));
  } catch {
    /* ignore */
  }
}
const toastContainerEl = $<HTMLDivElement>('toastContainer');

const archiveModalEl = $<HTMLDivElement>('archiveModal');
const modalChangesPreviewEl = $<HTMLDivElement>('modalChangesPreview');
const archiveTitleInputEl = $<HTMLInputElement>('archiveTitleInput');
const archiveNoteInputEl = $<HTMLTextAreaElement>('archiveNoteInput');
const switchModalEl = $<HTMLDivElement>('switchModal');
const switchModalDescEl = $<HTMLParagraphElement>('switchModalDesc');
const switchBackupOptionEl = $<HTMLLabelElement>('switchBackupOption');
const chkAutoBackupEl = $<HTMLInputElement>('chkAutoBackup');

const confirmModalEl = $<HTMLDivElement>('confirmModal');
const confirmModalTitleEl = $<HTMLHeadingElement>('confirmModalTitle');
const confirmModalMessageEl = $<HTMLParagraphElement>('confirmModalMessage');

let graphRenderer: DagGraphRenderer;
let confirmResolver: ((ok: boolean) => void) | null = null;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(
  message: string,
  type: 'success' | 'info' | 'error' = 'info',
  action?: { label: string; onClick: () => void; duration?: number }
): void {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const label = document.createElement('span');
  label.textContent = message;
  toast.appendChild(label);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      dismiss();
      action.onClick();
    });
    toast.appendChild(btn);
  }

  toastContainerEl.appendChild(toast);
  while (toastContainerEl.children.length > 4) {
    toastContainerEl.firstElementChild?.remove();
  }
  timer = setTimeout(dismiss, action?.duration ?? (action ? 9000 : 3200));
}

function showConfirm(title: string, message: string): Promise<boolean> {
  confirmModalTitleEl.textContent = title;
  confirmModalMessageEl.textContent = message;
  confirmModalEl.classList.remove('hidden');
  return new Promise<boolean>((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirm(ok: boolean): void {
  confirmModalEl.classList.add('hidden');
  if (confirmResolver) {
    const fn = confirmResolver;
    confirmResolver = null;
    fn(ok);
  }
}

function applyTheme(theme: AppConfig['theme']): void {
  const effective =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.setAttribute('data-theme', effective);
}

function syncFloatingUiState(): void {
  const cfg = state.config;
  if (!cfg) return;
  const topBtn = document.getElementById('btnTopMiniOrb');
  const barBtn = document.getElementById('btnMiniBar');
  const dotBtn = document.getElementById('btnMiniDot');
  const on = cfg.floatingEnabled !== false;
  if (topBtn) {
    topBtn.classList.toggle('active', on);
    topBtn.title = on
      ? `桌面悬浮窗：开启（${cfg.floatingStyle === 'mini-bar' ? 'Mini 条' : '悬浮球'}）· 点击关闭`
      : '桌面悬浮窗：已关闭 · 点击开启';
  }
  if (dotBtn) {
    dotBtn.classList.toggle('active', on && cfg.floatingStyle !== 'mini-bar');
  }
  if (barBtn) {
    barBtn.classList.toggle('active', on && cfg.floatingStyle === 'mini-bar');
  }
}

/* ============================ 分栏宽度与折叠状态 ============================ */
/* 放在模块作用域，供 switchTab / 键盘快捷键 / 拖拽分隔条共同读写 */

const DEFAULT_SIDEBAR_W = 264;
const DEFAULT_INSPECTOR_W = 348;
const MIN_SIDEBAR_W = 200;
const MAX_SIDEBAR_W = 420;
const MIN_INSPECTOR_W = 260;
const MAX_INSPECTOR_W = 560;

let leftCollapsed = false;
let rightCollapsed = false;
/** 由「当前视图不需要详情栏」自动触发的折叠，切回需要的视图时自动展开 */
let inspectorAutoHidden = false;
let savedBeforeFocus: { left: boolean; right: boolean } | null = null;

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  } catch {
    return fallback;
  }
}

function applyPaneWidths(sidebarW: number, inspectorW: number): void {
  document.documentElement.style.setProperty('--sidebar-w', `${sidebarW}px`);
  document.documentElement.style.setProperty('--inspector-w', `${inspectorW}px`);
}

function applyPaneState(nextLeft: boolean, nextRight: boolean): void {
  leftCollapsed = nextLeft;
  rightCollapsed = nextRight;
  document.getElementById('leftSidebar')?.classList.toggle('collapsed', leftCollapsed);
  document.getElementById('btnToggleLeftSidebar')?.classList.toggle('active', !leftCollapsed);
  document.getElementById('inspectorPane')?.classList.toggle('collapsed', rightCollapsed);
  document.getElementById('btnToggleRightInspector')?.classList.toggle('active', !rightCollapsed);
  try {
    localStorage.setItem('chronobox_left_collapsed', leftCollapsed ? '1' : '0');
    localStorage.setItem('chronobox_right_collapsed', rightCollapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function restorePaneState(): void {
  let l = false;
  let r = false;
  try {
    l = localStorage.getItem('chronobox_left_collapsed') === '1';
    r = localStorage.getItem('chronobox_right_collapsed') === '1';
  } catch {
    /* ignore */
  }
  applyPaneWidths(
    readNumber('chronobox_sidebar_w', DEFAULT_SIDEBAR_W, MIN_SIDEBAR_W, MAX_SIDEBAR_W),
    readNumber('chronobox_inspector_w', DEFAULT_INSPECTOR_W, MIN_INSPECTOR_W, MAX_INSPECTOR_W)
  );
  applyPaneState(l, r);
}

/** settings / archivebox 这类「全局页」不需要存档详情栏，自动让出横向空间 */
const VIEWS_NEEDING_INSPECTOR: AppState['activeView'][] = ['matrix', 'timeline', 'graph', 'diff'];

function syncInspectorForView(view: AppState['activeView']): void {
  const wanted = VIEWS_NEEDING_INSPECTOR.includes(view);
  if (!wanted && !rightCollapsed) {
    inspectorAutoHidden = true;
    applyPaneState(leftCollapsed, true);
  } else if (wanted && inspectorAutoHidden) {
    inspectorAutoHidden = false;
    applyPaneState(leftCollapsed, false);
  }
}


/* ============================ 自定义下拉（标题左 · 时间右） ============================ */

export interface DropOption {
  value: string;
  title: string;
  time?: string;
  meta?: string;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 用自绘下拉替代原生 <select>。
 * 原生 select 的下拉列表无法分别对齐——标题和时间只能挤在同一行左对齐，
 * 版本一多就难以扫读；这里把「标题左、时间右」做成两栏固定对齐。
 */
function renderDropSelect(
  host: HTMLElement,
  options: DropOption[],
  currentValue: string,
  onPick: (value: string) => void
): void {
  host.innerHTML = '';
  host.classList.add('cselect-wrap');

  const current = options.find((o) => o.value === currentValue) || options[0];

  const trigger = el('button', 'cselect') as HTMLButtonElement;
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  const tTitle = el('span', 'cselect-title', current ? current.title : '—');
  const tTime = el('span', 'cselect-time', current?.time || '');
  trigger.appendChild(tTitle);
  trigger.appendChild(tTime);
  trigger.appendChild(el('span', 'cselect-caret', '▾'));
  host.appendChild(trigger);

  const menu = el('div', 'cselect-menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  options.forEach((opt) => {
    const item = el('button', 'cselect-opt') as HTMLButtonElement;
    item.type = 'button';
    item.setAttribute('role', 'option');
    if (opt.value === currentValue) item.classList.add('is-active');
    item.appendChild(el('span', 'cselect-title', opt.title));
    if (opt.time) item.appendChild(el('span', 'cselect-time', opt.time));
    if (opt.meta) item.appendChild(el('span', 'cselect-meta', opt.meta));
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = true;
      host.classList.remove('is-open');
      if (opt.value === currentValue) return;
      onPick(opt.value);
    });
    menu.appendChild(item);
  });
  host.appendChild(menu);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    document.querySelectorAll<HTMLElement>('.cselect-wrap.is-open').forEach((w) => {
      w.classList.remove('is-open');
      const m = w.querySelector<HTMLElement>('.cselect-menu');
      if (m) m.hidden = true;
    });
    menu.hidden = !willOpen;
    host.classList.toggle('is-open', willOpen);
    if (willOpen) {
      const active = menu.querySelector<HTMLElement>('.cselect-opt.is-active');
      active?.scrollIntoView({ block: 'nearest' });
    }
  });
}

// 点空白处收起所有下拉
document.addEventListener('click', () => {
  document.querySelectorAll<HTMLElement>('.cselect-wrap.is-open').forEach((w) => {
    w.classList.remove('is-open');
    const m = w.querySelector<HTMLElement>('.cselect-menu');
    if (m) m.hidden = true;
  });
});

/* ============================ 底部状态栏 ============================ */

function renderStatusBar(status?: WorkspaceStatus): void {
  const stEl = document.getElementById('sbState');
  const dotEl = document.getElementById('sbDot');
  const filesEl = document.getElementById('sbFiles');
  const archivesEl = document.getElementById('sbArchives');
  const storageEl = document.getElementById('sbStorage');
  const autoEl = document.getElementById('sbAutoArchive');
  if (!stEl) return;

  const st = status || state.statuses.find((s) => s.projectId === state.activeProjectId);
  const currentArchive = state.manifest?.currentArchiveId
    ? state.manifest.archives[state.manifest.currentArchiveId]
    : null;

  if (!st) {
    stEl.innerHTML = '<span class="sb-dot"></span><strong>未选择项目</strong>';
    if (filesEl) filesEl.textContent = '—';
    if (archivesEl) archivesEl.textContent = '—';
    if (storageEl) storageEl.textContent = '—';
    return;
  }

  const dirty = Boolean(st.hasChanges);
  stEl.innerHTML = `<span class="sb-dot ${dirty ? 'dirty' : ''}"></span><strong>${
    !st.exists ? '文件夹不可访问' : dirty ? `${st.changes.length} 项未存档改动` : '已同步'
  }</strong>`;

  if (filesEl) {
    const total = currentArchive?.summary.totalFiles ?? 0;
    filesEl.innerHTML = `<strong>${total}</strong> 个文件`;
  }
  if (archivesEl) {
    archivesEl.innerHTML = `<strong>${st.archiveCount}</strong> 个存档`;
  }
  if (autoEl) {
    const on = state.manifest?.autoArchive?.enabled;
    autoEl.textContent = on
      ? `自动存档：每 ${state.manifest?.autoArchive.intervalMinutes ?? 0} 分钟`
      : '自动存档：关';
  }
  if (storageEl) {
    storageEl.textContent = currentArchive
      ? `${formatBytes(currentArchive.summary.totalSize)} · 当前版本`
      : '—';
  }
}

async function refreshStatusBarStorage(): Promise<void> {
  const storageEl = document.getElementById('sbStorage');
  if (!storageEl || !state.activeProjectId) return;
  try {
    const stats = await api.getStorageStats(state.activeProjectId);
    storageEl.textContent = `占用 ${formatBytes(stats.compressedBytes)} · 节省 ${formatBytes(stats.savedBytes)}`;
  } catch {
    /* 忽略：状态栏不应因统计失败而中断 */
  }
}

/* ============================ 快捷键速查表 ============================ */

function openShortcutsModal(): void {
  document.getElementById('shortcutsModal')?.classList.remove('hidden');
}

function closeShortcutsModal(): void {
  document.getElementById('shortcutsModal')?.classList.add('hidden');
}

async function refreshAll(): Promise<void> {
  state.config = await api.getConfig();
  setCurrentLanguage(state.config.language);
  applyTheme(state.config.theme);
  syncFloatingUiState();

  state.statuses = await api.listProjectStatuses();
  state.activeProjectId = state.config.activeProjectId;

  const activeStatuses = state.statuses.filter((s) => !s.archived);
  if ((!state.activeProjectId || !activeStatuses.some((s) => s.projectId === state.activeProjectId)) && activeStatuses.length > 0) {
    state.activeProjectId = activeStatuses[0].projectId;
    await api.setActiveProject(state.activeProjectId);
  } else if (activeStatuses.length === 0) {
    state.activeProjectId = null;
  }

  renderSidebar();

  if (!state.activeProjectId || activeStatuses.length === 0) {
    emptyStateEl.classList.remove('hidden');
    workspaceShellEl.classList.add('hidden');
    document.getElementById('leftSidebar')?.classList.remove('collapsed');
    return;
  }

  emptyStateEl.classList.add('hidden');
  workspaceShellEl.classList.remove('hidden');
  await refreshActiveProject();
}

async function refreshActiveProject(): Promise<void> {
  if (!state.activeProjectId) return;

  const status = await api.getProjectStatus(state.activeProjectId);
  const idx = state.statuses.findIndex((s) => s.projectId === state.activeProjectId);
  if (idx >= 0) state.statuses[idx] = status;
  renderSidebar();

  activeProjectNameEl.textContent = status.name;
  activeProjectPathEl.textContent = status.rootPath;

  if (!status.exists) {
    statusBadgeEl.className = 'status-badge dirty';
    statusBadgeEl.textContent = '文件夹已移动或重命名';
    workingChangesCardEl.classList.add('hidden');
    const missingCardHtml = `
      <div class="settings-card" style="margin:24px auto;max-width:600px;border-color:var(--diff-del-fg);">
        <h3 style="color:var(--diff-del-fg);margin-top:0;">无法访问该项目文件夹（历史数据仍安全保留在原文件夹内）</h3>
        <p style="font-size:12.5px;color:var(--text-secondary);line-height:1.65;">
          原记录路径：<code>${escapeHtml(status.rootPath)}</code><br/>
          如果您把该文件夹移动到了其他盘符或目录，请点击下方按钮（或在左侧栏项目上<strong>右键 → 关联到真实文件夹路径</strong>）重新关联；如果您把它移回了原位置，点右上角「刷新」即可立刻恢复全部历史。
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm act-relocate-now">🔗 关联到真实文件夹路径...</button>
          <button class="btn btn-ghost btn-sm act-retry-scan">↻ 刷新重新检测</button>
        </div>
      </div>
    `;
    timelineListEl.innerHTML = missingCardHtml;
    matrixContainerEl.innerHTML = missingCardHtml;
    const bindMissingActions = (rootEl: HTMLElement) => {
      rootEl.querySelector('.act-relocate-now')?.addEventListener('click', async () => {
        if (!state.activeProjectId) return;
        const picked = await api.pickFolder();
        if (!picked) return;
        try {
          const updated = await api.relocateProject(state.activeProjectId, picked);
          await refreshAll();
          showToast(`已成功关联真实路径「${updated.rootPath}」，全部历史存档完好无损`, 'success');
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), 'error');
        }
      });
      rootEl.querySelector('.act-retry-scan')?.addEventListener('click', () => void refreshAll());
    };
    bindMissingActions(timelineListEl);
    bindMissingActions(matrixContainerEl);
    return;
  }

  if (status.hasChanges) {
    statusBadgeEl.className = 'status-badge dirty';
    statusBadgeEl.textContent = t('dirtyCount', { n: status.changes.length });
  } else {
    statusBadgeEl.className = 'status-badge synced';
    statusBadgeEl.textContent = t('synced');
  }

  state.manifest = await api.getManifest(state.activeProjectId);
  state.archives = await api.listArchives(state.activeProjectId, {
    query: state.searchQuery,
    tag: state.tagFilter,
    order: 'desc'
  });

  if (!state.selectedArchiveId || !state.manifest.archives[state.selectedArchiveId]) {
    state.selectedArchiveId = state.manifest.currentArchiveId || state.archives[0]?.id || null;
  }

  const dag = await api.getDagLayout(state.activeProjectId);
  dagBranchColorMap = new Map(dag.nodes.map((n) => [n.id, n.branchColor]));
  renderWorkingChangesCard(status);
  renderTimeline();
  if (selectedTempFilePath && state.activeView === 'matrix') {
    void renderFileTempHistoryInspector(selectedTempFilePath);
  } else {
    renderInspector(status);
  }

  await withPreservedScroll(async () => {
    if (state.activeView === 'graph') {
      await renderGraphView();
    } else if (state.activeView === 'matrix') {
      await renderMatrixView();
    } else if (state.activeView === 'diff') {
      await renderDiffView();
    } else if (state.activeView === 'archivebox') {
      await renderArchiveBoxView();
    } else if (state.activeView === 'settings') {
      await renderSettingsView();
    } else if (state.activeView === 'browser') {
      await renderBrowserView();
    }
  });

  renderStatusBar(status);
  void refreshStatusBarStorage();
}

/**
 * 在重新渲染主视图时保留滚动位置。
 * 后台 watcher 每几秒就会触发一次刷新，若每次都把 scrollTop 归零，
 * 正在翻看历史版本的用户会被「弹回顶部」。
 */
async function withPreservedScroll<T>(fn: () => Promise<T> | T): Promise<T> {
  const panel = document.querySelector<HTMLElement>('.view-panel.active');
  const prevTop = panel?.scrollTop ?? 0;
  const result = await fn();
  if (panel) panel.scrollTop = prevTop;
  return result;
}

function renderSidebar(): void {
  projectListEl.innerHTML = '';
  archivedProjectListEl.innerHTML = '';

  const activeList = state.statuses.filter((s) => !s.archived);
  const archivedList = state.statuses.filter((s) => s.archived);

  for (const st of activeList) {
    const item = document.createElement('div');
    item.className = `project-item ${st.projectId === state.activeProjectId ? 'active' : ''}`;
    const dotClass = !st.exists ? 'missing' : st.hasChanges ? 'dirty' : 'synced';
    const tagsHtml = (st.customTags || [])
      .map((tg) => `<span class="custom-tag-pill">${escapeHtml(tg)}</span>`)
      .join('');

    item.innerHTML = `
      <div class="project-item-main">
        <div class="project-item-name">
          <span class="mini-dot-indicator ${dotClass}"></span>
          <span>${escapeHtml(st.name)}</span>
        </div>
        <div class="project-item-meta">
          <span>${st.archiveCount} 存档</span>
          ${st.hasChanges ? `<span style="color:var(--status-dirty);font-weight:600;">· ${st.changes.length} 变更</span>` : ''}
        </div>
        ${tagsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;padding-left:15px;">${tagsHtml}</div>` : ''}
      </div>
      <div class="project-item-actions">
        <button class="btn btn-icon btn-sm act-edit" title="重命名与管理标签">✎</button>
        <button class="btn btn-icon btn-sm act-open" title="在资源管理器打开">${ICONS.folderOpen}</button>
        <button class="btn btn-icon btn-sm act-archive-proj" title="归档暂停跟踪（保留全部历史文件）">${ICONS.archive}</button>
      </div>
    `;

    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api.showProjectSidebarMenu(st.projectId, st.name);
    });

    item.addEventListener('click', async () => {
      state.activeProjectId = st.projectId;
      state.selectedArchiveId = null;
      await api.setActiveProject(st.projectId);
      await refreshActiveProject();
    });

    item.querySelector('.act-edit')?.addEventListener('click', (e) => {
      e.stopPropagation();
      editingProjectId = st.projectId;
      inpEditProjectNameEl.value = st.name;
      chkSyncDiskRenameEl.checked = false;
      inpEditProjectTagsEl.value = (st.customTags || []).join(', ');
      projectEditModalEl.classList.remove('hidden');
      inpEditProjectNameEl.focus();
    });

    item.querySelector('.act-open')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.openFolder(st.rootPath);
    });

    item.querySelector('.act-archive-proj')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showConfirm(
        '安全归档项目（暂停跟踪）',
        `将「${st.name}」移入已归档区？归档后不再后台跟踪，但所有本地文件和历史存档 100% 安全保留，随时可一键恢复跟踪。`
      );
      if (!ok) return;
      await api.archiveProject(st.projectId);
      await refreshAll();
      showToast(`已安全归档项目：${st.name}（文件与历史完好保留）`, 'info');
    });

    projectListEl.appendChild(item);
  }

  archivedProjectsSectionEl.classList.toggle('hidden', archivedList.length === 0);
  for (const st of archivedList) {
    const row = document.createElement('div');
    row.className = 'archived-project-row';
    row.innerHTML = `
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="${escapeHtml(st.rootPath)}">${escapeHtml(st.name)}</span>
      <button class="btn btn-ghost btn-sm act-unarchive" style="padding:2px 7px;font-size:11px;">恢复跟踪</button>
    `;
    row.querySelector('.act-unarchive')?.addEventListener('click', async () => {
      await api.unarchiveProject(st.projectId);
      await refreshAll();
      showToast(`已恢复跟踪：${st.name}`, 'success');
    });
    archivedProjectListEl.appendChild(row);
  }
}

function renderWorkingChangesCard(status: WorkspaceStatus): void {
  if (!status.hasChanges) {
    workingChangesCardEl.classList.add('hidden');
    return;
  }

  workingChangesCardEl.classList.remove('hidden');
  const added = status.changes.filter((c) => c.status === 'added').length;
  const modified = status.changes.filter((c) => c.status === 'modified').length;
  const deleted = status.changes.filter((c) => c.status === 'deleted').length;
  const previewNames = status.changes.slice(0, 3).map((c) => c.path).join('、');

  workingChangesCardEl.innerHTML = `
    <div class="working-card-top">
      <div>
        <div class="working-card-title">
          <span class="mini-dot-indicator dirty"></span>
          <span>当前工作区有 ${status.changes.length} 个未存档变更</span>
        </div>
        <div class="working-card-files" style="margin-top:5px;">
          ${added > 0 ? `<span class="chip add">+${added} 新增</span>` : ''}
          ${modified > 0 ? `<span class="chip mod">~${modified} 修改</span>` : ''}
          ${deleted > 0 ? `<span class="chip del">-${deleted} 删除</span>` : ''}
          <span>${escapeHtml(previewNames)}${status.changes.length > 3 ? ' 等' : ''}</span>
        </div>
      </div>
      <button id="btnDiffWorking" class="btn btn-ghost btn-sm">${ICONS.diff} 查看差异</button>
    </div>
    <div class="quick-inline-form">
      <input id="inlineArchiveTitle" type="text" class="text-input" placeholder="输入简短说明并按 Enter 直接快速存档（留空自动生成）..." />
      <button id="btnInlineArchiveNow" class="btn btn-primary btn-sm">${ICONS.sparkle} 快速存档</button>
      <button id="btnArchiveWorking" class="btn btn-ghost btn-sm" title="打开详细存档弹窗（可添加备注与标签）">高级</button>
    </div>
  `;

  workingChangesCardEl.querySelector('#btnDiffWorking')?.addEventListener('click', () => {
    state.diffFromId = state.manifest?.currentArchiveId || null;
    state.diffToId = WORKING_TREE_ID;
    switchTab('diff');
  });

  const doInlineArchive = async () => {
    if (!state.activeProjectId) return;
    const inp = workingChangesCardEl.querySelector('#inlineArchiveTitle') as HTMLInputElement | null;
    try {
      const rec = await api.createArchive(state.activeProjectId, { title: inp?.value || '' });
      state.selectedArchiveId = rec.id;
      await refreshActiveProject();
      showToast(`已快速存档：${rec.title}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  workingChangesCardEl.querySelector('#btnInlineArchiveNow')?.addEventListener('click', () => void doInlineArchive());
  workingChangesCardEl.querySelector('#inlineArchiveTitle')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      void doInlineArchive();
    }
  });

  workingChangesCardEl.querySelector('#btnArchiveWorking')?.addEventListener('click', () => {
    openArchiveModal();
  });
}


function getActiveBranchChainIds(): Set<string> {
  const chain = new Set<string>();
  if (!state.manifest || !state.manifest.currentArchiveId) return chain;
  let cur: string | null = state.manifest.currentArchiveId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const arc: ArchiveRecord | undefined = state.manifest.archives[cur];
    if (!arc) break;
    chain.add(cur);
    cur = arc.parentId;
  }
  return chain;
}

function renderTimeline(): void {
  timelineListEl.innerHTML = '';

  if (state.archives.length === 0) {
    timelineListEl.innerHTML = `<div style="padding:28px 12px;color:var(--text-muted);">${t('noArchives')}</div>`;
    return;
  }

  const currentId = state.manifest?.currentArchiveId;
  const activeChain = getActiveBranchChainIds();
  const hasBranches = state.archives.some((a) => !activeChain.has(a.id));
  const otherStripePalette = ['#6366F1', '#3B82F6', '#F59E0B', '#EC4899', '#8B5CF6'];
  const todayStr = new Date().toISOString().slice(0, 10);
  const yestStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let lastDateGroup = '';

  for (const arc of state.archives) {
    const dStr = new Date(arc.createdAt).toISOString().slice(0, 10);
    if (dStr !== lastDateGroup) {
      lastDateGroup = dStr;
      const divider = document.createElement('div');
      divider.className = 'timeline-date-divider';
      divider.textContent = dStr === todayStr ? `今天 · ${dStr}` : dStr === yestStr ? `昨天 · ${dStr}` : dStr;
      timelineListEl.appendChild(divider);
    }

    const isCurrent = arc.id === currentId;
    const isSelected = arc.id === state.selectedArchiveId;
    const onActiveBranch = activeChain.has(arc.id);
    const branchCls = onActiveBranch ? 'on-active-branch' : 'on-other-branch';
    const card = document.createElement('div');
    card.className = `archive-card ${branchCls} ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''}`;
    if (!onActiveBranch) {
      const syncedColor = dagBranchColorMap.get(arc.id) || '#3B82F6';
      card.style.setProperty('--branch-stripe', syncedColor);
    }

    const tagsHtml = arc.tags
      .map((color) => `<span class="tag-dot ${color}" title="${color}"></span>`)
      .join('');

    card.innerHTML = `
      <div class="archive-card-top">
        <div class="archive-card-title">
          <span>${escapeHtml(arc.title)}</span>
          ${isCurrent ? `<span class="badge-current">${t('currentBadge')}</span>` : onActiveBranch && hasBranches ? '<span class="badge-active-branch">当前分支</span>' : !onActiveBranch ? '<span class="badge-other-branch">旁支</span>' : ''}
          ${arc.isAuto ? `<span class="badge-auto">${t('autoBadge')}</span>` : ''}
        </div>
        <span class="archive-card-time">${formatTime(arc.createdAt)}</span>
      </div>
      ${arc.note ? `<div style="margin-top:6px;font-size:12px;color:var(--text-secondary);line-height:1.5;">${escapeHtml(arc.note)}</div>` : ''}
      ${(arc.customTags || []).length > 0 ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">${(arc.customTags || []).map((tg) => `<span class="custom-tag-pill">#${escapeHtml(tg)}</span>`).join('')}</div>` : ''}
      ${renderCompactVisualStrip(arc, 6)}
      <div class="archive-card-meta">
        <div class="diff-chips">
          ${arc.summary.added > 0 ? `<span class="chip add">+${arc.summary.added}</span>` : ''}
          ${arc.summary.modified > 0 ? `<span class="chip mod">~${arc.summary.modified}</span>` : ''}
          ${arc.summary.deleted > 0 ? `<span class="chip del">-${arc.summary.deleted}</span>` : ''}
          <span class="chip neutral">${arc.summary.totalFiles} 文件 · ${formatBytes(arc.summary.totalSize)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="archive-card-hover-actions">
            <button class="btn btn-ghost btn-sm act-card-diff" title="查看本次变更">${ICONS.diff} 对比</button>
            ${!isCurrent ? `<button class="btn btn-primary btn-sm act-card-switch" title="恢复文件夹到此存档">${ICONS.restore} 回溯</button>` : ''}
          </div>
          <div class="archive-card-tags">${tagsHtml}</div>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      state.selectedArchiveId = arc.id;
      renderTimeline();
      const activeStatus = state.statuses.find((s) => s.projectId === state.activeProjectId);
      if (activeStatus) renderInspector(activeStatus);
    });

    card.querySelector('.act-card-diff')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.diffFromId = arc.parentId;
      state.diffToId = arc.id;
      switchTab('diff');
    });

    card.querySelector('.act-card-switch')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const activeStatus = state.statuses.find((s) => s.projectId === state.activeProjectId);
      openSwitchModal(arc.id, Boolean(activeStatus?.hasChanges));
    });

    timelineListEl.appendChild(card);
  }
}

function formatTimeWithSeconds(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function renderFileTempHistoryInspector(relPath: string): Promise<void> {
  if (!state.activeProjectId) return;
  selectedTempFilePath = relPath;
  // 若右侧栏处于折叠态，自动展开以便直观查看临时历史
  const inspectorPaneEl = document.getElementById('inspectorPane');
  if (inspectorPaneEl?.classList.contains('collapsed')) {
    inspectorPaneEl.classList.remove('collapsed');
    document.getElementById('btnToggleRightInspector')?.classList.add('active');
  }

  const entries: TempHistoryEntry[] = await api.getFileTempHistory(state.activeProjectId, relPath);
  const baseName = relPath.split('/').pop() || relPath;

  const opMeta: Record<string, { label: string; cls: string }> = {
    modified: { label: '修改', cls: 'mod' },
    renamed: { label: '重命名', cls: 'neutral' },
    created: { label: '新建', cls: 'add' },
    deleted: { label: '删除', cls: 'del' }
  };

  const rowsHtml = entries.length === 0
    ? `<div style="padding:18px 10px;color:var(--text-muted);font-size:12px;line-height:1.6;">
        当前未存档周期内暂无临时修改记录。<br/>
        每当您编辑保存或重命名此文件时，时匣都会自动保留临时快照供随时回退；正式点击「一键存档」后将自动清理。
      </div>`
    : [...entries].reverse().map((entry) => {
        const meta = opMeta[entry.opType] || { label: entry.opType, cls: 'neutral' };
        const renameNote = entry.previousPath
          ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">原名：${escapeHtml(entry.previousPath.split('/').pop() || entry.previousPath)}</div>`
          : '';
        return `
          <div class="file-row" style="align-items:flex-start;padding:8px 10px;${entry.isCurrentOnDisk ? 'border-color:var(--accent);background:var(--accent-soft);' : ''}">
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <strong style="font-size:12.5px;">第 ${entry.seq} 次</strong>
                <span style="font-size:11.5px;color:var(--text-secondary);font-family:var(--font-mono);">${formatTimeWithSeconds(entry.timestamp)}</span>
                <span class="chip ${meta.cls}">${meta.label}</span>
                ${entry.isCurrentOnDisk ? '<span class="badge-current" style="font-size:10px;padding:1px 6px;">当前磁盘</span>' : ''}
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
                ${entry.opType === 'deleted' ? '文件已从工作区移除' : `体积：${formatBytes(entry.size)}`}
              </div>
              ${renameNote}
            </div>
            ${
              entry.hash && !entry.isCurrentOnDisk
                ? `<button class="btn btn-ghost btn-sm act-restore-temp" data-temp-id="${escapeHtml(entry.id)}" data-seq="${entry.seq}" style="padding:3px 8px;font-size:11px;flex-shrink:0;">回退</button>`
                : ''
            }
          </div>
        `;
      }).join('');

  inspectorContentEl.innerHTML = `
    <div class="inspector-section">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <h3 class="inspector-title" style="font-size:14px;word-break:break-all;">${escapeHtml(baseName)}</h3>
        <button id="btnBackToArchiveInspector" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px;flex-shrink:0;">返回存档详情</button>
      </div>
      <div class="inspector-sub" style="word-break:break-all;">${escapeHtml(relPath)}</div>
      <div class="inspector-sub" style="margin-top:4px;">未存档临时历史：共 <strong>${entries.length}</strong> 次变更（正式存档后自动清空）</div>
      <div style="display:flex;gap:6px;margin-top:10px;">
        <button id="btnTempOpenFile" class="btn btn-ghost btn-sm">打开文档</button>
        <button id="btnTempArchiveNow" class="btn btn-primary btn-sm">立即正式存档</button>
      </div>
    </div>
    <div class="inspector-section">
      <div class="field-label" style="margin-bottom:8px;">临时历史记录（按时间倒序）</div>
      <div style="display:flex;flex-direction:column;gap:6px;">${rowsHtml}</div>
    </div>
  `;

  inspectorContentEl.querySelector('#btnBackToArchiveInspector')?.addEventListener('click', () => {
    selectedTempFilePath = null;
    const st = state.statuses.find((x) => x.projectId === state.activeProjectId);
    if (st) renderInspector(st);
  });

  inspectorContentEl.querySelector('#btnTempOpenFile')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const res = await api.openFileInDefaultApp(state.activeProjectId, relPath);
    if (!res.ok) showToast(res.error || '无法打开文件', 'error');
  });

  inspectorContentEl.querySelector('#btnTempArchiveNow')?.addEventListener('click', () => {
    openArchiveModal();
  });

  inspectorContentEl.querySelectorAll<HTMLButtonElement>('.act-restore-temp').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeProjectId) return;
      const tid = btn.dataset.tempId;
      const seq = btn.dataset.seq;
      if (!tid) return;
      try {
        await api.restoreTempHistoryEntry(state.activeProjectId, tid);
        await refreshActiveProject();
        await renderFileTempHistoryInspector(relPath);
        showToast(`已将「${baseName}」回退至第 ${seq} 次临时版本（未存档）`, 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    });
  });
}

/* ============================ 单元格级检视：单文件在某一版发生了什么 ============================ */

const CELL_STATUS_META: Record<string, { label: string; desc: string }> = {
  initial: { label: '初始', desc: '首次进入时间盒子的文件' },
  added: { label: '新增', desc: '本版本中新加入工作区的文件' },
  modified: { label: '编辑', desc: '内容发生变化（哈希已不同）' },
  renamed: { label: '重命名', desc: '内容完全一致，仅文件名变化（同目录）' },
  moved: { label: '移动', desc: '内容完全一致，父文件夹发生变化（跨目录搬移）' },
  copied: { label: '复制', desc: '内容与另一份仍存在的文件完全一致 —— 复制出来的副本' },
  archived: { label: '已归档', desc: '被移入 00【Archive】归档箱' },
  deleted: { label: '删除', desc: '从工作区直接删除（未进归档箱）' },
  unchanged: { label: '无变化', desc: '本版本中该文件完全没动' },
  absent: { label: '未出现', desc: '该版本时此文件还不存在' }
};

function extBadgeOf(relPath: string): { label: string; bg: string; fg: string } {
  const ext = (relPath.split('.').pop() || '').toLowerCase();
  if (['doc', 'docx'].includes(ext)) return { label: 'W', bg: '#DBEAFE', fg: '#1D4ED8' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { label: 'X', bg: '#D1FAE5', fg: '#047857' };
  if (['opju', 'opj', 'ogwu'].includes(ext)) return { label: 'O', bg: '#FFEDD5', fg: '#C2410C' };
  if (['ppt', 'pptx'].includes(ext)) return { label: 'P', bg: '#FEE2E2', fg: '#B91C1C' };
  if (ext === 'pdf') return { label: 'PDF', bg: '#FCE7F3', fg: '#BE185D' };
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'tif'].includes(ext)) return { label: 'IMG', bg: '#F3E8FF', fg: '#7E22CE' };
  if (['md', 'txt', 'log'].includes(ext)) return { label: 'MD', bg: '#E2E8F0', fg: '#475569' };
  return { label: ext ? ext.toUpperCase().slice(0, 3) : 'F', bg: '#F1F5F9', fg: '#475569' };
}

function renderFileCellInspector(
  row: FileMatrixRow,
  col: FileMatrixColumn,
  cell: FileMatrixCell,
  matrix: FileMatrixResult
): void {
  if (!state.activeProjectId) return;
  selectedTempFilePath = null;
  if (!col.isWorking) state.selectedArchiveId = col.id;
  matrixOptions.focusedCellKey = row.rowId + ':' + col.id;

  const paneEl = document.getElementById('inspectorPane');
  if (paneEl?.classList.contains('collapsed')) {
    inspectorAutoHidden = false;
    applyPaneState(leftCollapsed, false);
  }

  const meta = CELL_STATUS_META[cell.status] || { label: cell.status, desc: '' };
  const badge = extBadgeOf(row.displayPath);
  const baseName = row.displayPath.split('/').pop() || row.displayPath;
  const parentDir = row.displayPath.includes('/') ? row.displayPath.slice(0, row.displayPath.lastIndexOf('/')) : '';
  const deltaStr = cell.deltaSize && cell.deltaSize !== 0 ? ' (+' + formatBytes(cell.deltaSize) + ')' : '';

  const routeBox = (capA: string, valA: string, capB: string, valB: string, note: string): string =>
    '<div class="insp-op-route">' +
    '<div class="insp-op-side"><span class="insp-op-cap">' + capA + '</span><code>' + escapeHtml(valA) + '</code></div>' +
    '<div class="insp-op-arrow">→</div>' +
    '<div class="insp-op-side"><span class="insp-op-cap">' + capB + '</span><code>' + escapeHtml(valB) + '</code></div>' +
    '</div><div class="insp-op-note">' + note + '</div>';

  let opDetailHtml = '';
  if (cell.status === 'moved') {
    opDetailHtml = routeBox(
      '原位置', cell.fromDir ? cell.fromDir + '/' : '项目根目录/',
      '新位置', cell.toDir ? cell.toDir + '/' : '项目根目录/',
      '文件名与内容（SHA-256）完全一致，只是换了文件夹 —— 判定为「移动」而不是「重命名」。'
    );
  } else if (cell.status === 'copied' && cell.copiedFrom) {
    const srcDir = cell.copiedFrom.includes('/') ? cell.copiedFrom.slice(0, cell.copiedFrom.lastIndexOf('/')) : '根目录';
    opDetailHtml = routeBox(
      '复制来源', cell.copiedFrom,
      '副本位置', cell.path || row.displayPath,
      '复制时间：' + formatTime(col.createdAt) + ' · 源文件仍在 ' + escapeHtml(srcDir) + '，两份内容字节级一致。'
    );
  } else if (cell.status === 'renamed' && cell.previousPath) {
    opDetailHtml = routeBox(
      '原名', cell.previousPath.split('/').pop() || '',
      '新名', baseName,
      '同一文件夹内改名，内容哈希未变 —— 判定为「重命名」。'
    );
  } else if (cell.status === 'archived' && cell.archivedDateFolder) {
    opDetailHtml = '<div class="insp-op-note">移入归档箱：<code>00【Archive】/' + escapeHtml(cell.archivedDateFolder) + '/</code></div>';
  }

  const historyRows = matrix.columns
    .map((c, idx) => {
      const rc = row.cells[idx];
      if (!rc || rc.status === 'absent') return '';
      if (rc.status === 'unchanged') {
        return '<div class="insp-timeline-row is-quiet"><span class="insp-timeline-dot"></span><span class="insp-timeline-ver">' + escapeHtml(c.versionLabel) + '</span><span class="insp-timeline-text">无变化</span><span class="insp-timeline-time">' + formatTime(c.createdAt).slice(5) + '</span></div>';
      }
      const m = CELL_STATUS_META[rc.status] || { label: rc.status };
      let extra = '';
      if (rc.status === 'moved') extra = (rc.fromDir || '根') + '/ → ' + (rc.toDir || '根') + '/';
      else if (rc.status === 'copied' && rc.copiedFrom) extra = '来自 ' + rc.copiedFrom.split('/').pop();
      else if (rc.status === 'renamed' && rc.previousPath) extra = rc.previousPath.split('/').pop() + ' → ' + (rc.path || '').split('/').pop();
      else if (rc.status === 'modified' && rc.deltaSize) extra = (rc.deltaSize > 0 ? '+' : '-') + formatBytes(Math.abs(rc.deltaSize));
      else if (rc.size !== undefined) extra = formatBytes(rc.size);
      const activeCls = c.id === col.id ? ' is-active' : '';
      return '<div class="insp-timeline-row is-' + rc.status + activeCls + '"><span class="insp-timeline-dot"></span><span class="insp-timeline-ver">' + escapeHtml(c.versionLabel) + '</span><span class="m-pill ' + rc.status + '">' + m.label + '</span><span class="insp-timeline-text">' + escapeHtml(extra) + '</span><span class="insp-timeline-time">' + formatTime(c.createdAt).slice(5) + '</span></div>';
    })
    .filter(Boolean)
    .join('');

  const curIdx = matrix.columns.findIndex((c) => c.id === col.id);
  const prevCol = curIdx > 0 ? matrix.columns[curIdx - 1] : null;

  const sizeRow = cell.size !== undefined
    ? '<div class="insp-kv"><span>文件大小</span><strong>' + formatBytes(cell.size) + deltaStr + '</strong></div>'
    : '';
  const hashRow = cell.hash
    ? '<div class="insp-kv"><span>内容指纹</span><strong class="mono">' + escapeHtml(cell.hash.slice(0, 12)) + '…</strong></div>'
    : '';
  const diffBtn = !col.isWorking && prevCol
    ? '<button id="btnCellDiff" class="btn btn-ghost btn-sm">与 ' + escapeHtml(prevCol.versionLabel) + ' 对比</button>'
    : '';

  inspectorContentEl.innerHTML =
    '<div class="inspector-section">' +
      '<div class="insp-file-head">' +
        '<span class="insp-file-badge" style="background:' + badge.bg + ';color:' + badge.fg + ';">' + escapeHtml(badge.label) + '</span>' +
        '<div style="min-width:0;flex:1;">' +
          '<div class="insp-file-name" title="' + escapeHtml(row.displayPath) + '">' + escapeHtml(baseName) + '</div>' +
          '<div class="insp-file-dir">' + (parentDir ? escapeHtml(parentDir) + '/' : '项目根目录') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="insp-op-banner is-' + cell.status + '">' +
        '<span class="m-pill ' + cell.status + '">' + meta.label + '</span>' +
        '<span class="insp-op-desc">' + meta.desc + '</span>' +
      '</div>' +
      opDetailHtml +
      '<div class="insp-kv-grid">' +
        '<div class="insp-kv"><span>所在版本</span><strong>' + escapeHtml(col.versionLabel) + ' · ' + escapeHtml(col.title) + '</strong></div>' +
        '<div class="insp-kv"><span>存档时间</span><strong>' + formatTime(col.createdAt) + '</strong></div>' +
        sizeRow + hashRow +
      '</div>' +
      '<div class="inspector-actions" style="grid-template-columns:1fr 1fr;">' +
        '<button id="btnCellOpen" class="btn btn-ghost btn-sm">打开文档</button>' +
        '<button id="btnCellLocate" class="btn btn-ghost btn-sm">资源管理器</button>' +
        diffBtn +
        '<button id="btnCellHide" class="btn btn-ghost btn-sm">隐藏此文件</button>' +
      '</div>' +
    '</div>' +
    '<div class="inspector-section">' +
      '<div class="field-label" style="margin-bottom:8px;">完整路径</div>' +
      '<code class="insp-path-block">' + escapeHtml(row.displayPath) + '</code>' +
    '</div>' +
    '<details class="insp-details">' +
      '<summary>该文件的完整操作轨迹（' + matrix.columns.length + ' 个版本）</summary>' +
      '<div class="insp-timeline">' + (historyRows || '<div class="insp-file-dir">暂无记录</div>') + '</div>' +
    '</details>';

  inspectorContentEl.querySelector('#btnCellOpen')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const res = await api.openFileInDefaultApp(state.activeProjectId, row.displayPath);
    if (!res.ok) showToast(res.error || '无法打开该文件', 'error');
  });
  inspectorContentEl.querySelector('#btnCellLocate')?.addEventListener('click', () => {
    if (!state.activeProjectId) return;
    void api.showFileInExplorer(state.activeProjectId, row.displayPath);
  });
  inspectorContentEl.querySelector('#btnCellDiff')?.addEventListener('click', () => {
    if (!prevCol) return;
    state.diffFromId = prevCol.id;
    state.diffToId = col.id;
    state.selectedDiffFile = { path: cell.path || row.displayPath, status: 'modified', isBinary: false };
    switchTab('diff');
  });
  inspectorContentEl.querySelector('#btnCellHide')?.addEventListener('click', () => {
    toggleHiddenPath(row.displayPath);
  });
}

function renderInspector(status: WorkspaceStatus): void {
  const arc = state.selectedArchiveId && state.manifest ? state.manifest.archives[state.selectedArchiveId] : null;
  if (!arc) {
    inspectorContentEl.innerHTML = `<div style="padding:24px 8px;color:var(--text-muted);">选择一个存档以查看详细信息、恢复文件或编辑标签。</div>`;
    return;
  }

  const isCurrent = arc.id === state.manifest?.currentArchiveId;
  const files = Object.values(arc.files).sort((a, b) => a.path.localeCompare(b.path));

  const tagButtonsHtml = (['red', 'yellow', 'green'] as TagColor[])
    .map((color) => {
      const active = arc.tags.includes(color);
      const label = color === 'red' ? '红' : color === 'yellow' ? '黄' : '绿';
      return `<button class="tag-choice ${active ? 'selected' : ''}" data-insp-tag="${color}"><span class="tag-dot ${color}"></span> ${label}</button>`;
    })
    .join('');

  const visualGridHtml = renderVisualTileGrid(buildArchiveVisualItems(arc), '此存档为空目录');
  const fileRowsHtml = files
    .map(
      (f) => `
      <div class="file-row">
        <span class="file-row-name" title="${escapeHtml(f.path)}">${ICONS.file} ${escapeHtml(f.path.split('/').pop() || f.path)}</span>
        <button class="btn btn-ghost btn-sm act-jump-matrix" data-file-path="${escapeHtml(f.path)}" title="转到表格视图定位此文件演进历史" style="padding:3px 6px;font-size:11px;">追踪</button>
        <button class="btn btn-ghost btn-sm act-restore-copy" data-file-path="${escapeHtml(f.path)}" title="恢复为全新副本文件（不覆盖当前文件）" style="padding:3px 6px;font-size:11px;">新副本</button>
        <button class="btn btn-ghost btn-sm act-restore-single" data-file-path="${escapeHtml(f.path)}" title="覆盖恢复当前文件" style="padding:3px 6px;font-size:11px;">覆盖</button>
      </div>
    `
    )
    .join('');

  inspectorContentEl.innerHTML = `
    <div class="inspector-section">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <h3 class="inspector-title">${escapeHtml(arc.title)}</h3>
        ${isCurrent ? '<span class="badge-current">当前版本</span>' : ''}
      </div>
      <div class="inspector-sub">创建时间：${formatTime(arc.createdAt)}</div>
      <div class="inspector-sub" style="margin-top:2px;">文件总数：${arc.summary.totalFiles} · 逻辑大小：${formatBytes(arc.summary.totalSize)}</div>

      <div class="inspector-actions">
        <button id="btnInspSwitch" class="btn btn-primary btn-sm" ${isCurrent && !status.hasChanges ? 'disabled' : ''}>
          ${ICONS.restore} 恢复此存档
        </button>
        <button id="btnInspDiffParent" class="btn btn-ghost btn-sm">${ICONS.diff} 查看本次变更</button>
        <button id="btnInspExport" class="btn btn-ghost btn-sm">${ICONS.exportIcon} 导出副本</button>
        <button id="btnInspDelete" class="btn btn-danger btn-sm">${ICONS.archive} 归档隐藏</button>
      </div>
    </div>

    <div class="inspector-section">
      <div class="field-label" style="margin-bottom:8px;">存档标签（极简三色）</div>
      <div class="tag-picker">${tagButtonsHtml}</div>
    </div>

    <div class="inspector-section">
      <div class="field-label" style="margin-bottom:6px;">标题与备注</div>
      <input id="inspTitleInput" class="text-input" style="width:100%;margin-bottom:6px;" value="${escapeHtml(arc.title)}" />
      <textarea id="inspNoteInput" class="textarea-input" rows="2" style="width:100%;margin-bottom:6px;" placeholder="添加备注...">${escapeHtml(arc.note)}</textarea>
      <input id="inspCustomTagsInput" class="text-input" style="width:100%;margin-bottom:6px;" placeholder="自定义标签（逗号分隔，如：定稿, 审阅）" value="${escapeHtml((arc.customTags || []).join(', '))}" />
      <button id="btnInspSaveMeta" class="btn btn-ghost btn-sm">保存修改</button>
    </div>

    <details class="insp-details">
      <summary>目录快照（${files.length} 文件 / ${(arc.directories || []).length} 目录）</summary>
      <div id="inspVisualBrowser" style="margin-top:8px;"></div>
    </details>
    <details class="insp-details">
      <summary>单文件精准恢复（${files.length} 个文件）</summary>
      <div class="file-tree-list" style="margin-top:8px;">${fileRowsHtml || '<div style="color:var(--text-muted);font-size:12px;">空存档</div>'}</div>
    </details>
  `;

  inspectorContentEl.querySelector('#btnInspSwitch')?.addEventListener('click', () => {
    openSwitchModal(arc.id, status.hasChanges);
  });

  inspectorContentEl.querySelector('#btnInspDiffParent')?.addEventListener('click', () => {
    state.diffFromId = arc.parentId;
    state.diffToId = arc.id;
    switchTab('diff');
  });

  inspectorContentEl.querySelector('#btnInspExport')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const dest = await api.pickExportFolder();
    if (!dest) return;
    const res = await api.exportArchive(state.activeProjectId, arc.id, dest);
    showToast(`已成功导出 ${res.exportedFiles} 个文件到目标目录`, 'success');
  });

  inspectorContentEl.querySelector('#btnInspDelete')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const ok = await showConfirm(
      '归档隐藏此历史存档',
      `将存档「${arc.title}」移入归档回收站？数据不会被物理删除，随时可在「设置与关于」中还原（彻底删除仅在设置危险区执行）。`
    );
    if (!ok) return;
    await api.softArchiveRecord(state.activeProjectId, arc.id);
    state.selectedArchiveId = null;
    await refreshActiveProject();
    showToast('已安全归档至回收站（可在设置中还原）', 'info');
  });

  inspectorContentEl.querySelectorAll<HTMLButtonElement>('[data-insp-tag]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeProjectId) return;
      const color = btn.dataset.inspTag as TagColor;
      await api.toggleTag(state.activeProjectId, arc.id, color);
      await refreshActiveProject();
    });
  });

  inspectorContentEl.querySelector('#btnInspSaveMeta')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const title = ($<HTMLInputElement>('inspTitleInput')?.value || '').trim();
    const note = ($<HTMLTextAreaElement>('inspNoteInput')?.value || '').trim();
    if (!title) {
      showToast('存档标题不能为空', 'error');
      return;
    }
    const rawTags = ($<HTMLInputElement>('inspCustomTagsInput')?.value || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    await api.updateArchiveMeta(state.activeProjectId, arc.id, { title, note, customTags: rawTags });
    await refreshActiveProject();
    showToast('存档信息已更新', 'success');
  });

  const visualBrowserEl = inspectorContentEl.querySelector<HTMLElement>('#inspVisualBrowser');
  if (visualBrowserEl) {
    mountInteractiveVisualBrowser(visualBrowserEl, arc, (relPath) => jumpToFileInMatrix(relPath));
  }

  inspectorContentEl.querySelectorAll<HTMLButtonElement>('.act-jump-matrix').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fp = btn.dataset.filePath;
      if (fp) jumpToFileInMatrix(fp);
    });
  });

  inspectorContentEl.querySelectorAll<HTMLButtonElement>('.act-restore-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeProjectId) return;
      const fp = btn.dataset.filePath;
      if (!fp) return;
      const res = await api.restoreSingleFile(state.activeProjectId, arc.id, fp, 'copy');
      await refreshActiveProject();
      showToast(`已恢复为全新副本文件（未覆盖原稿）：${res.restoredPath}`, 'success');
    });
  });

  inspectorContentEl.querySelectorAll<HTMLButtonElement>('.act-restore-single').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeProjectId) return;
      const fp = btn.dataset.filePath;
      if (!fp) return;
      const ok = await showConfirm('覆盖恢复单文件', `确定用历史版本覆盖当前工作区中的「${fp}」吗？（如需保留原稿，请点击「新副本」）`);
      if (!ok) return;
      await api.restoreSingleFile(state.activeProjectId, arc.id, fp, 'overwrite');
      await refreshActiveProject();
      showToast(`已覆盖恢复文件：${fp}`, 'success');
    });
  });
}


function jumpToFileInMatrix(relPath: string): void {
  matrixOptions.showAllFiles = true;
  matrixOptions.hideRetired = false;
  matrixOptions.searchQuery = '';
  matrixOptions.highlightPath = relPath;
  switchTab('matrix');
  setTimeout(() => {
    matrixOptions.highlightPath = null;
  }, 2600);
}

async function renderMatrixView(): Promise<void> {
  if (!state.activeProjectId) return;
  const matrix = await api.getFileMatrix(state.activeProjectId, matrixOptions.onlyCurrentBranch);
  matrixOptions.selectedArchiveId = state.selectedArchiveId;
  matrixOptions.pinnedFiles = state.config?.pinnedFiles?.[state.activeProjectId] || [];
  matrixOptions.hiddenPaths = loadHiddenFiles(state.activeProjectId);
  matrixOptions.columnMode = loadColumnMode();

  renderFileMatrixView(matrixContainerEl, matrix, matrixOptions, {
    onSelectColumn: (archiveId) => {
      selectedTempFilePath = null;
      state.selectedArchiveId = archiveId;
      matrixOptions.selectedArchiveId = archiveId;
      const st = state.statuses.find((s) => s.projectId === state.activeProjectId);
      if (st) renderInspector(st);
      void renderMatrixView();
    },
    onInspectCellDiff: (_colIdx, col, cell, row) => {
      // 双击单元格 = 检视「这个文件在这一版发生了什么」，而不是直接跳去对比页
      renderFileCellInspector(row, col, cell, matrix);
    },
    onToggleHiddenFile: (relPath) => toggleHiddenPath(relPath),
    onTogglePinFile: async (relPath) => {
      if (!state.activeProjectId) return;
      const nextPinned = await api.togglePinFile(state.activeProjectId, relPath);
      if (state.config) {
        if (!state.config.pinnedFiles) state.config.pinnedFiles = {};
        state.config.pinnedFiles[state.activeProjectId] = nextPinned;
      }
      matrixOptions.pinnedFiles = nextPinned;
      void renderMatrixView();
    },
    onOpenFile: async (relPath) => {
      if (!state.activeProjectId) return;
      const res = await api.openFileInDefaultApp(state.activeProjectId, relPath);
      if (!res.ok) {
        showToast(res.error || '无法打开该文件', 'error');
      }
    },
    onFileContextMenu: (row, isPinned) => {
      if (!state.activeProjectId) return;
      api.showMatrixFileMenu({
        projectId: state.activeProjectId,
        relPath: row.displayPath,
        isPinned,
        currentState: row.currentState,
        isHidden: loadHiddenFiles(state.activeProjectId).some((h) => h.toLowerCase() === row.displayPath.toLowerCase())
      });
    },
    onSelectFileTempHistory: (relPath) => {
      void renderFileTempHistoryInspector(relPath);
    },
    onOptionsChange: (partial) => {
      if (typeof partial.columnMode === 'number') saveColumnMode(partial.columnMode);
      Object.assign(matrixOptions, partial);
      void renderMatrixView();
    }
  });
}


/* ============================ 通用输入弹窗 ============================ */

let inputModalResolver: ((value: { text: string; select: string } | null) => void) | null = null;

function showInputModal(opts: {
  title: string;
  label: string;
  defaultValue?: string;
  hint?: string;
  selectOptions?: Array<{ value: string; label: string }>;
  selectValue?: string;
}): Promise<{ text: string; select: string } | null> {
  const modal = $('inputModal');
  $('inputModalTitle').textContent = opts.title;
  $('inputModalLabel').textContent = opts.label;
  const field = $<HTMLInputElement>('inputModalField');
  field.value = opts.defaultValue || '';
  $('inputModalHint').textContent = opts.hint || '';
  const selWrap = $('inputModalSelectWrap');
  const sel = $<HTMLSelectElement>('inputModalSelect');
  if (opts.selectOptions && opts.selectOptions.length > 0) {
    selWrap.classList.remove('hidden');
    sel.innerHTML = opts.selectOptions
      .map((o) => '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>')
      .join('');
    sel.value = opts.selectValue || opts.selectOptions[0].value;
  } else {
    selWrap.classList.add('hidden');
    sel.innerHTML = '<option value="">根目录</option>';
  }
  modal.classList.remove('hidden');
  setTimeout(() => {
    field.focus();
    field.select();
  }, 30);
  return new Promise((resolve) => {
    inputModalResolver = resolve;
  });
}

function resolveInputModal(ok: boolean): void {
  const modal = $('inputModal');
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  const resolver = inputModalResolver;
  inputModalResolver = null;
  if (!resolver) return;
  if (!ok) {
    resolver(null);
    return;
  }
  resolver({
    text: $<HTMLInputElement>('inputModalField').value.trim(),
    select: $<HTMLSelectElement>('inputModalSelect').value
  });
}

/* ============================ 文件浏览器（资源管理器视图） ============================ */

let browserData: BrowserListResult | null = null;
let browserMenuEl: HTMLElement | null = null;

function closeBrowserMenu(): void {
  if (browserMenuEl) {
    browserMenuEl.remove();
    browserMenuEl = null;
  }
}

function openBrowserMenu(x: number, y: number, entry: BrowserEntry | null): void {
  closeBrowserMenu();
  const menu = document.createElement('div');
  menu.className = 'browser-menu';
  const items: Array<{ label: string; action: string; danger?: boolean; sep?: boolean }> = entry
    ? [
        { label: entry.isDirectory ? '打开文件夹' : '打开文档', action: 'open' },
        { label: '在资源管理器中定位', action: 'reveal' },
        { label: '', action: '', sep: true },
        { label: '重命名…', action: 'rename' },
        { label: '移动到其他文件夹…', action: 'move' },
        ...(entry.isDirectory ? [] : [{ label: '复制一份副本', action: 'duplicate' }]),
        { label: '移入 00【Archive】归档箱', action: 'archive' },
        { label: '', action: '', sep: true },
        { label: '删除（移入系统回收站）', action: 'trash', danger: true }
      ]
    : [
        { label: '新建文件夹…', action: 'newfolder' },
        { label: '刷新', action: 'refresh' },
        { label: '在资源管理器中打开当前目录', action: 'reveal-here' }
      ];

  for (const it of items) {
    if (it.sep) {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'browser-menu-sep' }));
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'browser-menu-item' + (it.danger ? ' is-danger' : '');
    btn.textContent = it.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBrowserMenu();
      void handleBrowserAction(it.action, entry);
    });
    menu.appendChild(btn);
  }

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  browserMenuEl = menu;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) menu.style.left = window.innerWidth - rect.width - 8 + 'px';
  if (rect.bottom > window.innerHeight - 8) menu.style.top = window.innerHeight - rect.height - 8 + 'px';
}

async function handleBrowserAction(action: string, entry: BrowserEntry | null): Promise<void> {
  if (!state.activeProjectId) return;
  const pid = state.activeProjectId;
  try {
    if (action === 'refresh') {
      await renderBrowserView();
      return;
    }
    if (action === 'reveal-here') {
      const root = state.statuses.find((s) => s.projectId === pid)?.rootPath || '';
      if (!root) return;
      const full = state.browserRelDir ? root.replace(/\\/g, '/') + '/' + state.browserRelDir : root;
      await api.openFolder(full);
      return;
    }
    if (action === 'newfolder') {
      const res = await showInputModal({ title: '新建文件夹', label: '文件夹名称', hint: '将创建在当前目录：' + (state.browserRelDir || '根目录') });
      if (!res || !res.text) return;
      await api.browserNewFolder(pid, state.browserRelDir, res.text);
      await renderBrowserView();
      showToast('已新建文件夹：' + res.text, 'success');
      return;
    }
    if (!entry) return;

    if (action === 'open') {
      if (entry.isDirectory) {
        state.browserRelDir = entry.relPath;
        state.browserSelected = null;
        await renderBrowserView();
      } else {
        const r = await api.openFileInDefaultApp(pid, entry.relPath);
        if (!r.ok) showToast(r.error || '无法打开该文件', 'error');
      }
      return;
    }
    if (action === 'reveal') {
      await api.browserReveal(pid, entry.relPath);
      return;
    }
    if (action === 'rename') {
      const res = await showInputModal({ title: '重命名', label: '新名称', defaultValue: entry.name });
      if (!res || !res.text || res.text === entry.name) return;
      await api.browserRename(pid, entry.relPath, res.text);
      await renderBrowserView();
      showToast('已重命名为：' + res.text, 'success');
      return;
    }
    if (action === 'move') {
      const dirs = (browserData?.allDirs || ['']).filter((d) => d !== getBrowserParent(entry.relPath));
      const options = dirs.map((d) => ({ value: d, label: d === '' ? '项目根目录' : d + '/' }));
      const res = await showInputModal({
        title: '移动到其他文件夹',
        label: '选择目标文件夹',
        selectOptions: options,
        hint: '将把「' + entry.name + '」移动到所选文件夹中'
      });
      if (!res) return;
      await api.browserMoveInto(pid, entry.relPath, res.select);
      await renderBrowserView();
      showToast('已移动：' + entry.name, 'success');
      return;
    }
    if (action === 'duplicate') {
      const newRel = await api.browserDuplicate(pid, entry.relPath);
      await renderBrowserView();
      showToast('已创建副本：' + newRel.split('/').pop(), 'success');
      return;
    }
    if (action === 'archive') {
      const root = state.statuses.find((s) => s.projectId === pid)?.rootPath;
      if (!root) return;
      const abs = root.replace(/\\/g, '/') + '/' + entry.relPath;
      const res = await api.archiveBoxDropPaths([abs], 'move');
      if (res.succeeded.length > 0) {
        showToast('已移入 00【Archive】归档箱：' + entry.name, 'success');
      } else {
        showToast(res.skipped[0]?.reason || '归档失败', 'error');
      }
      await renderBrowserView();
      if (state.activeView === 'archivebox') void renderArchiveBoxView();
      return;
    }
    if (action === 'trash') {
      const ok = await showConfirm('删除确认', '把「' + entry.name + '」移入 Windows 回收站？该操作可从回收站还原，但不会进入时间盒子历史。');
      if (!ok) return;
      await api.browserTrash(pid, entry.relPath);
      await renderBrowserView();
      showToast('已移入系统回收站：' + entry.name, 'info');
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function getBrowserParent(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

function formatBrowserTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function browserIconFor(entry: BrowserEntry): string {
  if (entry.isDirectory) {
    return '<span class="br-icon is-dir"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>';
  }
  const map: Record<string, { t: string; c: string }> = {
    docx: { t: 'W', c: 'is-doc' }, doc: { t: 'W', c: 'is-doc' },
    xlsx: { t: 'X', c: 'is-xls' }, xls: { t: 'X', c: 'is-xls' }, csv: { t: 'X', c: 'is-xls' },
    pptx: { t: 'P', c: 'is-ppt' }, ppt: { t: 'P', c: 'is-ppt' },
    pdf: { t: 'PDF', c: 'is-pdf' },
    png: { t: 'IMG', c: 'is-img' }, jpg: { t: 'IMG', c: 'is-img' }, jpeg: { t: 'IMG', c: 'is-img' }, svg: { t: 'IMG', c: 'is-img' },
    opju: { t: 'O', c: 'is-opj' }, opj: { t: 'O', c: 'is-opj' },
    md: { t: 'MD', c: 'is-txt' }, txt: { t: 'TXT', c: 'is-txt' }
  };
  const hit = map[entry.ext] || { t: entry.ext ? entry.ext.toUpperCase().slice(0, 3) : 'F', c: 'is-file' };
  return '<span class="br-icon ' + hit.c + '">' + escapeHtml(hit.t) + '</span>';
}

function formatBrowserSize(bytes: number): string {
  if (!bytes) return '—';
  return formatBytes(bytes);
}

/** 目录树/图标网格的资源管理器视图状态 */
let browserViewMode: 'grid' | 'list' = (() => {
  try {
    return localStorage.getItem('chronobox_browser_view') === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
})();

const FOLDER_SVG =
  '<svg viewBox="0 0 64 64" width="52" height="52" aria-hidden="true">' +
  '<path d="M5 16a4 4 0 0 1 4-4h14.2a3 3 0 0 1 2.4 1.2L29.4 18H55a4 4 0 0 1 4 4v6H5z" fill="#E0A82E"/>' +
  '<path d="M5 24h54v24a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="#FFCE5C"/>' +
  '<path d="M5 24h54v2.5H5z" fill="#FFFFFF" fill-opacity="0.35"/>' +
  '</svg>';

function browserTypeMeta(ext: string): { bg: string; fg: string; label: string } {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    docx: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'W' },
    doc: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'W' },
    xlsx: { bg: '#D1FAE5', fg: '#047857', label: 'X' },
    xls: { bg: '#D1FAE5', fg: '#047857', label: 'X' },
    csv: { bg: '#D1FAE5', fg: '#047857', label: 'X' },
    pptx: { bg: '#FEE2E2', fg: '#B91C1C', label: 'P' },
    ppt: { bg: '#FEE2E2', fg: '#B91C1C', label: 'P' },
    pdf: { bg: '#FCE7F3', fg: '#BE185D', label: 'PDF' },
    png: { bg: '#F3E8FF', fg: '#7E22CE', label: 'IMG' },
    jpg: { bg: '#F3E8FF', fg: '#7E22CE', label: 'IMG' },
    jpeg: { bg: '#F3E8FF', fg: '#7E22CE', label: 'IMG' },
    svg: { bg: '#F3E8FF', fg: '#7E22CE', label: 'SVG' },
    opju: { bg: '#FFEDD5', fg: '#C2410C', label: 'O' },
    opj: { bg: '#FFEDD5', fg: '#C2410C', label: 'O' },
    md: { bg: '#E2E8F0', fg: '#334155', label: 'MD' },
    txt: { bg: '#E2E8F0', fg: '#334155', label: 'TXT' }
  };
  return map[ext] || { bg: '#EEF2F7', fg: '#475569', label: ext ? ext.toUpperCase().slice(0, 3) : 'F' };
}

function makeBrowseIcon(entry: BrowserEntry): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'br-tile-icon';
  if (entry.isDirectory) {
    wrap.innerHTML = FOLDER_SVG;
    return wrap;
  }
  const meta = browserTypeMeta(entry.ext);
  const doc = document.createElement('div');
  doc.className = 'br-file-doc';
  doc.style.setProperty('--doc-bg', meta.bg);
  doc.style.setProperty('--doc-fg', meta.fg);
  const label = document.createElement('span');
  label.className = 'br-file-ext';
  label.textContent = meta.label;
  doc.appendChild(label);
  wrap.appendChild(doc);
  return wrap;
}

const DROP_MIME = 'application/x-chronobox-rel';

/**
 * 拖放目标绑定。
 * 之前用「dragover 加类 / dragleave 去类」，鼠标在子元素之间移动时 dragleave 会被
 * 连续触发（图标 → 文字 → 图标），高亮一闪一闪，看起来就是整个界面在屏闪。
 * 这里改成：dragenter/dragover 只在没有高亮时加类，dragleave 用 relatedTarget
 * 判断是否真的离开了容器；同时阻止冒泡，避免父级容器（整个列表区）再亮一次。
 */
function bindDropTarget(el: HTMLElement, targetRelDir: string): void {
  const setActive = () => {
    if (!el.classList.contains('is-drop-target')) el.classList.add('is-drop-target');
  };
  el.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setActive();
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    setActive();
  });
  el.addEventListener('dragleave', (e) => {
    const next = e.relatedTarget as Node | null;
    if (next && el.contains(next)) return;
    el.classList.remove('is-drop-target');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('is-drop-target');
    const rel = e.dataTransfer?.getData(DROP_MIME);
    if (rel) {
      void moveBrowserEntry(rel, targetRelDir);
      return;
    }
    void importExternalDrop(e, targetRelDir);
  });
}

async function moveBrowserEntry(relPath: string, targetRelDir: string): Promise<void> {
  if (!state.activeProjectId) return;
  const parent = getBrowserParent(relPath);
  if (parent === targetRelDir) return;
  try {
    await api.browserMoveInto(state.activeProjectId, relPath, targetRelDir);
    await renderBrowserView();
    showToast('已移动 ' + relPath.split('/').pop() + ' 到 ' + (targetRelDir || '根目录'), 'success', {
      label: '撤销',
      duration: 10000,
      onClick: async () => {
        if (!state.activeProjectId) return;
        try {
          const moved = await api.browserMoveInto(state.activeProjectId, targetRelDir ? targetRelDir + '/' + relPath.split('/').pop() : relPath.split('/').pop()!, parent);
          void moved;
          await renderBrowserView();
          showToast('已撤销移动', 'info');
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), 'error');
        }
      }
    });
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

async function importExternalDrop(e: DragEvent, targetRelDir: string): Promise<void> {
  if (!state.activeProjectId) return;
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;
  const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);
  if (paths.length === 0) return;
  try {
    const res = await api.browserImport(state.activeProjectId, paths, targetRelDir);
    await renderBrowserView();
    if (res.imported.length > 0) {
      showToast('已导入 ' + res.imported.length + ' 个文件到 ' + (targetRelDir || '根目录'), 'success');
    } else {
      showToast(res.skipped[0]?.reason || '没有可导入的文件', 'error');
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function makeBrowseTile(entry: BrowserEntry): HTMLElement {
  const tile = document.createElement('div');
  const isSel = state.browserSelected === entry.relPath;
  tile.className = 'br-tile' + (entry.isDirectory ? ' is-dir' : '') + (isSel ? ' is-selected' : '');
  tile.dataset.path = entry.relPath;
  tile.dataset.dir = entry.isDirectory ? '1' : '0';
  tile.title = entry.name + (entry.isDirectory ? '' : ' · ' + formatBrowserSize(entry.size));
  tile.draggable = true;
  tile.appendChild(makeBrowseIcon(entry));
  const nameEl = document.createElement('div');
  nameEl.className = 'br-tile-name';
  nameEl.textContent = entry.name;
  tile.appendChild(nameEl);
  if (entry.isDirectory) bindDropTarget(tile, entry.relPath);
  return tile;
}

function setBrowserViewMode(mode: 'grid' | 'list'): void {
  browserViewMode = mode;
  try {
    localStorage.setItem('chronobox_browser_view', mode);
  } catch {
    /* ignore */
  }
  void renderBrowserView();
}

async function renderBrowserView(): Promise<void> {
  if (!state.activeProjectId) return;
  const container = $<HTMLDivElement>('browserContainer');
  closeBrowserMenu();

  let data: BrowserListResult;
  try {
    data = await api.browserList(state.activeProjectId, state.browserRelDir);
  } catch (err) {
    container.innerHTML =
      '<div class="empty-block"><strong>无法打开该文件夹</strong><span>' +
      escapeHtml(err instanceof Error ? err.message : String(err)) +
      '</span></div>';
    return;
  }
  browserData = data;
  if (data.relDir !== state.browserRelDir) state.browserRelDir = data.relDir;

  const projectName = state.statuses.find((s) => s.projectId === state.activeProjectId)?.name || '项目根目录';

  // ---- 工具栏 ----
  container.innerHTML = '';
  const toolbar = document.createElement('div');
  toolbar.className = 'browser-toolbar';

  const crumbWrap = document.createElement('div');
  crumbWrap.className = 'br-crumbs';
  const mkCrumb = (label: string, rel: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'br-crumb';
    b.textContent = label;
    b.dataset.brGo = rel;
    bindDropTarget(b, rel);
    return b;
  };
  crumbWrap.appendChild(mkCrumb(projectName, ''));
  const segs = data.relDir ? data.relDir.split('/') : [];
  let acc = '';
  for (const s of segs) {
    acc = acc ? acc + '/' + s : s;
    const sep = document.createElement('span');
    sep.className = 'br-crumb-sep';
    sep.textContent = '/';
    crumbWrap.appendChild(sep);
    crumbWrap.appendChild(mkCrumb(s, acc));
  }

  const actions = document.createElement('div');
  actions.className = 'browser-actions';
  const mkBtn = (id: string, label: string, title?: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'btn btn-ghost btn-sm';
    b.textContent = label;
    if (title) b.title = title;
    return b;
  };
  actions.appendChild(mkBtn('btnBrNewFolder', '新建文件夹', 'Ctrl + Shift + N'));

  const modeWrap = document.createElement('div');
  modeWrap.className = 'br-viewmode';
  const mkModeBtn = (mode: 'grid' | 'list', svg: string, title: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'br-mode-btn' + (browserViewMode === mode ? ' is-active' : '');
    b.title = title;
    b.innerHTML = svg;
    b.addEventListener('click', () => setBrowserViewMode(mode));
    return b;
  };
  modeWrap.appendChild(
    mkModeBtn(
      'grid',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
      '大图标视图'
    )
  );
  modeWrap.appendChild(
    mkModeBtn(
      'list',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor"/></svg>',
      '详细信息列表'
    )
  );
  actions.appendChild(modeWrap);
  actions.appendChild(mkBtn('btnBrRefresh', '刷新'));
  actions.appendChild(mkBtn('btnBrReveal', '在资源管理器中打开'));

  toolbar.appendChild(crumbWrap);
  toolbar.appendChild(actions);
  container.appendChild(toolbar);

  // ---- 主体 ----
  const body = document.createElement('div');
  body.className = 'browser-body';

  const tree = document.createElement('aside');
  tree.className = 'browser-tree';
  const allDirs = data.allDirs || [];
  const mkTreeItem = (label: string, rel: string, depth: number) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'br-tree-item' + (data.relDir === rel ? ' is-active' : '');
    b.textContent = label;
    b.style.paddingLeft = 8 + depth * 13 + 'px';
    b.dataset.brGo = rel;
    bindDropTarget(b, rel);
    return b;
  };
  tree.appendChild(mkTreeItem('根目录', '', 0));
  for (const d of allDirs) {
    if (d === '') continue;
    const parts = d.split('/');
    tree.appendChild(mkTreeItem(parts[parts.length - 1], d, parts.length - 1));
  }

  const main = document.createElement('div');
  main.className = 'browser-main';
  main.id = 'browserMain';
  bindDropTarget(main, data.relDir);

  if (browserViewMode === 'grid') {
    const grid = document.createElement('div');
    grid.className = 'browser-grid';
    for (const entry of data.entries) grid.appendChild(makeBrowseTile(entry));
    if (data.entries.length === 0) {
      grid.innerHTML = '<div class="empty-block"><strong>这个文件夹是空的</strong><span>可以新建文件夹，或把文件从资源管理器直接拖进来</span></div>';
    }
    main.appendChild(grid);
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'browser-table-wrap';
    const rows = data.entries
      .map((e) => {
        const sel = state.browserSelected === e.relPath ? ' is-selected' : '';
        return (
          '<tr class="br-row' + sel + '" data-br-path="' + escapeHtml(e.relPath) + '" data-br-dir="' + (e.isDirectory ? '1' : '0') + '">' +
          '<td class="br-td-name"><div class="br-name-cell">' + browserIconFor(e) + '<span class="br-name">' + escapeHtml(e.name) + '</span></div></td>' +
          '<td class="br-td-size">' + formatBrowserSize(e.size) + '</td>' +
          '<td class="br-td-time">' + formatBrowserTime(e.mtimeMs) + '</td>' +
          '<td class="br-td-ops"><button class="btn btn-ghost btn-sm br-more" data-br-more="' + escapeHtml(e.relPath) + '" title="更多操作">⋯</button></td>' +
          '</tr>'
        );
      })
      .join('');
    wrap.innerHTML =
      '<table class="browser-table"><thead><tr><th class="br-th-name">名称</th><th class="br-th-size">大小</th><th class="br-th-time">修改时间</th><th class="br-th-ops"></th></tr></thead><tbody>' +
      rows +
      '</tbody></table>';
    main.appendChild(wrap);
  }

  body.appendChild(tree);
  body.appendChild(main);
  container.appendChild(body);

  // ---- 事件 ----
  container.querySelectorAll<HTMLElement>('[data-br-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.browserRelDir = btn.dataset.brGo || '';
      state.browserSelected = null;
      void renderBrowserView();
    });
    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('is-drop-target');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('is-drop-target'));
  });

  $('btnBrNewFolder')?.addEventListener('click', () => void handleBrowserAction('newfolder', null));
  $('btnBrRefresh')?.addEventListener('click', () => void renderBrowserView());
  $('btnBrReveal')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const rootPath = state.statuses.find((s) => s.projectId === state.activeProjectId)?.rootPath;
    if (!rootPath) return;
    const full = state.browserRelDir ? rootPath.replace(/\\\\/g, '/') + '/' + state.browserRelDir : rootPath;
    await api.openFolder(full);
  });

  const findEntry = (p: string | undefined) => data.entries.find((e) => e.relPath === p) || null;

  if (browserViewMode === 'grid') {
    container.querySelectorAll<HTMLElement>('.br-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        state.browserSelected = tile.dataset.path || null;
        container.querySelectorAll('.br-tile').forEach((x) => x.classList.remove('is-selected'));
        tile.classList.add('is-selected');
      });
      tile.addEventListener('dblclick', () => {
        const entry = findEntry(tile.dataset.path);
        if (entry) void handleBrowserAction('open', entry);
      });
      tile.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        state.browserSelected = tile.dataset.path || null;
        openBrowserMenu(ev.clientX, ev.clientY, findEntry(tile.dataset.path));
      });
      tile.addEventListener('dragstart', (ev) => {
        const rel = tile.dataset.path || '';
        ev.dataTransfer?.setData(DROP_MIME, rel);
        ev.dataTransfer?.setData('text/plain', rel);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        tile.classList.add('is-dragging');
      });
      tile.addEventListener('dragend', () => tile.classList.remove('is-dragging'));
    });
  } else {
    container.querySelectorAll<HTMLElement>('.br-row').forEach((tr) => {
      tr.addEventListener('click', () => {
        state.browserSelected = tr.dataset.brPath || null;
        container.querySelectorAll('.br-row').forEach((x) => x.classList.remove('is-selected'));
        tr.classList.add('is-selected');
      });
      tr.addEventListener('dblclick', () => {
        const entry = findEntry(tr.dataset.brPath);
        if (entry) void handleBrowserAction('open', entry);
      });
      tr.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        openBrowserMenu(ev.clientX, ev.clientY, findEntry(tr.dataset.brPath));
      });
    });
    container.querySelectorAll<HTMLElement>('.br-more').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const rect = btn.getBoundingClientRect();
        openBrowserMenu(rect.left - 140, rect.bottom + 4, findEntry(btn.dataset.brMore));
      });
    });
  }

  container.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('.br-tile, .br-row')) return;
    ev.preventDefault();
    openBrowserMenu(ev.clientX, ev.clientY, null);
  });
}

async function renderGraphView(): Promise<void> {
  if (!state.activeProjectId) return;
  const layout = await api.getDagLayout(state.activeProjectId);
  const visibleIds =
    state.tagFilter || state.searchQuery.trim()
      ? new Set(state.archives.map((a) => a.id))
      : undefined;
  graphRenderer.render(layout, state.selectedArchiveId, visibleIds, getActiveBranchChainIds());
}

async function renderDiffView(): Promise<void> {
  if (!state.activeProjectId || !state.manifest) return;
  const allArchives = Object.values(state.manifest.archives).sort((a, b) => b.createdAt - a.createdAt);

  const buildOptions = (includeEmpty: boolean): DropOption[] => {
    const opts: DropOption[] = [];
    opts.push({ value: WORKING_TREE_ID, title: t('workingTree'), time: '实时', meta: 'LIVE' });
    if (includeEmpty) {
      opts.push({ value: '', title: '（空初始状态）', time: '', meta: 'EMPTY' });
    }
    for (const a of allArchives) {
      opts.push({
        value: a.id,
        title: a.title,
        time: formatTime(a.createdAt),
        meta: a.id === state.manifest?.currentArchiveId ? '当前' : ''
      });
    }
    return opts;
  };

  const fromOptions = buildOptions(true);
  const toOptions = buildOptions(true);

  if (state.diffFromId === null && allArchives.length > 0 && state.diffToId === WORKING_TREE_ID) {
    state.diffFromId = state.manifest.currentArchiveId || allArchives[0].id;
  }

  renderDropSelect(diffFromSelectEl, fromOptions, state.diffFromId ?? '', (v) => {
    state.diffFromId = v || null;
    void renderDiffView();
  });
  renderDropSelect(diffToSelectEl, toOptions, state.diffToId ?? WORKING_TREE_ID, (v) => {
    state.diffToId = v || null;
    void renderDiffView();
  });

  const diff = await api.diffArchives(state.activeProjectId, state.diffFromId, state.diffToId);
  state.currentDiff = diff;
  renderDiffSummaryBar(diffSummaryBarEl, diff);
  if (diff.fromVisual || diff.toVisual) {
    diffVisualCompareEl.classList.remove('hidden');
    diffVisualCompareEl.innerHTML = `
      <div class="diff-visual-box">
        <div class="diff-visual-box-title">基准快照视觉视图：${escapeHtml(diff.fromTitle)}</div>
        ${renderVisualTileGrid(diff.fromVisual || [], '空初始状态')}
      </div>
      <div class="diff-visual-box">
        <div class="diff-visual-box-title">目标快照视觉视图：${escapeHtml(diff.toTitle)}</div>
        ${renderVisualTileGrid(diff.toVisual || [], '空目录')}
      </div>
    `;
  } else {
    diffVisualCompareEl.classList.add('hidden');
  }

  const stillExists = diff.items.find((i) => i.path === state.selectedDiffFile?.path);
  state.selectedDiffFile = stillExists || diff.items[0] || null;

  const handleSelectDiffFile = async (item: FileDiffItem): Promise<void> => {
    state.selectedDiffFile = item;
    renderDiffFileList(diffFileListEl, diff, item.path, handleSelectDiffFile);
    await loadSelectedFileDiff(item);
  };

  renderDiffFileList(diffFileListEl, diff, state.selectedDiffFile?.path || null, handleSelectDiffFile);
  await loadSelectedFileDiff(state.selectedDiffFile);
}

async function loadSelectedFileDiff(item: FileDiffItem | null): Promise<void> {
  if (!state.activeProjectId || !item) {
    renderTextDiffViewer(diffCodeViewerEl, null, null);
    return;
  }
  const textDiff = await api.diffFileText(state.activeProjectId, state.diffFromId, state.diffToId, item.path);
  renderTextDiffViewer(diffCodeViewerEl, item, textDiff);
}


async function renderArchiveBoxView(): Promise<void> {
  if (!state.activeProjectId || !state.config) return;
  const cfg = state.config.archiveBox;
  const entries = await api.archiveBoxList(state.activeProjectId);

  // 按日期分组
  const grouped = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = grouped.get(e.dateFolder) || [];
    list.push(e);
    grouped.set(e.dateFolder, list);
  }

  let historyHtml = '';
  if (entries.length === 0) {
    historyHtml = `<div style="padding:20px;color:var(--text-muted);text-align:center;">暂无归档记录，可将旧文件直接拖拽到上方区域或桌面悬浮球。</div>`;
  } else {
    for (const [dateStr, items] of grouped) {
      const rows = items
        .map(
          (item) => `
          <div class="file-row" style="padding:8px 10px;">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${item.isDirectory ? ICONS.folder : ICONS.file} ${escapeHtml(item.relativeOriginalPath)}
                <span class="chip neutral" style="margin-left:6px;">${item.action === 'copy' ? '复制留档' : '已移入'}</span>
                ${item.restored ? '<span class="chip add" style="margin-left:4px;">已放回原位</span>' : ''}
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                ${formatTime(item.archivedAt)} → ${escapeHtml(item.archivedPath)}
              </div>
            </div>
            ${
              !item.restored && item.existsOnDisk
                ? `<button class="btn btn-ghost btn-sm act-box-restore" data-root="${escapeHtml(item.archiveRoot)}" data-id="${escapeHtml(item.id)}">${ICONS.restore} 放回原位</button>`
                : ''
            }
          </div>
        `
        )
        .join('');
      historyHtml += `<div class="archive-box-date-group"><div class="archive-box-date-title">${ICONS.archive} ${escapeHtml(dateStr)}（${items.length} 项）</div><div style="display:flex;flex-direction:column;gap:6px;">${rows}</div></div>`;
    }
  }

  archiveBoxContainerEl.innerHTML = `
    <div id="archiveDropzone" class="archive-dropzone">
      <div class="dropzone-icon-badge">${ICONS.inbox}</div>
      <div style="font-weight:700;font-size:14.5px;margin-bottom:4px;">拖拽文件或文件夹到这里，一键移入「${escapeHtml(cfg.folderName)}/当天日期/」</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
        直接拖拽 = 移动清理工作区 · 按住 Ctrl 拖拽 = 保留原件并复制一份到归档目录 · 同名自动加时间戳防覆盖
      </div>
      <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;">
        <button id="btnOpenArchiveBoxDir" class="btn btn-ghost btn-sm">${ICONS.folderOpen} 打开 ${escapeHtml(cfg.folderName)} 文件夹</button>
        <button id="btnLaunchDropOrb" class="btn btn-primary btn-sm">${ICONS.orb} 呼出桌面悬浮归档球</button>
      </div>
    </div>

    <div class="settings-card">
      <h3>归档箱规则配置</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;">
        <div>
          <label class="field-label" style="display:block;margin-bottom:4px;">归档根目录名称</label>
          <input id="inpBoxFolderName" class="text-input" style="width:100%;" value="${escapeHtml(cfg.folderName)}" />
        </div>
        <div>
          <label class="field-label" style="display:block;margin-bottom:4px;">日期子目录格式</label>
          <select id="selBoxDateFmt" class="select-input" style="width:100%;">
            <option value="YYYY-MM-DD" ${cfg.dateFormat === 'YYYY-MM-DD' ? 'selected' : ''}>YYYY-MM-DD（如 2026-11-18）</option>
            <option value="YYYYMMDD" ${cfg.dateFormat === 'YYYYMMDD' ? 'selected' : ''}>YYYYMMDD（如 20261118）</option>
            <option value="YYYY-MM" ${cfg.dateFormat === 'YYYY-MM' ? 'selected' : ''}>YYYY-MM（按月归档）</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:12px;">
        <label class="checkbox-row">
          <input id="chkBoxPreserveRel" type="checkbox" ${cfg.preserveRelativePath ? 'checked' : ''} />
          <span>保留原始子目录结构（推荐，放回原位更清晰）</span>
        </label>
        <label class="checkbox-row">
          <input id="chkBoxDefaultCopy" type="checkbox" ${cfg.defaultAction === 'copy' ? 'checked' : ''} />
          <span>默认使用复制模式（不勾选则为移动）</span>
        </label>
      </div>
      <button id="btnSaveBoxCfg" class="btn btn-primary btn-sm">保存归档箱设置</button>
    </div>

    <div class="settings-card">
      <h3>归档历史记录（支持一键放回原位）</h3>
      ${historyHtml}
    </div>
  `;

  const dropzone = archiveBoxContainerEl.querySelector('#archiveDropzone') as HTMLDivElement;
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const p = api.getPathForFile(files[i]);
      if (p) paths.push(p);
    }
    if (paths.length === 0) return;
    const res = await api.archiveBoxDropPaths(paths, e.ctrlKey ? 'copy' : undefined);
    if (res.succeeded.length > 0) {
      showToast(`已归档 ${res.succeeded.length} 项到 ${cfg.folderName}`, 'success');
    }
    if (res.skipped.length > 0) {
      showToast(`跳过 ${res.skipped.length} 项：${res.skipped[0].reason}`, 'info');
    }
    await renderArchiveBoxView();
  });

  archiveBoxContainerEl.querySelector('#btnOpenArchiveBoxDir')?.addEventListener('click', () => {
    if (state.activeProjectId) void api.archiveBoxOpenFolder(state.activeProjectId);
  });

  archiveBoxContainerEl.querySelector('#btnLaunchDropOrb')?.addEventListener('click', () => {
    void api.setFloatingStyle('mini-dot');
  });

  archiveBoxContainerEl.querySelector('#btnSaveBoxCfg')?.addEventListener('click', async () => {
    const folderName = ($<HTMLInputElement>('inpBoxFolderName').value || '').trim() || '00【Archive】';
    const dateFormat = $<HTMLSelectElement>('selBoxDateFmt').value as 'YYYY-MM-DD' | 'YYYYMMDD' | 'YYYY-MM';
    const preserveRelativePath = $<HTMLInputElement>('chkBoxPreserveRel').checked;
    const defaultAction = $<HTMLInputElement>('chkBoxDefaultCopy').checked ? 'copy' : 'move';
    state.config = await api.archiveBoxUpdateConfig({
      folderName,
      dateFormat,
      preserveRelativePath,
      defaultAction
    });
    showToast('00【Archive】归档箱设置已保存', 'success');
    await renderArchiveBoxView();
  });

  archiveBoxContainerEl.querySelectorAll<HTMLButtonElement>('.act-box-restore').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const root = btn.dataset.root;
      const id = btn.dataset.id;
      if (!root || !id) return;
      try {
        const res = await api.archiveBoxRestore(root, id);
        showToast(`已放回原位：${res.fileName}`, 'success');
        await refreshActiveProject();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    });
  });
}


async function runBeyondCompare(mode: 'file' | 'folder', fromId: string | null, toId: string | null, relPath?: string): Promise<void> {
  if (!state.activeProjectId) return;
  try {
    let res = mode === 'file' && relPath
      ? await api.bcCompareFile(state.activeProjectId, fromId, toId, relPath)
      : await api.bcCompareFolder(state.activeProjectId, fromId, toId);

    if (res.needsPath) {
      const ok = await showConfirm(
        '配置 Beyond Compare 路径',
        '尚未配置 Beyond Compare（BCompare.exe）路径。是否现在浏览选择 BCompare.exe？选好后将立即启动对比。'
      );
      if (!ok) return;
      const picked = await api.pickBeyondCompareExe();
      if (!picked) return;
      state.config = await api.updateGeneralSettings({ beyondComparePath: picked });
      res = mode === 'file' && relPath
        ? await api.bcCompareFile(state.activeProjectId, fromId, toId, relPath)
        : await api.bcCompareFolder(state.activeProjectId, fromId, toId);
    }

    if (res.launched) {
      showToast('已启动 Beyond Compare 进行内容对比', 'success');
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

function openExportBundleModal(projectId: string): void {
  const st = state.statuses.find((x) => x.projectId === projectId);
  if (!st) return;
  exportingBundleProjectId = projectId;
  $('exportBundleDesc').textContent = `正在为项目「${st.name}」生成自包含结项包（包含 01_最终版本、02_历史版本、03_Archive归档箱、结项清单.md 及 重新加载项目.chronobox.json 一键恢复凭证）。`;
  const defRadio = document.querySelector<HTMLInputElement>('input[name="bundleHistoryScope"][value="current-branch"]');
  if (defRadio) defRadio.checked = true;
  $<HTMLInputElement>('chkBundleAutoArchive').checked = true;
  $<HTMLInputElement>('chkBundleSoftArchive').checked = false;
  $('exportBundleModal').classList.remove('hidden');
}

async function handleImportProjectBundle(): Promise<void> {
  const bundleFile = await api.pickBundleFile();
  if (!bundleFile) return;
  const targetDir = await api.pickExportFolder();
  if (!targetDir) return;
  try {
    const res = await api.importProjectBundle(bundleFile, targetDir);
    await refreshAll();
    showToast(`已成功加载结项包「${res.project.name}」（恢复 ${res.archiveCount} 个历史存档），可无缝继续工作`, 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error');
  }
}

async function renderSettingsView(): Promise<void> {
  if (!state.activeProjectId || !state.manifest) return;
  const stats: StorageStats = await api.getStorageStats(state.activeProjectId);
  const ratioPct = Math.round(stats.dedupRatio * 100);
  const cfg = state.config!;

  // 统一使用线性 SVG 图标，避免 emoji 在 Windows 上渲染成彩色字体破坏一致性
  const navIcons: Record<string, string> = {
    general: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    themes: '<circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="13.5" r="2.5"/><circle cx="8.5" cy="7.5" r="2.5"/><circle cx="6.5" cy="14.5" r="2.5"/><path d="M12 2a10 10 0 1 0 0 20 2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h1a3 3 0 0 0 3-3 10 10 0 0 0-8-10z"/>',
    shortcuts: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
    bc: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    automation: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/><path d="M12 8v4l3 2"/>',
    storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
    bundle: '<rect x="3" y="4" width="18" height="4" rx="1.5"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 13h4"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6h.01"/>'
  };

  const navItems: Array<{ id: typeof activeSettingsSection; label: string }> = [
    { id: 'general', label: '常规与悬浮窗' },
    { id: 'themes', label: '外观与主题' },
    { id: 'shortcuts', label: '全局快捷键' },
    { id: 'bc', label: 'Beyond Compare' },
    { id: 'automation', label: '自动存档与忽略' },
    { id: 'storage', label: '存储空间与清理' },
    { id: 'bundle', label: '结项与回收站' },
    { id: 'about', label: '关于与说明书' }
  ];

  const navHtml = navItems
    .map(
      (item) => `
      <button class="settings-nav-item ${activeSettingsSection === item.id ? 'active' : ''}" data-sec="${item.id}">
        <span class="settings-nav-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${navIcons[item.id] || ''}</svg></span>
        <span>${item.label}</span>
      </button>`
    )
    .join('');

  let paneHtml = '';

  if (activeSettingsSection === 'general') {
    paneHtml = `
      <div class="settings-card">
        <h3>常规与窗口行为</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
          <div>
            <label class="field-label" style="display:block;margin-bottom:4px;">点击主窗口关闭按钮（✕）时</label>
            <select id="selCloseBehavior" class="select-input" style="width:100%;">
              <option value="tray" ${cfg.closeBehavior !== 'quit' ? 'selected' : ''}>最小化到系统托盘（后台继续监听）</option>
              <option value="quit" ${cfg.closeBehavior === 'quit' ? 'selected' : ''}>直接退出应用</option>
            </select>
          </div>
          <div>
            <label class="field-label" style="display:block;margin-bottom:4px;">默认悬浮窗形态</label>
            <select id="selFloatingStyle" class="select-input" style="width:100%;">
              <option value="mini-dot" ${cfg.floatingStyle !== 'mini-bar' ? 'selected' : ''}>桌面悬浮归档球（支持贴边半圆胶囊）</option>
              <option value="mini-bar" ${cfg.floatingStyle === 'mini-bar' ? 'selected' : ''}>Mini 悬浮条</option>
            </select>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:14px;">
          <label class="checkbox-row">
            <input id="chkLaunchAtLogin" type="checkbox" ${cfg.launchAtLogin ? 'checked' : ''} />
            <span>Windows 开机自动启动时匣 ChronoBox</span>
          </label>
          <label class="checkbox-row" title="开启后无论主窗口打开、关闭或后台运行，桌面都将保持显示悬浮球或 Mini 条">
            <input id="chkFloatingEnabled" type="checkbox" ${cfg.floatingEnabled !== false ? 'checked' : ''} />
            <span>开启桌面悬浮窗（与主窗口互不冲突；按住 Ctrl + 左键点击悬浮窗可快速显示/隐藏主界面）</span>
          </label>
          <label class="checkbox-row" title="开启后将阻止重复添加已有项目的子文件夹，避免冲突与双倍空间占用">
            <input id="chkRestrictNested" type="checkbox" ${cfg.restrictNestedFolders !== false ? 'checked' : ''} />
            <span>限制添加已有项目的嵌套子文件夹（推荐开启）</span>
          </label>
        </div>
        <button id="btnSaveGeneralOnly" class="btn btn-primary btn-sm">保存常规与悬浮窗设置</button>
      </div>
      <div class="settings-card">
        <h3>表格视图显示</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--text-secondary);line-height:1.65;">
          表格视图默认横向显示多少个历史版本列。选「自动」会按窗口宽度尽量多显示；
          选固定列数时，无论右侧详情栏是否展开，都始终保留同样多的列，只是把列宽挤压变窄。
        </p>
        <label class="field-label" style="display:block;margin-bottom:4px;">默认显示列数</label>
        <select id="selMatrixColCount" class="select-input" style="width:260px;">
          ${[[0, 4, 5, 6, 7, 8].map((n) => '<option value="' + n + '"' + (loadColumnMode() === n ? ' selected' : '') + '>' + (n === 0 ? '自动适配窗口' : '固定 ' + n + ' 列') + '</option>').join('')]}
        </select>
        <div class="inspector-sub" style="margin-top:6px;">提示：表格工具栏里也有同一个切换开关，改完全局生效。</div>
      </div>
    `;
  } else if (activeSettingsSection === 'themes') {
    const themeDefs: Array<{ id: AppConfig['theme']; name: string; desc: string; swatches: [string, string, string] }> = [
      { id: 'system', name: '跟随系统', desc: '随 Windows 深色/浅色设置自动切换，白天黑夜都不用管', swatches: ['#F2F5FA', '#0A0F16', '#2563EB'] },
      { id: 'light', name: '明亮主题', desc: '清爽纯白与专业靛蓝，日间办公清晰通透', swatches: ['#F2F5FA', '#FFFFFF', '#2563EB'] },
      { id: 'dark', name: '暗黑主题', desc: '深邃夜空蓝灰，低眩光护眼适合夜间专注', swatches: ['#0B1120', '#131C2E', '#3B82F6'] },
      { id: 'spring', name: '春 · 樱芽青', desc: '柔和薄荷浅绿与新芽翡翠，清新柔和不刺眼', swatches: ['#F3FAF5', '#E7F5EC', '#16A34A'] },
      { id: 'summer', name: '夏 · 晴海蓝', desc: '清澈晴空浅蓝与碧海青，通透利落显质感', swatches: ['#EEF8FD', '#E0F2FE', '#0284C7'] },
      { id: 'autumn', name: '秋 · 暖枫琥珀', desc: '温润宣纸米白与暖枫琥珀，久看不累眼', swatches: ['#FDF7F0', '#F7EBDD', '#D97706'] },
      { id: 'winter', name: '冬 · 霜雪靛', desc: '静谧冰川银灰与深霜靛紫，沉稳克制高对比', swatches: ['#F1F4F9', '#E5EBF5', '#4F46E5'] }
    ];
    const cardsHtml = themeDefs
      .map(
        (th) => `
        <button class="theme-card ${cfg.theme === th.id ? 'active' : ''}" data-theme-pick="${th.id}">
          <div class="theme-swatch-row">
            <span class="theme-swatch" style="background:${th.swatches[0]};"></span>
            <span class="theme-swatch" style="background:${th.swatches[1]};"></span>
            <span class="theme-swatch" style="background:${th.swatches[2]};"></span>
          </div>
          <div class="theme-card-title">${th.name}${cfg.theme === th.id ? ' · 当前' : ''}</div>
          <div class="theme-card-desc">${th.desc}</div>
        </button>`
      )
      .join('');
    paneHtml = `
      <div class="settings-card">
        <h3>外观与主题</h3>
        <p style="margin:0 0 10px;font-size:12px;color:var(--text-secondary);">点击任意色卡即可实时切换主窗口与悬浮窗主题（跟随系统 / 明亮 / 暗黑 / 春夏秋冬，共 7 套）：</p>
        <div class="theme-card-grid">${cardsHtml}</div>
      </div>
    `;
  } else if (activeSettingsSection === 'shortcuts') {
    paneHtml = `
      <div class="settings-card">
        <h3>全局快捷键设置</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--text-secondary);">全局快捷键在任何软件（Word / Origin / 资源管理器）前台均可直接触发。</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
          <div>
            <label class="field-label" style="display:block;margin-bottom:4px;">一键显示 / 隐藏桌面悬浮窗（点击输入框后直接按键录入）</label>
            <input id="inpShortcutMini" readonly class="text-input shortcut-recorder" style="width:100%;font-family:var(--font-mono);cursor:pointer;" placeholder="点击此处并按下组合键..." value="${escapeHtml((cfg.shortcuts.toggleMini || 'CommandOrControl+Shift+M').replace(/CommandOrControl/g, 'Ctrl'))}" />
          </div>
          <div>
            <label class="field-label" style="display:block;margin-bottom:4px;">一键快速存档当前项目（点击输入框后直接按键录入）</label>
            <input id="inpShortcutArchive" readonly class="text-input shortcut-recorder" style="width:100%;font-family:var(--font-mono);cursor:pointer;" placeholder="点击此处并按下组合键..." value="${escapeHtml((cfg.shortcuts.quickArchive || 'CommandOrControl+Shift+S').replace(/CommandOrControl/g, 'Ctrl'))}" />
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="btnSaveShortcutsOnly" class="btn btn-primary btn-sm">保存快捷键设置</button>
          <button id="btnResetShortcuts" class="btn btn-ghost btn-sm">恢复默认</button>
        </div>
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-color);font-size:12px;color:var(--text-secondary);line-height:1.8;">
          <div><strong>内置快捷操作一览：</strong></div>
          <div>• <code>Ctrl + 左键单击悬浮窗</code>：快速显示 / 隐藏主界面（后台运行）</div>
          <div>• <code>双击悬浮球</code>：为已添加项目一键快速存档</div>
          <div>• <code>Ctrl + \</code> / <code>Ctrl + Shift + \</code>：折叠或展开左侧栏 / 右侧详情栏</div>
          <div>• <code>Shift + 滚轮</code>：表格视图中左右平滑浏览全部历史版本</div>
        </div>
      </div>
    `;
  } else if (activeSettingsSection === 'bc') {
    paneHtml = `
      <div class="settings-card">
        <h3>Beyond Compare 外部内容对比工具</h3>
        <p style="margin:0 0 12px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
          配置 <code>BCompare.exe</code> 路径后，在「存档对比」视图中可一键将任意两个历史版本的单个文件或整个目录解包并拉起 Beyond Compare 进行深度对比（支持 Word、Excel、PDF、图片与代码）。
        </p>
        <label class="field-label" style="display:block;margin-bottom:4px;">Beyond Compare 应用程序路径（BCompare.exe）</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">
          <input id="inpBcPath" class="text-input" style="flex:1;font-family:var(--font-mono);" placeholder="例如：C:\\Program Files\\Beyond Compare 4\\BCompare.exe" value="${escapeHtml(cfg.beyondComparePath || '')}" />
          <button id="btnDetectBc" class="btn btn-ghost btn-sm">自动检测</button>
          <button id="btnPickBc" class="btn btn-ghost btn-sm">浏览...</button>
        </div>
        <button id="btnSaveBcOnly" class="btn btn-primary btn-sm">保存 Beyond Compare 路径</button>
      </div>
    `;
  } else if (activeSettingsSection === 'automation') {
    paneHtml = `
      <div class="settings-card">
        <h3>定时自动存档（保底快照）</h3>
        <p style="margin:0 0 10px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
          日常每次文档保存均已由<strong>「临时历史文件」</strong>自动无感保护（点击表格视图文件名即可按次数回退）；若仍需定期生成正式时间盒子，可在此开启定时自动存档。
        </p>
        <label class="checkbox-row" style="margin-bottom:10px;">
          <input id="chkAutoArchive" type="checkbox" ${state.manifest.autoArchive.enabled ? 'checked' : ''} />
          <span>开启后台静默定时自动存档（仅在检测到文件变化时创建）</span>
        </label>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:12.5px;">检查间隔（分钟）：</span>
          <input id="numAutoInterval" type="number" min="1" max="1440" class="text-input" style="width:90px;" value="${state.manifest.autoArchive.intervalMinutes}" />
          <button id="btnSaveAutoArchive" class="btn btn-primary btn-sm">保存定时设置</button>
        </div>
      </div>

      <div class="settings-card">
        <h3>自定义忽略规则</h3>
        <p style="margin:0 0 8px;font-size:12px;color:var(--text-muted);">每行一条通配符规则（已内置忽略 Office 临时锁 ~$*、*.tmp、Thumbs.db 等；父子独立管理排除的子目录也会自动记录在此）。</p>
        <textarea id="txtIgnorePatterns" class="textarea-input" rows="6" style="width:100%;font-family:var(--font-mono);">${escapeHtml((state.manifest.ignorePatterns || []).join('\n'))}</textarea>
        <div style="margin-top:10px;">
          <button id="btnSaveIgnore" class="btn btn-primary btn-sm">保存忽略规则</button>
        </div>
      </div>
    `;
  } else if (activeSettingsSection === 'storage') {
    paneHtml = `
      <div class="settings-card">
        <h3>本地增量存储空间统计</h3>
        <div class="stat-grid">
          <div class="stat-box">
            <div class="stat-value">${formatBytes(stats.compressedBytes)}</div>
            <div class="stat-label">实际磁盘占用（去重压缩后）</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">${formatBytes(stats.logicalBytes)}</div>
            <div class="stat-label">历史累计原始体积</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">${ratioPct}%</div>
            <div class="stat-label">累计节省空间（${formatBytes(stats.savedBytes)}）</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-secondary);margin-top:6px;">
          <span>当前项目包含 <strong>${stats.archiveCount}</strong> 个时间盒子，共 <strong>${stats.objectCount}</strong> 个 SHA-256 内容块对象。</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="btnScanDuplicates" class="btn btn-primary btn-sm">扫描重复大文件</button>
            <button id="btnRunGC" class="btn btn-ghost btn-sm">清理孤立对象 (GC)</button>
          </div>
        </div>
      </div>
    `;
  } else if (activeSettingsSection === 'bundle') {
    const softArchived = await api.listArchives(state.activeProjectId, { onlyArchived: true });
    const archivedProjects = state.statuses.filter((s) => s.archived);

    const recycleHtml = softArchived.length === 0
      ? '<div style="font-size:12px;color:var(--text-muted);">当前没有已归档隐藏的历史存档。</div>'
      : softArchived.map((a) => `
          <div class="file-row" style="margin-bottom:6px;">
            <span class="file-row-name">${escapeHtml(a.title)}（${formatTime(a.createdAt)}）</span>
            <button class="btn btn-ghost btn-sm act-restore-rec" data-id="${escapeHtml(a.id)}">还原</button>
            <button class="btn btn-danger btn-sm act-perm-del-rec" data-id="${escapeHtml(a.id)}" data-title="${escapeHtml(a.title)}">彻底删除</button>
          </div>
        `).join('');

    const archivedProjHtml = archivedProjects.length === 0
      ? '<div style="font-size:12px;color:var(--text-muted);">当前没有已归档的项目。</div>'
      : archivedProjects.map((p) => `
          <div class="file-row" style="margin-bottom:6px;">
            <span class="file-row-name">${escapeHtml(p.name)}（${escapeHtml(p.rootPath)}）</span>
            <button class="btn btn-ghost btn-sm act-unarch-p" data-id="${escapeHtml(p.projectId)}">恢复跟踪</button>
            <button class="btn btn-danger btn-sm act-perm-del-p" data-id="${escapeHtml(p.projectId)}" data-name="${escapeHtml(p.name)}">彻底移除</button>
          </div>
        `).join('');

    paneHtml = `
      <div class="settings-card">
        <h3>项目结项导出与一键加载恢复</h3>
        <p style="margin:0 0 10px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
          项目完成时可打包为自包含结项目录（清晰区分 <code>01_最终版本</code> 与 <code>02_历史版本</code>，脱离软件也能直接查阅）；日后需要返修重启时，点击「加载结项包」选中 <code>重新加载项目.chronobox.json</code> 即可 100% 续上全部历史。
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button id="btnSettingsExportBundle" class="btn btn-primary btn-sm">结项导出当前项目</button>
          <button id="btnSettingsImportBundle" class="btn btn-ghost btn-sm">加载结项包恢复项目</button>
          <button id="btnSettingsOpenReport" class="btn btn-ghost btn-sm">生成项目周报 / 进展汇总</button>
        </div>
      </div>

      <div class="settings-card">
        <h3>归档回收站与危险操作区（彻底删除需二次确认）</h3>
        <div class="field-label" style="margin-bottom:6px;">已归档隐藏的历史存档（${softArchived.length}）</div>
        ${recycleHtml}
        <div class="field-label" style="margin:12px 0 6px;">已归档暂停跟踪的项目（${archivedProjects.length}）</div>
        ${archivedProjHtml}
      </div>
    `;
  } else {
    paneHtml = `
      <div class="settings-card">
        <h3>关于时匣与使用说明书</h3>
        <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.8;margin-bottom:14px;">
          <div><strong>软件名称：</strong>时匣 ChronoBox（本地文件历史时间盒与视觉快照工具）</div>
          <div><strong>作者 / 开发者：</strong>Mika</div>
          <div><strong>版权声明：</strong>Copyright © 2026 Mika. All Rights Reserved.</div>
          <div><strong>隐私与存储：</strong>100% 本地硬盘存储与增量压缩去重，无云端上传，保障科研与工程数据安全。</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button id="btnOpenManualPopup" class="btn btn-primary btn-sm">查看详细使用说明书（弹窗）</button>
          <button id="btnOpenManualMdFile" class="btn btn-ghost btn-sm">打开 Markdown 说明书文件</button>
        </div>
      </div>
    `;
  }

  settingsContainerEl.innerHTML = `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">${navHtml}</nav>
      <div class="settings-content-pane">${paneHtml}</div>
    </div>
  `;

  // 左侧设置分类切换
  settingsContainerEl.querySelector<HTMLSelectElement>('#selMatrixColCount')?.addEventListener('change', (e) => {
    const n = Number((e.target as HTMLSelectElement).value) || 0;
    saveColumnMode(n);
    matrixOptions.columnMode = n;
    showToast(n === 0 ? '表格列数已设为「自动适配窗口」' : '表格列数已固定为 ' + n + ' 列', 'success');
    if (state.activeView === 'matrix') void renderMatrixView();
  });

  settingsContainerEl.querySelectorAll<HTMLButtonElement>('.settings-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = btn.dataset.sec as typeof activeSettingsSection | undefined;
      if (sec) {
        activeSettingsSection = sec;
        void renderSettingsView();
      }
    });
  });

  // 常规与悬浮窗
  settingsContainerEl.querySelector('#btnSaveGeneralOnly')?.addEventListener('click', async () => {
    const closeBehavior = $<HTMLSelectElement>('selCloseBehavior').value as 'tray' | 'quit';
    const floatingStyle = $<HTMLSelectElement>('selFloatingStyle').value as 'mini-dot' | 'mini-bar';
    const launchAtLogin = $<HTMLInputElement>('chkLaunchAtLogin').checked;
    const floatingEnabled = $<HTMLInputElement>('chkFloatingEnabled').checked;
    const restrictNestedFolders = $<HTMLInputElement>('chkRestrictNested').checked;
    state.config = await api.updateGeneralSettings({ closeBehavior, launchAtLogin, restrictNestedFolders });
    if (floatingEnabled) {
      state.config = await api.setFloatingStyle(floatingStyle);
    } else {
      state.config = await api.setFloatingEnabled(false);
    }
    syncFloatingUiState();
    showToast('常规与悬浮窗设置已保存', 'success');
  });

  // 外观与四季主题
  settingsContainerEl.querySelectorAll<HTMLButtonElement>('[data-theme-pick]').forEach((card) => {
    card.addEventListener('click', async () => {
      const picked = card.dataset.themePick as AppConfig['theme'];
      if (!picked) return;
      state.config = await api.setTheme(picked);
      applyTheme(picked);
      await renderSettingsView();
      showToast(`已切换主题：${card.querySelector('.theme-card-title')?.textContent?.replace(' · 当前', '') || picked}`, 'success');
    });
  });

  // 全局快捷键：交互式按键录入器（点入框内直接按组合键，实时显示 Ctrl / Ctrl+Shift+M 等）
  const attachShortcutRecorder = (input: HTMLInputElement | null) => {
    if (!input) return;
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        input.blur();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        input.value = '';
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');

      const rawKey = e.key;
      const isModifierOnly = ['Control', 'Shift', 'Alt', 'Meta'].includes(rawKey);
      if (!isModifierOnly) {
        let keyLabel = rawKey;
        if (rawKey === ' ') keyLabel = 'Space';
        else if (rawKey.length === 1) keyLabel = rawKey.toUpperCase();
        else if (rawKey.startsWith('Arrow')) keyLabel = rawKey.replace('Arrow', '');
        parts.push(keyLabel);
      }
      if (parts.length > 0) {
        input.value = parts.join('+');
      }
    });
  };
  attachShortcutRecorder(settingsContainerEl.querySelector('#inpShortcutMini'));
  attachShortcutRecorder(settingsContainerEl.querySelector('#inpShortcutArchive'));

  settingsContainerEl.querySelector('#btnResetShortcuts')?.addEventListener('click', () => {
    const m = settingsContainerEl.querySelector<HTMLInputElement>('#inpShortcutMini');
    const a = settingsContainerEl.querySelector<HTMLInputElement>('#inpShortcutArchive');
    if (m) m.value = 'Ctrl+Shift+M';
    if (a) a.value = 'Ctrl+Shift+S';
  });

  settingsContainerEl.querySelector('#btnSaveShortcutsOnly')?.addEventListener('click', async () => {
    const toElectronAccel = (v: string) => v.trim().replace(/^Ctrl\b|(?<=\+)Ctrl\b/g, 'CommandOrControl');
    const toggleMini = toElectronAccel($<HTMLInputElement>('inpShortcutMini').value);
    const quickArchive = toElectronAccel($<HTMLInputElement>('inpShortcutArchive').value);
    if (!toggleMini.includes('+') || !quickArchive.includes('+')) {
      showToast('请录入包含修饰键的完整组合键（例如 Ctrl+Shift+M）', 'error');
      return;
    }
    state.config = await api.updateGeneralSettings({ shortcuts: { toggleMini, quickArchive } });
    showToast('全局快捷键已保存并立即生效', 'success');
  });

  // Beyond Compare
  settingsContainerEl.querySelector('#btnDetectBc')?.addEventListener('click', async () => {
    const found = await api.detectBeyondCompare();
    if (found) {
      $<HTMLInputElement>('inpBcPath').value = found;
      showToast(`已自动检测到：${found}`, 'success');
    } else {
      showToast('未在默认安装目录检测到 BCompare.exe，请点击「浏览...」手动选择', 'info');
    }
  });
  settingsContainerEl.querySelector('#btnPickBc')?.addEventListener('click', async () => {
    const picked = await api.pickBeyondCompareExe();
    if (picked) $<HTMLInputElement>('inpBcPath').value = picked;
  });
  settingsContainerEl.querySelector('#btnSaveBcOnly')?.addEventListener('click', async () => {
    const beyondComparePath = $<HTMLInputElement>('inpBcPath').value.trim();
    state.config = await api.updateGeneralSettings({ beyondComparePath });
    showToast('Beyond Compare 路径已保存', 'success');
  });

  // 自动存档与忽略规则
  settingsContainerEl.querySelector('#btnSaveAutoArchive')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const enabled = $<HTMLInputElement>('chkAutoArchive').checked;
    const minutes = Number($<HTMLInputElement>('numAutoInterval').value) || 30;
    await api.updateAutoArchive(state.activeProjectId, enabled, minutes);
    await refreshActiveProject();
    showToast('定时自动存档设置已保存', 'success');
  });
  settingsContainerEl.querySelector('#btnSaveIgnore')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const lines = $<HTMLTextAreaElement>('txtIgnorePatterns').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    await api.updateIgnorePatterns(state.activeProjectId, lines);
    await refreshActiveProject();
    showToast('自定义忽略规则已保存并生效', 'success');
  });

  // 存储空间 GC 与重复大文件体检
  settingsContainerEl.querySelector('#btnScanDuplicates')?.addEventListener('click', () => void openDuplicateFilesModal());
  settingsContainerEl.querySelector('#btnRunGC')?.addEventListener('click', async () => {
    if (!state.activeProjectId) return;
    const ok = await showConfirm(
      '确认清理孤立对象 (GC)',
      '此操作将永久删除已被彻底删除的历史存档所残留的底层压缩块以释放磁盘空间。\n\n• 不会影响当前工作区中的任何文件；\n• 不会影响任何正常存档及回收站中的软归档；\n• 清理后，此前已永久删除的历史记录将彻底无法通过底层找回。\n\n是否立即执行清理？'
    );
    if (!ok) return;
    const res = await api.runGC(state.activeProjectId);
    showToast(`空间清理完成：移除 ${res.removedObjects} 个孤立对象，释放 ${formatBytes(res.freedBytes)}`, 'success');
    await renderSettingsView();
  });

  // 结项与回收站
  settingsContainerEl.querySelector('#btnSettingsExportBundle')?.addEventListener('click', () => {
    if (state.activeProjectId) openExportBundleModal(state.activeProjectId);
  });
  settingsContainerEl.querySelector('#btnSettingsImportBundle')?.addEventListener('click', () => {
    void handleImportProjectBundle();
  });
  settingsContainerEl.querySelector('#btnSettingsOpenReport')?.addEventListener('click', () => {
    void openProgressReportModal();
  });
  settingsContainerEl.querySelectorAll<HTMLButtonElement>('.act-restore-rec').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!state.activeProjectId || !b.dataset.id) return;
      await api.restoreSoftArchivedRecord(state.activeProjectId, b.dataset.id);
      await refreshActiveProject();
      showToast('已从归档回收站还原存档', 'success');
    });
  });
  settingsContainerEl.querySelectorAll<HTMLButtonElement>('.act-perm-del-rec').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!state.activeProjectId || !b.dataset.id) return;
      const ok1 = await showConfirm('危险操作：永久删除存档', `确定要彻底删除存档「${b.dataset.title}」吗？删除后将无法恢复！`);
      if (!ok1) return;
      await api.deleteArchive(state.activeProjectId, b.dataset.id);
      await refreshActiveProject();
      showToast(`已永久删除存档：${b.dataset.title}`, 'info');
    });
  });
  settingsContainerEl.querySelectorAll<HTMLButtonElement>('.act-unarch-p').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!b.dataset.id) return;
      await api.unarchiveProject(b.dataset.id);
      await refreshAll();
      showToast('已恢复跟踪项目', 'success');
    });
  });
  settingsContainerEl.querySelectorAll<HTMLButtonElement>('.act-perm-del-p').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!b.dataset.id) return;
      const ok = await showConfirm(
        '危险操作：彻底移除项目记录',
        `确定从时匣彻底移除项目「${b.dataset.name}」吗？（不会删除电脑上的工作文件，仅移除软件列表记录）`
      );
      if (!ok) return;
      await api.removeProject(b.dataset.id, false);
      await refreshAll();
      showToast(`已彻底移除项目：${b.dataset.name}`, 'info');
    });
  });

  // 关于与说明书
  settingsContainerEl.querySelector('#btnOpenManualPopup')?.addEventListener('click', () => {
    $('manualModal').classList.remove('hidden');
  });
  settingsContainerEl.querySelector('#btnOpenManualMdFile')?.addEventListener('click', async () => {
    const ok = await api.openManualMarkdown();
    if (!ok) showToast('未找到外置说明书文件，已为您打开内置说明书弹窗', 'info');
  });
}

function switchTab(view: AppState['activeView']): void {
  state.activeView = view;
  document.querySelectorAll<HTMLButtonElement>('.view-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  document.querySelectorAll<HTMLElement>('.view-panel').forEach((panel) => {
    panel.classList.remove('active');
  });
  const panelMap = {
    timeline: 'viewTimeline',
    graph: 'viewGraph',
    matrix: 'viewMatrix',
    browser: 'viewBrowser',
    diff: 'viewDiff',
    archivebox: 'viewArchiveBox',
    settings: 'viewSettings'
  };
  $(panelMap[view]).classList.add('active');
  filterBarEl.classList.toggle(
    'hidden',
    view === 'diff' || view === 'settings' || view === 'archivebox' || view === 'matrix' || view === 'browser'
  );

  // 全局页（设置 / 归档箱）自动让出右侧详情栏，回到数据视图时自动还原
  syncInspectorForView(view);

  if (view === 'graph') {
    void renderGraphView();
  } else if (view === 'matrix') {
    void renderMatrixView();
  } else if (view === 'diff') {
    void renderDiffView();
  } else if (view === 'archivebox') {
    void renderArchiveBoxView();
  } else if (view === 'settings') {
    void renderSettingsView();
  } else if (view === 'browser') {
    void renderBrowserView();
  }
  try {
    localStorage.setItem('chronobox_active_view', view);
  } catch {
    /* ignore */
  }
}

const VIEW_ORDER: AppState['activeView'][] = ['matrix', 'graph', 'timeline', 'browser', 'diff', 'archivebox', 'settings'];

function openArchiveModal(): void {
  if (!state.activeProjectId) return;
  const status = state.statuses.find((s) => s.projectId === state.activeProjectId);
  if (!status || !status.exists) return;

  if (!status.hasChanges && status.archiveCount > 0) {
    showToast('当前文件夹没有检测到新的变化，无需重复存档', 'info');
    return;
  }

  state.modalSelectedTags = [];
  archiveTitleInputEl.value = '';
  archiveNoteInputEl.value = '';
  archiveCustomTagsInputEl.value = '';
  document.querySelectorAll<HTMLButtonElement>('#modalTagPicker .tag-choice').forEach((b) => {
    b.classList.remove('selected');
  });

  const added = status.changes.filter((c) => c.status === 'added').length;
  const modified = status.changes.filter((c) => c.status === 'modified').length;
  const deleted = status.changes.filter((c) => c.status === 'deleted').length;
  modalChangesPreviewEl.innerHTML = `
    <div class="diff-chips">
      <span class="chip add">+${added} 新增</span>
      <span class="chip mod">~${modified} 修改</span>
      <span class="chip del">-${deleted} 删除</span>
    </div>
  `;

  archiveModalEl.classList.remove('hidden');
  archiveTitleInputEl.focus();
}

function openSwitchModal(archiveId: string, isDirty: boolean): void {
  const arc = state.manifest?.archives[archiveId];
  if (!arc) return;
  state.pendingSwitchArchiveId = archiveId;
  switchModalDescEl.textContent = `确定将整个文件夹恢复到存档「${arc.title}」（${formatTime(arc.createdAt)}）时的状态吗？恢复后，您仍可随时切回任意其他存档，或在此基础上继续修改并创建新分支。`;
  const defaultOverwriteRadio = document.querySelector<HTMLInputElement>('input[name="restoreMode"][value="overwrite"]');
  if (defaultOverwriteRadio) defaultOverwriteRadio.checked = true;
  switchBackupOptionEl.classList.toggle('hidden', !isDirty);
  chkAutoBackupEl.checked = true;
  switchModalEl.classList.remove('hidden');
}

let milestoneModalRelPath: string | null = null;
let milestoneFromId: string | null = null;
let milestoneToId: string | null = null;
let reportViewMode: 'visual' | 'raw' = 'visual';
let lastDuplicateGroups: Array<{ paths: string[]; wastedBytes: number }> = [];
let gsFilterKind: 'all' | 'file' | 'archive' | 'project' = 'all';
let gsSelectedIdx = 0;

function applyReportViewMode(): void {
  const isVisual = reportViewMode === 'visual';
  $('reportVisualBody').classList.toggle('hidden', !isVisual);
  $('txtReportMarkdown').classList.toggle('hidden', isVisual);
  $('btnReportModeVisual').className = isVisual ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  $('btnReportModeRaw').className = !isVisual ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
}

async function openProgressReportModal(): Promise<void> {
  reportViewMode = 'visual';
  applyReportViewMode();
  $('progressReportModal').classList.remove('hidden');
  await refreshProgressReport();
}

async function refreshProgressReport(): Promise<void> {
  const days = Number($<HTMLSelectElement>('selReportPeriod').value);
  const scope = $<HTMLSelectElement>('selReportScope').value;
  const projectId = scope === 'current' ? state.activeProjectId : null;
  const res = await api.generateProgressReport({ projectId, days });
  $<HTMLTextAreaElement>('txtReportMarkdown').value = res.markdown;
  $('lblReportStats').textContent = `${res.projectCount} 项目 · ${res.archiveCount} 存档 · ${res.touchedFilesCount} 文件`;
  renderVisualProgressReport($('reportVisualBody'), res);
  applyReportViewMode();
}

async function openDuplicateFilesModal(): Promise<void> {
  if (!state.activeProjectId) return;
  $('duplicateFilesModal').classList.remove('hidden');
  $('duplicateSummaryBar').textContent = '正在基于 SHA-256 哈希体检重复文件...';
  $('duplicateListBody').innerHTML = '';
  $('btnBatchArchiveDuplicates').classList.add('hidden');
  lastDuplicateGroups = [];

  const res = await api.findDuplicateFiles(state.activeProjectId);
  if (res.groups.length === 0) {
    $('duplicateSummaryBar').innerHTML = renderDuplicateWasteBanner(res) + '<div style="font-size:12px;">体检完成：当前项目非常清爽，未发现内容完全相同的重复文件。</div>';
    $('duplicateListBody').innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);">✨ 没有重复副本，空间利用率很棒！</div>';
    return;
  }

  lastDuplicateGroups = res.groups.map((g) => ({ paths: g.paths, wastedBytes: g.wastedBytes }));
  $('btnBatchArchiveDuplicates').classList.remove('hidden');
  $('duplicateSummaryBar').innerHTML =
    renderDuplicateWasteBanner(res) +
    `<div style="font-size:12px;">移入 <code>00【Archive】</code> 归档箱可随时一键放回原位，绝不直接删除您的文件。</div>`;

  $('duplicateListBody').innerHTML = res.groups
    .map(
      (g, gi) => `
      <div class="settings-card" style="padding:12px 14px;margin:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:12.5px;">
          <strong>第 ${gi + 1} 组重复文件 · 单份 ${formatBytes(g.size)}</strong>
          <span class="chip mod" style="background:rgba(245,158,11,0.14);color:#B45309;">${g.paths.length} 份相同 · 可省 ${formatBytes(g.wastedBytes)}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${g.paths
            .map(
              (fp, idx) => `
            <div class="file-row" style="padding:6px 8px;">
              <span class="file-row-name" title="${escapeHtml(fp)}">${idx === 0 ? '<span class="chip add" style="margin-right:6px;">建议保留</span>' : '<span class="chip del" style="margin-right:6px;">多余副本</span>'}${escapeHtml(fp)}</span>
              <button class="btn btn-ghost btn-sm act-dup-show" data-path="${escapeHtml(fp)}" style="padding:2px 7px;font-size:11px;">定位</button>
              <button class="btn btn-ghost btn-sm act-dup-archive" data-path="${escapeHtml(fp)}" style="padding:2px 7px;font-size:11px;">移入归档箱</button>
            </div>`
            )
            .join('')}
        </div>
      </div>`
    )
    .join('');

  $('duplicateListBody').querySelectorAll<HTMLButtonElement>('.act-dup-show').forEach((b) => {
    b.addEventListener('click', () => {
      if (state.activeProjectId && b.dataset.path) void api.showFileInExplorer(state.activeProjectId, b.dataset.path);
    });
  });

  $('duplicateListBody').querySelectorAll<HTMLButtonElement>('.act-dup-archive').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!state.activeProjectId || !b.dataset.path) return;
      try {
        await api.archiveDuplicateFile(state.activeProjectId, b.dataset.path);
        showToast(`已安全移入 00【Archive】归档箱：${b.dataset.path}`, 'success');
        await refreshActiveProject();
        await openDuplicateFilesModal();
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    });
  });
}

async function openFileMilestonesModal(projectId: string, relPath: string): Promise<void> {
  milestoneModalRelPath = relPath;
  const baseName = relPath.split('/').pop() || relPath;
  $('fileMilestonesTitle').textContent = `📜 单文件里程碑演进 — ${baseName}`;
  $('fileMilestonesModal').classList.remove('hidden');

  const items = await api.getFileMilestones(projectId, relPath);
  if (items.length === 0) {
    $('fileMilestonesList').innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);">暂未找到该文件的历史里程碑记录。</div>';
    milestoneFromId = null;
    milestoneToId = null;
    return;
  }

  milestoneToId = items[items.length - 1].archiveId;
  milestoneFromId = items.length >= 2 ? items[items.length - 2].archiveId : items[0].archiveId;

  const actionLabel: Record<string, { text: string; cls: string }> = {
    initial: { text: '初始', cls: 'neutral' },
    added: { text: '新增', cls: 'add' },
    modified: { text: '编辑', cls: 'mod' },
    renamed: { text: '重命名', cls: 'neutral' },
    deleted: { text: '删除', cls: 'del' }
  };

  const sparkSvg = renderFileSizeSparklineSvg(items);

  const renderRows = () => {
    const rowsHtml = [...items]
      .reverse()
      .map((m) => {
        const meta = actionLabel[m.action] || { text: m.action, cls: 'neutral' };
        const isA = m.archiveId === milestoneFromId;
        const isB = m.archiveId === milestoneToId;
        const deltaStr = m.deltaSize === 0 ? '' : `${m.deltaSize > 0 ? '+' : '-'}${formatBytes(Math.abs(m.deltaSize))}`;
        return `
          <div class="file-row" style="padding:8px 10px;align-items:center;${isA || isB ? 'border-color:var(--accent);background:var(--accent-soft);' : ''}">
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <strong>${escapeHtml(m.versionLabel)}</strong>
                <span class="chip ${meta.cls}">${meta.text}</span>
                <span>${escapeHtml(m.title)}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                ${formatTime(m.createdAt)} · ${formatBytes(m.size)}${deltaStr ? ` (${deltaStr})` : ''}${m.previousPath ? ` · 原名：${escapeHtml(m.previousPath)}` : ''}
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button class="btn ${isA ? 'btn-primary' : 'btn-ghost'} btn-sm act-ms-a" data-aid="${escapeHtml(m.archiveId)}" style="padding:2px 8px;font-size:11px;">基准 A</button>
              <button class="btn ${isB ? 'btn-primary' : 'btn-ghost'} btn-sm act-ms-b" data-aid="${escapeHtml(m.archiveId)}" style="padding:2px 8px;font-size:11px;">目标 B</button>
            </div>
          </div>`;
      })
      .join('');

    $('fileMilestonesList').innerHTML = `${sparkSvg}${rowsHtml}`;

    $('fileMilestonesList').querySelectorAll<HTMLButtonElement>('.act-ms-a').forEach((b) => {
      b.addEventListener('click', () => {
        milestoneFromId = b.dataset.aid || null;
        renderRows();
      });
    });
    $('fileMilestonesList').querySelectorAll<HTMLButtonElement>('.act-ms-b').forEach((b) => {
      b.addEventListener('click', () => {
        milestoneToId = b.dataset.aid || null;
        renderRows();
      });
    });
  };
  renderRows();
}

function highlightMatch(text: string, q: string): string {
  const safe = escapeHtml(text);
  const qt = q.trim();
  if (!qt) return safe;
  const re = new RegExp(`(${qt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark class="gs-mark">$1</mark>');
}

function openGlobalSearchModal(): void {
  gsFilterKind = 'all';
  gsSelectedIdx = 0;
  document.querySelectorAll<HTMLButtonElement>('.gs-filter-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.gsKind === 'all');
  });
  $('globalSearchModal').classList.remove('hidden');
  const inp = $<HTMLInputElement>('inpGlobalSearch');
  inp.value = '';
  inp.focus();
  void renderGlobalSearchResults('');
}

interface PaletteCommand {
  icon: string;
  label: string;
  hint: string;
  keywords: string;
  run: () => void;
}

function paletteCommands(): PaletteCommand[] {
  const closePalette = () => $('globalSearchModal').classList.add('hidden');
  const go = (view: AppState['activeView']) => () => {
    closePalette();
    switchTab(view);
  };
  const cycleTheme = () => $<HTMLButtonElement>('btnToggleTheme').click();

  const cmds: PaletteCommand[] = [
    { icon: '▦', label: '表格视图 · 文件级生命周期', hint: 'Ctrl 1', keywords: 'matrix table 表格 文件', run: go('matrix') },
    { icon: '◈', label: '关系视图 · 分支思维导图', hint: 'Ctrl 2', keywords: 'graph dag 关系 分支', run: go('graph') },
    { icon: '◷', label: '时间轴 · 存档卡片流', hint: 'Ctrl 3', keywords: 'timeline 时间轴 存档', run: go('timeline') },
    { icon: '⇄', label: '存档对比 · 差异检视', hint: 'Ctrl 4', keywords: 'diff compare 对比 差异', run: go('diff') },
    { icon: '▤', label: '00【Archive】归档箱', hint: 'Ctrl 5', keywords: 'archive 归档 收纳', run: go('archivebox') },
    { icon: '⚙', label: '设置与关于', hint: 'Ctrl 6', keywords: 'settings 设置 主题', run: go('settings') },
    { icon: '✦', label: '立即为当前项目创建存档', hint: 'Ctrl Shift S', keywords: 'archive now 存档 快照', run: () => { closePalette(); openArchiveModal(); } },
    { icon: '↻', label: '重新扫描当前项目', hint: 'F5', keywords: 'refresh rescan 刷新 扫描', run: () => { closePalette(); void refreshAll().then(() => showToast('已重新扫描当前项目', 'info')); } },
    { icon: '◐', label: '切换下一个主题', hint: 'Ctrl Shift T', keywords: 'theme 主题 配色 外观', run: () => { closePalette(); cycleTheme(); } },
    { icon: '⌘', label: '查看键盘快捷键', hint: '?', keywords: 'shortcut 快捷键 keymap', run: () => { closePalette(); openShortcutsModal(); } },
    { icon: '≡', label: '项目周报 · 进展可视化看板', hint: '报告', keywords: 'report 周报 报告 统计', run: () => { closePalette(); void openProgressReportModal(); } },
    { icon: '⧉', label: '重复大文件体检（SHA-256）', hint: '瘦身', keywords: 'duplicate 重复 冗余 瘦身', run: () => { closePalette(); void openDuplicateFilesModal(); } },
    { icon: '▣', label: '结项导出（最终版 + 全部历史）', hint: '冷备份', keywords: 'bundle export 导出 结项 备份', run: () => { closePalette(); if (state.activeProjectId) openExportBundleModal(state.activeProjectId); } }
  ];

  return cmds;
}

function commandRowHtml(cmd: PaletteCommand, idx: number, activeIdx: number): string {
  return `
    <div class="file-row act-gs-item ${idx === activeIdx ? 'gs-hit-active' : ''}" data-cmd-idx="${idx}" style="cursor:pointer;padding:8px 10px;">
      <span class="visual-mini-badge" style="background:var(--bg-subtle);color:var(--text-secondary);font-size:11px;">${cmd.icon}</span>
      <span class="file-row-name" style="margin-left:2px;">${escapeHtml(cmd.label)}</span>
      <span class="kbd">${escapeHtml(cmd.hint)}</span>
    </div>`;
}

function bindCommandRows(box: HTMLElement, cmds: PaletteCommand[], offset: number): void {
  box.querySelectorAll<HTMLElement>('[data-cmd-idx]').forEach((el) => {
    el.addEventListener('click', () => {
      const cmd = cmds[Number(el.dataset.cmdIdx)];
      if (cmd) cmd.run();
    });
  });
  void offset;
}

async function renderGlobalSearchResults(query: string): Promise<void> {
  const box = $('globalSearchResults');
  gsSelectedIdx = 0;
  const cmds = paletteCommands();
  const q = query.trim().toLowerCase();
  const matchedCmds = q
    ? cmds.filter((c) => (c.label + ' ' + c.keywords).toLowerCase().includes(q))
    : cmds;

  if (!q) {
    box.innerHTML =
      `<div class="palette-group-title">命令</div>` +
      matchedCmds.map((c, i) => commandRowHtml(c, i, 0)).join('') +
      `<div class="palette-group-title">提示</div>
       <div style="font-size:11.5px;color:var(--text-muted);padding:2px 4px 4px;line-height:1.7;">
         直接输入关键词可跨项目秒搜文件名、存档标题、备注与标签 · <span class="kbd">↑</span> <span class="kbd">↓</span> 选择 · <span class="kbd">Enter</span> 执行
       </div>`;
    bindCommandRows(box, matchedCmds, 0);
    return;
  }

  const allHits = await api.globalSearch(query);
  const hits = gsFilterKind === 'all' ? allHits : allHits.filter((h) => h.kind === gsFilterKind);

  const cmdHtml = matchedCmds.length
    ? `<div class="palette-group-title">命令</div>` + matchedCmds.map((c, i) => commandRowHtml(c, i, gsSelectedIdx)).join('')
    : '';

  const kindBadge: Record<string, string> = { project: '项目', file: '文件', archive: '存档' };
  const hitHtml = hits.length
    ? `<div class="palette-group-title">搜索命中</div>` +
      hits
        .map(
          (h, idx) => `
      <div class="file-row act-gs-item" data-idx="${idx}" style="cursor:pointer;padding:8px 10px;">
        <span class="chip ${h.kind === 'file' ? 'mod' : h.kind === 'project' ? 'add' : 'neutral'}" style="margin-right:6px;">${kindBadge[h.kind]}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${highlightMatch(h.title, query)}</div>
          <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${highlightMatch(h.subtitle, query)}</div>
        </div>
      </div>`
        )
        .join('')
    : '';

  if (!cmdHtml && !hitHtml) {
    box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);">未找到匹配的命令、项目、存档或历史文件。</div>';
    return;
  }

  box.innerHTML = cmdHtml + hitHtml;
  bindCommandRows(box, matchedCmds, 0);

  box.querySelectorAll<HTMLElement>('[data-idx]').forEach((el) => {
    el.addEventListener('click', async () => {
      const hit = hits[Number(el.dataset.idx)];
      if (!hit) return;
      $('globalSearchModal').classList.add('hidden');
      if (state.activeProjectId !== hit.projectId) {
        state.activeProjectId = hit.projectId;
        await api.setActiveProject(hit.projectId);
        await refreshActiveProject();
      }
      if (hit.kind === 'file' && hit.relPath) {
        jumpToFileInMatrix(hit.relPath);
      } else if (hit.kind === 'archive' && hit.archiveId) {
        state.selectedArchiveId = hit.archiveId;
        await refreshActiveProject();
      }
    });
  });
}

function bindEvents(): void {
  const addFolderPathWithNestedCheck = async (folder: string) => {
    try {
      const children = await api.findNestedChildProjects(folder);
      if (children.length > 0) {
        const names = children.map((c) => `「${c.name}」`).join('、');
        pendingNestedFolder = folder;
        $('nestedModalDesc').textContent = `您正在添加的父文件夹内部已包含子项目：${names}。请选择希望如何管理它们：`;
        const defaultExclude = document.querySelector<HTMLInputElement>('input[name="nestedMode"][value="exclude"]');
        if (defaultExclude) defaultExclude.checked = true;
        $('nestedUpgradeModal').classList.remove('hidden');
        return;
      }
      const proj = await api.addProject(folder);
      await refreshAll();
      showToast(`已添加项目：${proj.name}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const handleAddFolder = async () => {
    const folder = await api.pickFolder();
    if (!folder) return;
    await addFolderPathWithNestedCheck(folder);
  };

  // === 左侧项目列表侧边栏：支持直接拖拽文件夹添加为项目（带确认弹窗） ===
  const sidebarDropZone = $('leftSidebar');
  let sidebarDragDepth = 0;
  let sidebarBanner: HTMLDivElement | null = null;
  const setSidebarDropHover = (on: boolean) => {
    sidebarDropZone.classList.toggle('sidebar-drop-active', on);
    if (on && !sidebarBanner) {
      sidebarBanner = document.createElement('div');
      sidebarBanner.className = 'sidebar-drop-banner';
      sidebarBanner.innerHTML = '<span>📂 松手添加为项目</span><span style="font-size:11px;font-weight:500;">将弹出确认框</span>';
      sidebarDropZone.appendChild(sidebarBanner);
    } else if (!on && sidebarBanner) {
      sidebarBanner.remove();
      sidebarBanner = null;
    }
  };
  sidebarDropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    sidebarDragDepth++;
    setSidebarDropHover(true);
  });
  sidebarDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  sidebarDropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    sidebarDragDepth = Math.max(0, sidebarDragDepth - 1);
    if (sidebarDragDepth === 0) setSidebarDropHover(false);
  });
  sidebarDropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    sidebarDragDepth = 0;
    setSidebarDropHover(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const rawPath = api.getPathForFile(files[0]);
    if (!rawPath) return;
    const info = await api.statPath(rawPath);
    if (!info.exists) {
      showToast('无法读取拖入的路径', 'error');
      return;
    }
    const targetFolder = info.isDirectory ? info.resolved : info.parentDir;
    const targetName = info.isDirectory ? info.name : targetFolder.split(/[\\/]/).pop() || targetFolder;
    const tipPrefix = info.isDirectory
      ? `确定将以下文件夹添加为新项目吗？`
      : `您拖入的是单个文件「${info.name}」，是否将其所在的文件夹添加为新项目？`;
    const ok = await showConfirm(
      '确认添加为项目',
      `${tipPrefix}\n\n项目名称：${targetName}\n文件夹路径：${targetFolder}`
    );
    if (!ok) return;
    await addFolderPathWithNestedCheck(targetFolder);
  });

  $('btnAddProject').addEventListener('click', handleAddFolder);
  $('btnEmptyAdd').addEventListener('click', handleAddFolder);
  $('btnRefresh').addEventListener('click', () => void refreshActiveProject());
  $('btnQuickArchive').addEventListener('click', openArchiveModal);
  activeProjectPathEl.addEventListener('click', () => {
    const st = state.statuses.find((s) => s.projectId === state.activeProjectId);
    if (st) void api.openFolder(st.rootPath);
  });

  $('btnMiniBar').addEventListener('click', async () => {
    state.config = await api.setFloatingStyle('mini-bar');
    syncFloatingUiState();
  });
  $('btnMiniDot').addEventListener('click', async () => {
    state.config = await api.setFloatingStyle('mini-dot');
    syncFloatingUiState();
  });
  $('btnTopMiniOrb').addEventListener('click', async () => {
    const currentlyOn = state.config?.floatingEnabled !== false;
    state.config = await api.setFloatingEnabled(!currentlyOn);
    syncFloatingUiState();
    showToast(state.config.floatingEnabled ? '已开启桌面悬浮窗（可与主窗口同时显示）' : '已隐藏桌面悬浮窗', 'info');
  });

  // === 左侧栏与右侧详情栏：折叠 / 拖拽调宽 / 专注模式 ===
  const btnToggleLeft = $<HTMLButtonElement>('btnToggleLeftSidebar');
  const btnToggleRight = $<HTMLButtonElement>('btnToggleRightInspector');
  const btnFocus = $<HTMLButtonElement>('btnFocusWorkspace');

  restorePaneState();
  document.body.classList.toggle('focus-mode', leftCollapsed && rightCollapsed);
  btnFocus.classList.toggle('active', leftCollapsed && rightCollapsed);

  const rerenderMatrixSoon = () => {
    if (state.activeView === 'matrix') setTimeout(() => void renderMatrixView(), 220);
  };

  btnToggleLeft.addEventListener('click', () => {
    inspectorAutoHidden = false;
    applyPaneState(!leftCollapsed, rightCollapsed);
    rerenderMatrixSoon();
  });

  btnToggleRight.addEventListener('click', () => {
    inspectorAutoHidden = false;
    applyPaneState(leftCollapsed, !rightCollapsed);
    rerenderMatrixSoon();
  });

  // 专注放大工作区（收起左右侧栏，只显示中间核心工作区，非系统全屏）
  btnFocus.addEventListener('click', () => {
    const isFocused = leftCollapsed && rightCollapsed;
    if (!isFocused) {
      savedBeforeFocus = { left: leftCollapsed, right: rightCollapsed };
      applyPaneState(true, true);
      btnFocus.classList.add('active');
    } else {
      applyPaneState(savedBeforeFocus ? savedBeforeFocus.left : false, savedBeforeFocus ? savedBeforeFocus.right : false);
      btnFocus.classList.remove('active');
    }
    document.body.classList.toggle('focus-mode', leftCollapsed && rightCollapsed);
    rerenderMatrixSoon();
  });

  // === 拖拽调整左右栏宽度（双击复位） ===
  const bindPaneResizer = (
    resizerId: string,
    opts: { min: number; max: number; fallback: number; storageKey: string; cssVar: string; invert?: boolean }
  ) => {
    const handle = document.getElementById(resizerId);
    if (!handle) return;
    let startX = 0;
    let startW = 0;
    let width = readNumber(opts.storageKey, opts.fallback, opts.min, opts.max);
    document.documentElement.style.setProperty(opts.cssVar, `${width}px`);

    const onMove = (e: PointerEvent) => {
      const delta = e.clientX - startX;
      const next = Math.min(opts.max, Math.max(opts.min, startW + (opts.invert ? -delta : delta)));
      width = next;
      document.documentElement.style.setProperty(opts.cssVar, `${next}px`);
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        localStorage.setItem(opts.storageKey, String(width));
      } catch {
        /* ignore */
      }
      if (state.activeView === 'matrix') void renderMatrixView();
    };

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue(opts.cssVar), 10) || opts.fallback;
      handle.classList.add('dragging');
      document.body.classList.add('is-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty(opts.cssVar, `${opts.fallback}px`);
      try {
        localStorage.setItem(opts.storageKey, String(opts.fallback));
      } catch {
        /* ignore */
      }
      if (state.activeView === 'matrix') void renderMatrixView();
    });
  };

  bindPaneResizer('sidebarResizer', {
    min: MIN_SIDEBAR_W,
    max: MAX_SIDEBAR_W,
    fallback: DEFAULT_SIDEBAR_W,
    storageKey: 'chronobox_sidebar_w',
    cssVar: '--sidebar-w'
  });
  bindPaneResizer('inspectorResizer', {
    min: MIN_INSPECTOR_W,
    max: MAX_INSPECTOR_W,
    fallback: DEFAULT_INSPECTOR_W,
    storageKey: 'chronobox_inspector_w',
    cssVar: '--inspector-w',
    invert: true
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (state.activeView !== 'matrix') return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void renderMatrixView(), 180);
  });

  // 说明书弹窗关闭与打开外部 Markdown
  const closeManualModal = () => $('manualModal').classList.add('hidden');
  $('btnCloseManualModal').addEventListener('click', closeManualModal);
  $('btnOkManualModal').addEventListener('click', closeManualModal);
  $('btnModalOpenMd').addEventListener('click', () => void api.openManualMarkdown());

  $('btnGlobalSearch').addEventListener('click', openGlobalSearchModal);
  $('btnCloseGlobalSearch').addEventListener('click', () => $('globalSearchModal').classList.add('hidden'));
  $('inpGlobalSearch').addEventListener('input', (e) => {
    void renderGlobalSearchResults((e.target as HTMLInputElement).value);
  });

  $('btnCloseProgressReport').addEventListener('click', () => $('progressReportModal').classList.add('hidden'));
  $('selReportPeriod').addEventListener('change', () => void refreshProgressReport());
  $('selReportScope').addEventListener('change', () => void refreshProgressReport());
  $('btnReportModeVisual').addEventListener('click', () => {
    reportViewMode = 'visual';
    applyReportViewMode();
  });
  $('btnReportModeRaw').addEventListener('click', () => {
    reportViewMode = 'raw';
    applyReportViewMode();
  });
  $('btnBatchArchiveDuplicates').addEventListener('click', async () => {
    if (!state.activeProjectId || lastDuplicateGroups.length === 0) return;
    const toArchive: string[] = [];
    for (const g of lastDuplicateGroups) {
      toArchive.push(...g.paths.slice(1));
    }
    const ok = await showConfirm(
      '确认一键批量瘦身',
      `将把 ${toArchive.length} 个多余重复副本安全移入 00【Archive】归档箱（每组保留第 1 份，且随时可一键放回原位）。是否继续？`
    );
    if (!ok) return;
    for (const rel of toArchive) {
      try { await api.archiveDuplicateFile(state.activeProjectId, rel); } catch { /* ignore */ }
    }
    showToast(`批量瘦身完成：已将 ${toArchive.length} 个重复副本安全移入 00【Archive】`, 'success');
    await refreshActiveProject();
    await openDuplicateFilesModal();
  });
  document.querySelectorAll<HTMLButtonElement>('.gs-filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      gsFilterKind = (btn.dataset.gsKind || 'all') as typeof gsFilterKind;
      document.querySelectorAll<HTMLButtonElement>('.gs-filter-pill').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      void renderGlobalSearchResults($<HTMLInputElement>('inpGlobalSearch').value);
    });
  });
  $('inpGlobalSearch').addEventListener('keydown', (e: KeyboardEvent) => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('#globalSearchResults .act-gs-item'));
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      gsSelectedIdx = (gsSelectedIdx + 1) % items.length;
      items.forEach((el, i) => el.classList.toggle('gs-hit-active', i === gsSelectedIdx));
      items[gsSelectedIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      gsSelectedIdx = (gsSelectedIdx - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('gs-hit-active', i === gsSelectedIdx));
      items[gsSelectedIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[gsSelectedIdx]?.click();
    }
  });

  $('btnCopyReportMd').addEventListener('click', async () => {
    const md = $<HTMLTextAreaElement>('txtReportMarkdown').value;
    try {
      await navigator.clipboard.writeText(md);
      showToast('已复制 Markdown 进展周报到剪贴板', 'success');
    } catch {
      showToast('复制失败，请手动全选复制', 'error');
    }
  });
  $('btnExportReportMd').addEventListener('click', async () => {
    const md = $<HTMLTextAreaElement>('txtReportMarkdown').value;
    const saved = await api.exportReportMarkdown(md, '项目进展周报.md');
    if (saved) showToast(`已导出周报文件：${saved}`, 'success');
  });

  $('btnCloseDuplicateModal').addEventListener('click', () => $('duplicateFilesModal').classList.add('hidden'));
  $('btnOkDuplicateModal').addEventListener('click', () => $('duplicateFilesModal').classList.add('hidden'));

  $('btnCloseFileMilestones').addEventListener('click', () => $('fileMilestonesModal').classList.add('hidden'));
  $('btnMilestoneInnerDiff').addEventListener('click', () => {
    if (!milestoneModalRelPath || !milestoneFromId || !milestoneToId) return;
    $('fileMilestonesModal').classList.add('hidden');
    state.diffFromId = milestoneFromId;
    state.diffToId = milestoneToId;
    state.selectedDiffFile = { path: milestoneModalRelPath, status: 'modified', isBinary: false };
    switchTab('diff');
  });
  $('btnMilestoneBcDiff').addEventListener('click', () => {
    if (!milestoneModalRelPath || !milestoneFromId || !milestoneToId) return;
    void runBeyondCompare('file', milestoneFromId, milestoneToId, milestoneModalRelPath);
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable === true;

    // Ctrl / Cmd + K —— 命令面板（输入框内也生效，符合工具直觉）
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openGlobalSearchModal();
      return;
    }

    if (e.key === 'Escape') {
      [
        'globalSearchModal',
        'progressReportModal',
        'duplicateFilesModal',
        'fileMilestonesModal',
        'shortcutsModal'
      ].forEach((id) => document.getElementById(id)?.classList.add('hidden'));
      closeBrowserMenu();
      return;
    }

    if (typing) return;

    // ? —— 快捷键速查表
    if (e.key === '?' && !mod) {
      e.preventDefault();
      openShortcutsModal();
      return;
    }

    // 文件浏览器内的资源管理器式快捷键
    if (state.activeView === 'browser') {
      if (e.key === 'F2' && state.browserSelected && browserData) {
        e.preventDefault();
        const entry = browserData.entries.find((x) => x.relPath === state.browserSelected);
        if (entry) void handleBrowserAction('rename', entry);
        return;
      }
      if (e.key === 'Delete' && state.browserSelected && browserData) {
        e.preventDefault();
        const entry = browserData.entries.find((x) => x.relPath === state.browserSelected);
        if (entry) void handleBrowserAction('trash', entry);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void handleBrowserAction('newfolder', null);
        return;
      }
    }

    // F5 —— 重新扫描
    if (e.key === 'F5') {
      e.preventDefault();
      void refreshAll().then(() => showToast('已重新扫描当前项目', 'info'));
      return;
    }

    // Ctrl + 1..6 —— 视图切换
    if (mod && !e.shiftKey && /^[1-6]$/.test(e.key)) {
      e.preventDefault();
      const view = VIEW_ORDER[Number(e.key) - 1];
      if (view) switchTab(view);
      return;
    }

    // Ctrl + Shift + T —— 循环主题
    if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      $('btnToggleTheme').click();
      return;
    }

    // Ctrl + Shift + F —— 专注模式
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('btnFocusWorkspace').click();
      return;
    }

    // Ctrl + \ / Ctrl + Shift + \ —— 折叠侧栏
    if (mod && e.key === '\\') {
      e.preventDefault();
      if (e.shiftKey) {
        applyPaneState(leftCollapsed, !rightCollapsed);
      } else {
        applyPaneState(!leftCollapsed, rightCollapsed);
      }
      if (state.activeView === 'matrix') setTimeout(() => void renderMatrixView(), 220);
    }
  });

  // 快捷键速查表
  $('btnCloseShortcuts').addEventListener('click', closeShortcutsModal);
  $('btnOkShortcuts').addEventListener('click', closeShortcutsModal);
  $('sbShortcuts').addEventListener('click', openShortcutsModal);


  $('btnToggleLang').addEventListener('click', async () => {
    const next = state.config?.language === 'en-US' ? 'zh-CN' : 'en-US';
    await api.setLanguage(next);
    await refreshAll();
  });

  $('btnToggleTheme').addEventListener('click', async () => {
    const order: AppConfig['theme'][] = ['light', 'dark', 'system', 'spring', 'summer', 'autumn', 'winter'];
    const labels: Record<string, string> = {
      light: '明亮主题',
      dark: '暗黑主题',
      system: '跟随系统',
      spring: '春 · 樱芽青',
      summer: '夏 · 晴海蓝',
      autumn: '秋 · 暖枫琥珀',
      winter: '冬 · 霜雪靛'
    };
    const cur = state.config?.theme || 'light';
    const idx = order.indexOf(cur);
    const next = order[(idx + 1) % order.length];
    state.config = await api.setTheme(next);
    applyTheme(next);
    showToast(`已切换至：${labels[next] || next}`, 'info');
    if (state.activeView === 'settings' && activeSettingsSection === 'themes') {
      void renderSettingsView();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.view as AppState['activeView']));
  });

  document.querySelectorAll<HTMLButtonElement>('.tag-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tag-filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tagFilter = (btn.dataset.tag || null) as TagColor | null;
      void refreshActiveProject();
    });
  });

  searchInputEl.addEventListener('input', () => {
    state.searchQuery = searchInputEl.value;
    void refreshActiveProject();
  });

  // 关系图相对缩放控制
  $('btnZoomIn').addEventListener('click', () => graphRenderer.zoomBy(0.15));
  $('btnZoomOut').addEventListener('click', () => graphRenderer.zoomBy(-0.15));
  $('btnZoomReset').addEventListener('click', () => graphRenderer.resetView());

  // 差异对比下拉框（自绘组件在 renderDiffView 内部绑定事件）
  $('btnSwapDiff').addEventListener('click', () => {
    const tmp = state.diffFromId;
    state.diffFromId = state.diffToId;
    state.diffToId = tmp;
    void renderDiffView();
  });

  $('btnBcCompareFile').addEventListener('click', () => {
    if (!state.selectedDiffFile) {
      showToast('请先在左侧差异列表中点击选择一个文件', 'info');
      return;
    }
    void runBeyondCompare('file', state.diffFromId, state.diffToId, state.selectedDiffFile.path);
  });

  $('btnBcCompareFolder').addEventListener('click', () => {
    void runBeyondCompare('folder', state.diffFromId, state.diffToId);
  });

  // 存档弹窗事件
  const closeArchiveModal = () => archiveModalEl.classList.add('hidden');
  $('btnCloseArchiveModal').addEventListener('click', closeArchiveModal);
  $('btnCancelArchive').addEventListener('click', closeArchiveModal);

  const submitArchive = async () => {
    if (!state.activeProjectId) return;
    try {
      const customTags = archiveCustomTagsInputEl.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const record = await api.createArchive(state.activeProjectId, {
        title: archiveTitleInputEl.value,
        note: archiveNoteInputEl.value,
        tags: state.modalSelectedTags,
        customTags
      });
      closeArchiveModal();
      state.selectedArchiveId = record.id;
      await refreshActiveProject();
      showToast(`存档成功：${record.title}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  $('btnConfirmArchive').addEventListener('click', () => void submitArchive());
  archiveTitleInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitArchive();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('#modalTagPicker .tag-choice').forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color as TagColor;
      if (state.modalSelectedTags.includes(color)) {
        state.modalSelectedTags = state.modalSelectedTags.filter((c) => c !== color);
        btn.classList.remove('selected');
      } else {
        state.modalSelectedTags.push(color);
        btn.classList.add('selected');
      }
    });
  });

  // 切换存档弹窗事件
  const closeSwitchModal = () => {
    switchModalEl.classList.add('hidden');
    state.pendingSwitchArchiveId = null;
  };
  $('btnCloseSwitchModal').addEventListener('click', closeSwitchModal);
  $('btnCancelSwitch').addEventListener('click', closeSwitchModal);
  $('btnConfirmSwitch').addEventListener('click', async () => {
    if (!state.activeProjectId || !state.pendingSwitchArchiveId) return;
    const modeRadio = document.querySelector<HTMLInputElement>('input[name="restoreMode"]:checked');
    const mode = modeRadio?.value || 'overwrite';
    const previousArchiveId = state.manifest?.currentArchiveId ?? null;
    try {
      if (mode === 'new-folder') {
        const res = await api.restoreToNewFolder(state.activeProjectId, state.pendingSwitchArchiveId);
        closeSwitchModal();
        showToast(`已恢复到全新独立文件夹（${res.exportedFiles} 个文件），正在打开...`, 'success');
        await api.openFolder(res.destinationDir);
      } else {
        const res = await api.switchArchive(state.activeProjectId, state.pendingSwitchArchiveId, {
          autoBackupIfDirty: chkAutoBackupEl.checked,
          force: !chkAutoBackupEl.checked
        });
        closeSwitchModal();
        state.selectedArchiveId = res.switchedTo.id;
        await refreshActiveProject();

        // 可撤销：恢复的是哪一步，就退回哪一步 —— 降低「点错回溯」的心理负担
        const undoId = res.switchedTo.id;
        const backupId = res.backupArchive?.id ?? previousArchiveId;
        showToast(
          res.backupArchive
            ? `已自动保护当前改动并覆盖恢复至：${res.switchedTo.title}`
            : `已覆盖恢复文件夹至：${res.switchedTo.title}`,
          'success',
          backupId && backupId !== undoId
            ? {
                label: '撤销',
                duration: 12000,
                onClick: async () => {
                  if (!state.activeProjectId) return;
                  try {
                    await api.switchArchive(state.activeProjectId, backupId, { autoBackupIfDirty: true });
                    state.selectedArchiveId = backupId;
                    await refreshActiveProject();
                    showToast('已撤销，文件夹回到切换前的状态', 'info');
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), 'error');
                  }
                }
              }
            : undefined
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  // 项目重命名与标签管理弹窗事件
  const closeProjectEdit = () => {
    projectEditModalEl.classList.add('hidden');
    editingProjectId = null;
  };
  $('btnCloseProjectEdit').addEventListener('click', closeProjectEdit);
  $('btnCancelProjectEdit').addEventListener('click', closeProjectEdit);
  $('btnSaveProjectEdit').addEventListener('click', async () => {
    if (!editingProjectId) return;
    const newName = inpEditProjectNameEl.value.trim();
    const syncDisk = chkSyncDiskRenameEl.checked;
    const tags = inpEditProjectTagsEl.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!newName) {
      showToast('名称不能为空', 'error');
      return;
    }
    try {
      await api.renameProject(editingProjectId, newName, syncDisk);
      await api.updateProjectTags(editingProjectId, tags);
      closeProjectEdit();
      await refreshAll();
      showToast(syncDisk ? `已同步重命名磁盘文件夹与标签：${newName}` : `已更新显示名与标签：${newName}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  // 项目结项导出弹窗事件
  const closeExportBundleModal = () => {
    $('exportBundleModal').classList.add('hidden');
    exportingBundleProjectId = null;
  };
  $('btnCloseExportBundle').addEventListener('click', closeExportBundleModal);
  $('btnCancelExportBundle').addEventListener('click', closeExportBundleModal);
  $('btnConfirmExportBundle').addEventListener('click', async () => {
    if (!exportingBundleProjectId) return;
    const pid = exportingBundleProjectId;
    const scopeRadio = document.querySelector<HTMLInputElement>('input[name="bundleHistoryScope"]:checked');
    const historyScope = (scopeRadio?.value || 'current-branch') as 'current-branch' | 'all' | 'compressed-only';
    const autoArchiveFinalIfDirty = $<HTMLInputElement>('chkBundleAutoArchive').checked;
    const softArchiveAfterExport = $<HTMLInputElement>('chkBundleSoftArchive').checked;

    const destParent = await api.pickExportFolder();
    if (!destParent) return;
    closeExportBundleModal();
    try {
      const res = await api.exportProjectBundle(pid, {
        destinationParentDir: destParent,
        historyScope,
        autoArchiveFinalIfDirty,
        softArchiveAfterExport
      });
      await refreshAll();
      showToast(
        `结项导出完成：最终版 ${res.finalFilesCount} 个文件，展开 ${res.exportedHistoryCount} 个历史版本，正在打开目录...`,
        'success'
      );
      await api.openFolder(res.bundleDir);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  // 父子项目嵌套双选弹窗事件
  const closeNestedModal = () => {
    $('nestedUpgradeModal').classList.add('hidden');
    pendingNestedFolder = null;
  };
  $('btnCloseNestedModal').addEventListener('click', closeNestedModal);
  $('btnCancelNested').addEventListener('click', closeNestedModal);
  $('btnConfirmNested').addEventListener('click', async () => {
    if (!pendingNestedFolder) return;
    const folder = pendingNestedFolder;
    const modeRadio = document.querySelector<HTMLInputElement>('input[name="nestedMode"]:checked');
    const mode = modeRadio?.value || 'exclude';
    closeNestedModal();
    try {
      if (mode === 'exclude') {
        const res = await api.addParentExcludingChildren(folder);
        await refreshAll();
        showToast(
          `已添加独立父项目「${res.project.name}」，并自动排除内部 ${res.excludedChildren.length} 个子项目`,
          'success'
        );
      } else {
        const upgraded = await api.upgradeToParentProject(folder);
        await refreshAll();
        showToast(
          `已升级合并为父级项目「${upgraded.project.name}」（原 ${upgraded.archivedChildren.length} 个子项目已软归档保留历史）`,
          'success'
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  // 通用输入弹窗
  $('btnCloseInputModal').addEventListener('click', () => resolveInputModal(false));
  $('btnCancelInputModal').addEventListener('click', () => resolveInputModal(false));
  $('btnOkInputModal').addEventListener('click', () => resolveInputModal(true));
  $('inputModalField').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      resolveInputModal(true);
    }
  });

  // 通用内联确认弹窗事件
  $('btnCloseConfirmModal').addEventListener('click', () => resolveConfirm(false));
  $('btnCancelConfirm').addEventListener('click', () => resolveConfirm(false));
  $('btnOkConfirm').addEventListener('click', () => resolveConfirm(true));

  // 全局 Esc 关闭弹窗
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('inputModal').classList.contains('hidden')) resolveInputModal(false);
      if (!confirmModalEl.classList.contains('hidden')) resolveConfirm(false);
      if (!archiveModalEl.classList.contains('hidden')) closeArchiveModal();
      if (!switchModalEl.classList.contains('hidden')) closeSwitchModal();
    }
  });

  api.onWorkspaceUpdated(() => void refreshActiveProject());
  api.onConfigChanged(() => void refreshAll());
  api.onToast((toast) => showToast(toast.message, toast.type));
  api.onUiAction(async (payload) => {
    if (!payload.projectId) return;
    const st = state.statuses.find((x) => x.projectId === payload.projectId);
    if (payload.action === 'open-file-milestones' && payload.relPath) {
      void openFileMilestonesModal(payload.projectId, payload.relPath);
    } else if (payload.action === 'toggle-hide-file' && payload.relPath) {
      if (payload.projectId && payload.projectId !== state.activeProjectId) {
        state.activeProjectId = payload.projectId;
        await api.setActiveProject(payload.projectId);
      }
      toggleHiddenPath(payload.relPath);
    } else if (payload.action === 'relocate-project') {
      const picked = await api.pickFolder();
      if (!picked) return;
      try {
        const updated = await api.relocateProject(payload.projectId, picked);
        await refreshAll();
        showToast(`已关联到真实路径「${updated.rootPath}」，历史记录完好无损`, 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
      }
    } else if (payload.action === 'open-export-bundle') {
      openExportBundleModal(payload.projectId);
    } else if (payload.action === 'open-edit-project' && st) {
      editingProjectId = st.projectId;
      inpEditProjectNameEl.value = st.name;
      chkSyncDiskRenameEl.checked = false;
      inpEditProjectTagsEl.value = (st.customTags || []).join(', ');
      projectEditModalEl.classList.remove('hidden');
      inpEditProjectNameEl.focus();
    } else if (payload.action === 'archive-project' && st) {
      const ok = await showConfirm(
        '安全归档项目（暂停跟踪）',
        `将「${st.name}」移入已归档区？归档后不再后台跟踪，但所有本地文件和历史存档 100% 安全保留，随时可一键恢复跟踪。`
      );
      if (!ok) return;
      await api.archiveProject(st.projectId);
      await refreshAll();
      showToast(`已安全归档项目：${st.name}（文件与历史完好保留）`, 'info');
    }
  });
}

async function bootstrap(): Promise<void> {
  graphRenderer = new DagGraphRenderer(
    document.getElementById('graphSvg') as unknown as SVGSVGElement,
    $('graphCanvasWrap'),
    $('zoomLabel'),
    {
      onSelectNode: (archiveId) => {
        state.selectedArchiveId = archiveId;
        void renderGraphView();
        const st = state.statuses.find((s) => s.projectId === state.activeProjectId);
        if (st) renderInspector(st);
      },
      onDoubleClickNode: (archiveId) => {
        const st = state.statuses.find((s) => s.projectId === state.activeProjectId);
        openSwitchModal(archiveId, Boolean(st?.hasChanges));
      }
    }
  );

  bindEvents();

  // 恢复上次停留的视图（矩阵是默认首页）
  let initialView: AppState['activeView'] = 'matrix';
  try {
    const saved = localStorage.getItem('chronobox_active_view');
    if (saved && (VIEW_ORDER as string[]).includes(saved)) initialView = saved as AppState['activeView'];
  } catch {
    /* ignore */
  }
  state.activeView = initialView;
  if (initialView !== 'matrix') {
    document.querySelectorAll<HTMLButtonElement>('.view-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === initialView);
    });
    const panelMap: Record<string, string> = {
      timeline: 'viewTimeline',
      graph: 'viewGraph',
      matrix: 'viewMatrix',
      browser: 'viewBrowser',
      diff: 'viewDiff',
      archivebox: 'viewArchiveBox',
      settings: 'viewSettings'
    };
    document.querySelectorAll<HTMLElement>('.view-panel').forEach((panel) => panel.classList.remove('active'));
    document.getElementById(panelMap[initialView])?.classList.add('active');
    filterBarEl.classList.toggle('hidden', ['diff', 'settings', 'archivebox', 'matrix'].includes(initialView));
  }

  renderStatusBar();
  await refreshAll();
  syncInspectorForView(state.activeView);
}

void bootstrap();
