import * as path from 'path';
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, screen, shell } from 'electron';
import { WorkspaceManager } from '../core/workspaceManager';
import { WorkspaceWatcher } from '../core/watcher';
import { ActiveContextStatus, DetectedWindowContext, resolveActiveContextStatus, WindowsActiveContextMonitor } from '../core/activeContext';
import { AppConfig, WindowMode } from '../core/types';
import { registerIpcHandlers } from './ipcHandlers';
import { createAppTray } from './tray';

let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let workspaceManager: WorkspaceManager;
let workspaceWatcher: WorkspaceWatcher;
let isQuitting = false;
let activeContextMonitor: WindowsActiveContextMonitor;
let lastDetectedWindow: DetectedWindowContext | null = null;

// 预留充足透明边距供柔和阴影自然衰减至 0% 透明度，彻底杜绝 Windows 透明窗矩形切边与黑框
const MINI_BAR_SIZE = { width: 382, height: 76 };
const MINI_DOT_SIZE = { width: 96, height: 96 };

function getIconPath(): string {
  return path.join(__dirname, '..', '..', 'assets', 'icon.png');
}

export function getActiveContextStatus(): ActiveContextStatus {
  return resolveActiveContextStatus(lastDetectedWindow, workspaceManager);
}

export function broadcastToWindows(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send(channel, payload);
  }
}

export function applyLoginItemSetting(openAtLogin: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(openAtLogin),
      path: process.execPath
    });
  } catch {
    // 非打包开发态或系统权限限制时静默忽略
  }
}

function getSafeMiniPosition(width: number, height: number): { x: number; y: number } {
  const saved = workspaceManager.getConfig().miniPosition;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh, x: sx, y: sy } = primaryDisplay.workArea;

  if (saved) {
    const clampedX = Math.max(sx, Math.min(saved.x, sx + sw - width));
    const clampedY = Math.max(sy, Math.min(saved.y, sy + sh - height));
    return { x: clampedX, y: clampedY };
  }

  return {
    x: sx + sw - width - 24,
    y: sy + sh - height - 24
  };
}

function createMainWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1440, Math.max(1080, workArea.width - 48)),
    height: Math.min(840, Math.max(660, workArea.height - 48)),
    minWidth: 1080,
    minHeight: 640,
    title: '时匣 ChronoBox 5.1.1 — 本地文件历史与视觉快照',
    icon: nativeImage.createFromPath(getIconPath()),
    backgroundColor: '#F2F5FA',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('close', (event) => {
    if (isQuitting) return;
    const behavior = workspaceManager.getConfig().closeBehavior;
    if (behavior === 'quit') {
      isQuitting = true;
      app.quit();
    } else {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function createMiniWindow(style: 'mini-bar' | 'mini-dot'): BrowserWindow {
  const size = style === 'mini-bar' ? MINI_BAR_SIZE : MINI_DOT_SIZE;
  const pos = getSafeMiniPosition(size.width, size.height);

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'mini.html'), {
    query: { mode: style }
  });

  win.on('moved', () => {
    if (!win.isDestroyed()) {
      const [x, y] = win.getPosition();
      workspaceManager.setMiniPosition(x, y);
    }
  });

  win.on('closed', () => {
    miniWindow = null;
  });

  return win;
}

/**
 * 独立显示/聚焦主窗口（不影响悬浮球或 Mini 条的显示状态）
 */
export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 切换主窗口显示 / 隐藏到后台运行（悬浮窗保持不受影响）
 */
export function toggleMainWindow(): boolean {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    return false;
  }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  showMainWindow();
  return true;
}

/**
 * 根据当前配置同步悬浮窗（悬浮球 / Mini 条）显示状态，完全独立于主窗口
 */
function syncFloatingWindow(): void {
  const cfg = workspaceManager.getConfig();
  if (!cfg.floatingEnabled) {
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.hide();
    }
    if (activeContextMonitor) activeContextMonitor.stop();
    return;
  }

  const style: 'mini-dot' | 'mini-bar' = cfg.floatingStyle === 'mini-bar' ? 'mini-bar' : 'mini-dot';
  const size = style === 'mini-bar' ? MINI_BAR_SIZE : MINI_DOT_SIZE;

  if (!miniWindow || miniWindow.isDestroyed()) {
    miniWindow = createMiniWindow(style);
  } else {
    const [curX, curY] = miniWindow.getPosition();
    const [curW] = miniWindow.getSize();
    const nextX = Math.max(0, curX + (curW - size.width));
    miniWindow.setBounds({ x: nextX, y: curY, width: size.width, height: size.height });
    miniWindow.setAlwaysOnTop(true, 'floating');
    miniWindow.showInactive();
  }

  if (activeContextMonitor) activeContextMonitor.start();
  broadcastToWindows('window:mode-changed', style);
}

export function setFloatingEnabled(enabled: boolean): AppConfig {
  const cfg = workspaceManager.setFloatingEnabled(enabled);
  syncFloatingWindow();
  broadcastToWindows('app:config-changed', cfg);
  return cfg;
}

export function setFloatingStyle(style: 'mini-dot' | 'mini-bar'): AppConfig {
  workspaceManager.setFloatingEnabled(true);
  const cfg = workspaceManager.setFloatingStyle(style);
  syncFloatingWindow();
  broadcastToWindows('app:config-changed', cfg);
  return cfg;
}

/**
 * 兼容旧版窗口模式调用：不再互斥隐藏另一方窗口
 */
export function setWindowMode(mode: WindowMode): void {
  workspaceManager.setWindowMode(mode);
  if (mode === 'full') {
    showMainWindow();
  } else {
    setFloatingStyle(mode);
  }
}

export function quickArchiveActiveProject(): { ok: boolean; message: string } {
  const activeId = workspaceManager.getConfig().activeProjectId;
  if (!activeId) {
    return { ok: false, message: '未选择项目' };
  }
  try {
    const repo = workspaceManager.getRepository(activeId);
    const working = repo.getWorkingChanges();
    if (working.changes.length === 0) {
      broadcastToWindows('app:toast', { type: 'info', message: '当前项目没有新的文件变更' });
      return { ok: false, message: '无新变更' };
    }
    const record = repo.createArchive({});
    broadcastToWindows('workspace:updated', { projectId: activeId });
    broadcastToWindows('context:active-changed', getActiveContextStatus());
    broadcastToWindows('app:toast', { type: 'success', message: `已一键存档：${record.title}` });
    return { ok: true, message: '已存档' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcastToWindows('app:toast', { type: 'error', message: msg });
    return { ok: false, message: msg };
  }
}

export function showMiniContextMenu(): void {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  const cfg = workspaceManager.getConfig();
  const ctx = getActiveContextStatus();
  const targetProjectId = ctx.matchedProjectId || cfg.activeProjectId;

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (ctx.state === 'untracked' && ctx.folderPath) {
    const folderShort = path.basename(ctx.folderPath) || ctx.folderPath;
    const nestedChildren = workspaceManager.findNestedChildProjects(ctx.folderPath);
    if (nestedChildren.length > 0) {
      template.push(
        {
          label: `+ 添加父项目「${folderShort}」（独立排除内部 ${nestedChildren.length} 个子项目，推荐）`,
          click: () => {
            try {
              const res = workspaceManager.addParentExcludingChildren(ctx.folderPath!);
              workspaceWatcher.syncAll();
              broadcastToWindows('workspace:updated', { projectId: res.project.id });
              broadcastToWindows('app:config-changed', workspaceManager.getConfig());
              broadcastToWindows('context:active-changed', getActiveContextStatus());
              broadcastToWindows('app:toast', {
                type: 'success',
                message: `已添加独立父项目「${res.project.name}」，并自动排除内部 ${res.excludedChildren.length} 个子项目`
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              broadcastToWindows('app:toast', { type: 'error', message: msg });
            }
          }
        },
        {
          label: `⬆ 升级合并为父级项目「${folderShort}」（包含子文件夹并归档子项目）`,
          click: () => {
            try {
              const res = workspaceManager.upgradeToParentProject(ctx.folderPath!);
              workspaceWatcher.syncAll();
              broadcastToWindows('workspace:updated', { projectId: res.project.id });
              broadcastToWindows('app:config-changed', workspaceManager.getConfig());
              broadcastToWindows('context:active-changed', getActiveContextStatus());
              broadcastToWindows('app:toast', {
                type: 'success',
                message: `已升级合并为父级项目「${res.project.name}」（原 ${res.archivedChildren.length} 个子项目已软归档保留历史）`
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              broadcastToWindows('app:toast', { type: 'error', message: msg });
            }
          }
        }
      );
    } else {
      template.push({
        label: `+ 将当前文件夹「${folderShort}」添加为项目`,
        click: () => {
          try {
            const proj = workspaceManager.addProject(ctx.folderPath!, undefined, true);
            workspaceWatcher.syncAll();
            broadcastToWindows('workspace:updated', { projectId: proj.id });
            broadcastToWindows('app:config-changed', workspaceManager.getConfig());
            broadcastToWindows('context:active-changed', getActiveContextStatus());
            broadcastToWindows('app:toast', { type: 'success', message: `已添加项目：${proj.name}` });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            broadcastToWindows('app:toast', { type: 'error', message: msg });
          }
        }
      });
    }
    template.push({ type: 'separator' });
  }

  template.push(
    {
      label: targetProjectId ? '✦ 一键快速存档当前项目' : '✦ 一键快速存档（请先添加项目）',
      enabled: Boolean(targetProjectId),
      click: () => {
        if (!targetProjectId) return;
        try {
          const repo = workspaceManager.getRepository(targetProjectId);
          const working = repo.getWorkingChanges();
          if (working.changes.length === 0) {
            broadcastToWindows('app:toast', { type: 'info', message: '当前项目没有新的文件变更' });
            return;
          }
          const rec = repo.createArchive({});
          broadcastToWindows('workspace:updated', { projectId: targetProjectId });
          broadcastToWindows('context:active-changed', getActiveContextStatus());
          broadcastToWindows('app:toast', { type: 'success', message: `已一键存档：${rec.title}` });
        } catch (err) {
          broadcastToWindows('app:toast', { type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    { type: 'separator' },
    { label: '⤢ 打开主窗口（保留悬浮窗）', click: () => showMainWindow() },
    {
      label: cfg.floatingStyle === 'mini-dot' ? '▭ 展开为 Mini 悬浮条' : '● 切换为悬浮归档球',
      click: () => setFloatingStyle(cfg.floatingStyle === 'mini-dot' ? 'mini-bar' : 'mini-dot')
    },
    {
      label: '✕ 隐藏悬浮窗',
      click: () => setFloatingEnabled(false)
    },
    {
      label: `📂 打开 ${cfg.archiveBox.folderName} 文件夹`,
      enabled: Boolean(targetProjectId),
      click: () => {
        if (!targetProjectId) return;
        const root = workspaceManager.getArchiveBoxRoot(targetProjectId);
        if (root) void shell.openPath(root);
      }
    },
    { type: 'separator' },
    {
      label: '退出时匣 ChronoBox',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  );

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: miniWindow });
}

export function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const { shortcuts } = workspaceManager.getConfig();
  try {
    globalShortcut.register(shortcuts.quickArchive, () => {
      quickArchiveActiveProject();
    });
  } catch { /* ignore */ }

  try {
    globalShortcut.register(shortcuts.toggleMini, () => {
      const cfg = workspaceManager.getConfig();
      setFloatingEnabled(!cfg.floatingEnabled);
    });
  } catch { /* ignore */ }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    const userDataDir = path.join(app.getPath('userData'), 'chronobox');
    workspaceManager = new WorkspaceManager(userDataDir);
    workspaceWatcher = new WorkspaceWatcher(workspaceManager);
    activeContextMonitor = new WindowsActiveContextMonitor();
    activeContextMonitor.on('detected', (detected: DetectedWindowContext) => {
      lastDetectedWindow = detected;
      broadcastToWindows('context:active-changed', getActiveContextStatus());
    });

    applyLoginItemSetting(workspaceManager.getConfig().launchAtLogin);

    workspaceWatcher.on('change', (projectId: string) => {
      broadcastToWindows('workspace:updated', { projectId });
      broadcastToWindows('context:active-changed', getActiveContextStatus());
    });

    workspaceWatcher.on('auto-archived', (payload: { projectId: string; archive: { title: string } }) => {
      broadcastToWindows('workspace:updated', { projectId: payload.projectId });
      broadcastToWindows('context:active-changed', getActiveContextStatus());
      broadcastToWindows('app:toast', {
        type: 'info',
        message: `自动存档完成：${payload.archive.title}`
      });
    });

    registerIpcHandlers({
      manager: workspaceManager,
      watcher: workspaceWatcher,
      getMainWindow: () => mainWindow,
      getMiniWindow: () => miniWindow,
      setWindowMode,
      setFloatingEnabled,
      setFloatingStyle,
      showMainWindow,
      toggleMainWindow,
      broadcast: broadcastToWindows,
      applyLoginItemSetting,
      showMiniContextMenu,
      reregisterShortcuts: registerShortcuts,
      getActiveContextStatus
    });

    mainWindow = createMainWindow();
    if (workspaceManager.getConfig().floatingEnabled) {
      syncFloatingWindow();
    }

    createAppTray({
      iconPath: getIconPath(),
      onOpenFull: () => showMainWindow(),
      onToggleFloating: () => setFloatingEnabled(!workspaceManager.getConfig().floatingEnabled),
      onOpenMiniBar: () => setFloatingStyle('mini-bar'),
      onOpenMiniDot: () => setFloatingStyle('mini-dot'),
      onQuickArchive: () => quickArchiveActiveProject(),
      onQuit: () => {
        isQuitting = true;
        app.quit();
      }
    });

    workspaceWatcher.syncAll();
    registerShortcuts();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    if (workspaceWatcher) workspaceWatcher.dispose();
    if (activeContextMonitor) activeContextMonitor.stop();
  });

  app.on('window-all-closed', () => {
    if (isQuitting) {
      app.quit();
    }
  });
}
