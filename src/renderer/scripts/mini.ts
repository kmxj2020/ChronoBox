import { ActiveContextStatus, WindowMode } from './types.js';

const api = window.chronoboxApi;

const miniBarEl = document.getElementById('miniBar') as HTMLDivElement;
const miniDotEl = document.getElementById('miniDot') as HTMLDivElement;
const miniBarDragEl = document.getElementById('miniBarDrag') as HTMLDivElement;
const miniStatusDotEl = document.getElementById('miniStatusDot') as HTMLDivElement;
const miniProjectNameEl = document.getElementById('miniProjectName') as HTMLDivElement;
const miniStatusTextEl = document.getElementById('miniStatusText') as HTMLDivElement;
const miniDotOrbEl = document.getElementById('miniDotOrb') as HTMLDivElement;
const miniDotCountEl = document.getElementById('miniDotCount') as HTMLSpanElement;
const btnQuickArchive = document.getElementById('btnMiniQuickArchive') as HTMLButtonElement;
const btnToDot = document.getElementById('btnToDot') as HTMLButtonElement;
const btnToFull = document.getElementById('btnToFull') as HTMLButtonElement;

let activeContext: ActiveContextStatus | null = null;
let currentMode: WindowMode = 'mini-dot';
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
let singleClickTimer: ReturnType<typeof setTimeout> | null = null;
let archiveFolderName = '00【Archive】';
let dockSide: 'left' | 'right' | 'none' = 'none';
function applyDockClass(): void {
  miniDotOrbEl.classList.toggle('dock-left', dockSide === 'left');
  miniDotOrbEl.classList.toggle('dock-right', dockSide === 'right');
}

function applyMode(mode: WindowMode): void {
  currentMode = mode;
  if (mode === 'mini-dot') {
    miniBarEl.classList.add('hidden');
    miniDotEl.classList.remove('hidden');
  } else {
    miniDotEl.classList.add('hidden');
    miniBarEl.classList.remove('hidden');
  }
}

function renderContextState(ctx: ActiveContextStatus): void {
  activeContext = ctx;
  miniProjectNameEl.textContent = ctx.displayName;

  if (ctx.state === 'untracked') {
    // 紫色：当前打开的文件夹或 Word/Excel/PPT 所在目录尚未添加为项目
    miniStatusDotEl.className = 'pulse-dot untracked';
    miniDotOrbEl.className = 'mini-dot-orb untracked';
    miniDotCountEl.textContent = '未跟踪';
    miniStatusTextEl.textContent = '未添加为项目 · 右击悬浮球添加（防误触）';
    btnQuickArchive.textContent = '加项目';
    btnQuickArchive.title = '将当前打开的文件夹添加为项目';
  } else if (ctx.state === 'dirty') {
    // 橙色：已添加项目，有未存档改动或尚未创建首个存档
    miniStatusDotEl.className = 'pulse-dot dirty';
    miniDotOrbEl.className = 'mini-dot-orb dirty';
    miniDotCountEl.textContent =
      ctx.archiveCount === 0
        ? '待存'
        : ctx.changeCount > 99
          ? '99+'
          : String(ctx.changeCount);
    miniStatusTextEl.textContent =
      ctx.archiveCount === 0
        ? '尚未创建首个存档 · 双击悬浮球存档'
        : `${ctx.changeCount} 项未存档 · 双击悬浮球一键存档`;
    btnQuickArchive.textContent = '存档';
    btnQuickArchive.title = '一键存档当前项目';
  } else if (ctx.state === 'synced') {
    // 绿色：已添加项目且已存档同步
    miniStatusDotEl.className = 'pulse-dot synced';
    miniDotOrbEl.className = 'mini-dot-orb synced';
    miniDotCountEl.textContent = '✓';
    miniStatusTextEl.textContent = `已存档同步 · 拖入文件归档至 ${archiveFolderName}`;
    btnQuickArchive.textContent = '存档';
    btnQuickArchive.title = '当前已同步';
  } else {
    miniStatusDotEl.className = 'pulse-dot untracked';
    miniDotOrbEl.className = 'mini-dot-orb untracked';
    miniDotCountEl.textContent = '时匣';
    miniStatusTextEl.textContent = '打开任意文件夹或右击添加项目';
    btnQuickArchive.textContent = '主窗';
    btnQuickArchive.title = '打开主窗口';
  }

  // 悬浮提示：简洁展示项目名、当前状态与活动文档（最多 3 行，绝不遮挡视野）
  const lines: string[] = [];
  if (ctx.state === 'untracked') {
    lines.push(`未添加：${ctx.displayName.replace(/（未加）$/, '')}`);
    lines.push('状态：未在项目列表');
  } else if (ctx.state === 'dirty') {
    lines.push(`项目：${ctx.displayName}`);
    lines.push(ctx.archiveCount === 0 ? '状态：待创建首个存档' : `状态：${ctx.changeCount} 项未存档 · 共 ${ctx.archiveCount} 存档`);
  } else if (ctx.state === 'synced') {
    lines.push(`项目：${ctx.displayName}`);
    lines.push(`状态：已存档同步 · 共 ${ctx.archiveCount} 存档`);
  } else {
    lines.push('时匣 ChronoBox');
    lines.push('状态：等待打开文件夹或文档');
  }
  if (ctx.filePath) {
    const fn = ctx.filePath.split(/[\\/]/).pop() || ctx.filePath;
    lines.push(`文档：${fn.length > 26 ? fn.slice(0, 25) + '…' : fn}`);
  } else if (ctx.folderPath) {
    const shortPath = ctx.folderPath.length > 28 ? '…' + ctx.folderPath.slice(-27) : ctx.folderPath;
    lines.push(`目录：${shortPath}`);
  }
  const tip = lines.slice(0, 3).join('\n');
  applyDockClass();
  miniDotOrbEl.title = tip;
  miniBarEl.title = tip;
}

async function refreshMiniState(): Promise<void> {
  const config = await api.getConfig();
  archiveFolderName = config.archiveBox?.folderName || '00【Archive】';
  const effectiveTheme =
    config.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : config.theme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);

  const ctx = await api.getActiveContextStatus();
  renderContextState(ctx);
}

function showOrbFeedback(text: string): void {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  miniDotOrbEl.classList.remove('drag-over');
  miniDotOrbEl.classList.add('drop-ok');
  miniDotCountEl.textContent = text;
  miniStatusTextEl.textContent = text;

  feedbackTimer = setTimeout(() => {
    miniDotOrbEl.classList.remove('drop-ok');
    void refreshMiniState();
  }, 1900);
}

/**
 * 悬浮球双击 / Mini条按钮主操作：
 * - allowAddUntracked = false（悬浮球双击）：若当前为紫色未跟踪目录，严禁双击自动添加，仅提示「右击添加」防止误触！
 * - allowAddUntracked = true（Mini条显式点击「加项目」按钮）：主动将当前文件夹添加为项目。
 */
async function triggerPrimaryAction(allowAddUntracked: boolean): Promise<void> {
  if (!activeContext) {
    await refreshMiniState();
    return;
  }
  if (activeContext.state === 'untracked' && activeContext.folderPath) {
    if (!allowAddUntracked) {
      showOrbFeedback('右击添加');
      return;
    }
    try {
      const children = await api.findNestedChildProjects(activeContext.folderPath);
      if (children.length > 0) {
        await api.upgradeToParentProject(activeContext.folderPath);
        showOrbFeedback('✓ 已升级');
      } else {
        await api.addProject(activeContext.folderPath);
        showOrbFeedback('✓ 已添加');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '添加失败';
      showOrbFeedback(msg.slice(0, 6));
    }
    return;
  }
  if (!activeContext.matchedProjectId) {
    if (allowAddUntracked) {
      void api.toggleMainWindow();
    } else {
      showOrbFeedback('右击操作');
    }
    return;
  }
  try {
    await api.createArchive(activeContext.matchedProjectId, {});
    showOrbFeedback('✓ 已存档');
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    showOrbFeedback(msg.includes('没有检测到') ? '无新变更' : '存档失败');
  }
}

let dragLeaveTimer: ReturnType<typeof setTimeout> | null = null;
let isDragHovering = false;
let lastDragCopy = false;

function bindUnifiedFileDropTarget(): void {
  const applyHover = (on: boolean, isCopy: boolean) => {
    if (isDragHovering === on && (!on || lastDragCopy === isCopy)) return;
    isDragHovering = on;
    lastDragCopy = isCopy;
    if (currentMode === 'mini-dot') {
      miniDotOrbEl.classList.toggle('drag-over', on);
      if (on) {
        miniDotCountEl.textContent = isCopy ? '松手\n复制' : '松手\n归档';
      } else if (!miniDotOrbEl.classList.contains('drop-ok') && activeContext) {
        renderContextState(activeContext);
      }
    } else {
      miniBarEl.classList.toggle('drag-over', on);
      if (on) {
        miniStatusTextEl.textContent = isCopy
          ? `松手复制副本至 ${archiveFolderName}/今天日期`
          : `松手移动归档至 ${archiveFolderName}/今天日期`;
      } else if (activeContext) {
        renderContextState(activeContext);
      }
    }
  };

  const clearLeaveTimer = () => {
    if (dragLeaveTimer) {
      clearTimeout(dragLeaveTimer);
      dragLeaveTimer = null;
    }
  };

  // 绑定在整个透明窗体 (document.body) 上并加入 140ms 防抖离场，彻底消除边缘拖拽闪烁
  document.body.addEventListener('dragenter', (e) => {
    e.preventDefault();
    clearLeaveTimer();
    applyHover(true, e.ctrlKey);
  });

  document.body.addEventListener('dragover', (e) => {
    e.preventDefault();
    clearLeaveTimer();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    }
    applyHover(true, e.ctrlKey);
  });

  document.body.addEventListener('dragleave', (e) => {
    e.preventDefault();
    clearLeaveTimer();
    dragLeaveTimer = setTimeout(() => {
      dragLeaveTimer = null;
      applyHover(false, false);
    }, 140);
  });

  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearLeaveTimer();
    applyHover(false, false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const p = api.getPathForFile(files[i]);
      if (p) paths.push(p);
    }
    if (paths.length === 0) return;

    const action = e.ctrlKey ? 'copy' : undefined;
    try {
      const res = await api.archiveBoxDropPaths(paths, action);
      if (res.succeeded.length > 0) {
        showOrbFeedback(`已归档 ${res.succeeded.length}`);
      } else if (res.skipped.length > 0) {
        showOrbFeedback('已跳过');
      }
    } catch {
      showOrbFeedback('归档失败');
    }
  });
}

function attachDrag(handle: HTMLElement, onClickWithoutDrag?: (withCtrl: boolean) => void): void {
  let dragging = false;
  let moved = false;
  let ctrlAtDown = false;
  let lastX = 0;
  let lastY = 0;

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    ctrlAtDown = e.ctrlKey;
    lastX = e.screenX;
    lastY = e.screenY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      moved = true;
      lastX = e.screenX;
      lastY = e.screenY;
      api.dragMiniWindow(dx, dy);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (moved && currentMode === 'mini-dot') {
      void api.snapMiniToEdge().then((side) => {
        dockSide = side;
        applyDockClass();
      });
    } else if (!moved && onClickWithoutDrag) {
      onClickWithoutDrag(ctrlAtDown || e.ctrlKey);
    }
  });
}

async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const modeParam = params.get('mode') as WindowMode | null;
  applyMode(modeParam === 'mini-bar' ? 'mini-bar' : 'mini-dot');

  bindUnifiedFileDropTarget();

  attachDrag(miniBarDragEl, (withCtrl) => { if (withCtrl) void api.toggleMainWindow(); });

  // 悬浮球交互：
  // - 按住 Ctrl + 左键单击：直接打开主窗口
  // - 普通单击：不切换为 Mini 条（悬浮球与 Mini 条仅在主界面或右键菜单切换）
  // - 普通双击：仅对已添加项目一键快速存档（未添加紫色状态严禁双击自动添加）
  attachDrag(miniDotEl, (withCtrl) => {
    if (currentMode !== 'mini-dot') return;
    if (withCtrl) {
      if (singleClickTimer) {
        clearTimeout(singleClickTimer);
        singleClickTimer = null;
      }
      void api.toggleMainWindow();
      return;
    }
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
      void triggerPrimaryAction(false);
    } else {
      singleClickTimer = setTimeout(() => {
        singleClickTimer = null;
      }, 280);
    }
  });

  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    api.showMiniContextMenu();
  };
  miniDotEl.addEventListener('contextmenu', onContext);
  miniBarEl.addEventListener('contextmenu', onContext);

  btnToDot.addEventListener('click', () => void api.setFloatingStyle('mini-dot'));
  btnToFull.addEventListener('click', () => void api.showMainWindow());
  btnQuickArchive.addEventListener('click', () => void triggerPrimaryAction(true));

  api.onWorkspaceUpdated(() => void refreshMiniState());
  api.onConfigChanged(() => void refreshMiniState());
  api.onActiveContextChanged((ctx) => renderContextState(ctx));
  api.onWindowModeChanged((mode) => {
    if (mode === 'mini-bar' || mode === 'mini-dot') {
      applyMode(mode);
    }
  });

  await refreshMiniState();
  if (currentMode === 'mini-dot') {
    dockSide = await api.snapMiniToEdge();
    applyDockClass();
  }
}

void init();
