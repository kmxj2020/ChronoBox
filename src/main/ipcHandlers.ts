import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, dialog, ipcMain, Menu, OpenDialogOptions, screen, shell } from 'electron';
import { WorkspaceManager } from '../core/workspaceManager';
import { WorkspaceWatcher } from '../core/watcher';
import {
  AppConfig,
  ArchiveBoxConfig,
  BrowserEntry,
  BrowserListResult,
  LanguageCode,
  TagColor,
  ThemeMode,
  WindowMode
} from '../core/types';
import { CreateArchiveOptions, SwitchArchiveOptions } from '../core/repository';
import { ActiveContextStatus } from '../core/activeContext';
import { findDuplicateFiles, generateProgressReport, getFileMilestoneTimeline, globalSearchWorkspace } from '../core/analyticsEngine';
import { BundleHistoryScope, exportProjectBundle, importProjectBundle } from '../core/projectBundle';
import { detectBeyondComparePath, launchBeyondCompare, prepareCompareFilePair, prepareCompareFolderPair } from '../core/beyondCompare';

export interface IpcContext {
  manager: WorkspaceManager;
  watcher: WorkspaceWatcher;
  getMainWindow: () => BrowserWindow | null;
  getMiniWindow: () => BrowserWindow | null;
  setWindowMode: (mode: WindowMode) => void;
  setFloatingEnabled: (enabled: boolean) => AppConfig;
  setFloatingStyle: (style: 'mini-dot' | 'mini-bar') => AppConfig;
  showMainWindow: () => void;
  toggleMainWindow: () => boolean;
  broadcast: (channel: string, payload?: unknown) => void;
  applyLoginItemSetting: (openAtLogin: boolean) => void;
  showMiniContextMenu: () => void;
  reregisterShortcuts: () => void;
  getActiveContextStatus: () => ActiveContextStatus;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const {
    manager,
    watcher,
    getMainWindow,
    getMiniWindow,
    setWindowMode,
    setFloatingEnabled,
    setFloatingStyle,
    showMainWindow,
    toggleMainWindow,
    broadcast,
    applyLoginItemSetting,
    showMiniContextMenu,
    reregisterShortcuts,
    getActiveContextStatus
  } = ctx;

  // === 应用配置与窗口模式 ===
  ipcMain.handle('app:get-config', () => manager.getConfig());

  ipcMain.handle('app:set-language', (_e, lang: LanguageCode) => {
    const cfg = manager.setLanguage(lang);
    broadcast('app:config-changed', cfg);
    return cfg;
  });

  ipcMain.handle('app:set-theme', (_e, theme: ThemeMode) => {
    const cfg = manager.setTheme(theme);
    broadcast('app:config-changed', cfg);
    return cfg;
  });

  ipcMain.handle('window:set-mode', (_e, mode: WindowMode) => {
    setWindowMode(mode);
    return mode;
  });

  ipcMain.handle('window:show-main', () => {
    showMainWindow();
  });

  ipcMain.handle('window:toggle-main', () => {
    return toggleMainWindow();
  });

  ipcMain.handle('floating:set-enabled', (_e, enabled: boolean) => {
    return setFloatingEnabled(enabled);
  });

  ipcMain.handle('floating:set-style', (_e, style: 'mini-dot' | 'mini-bar') => {
    return setFloatingStyle(style);
  });

  ipcMain.on('window:mini-drag', (_e, delta: { dx: number; dy: number }) => {
    const mini = getMiniWindow();
    if (!mini || mini.isDestroyed()) return;
    const [x, y] = mini.getPosition();
    const nx = Math.round(x + delta.dx);
    const ny = Math.round(y + delta.dy);
    mini.setPosition(nx, ny);
    manager.setMiniPosition(nx, ny);
  });

  ipcMain.handle('window:mini-snap-edge', () => {
    const mini = getMiniWindow();
    if (!mini || mini.isDestroyed()) return 'none';
    if (manager.getConfig().floatingStyle !== 'mini-dot') return 'none';
    const [x, y] = mini.getPosition();
    const [w, h] = mini.getSize();
    const display = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) });
    const wa = display.workArea;
    const clampedY = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    const SNAP_THRESHOLD = 36;

    if (x - wa.x <= SNAP_THRESHOLD) {
      const snapX = wa.x - 16;
      mini.setPosition(snapX, clampedY);
      manager.setMiniPosition(snapX, clampedY);
      return 'left';
    }
    if (wa.x + wa.width - (x + w) <= SNAP_THRESHOLD) {
      const snapX = wa.x + wa.width - w + 16;
      mini.setPosition(snapX, clampedY);
      manager.setMiniPosition(snapX, clampedY);
      return 'right';
    }
    return 'none';
  });

  // === 系统对话框与资源管理器 ===
  ipcMain.handle('dialog:pick-folder', async () => {
    const win = getMainWindow();
    const opts: OpenDialogOptions = {
      title: '选择要添加为项目的文件夹',
      properties: ['openDirectory']
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-bundle', async () => {
    const win = getMainWindow();
    const opts: OpenDialogOptions = {
      title: '选择结项恢复凭证（重新加载项目.chronobox.json）',
      properties: ['openFile'],
      filters: [{ name: '时匣结项恢复凭证', extensions: ['json'] }]
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-export-folder', async () => {
    const win = getMainWindow();
    const opts: OpenDialogOptions = {
      title: '选择恢复或导出目标文件夹',
      properties: ['openDirectory', 'createDirectory']
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('fs:stat-path', (_e, targetPath: string) => {
    try {
      const resolved = path.resolve(targetPath);
      if (!fs.existsSync(resolved)) return { exists: false, isDirectory: false, resolved, name: path.basename(resolved), parentDir: path.dirname(resolved) };
      const st = fs.statSync(resolved);
      return {
        exists: true,
        isDirectory: st.isDirectory(),
        resolved,
        name: path.basename(resolved) || resolved,
        parentDir: path.dirname(resolved)
      };
    } catch {
      return { exists: false, isDirectory: false, resolved: targetPath, name: '', parentDir: '' };
    }
  });

  ipcMain.handle('shell:open-folder', async (_e, folderPath: string) => {
    if (!folderPath) return;
    await shell.openPath(folderPath);
  });

  ipcMain.handle('shell:show-file', (_e, projectId: string, relPath: string) => {
    const project = manager.getProject(projectId);
    if (!project) return;
    const fullPath = path.join(project.rootPath, ...relPath.split('/'));
    if (fs.existsSync(fullPath)) {
      shell.showItemInFolder(fullPath);
    } else {
      void shell.openPath(path.dirname(fullPath));
    }
  });

  ipcMain.handle('shell:open-file', async (_e, projectId: string, relPath: string) => {
    const project = manager.getProject(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const fullPath = path.join(project.rootPath, ...relPath.split('/'));
    if (!fs.existsSync(fullPath)) {
      return { ok: false, error: '当前工作区中找不到该文件（可能已被归档或删除）' };
    }
    const err = await shell.openPath(fullPath);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.on('matrix:show-file-menu', (_e, payload: { projectId: string; relPath: string; isPinned: boolean; currentState: string; isHidden?: boolean }) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const project = manager.getProject(payload.projectId);
    if (!project) return;
    const fullPath = path.join(project.rootPath, ...payload.relPath.split('/'));
    const exists = fs.existsSync(fullPath);
    const menu = Menu.buildFromTemplate([
      {
        label: '📜 查看单文件里程碑与历史对比...',
        click: () => win.webContents.send('ui:action', { action: 'open-file-milestones', projectId: payload.projectId, relPath: payload.relPath })
      },
      { type: 'separator' },
      {
        label: exists ? '📄 直接打开文档编辑' : '📄 直接打开文档（当前工作区不存在）',
        enabled: exists,
        click: () => {
          void shell.openPath(fullPath);
        }
      },
      {
        label: '📂 在资源管理器中定位',
        click: () => {
          if (fs.existsSync(fullPath)) {
            shell.showItemInFolder(fullPath);
          } else {
            void shell.openPath(path.dirname(fullPath));
          }
        }
      },
      { type: 'separator' },
      {
        label: payload.isPinned ? '📌 取消置顶此文件' : '📌 置顶关注此文件',
        click: () => {
          manager.togglePinFile(payload.projectId, payload.relPath);
          broadcast('app:config-changed', manager.getConfig());
        }
      },
      {
        label: payload.isHidden ? '👁 取消隐藏此文件' : '🙈 隐藏此文件（不在表格中显示）',
        click: () => {
          win.webContents.send('ui:action', {
            action: 'toggle-hide-file',
            projectId: payload.projectId,
            relPath: payload.relPath
          });
        }
      }
    ]);
    menu.popup({ window: win });
  });

  // === 项目工作区管理（含同步磁盘重命名、标签、安全软归档、父级升级与重新定位） ===
  ipcMain.handle('project:list-statuses', () => manager.getAllProjectStatuses());
  ipcMain.handle('project:get-status', (_e, projectId: string) => manager.getProjectStatus(projectId));

  ipcMain.handle('project:find-nested-children', (_e, folderPath: string) => {
    return manager.findNestedChildProjects(folderPath);
  });

  ipcMain.handle('project:upgrade-to-parent', (_e, parentFolderPath: string, customName?: string) => {
    const result = manager.upgradeToParentProject(parentFolderPath, customName);
    watcher.syncAll();
    broadcast('app:config-changed', manager.getConfig());
    broadcast('workspace:updated', { projectId: result.project.id });
    broadcast('context:active-changed', getActiveContextStatus());
    return result;
  });

  ipcMain.handle('project:add-parent-excluding-children', (_e, parentFolderPath: string, customName?: string) => {
    const result = manager.addParentExcludingChildren(parentFolderPath, customName);
    watcher.syncAll();
    broadcast('app:config-changed', manager.getConfig());
    broadcast('workspace:updated', { projectId: result.project.id });
    broadcast('context:active-changed', getActiveContextStatus());
    return result;
  });

  ipcMain.handle(
    'project:export-bundle',
    (
      _e,
      projectId: string,
      options: {
        destinationParentDir: string;
        historyScope: BundleHistoryScope;
        autoArchiveFinalIfDirty: boolean;
        softArchiveAfterExport?: boolean;
      }
    ) => {
      const project = manager.getProject(projectId);
      if (!project) throw new Error('项目不存在');
      const repo = manager.getRepository(projectId);
      const res = exportProjectBundle(repo, project, {
        destinationParentDir: options.destinationParentDir,
        historyScope: options.historyScope,
        archiveBoxFolderName: manager.getConfig().archiveBox.folderName,
        autoArchiveFinalIfDirty: options.autoArchiveFinalIfDirty
      });
      if (options.softArchiveAfterExport) {
        manager.archiveProject(projectId);
        watcher.syncAll();
        broadcast('app:config-changed', manager.getConfig());
      } else {
        broadcast('workspace:updated', { projectId });
      }
      broadcast('context:active-changed', getActiveContextStatus());
      return res;
    }
  );

  ipcMain.handle('project:import-bundle', (_e, bundleFileOrDir: string, targetDir: string) => {
    const res = importProjectBundle(bundleFileOrDir, targetDir, manager);
    watcher.syncAll();
    broadcast('app:config-changed', manager.getConfig());
    broadcast('workspace:updated', { projectId: res.project.id });
    broadcast('context:active-changed', getActiveContextStatus());
    return res;
  });

  ipcMain.on('project:show-sidebar-menu', (_e, payload: { projectId: string; name: string }) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const proj = manager.getProject(payload.projectId);
    if (!proj) return;
    const menu = Menu.buildFromTemplate([
      {
        label: '🔗 关联到真实文件夹路径...',
        click: () => win.webContents.send('ui:action', { action: 'relocate-project', projectId: payload.projectId })
      },
      {
        label: '📦 结项导出（打包最终版与历史）...',
        click: () => win.webContents.send('ui:action', { action: 'open-export-bundle', projectId: payload.projectId })
      },
      { type: 'separator' },
      {
        label: '✎ 编辑项目（名称与标签）',
        click: () => win.webContents.send('ui:action', { action: 'open-edit-project', projectId: payload.projectId })
      },
      {
        label: '📂 在资源管理器中打开',
        click: () => void shell.openPath(proj.rootPath)
      },
      { type: 'separator' },
      {
        label: '⏸ 安全软归档（暂停跟踪）',
        click: () => win.webContents.send('ui:action', { action: 'archive-project', projectId: payload.projectId })
      }
    ]);
    menu.popup({ window: win });
  });

  ipcMain.handle('project:relocate', (_e, projectId: string, newFolderPath: string) => {
    const updated = manager.relocateProject(projectId, newFolderPath);
    watcher.syncAll();
    broadcast('app:config-changed', manager.getConfig());
    broadcast('workspace:updated', { projectId: updated.id });
    broadcast('context:active-changed', getActiveContextStatus());
    return updated;
  });

  ipcMain.handle('project:add', (_e, folderPath: string, customName?: string) => {
    const project = manager.addProject(folderPath, customName, true);
    watcher.syncAll();
    broadcast('app:config-changed', manager.getConfig());
    broadcast('workspace:updated', { projectId: project.id });
    broadcast('context:active-changed', getActiveContextStatus());
    return project;
  });

  ipcMain.handle('project:archive', (_e, projectId: string) => {
    const cfg = manager.archiveProject(projectId);
    watcher.syncAll();
    broadcast('app:config-changed', cfg);
    broadcast('context:active-changed', getActiveContextStatus());
    return cfg;
  });

  ipcMain.handle('project:unarchive', (_e, projectId: string) => {
    const cfg = manager.unarchiveProject(projectId);
    watcher.syncAll();
    broadcast('app:config-changed', cfg);
    broadcast('context:active-changed', getActiveContextStatus());
    return cfg;
  });

  ipcMain.handle('project:remove', (_e, projectId: string, deleteHistoryData = false) => {
    manager.removeProject(projectId, deleteHistoryData);
    watcher.syncAll();
    broadcast('app:config-changed', manager.getConfig());
    broadcast('context:active-changed', getActiveContextStatus());
    return manager.getConfig();
  });

  ipcMain.handle('project:set-active', (_e, projectId: string | null) => {
    const cfg = manager.setActiveProject(projectId);
    broadcast('app:config-changed', cfg);
    return cfg;
  });

  ipcMain.handle('project:rename', (_e, projectId: string, newName: string, syncDiskFolder = false) => {
    const updated = manager.renameProject(projectId, newName, syncDiskFolder);
    if (syncDiskFolder) watcher.syncAll();
    broadcast('workspace:updated', { projectId });
    return updated;
  });

  ipcMain.handle('project:update-tags', (_e, projectId: string, tags: string[]) => {
    const updated = manager.updateProjectTags(projectId, tags);
    broadcast('workspace:updated', { projectId });
    return updated;
  });

  ipcMain.handle('project:toggle-pin', (_e, projectId: string) => {
    const updated = manager.togglePinProject(projectId);
    broadcast('workspace:updated', { projectId });
    return updated;
  });

  // === 存档核心操作 ===
  ipcMain.handle('repo:get-manifest', (_e, projectId: string) => {
    return manager.getRepository(projectId).loadManifest();
  });

  ipcMain.handle(
    'repo:list-archives',
    (
      _e,
      projectId: string,
      filter?: {
        query?: string;
        tag?: TagColor | null;
        customTag?: string | null;
        includeArchived?: boolean;
        onlyArchived?: boolean;
        order?: 'desc' | 'asc';
      }
    ) => {
      return manager.getRepository(projectId).listArchives(filter);
    }
  );

  ipcMain.handle('repo:create-archive', (_e, projectId: string, options: CreateArchiveOptions) => {
    const record = manager.getRepository(projectId).createArchive(options);
    broadcast('workspace:updated', { projectId });
    broadcast('context:active-changed', getActiveContextStatus());
    return record;
  });

  ipcMain.handle('repo:switch-archive', (_e, projectId: string, archiveId: string, options: SwitchArchiveOptions) => {
    const result = manager.getRepository(projectId).switchToArchive(archiveId, options);
    broadcast('workspace:updated', { projectId });
    broadcast('context:active-changed', getActiveContextStatus());
    return result;
  });

  ipcMain.handle('repo:restore-to-new-folder', (_e, projectId: string, archiveId: string, destParentDir?: string) => {
    return manager.getRepository(projectId).restoreArchiveToNewFolder(archiveId, destParentDir);
  });

  ipcMain.handle(
    'repo:restore-file',
    (_e, projectId: string, archiveId: string, relPath: string, mode: 'overwrite' | 'copy' = 'overwrite') => {
      const res = manager.getRepository(projectId).restoreSingleFile(archiveId, relPath, mode);
      broadcast('workspace:updated', { projectId });
      return res;
    }
  );

  ipcMain.handle('repo:export-archive', (_e, projectId: string, archiveId: string, destDir: string) => {
    return manager.getRepository(projectId).exportArchive(archiveId, destDir);
  });

  ipcMain.handle('repo:diff-archives', (_e, projectId: string, fromId: string | null, toId: string | null) => {
    return manager.getRepository(projectId).diffArchives(fromId, toId);
  });

  ipcMain.handle('repo:diff-file-text', (_e, projectId: string, fromId: string | null, toId: string | null, relPath: string) => {
    return manager.getRepository(projectId).diffFileText(fromId, toId, relPath);
  });

  ipcMain.handle('repo:toggle-tag', (_e, projectId: string, archiveId: string, color: TagColor) => {
    const updated = manager.getRepository(projectId).toggleTag(archiveId, color);
    broadcast('workspace:updated', { projectId });
    return updated;
  });

  ipcMain.handle(
    'repo:update-meta',
    (_e, projectId: string, archiveId: string, updates: { title?: string; note?: string; tags?: TagColor[]; customTags?: string[] }) => {
      const updated = manager.getRepository(projectId).updateArchiveMeta(archiveId, updates);
      broadcast('workspace:updated', { projectId });
      return updated;
    }
  );

  ipcMain.handle('repo:soft-archive', (_e, projectId: string, archiveId: string) => {
    const updated = manager.getRepository(projectId).softArchiveRecord(archiveId);
    broadcast('workspace:updated', { projectId });
    return updated;
  });

  ipcMain.handle('repo:restore-soft-archived', (_e, projectId: string, archiveId: string) => {
    const updated = manager.getRepository(projectId).restoreSoftArchivedRecord(archiveId);
    broadcast('workspace:updated', { projectId });
    return updated;
  });

  ipcMain.handle('repo:delete-archive', (_e, projectId: string, archiveId: string) => {
    const result = manager.getRepository(projectId).deleteArchive(archiveId);
    broadcast('workspace:updated', { projectId });
    return result;
  });

  ipcMain.handle('repo:get-file-matrix', (_e, projectId: string, onlyCurrentBranch = true) => {
    return manager.getFileMatrix(projectId, onlyCurrentBranch);
  });

  ipcMain.handle('repo:get-temp-history', (_e, projectId: string, relPath: string) => {
    return manager.getRepository(projectId).getFileTempHistory(relPath);
  });

  ipcMain.handle('repo:restore-temp-history', (_e, projectId: string, entryId: string) => {
    const res = manager.getRepository(projectId).restoreTempHistoryEntry(entryId);
    broadcast('workspace:updated', { projectId });
    broadcast('context:active-changed', getActiveContextStatus());
    return res;
  });

  ipcMain.handle('repo:get-dag', (_e, projectId: string) => {
    return manager.getRepository(projectId).getDagLayout();
  });

  ipcMain.handle('repo:get-storage-stats', (_e, projectId: string) => {
    return manager.getRepository(projectId).getStorageStats();
  });

  ipcMain.handle('repo:run-gc', (_e, projectId: string) => {
    const result = manager.getRepository(projectId).runGarbageCollection();
    broadcast('workspace:updated', { projectId });
    return result;
  });

  ipcMain.handle('repo:update-ignore', (_e, projectId: string, patterns: string[]) => {
    const manifest = manager.getRepository(projectId).updateIgnorePatterns(patterns);
    broadcast('workspace:updated', { projectId });
    return manifest;
  });

  ipcMain.handle('repo:update-doc-save-archive', (_e, projectId: string, enabled: boolean, extensions: string[], cooldownMinutes: number) => {
    const manifest = manager.getRepository(projectId).updateDocSaveAutoArchive(enabled, extensions, cooldownMinutes);
    broadcast('workspace:updated', { projectId });
    return manifest;
  });

  ipcMain.handle('repo:update-auto-archive', (_e, projectId: string, enabled: boolean, intervalMinutes: number) => {
    const manifest = manager.getRepository(projectId).updateAutoArchive(enabled, intervalMinutes);
    watcher.syncAutoArchiveTimer(projectId);
    broadcast('workspace:updated', { projectId });
    return manifest;
  });

  // === 00【Archive】可视化拖拽归档箱 ===

  // === 文件浏览器（资源管理器视图）：全部路径严格限制在项目根目录内 ===

  const resolveInProject = (projectId: string, relPath: string): { root: string; full: string } | null => {
    const project = manager.getProject(projectId);
    if (!project) return null;
    const root = path.resolve(project.rootPath);
    const full = path.resolve(root, ...(relPath || '').split('/').filter(Boolean));
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return { root, full };
  };

  const HIDDEN_DIRS = new Set(['.chronobox', 'node_modules']);

  ipcMain.handle('browser:list', (_e, projectId: string, relDir = '') => {
    const target = resolveInProject(projectId, relDir);
    if (!target) throw new Error('路径越界：只能浏览当前项目文件夹内部');
    if (!fs.existsSync(target.full)) throw new Error('目录不存在（可能已被移动或删除）');
    const st = fs.statSync(target.full);
    if (!st.isDirectory()) throw new Error('目标不是文件夹');

    const entries: BrowserEntry[] = [];
    const allDirs: string[] = [''];

    // 目录树必须是「整个项目」的树，而不是当前目录的子树 —— 否则拖拽目标会缺项。
    const walkDirs = (dirAbs: string, dirRel: string, depth: number) => {
      if (depth > 8) return;
      let names: string[] = [];
      try {
        names = fs.readdirSync(dirAbs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return;
      }
      for (const name of names) {
        if (HIDDEN_DIRS.has(name.toLowerCase())) continue;
        const childRel = dirRel ? dirRel + '/' + name : name;
        allDirs.push(childRel);
        walkDirs(path.join(dirAbs, name), childRel, depth + 1);
      }
    };
    walkDirs(target.root, '', 0);

    const dirents = fs.readdirSync(target.full, { withFileTypes: true });
    for (const d of dirents) {
      if (HIDDEN_DIRS.has(d.name.toLowerCase())) continue;
      const childRel = relDir ? relDir + '/' + d.name : d.name;
      let size = 0;
      let mtimeMs = 0;
      try {
        const s = fs.statSync(path.join(target.full, d.name));
        size = d.isDirectory() ? 0 : s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        /* 无法 stat 的条目仍然列出 */
      }
      const dot = d.name.lastIndexOf('.');
      const ext = !d.isDirectory() && dot > 0 ? d.name.slice(dot + 1).toLowerCase() : '';
      entries.push({ name: d.name, relPath: childRel, isDirectory: d.isDirectory(), size, mtimeMs, ext });
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    const parentRel = relDir === '' ? null : relDir.includes('/') ? relDir.slice(0, relDir.lastIndexOf('/')) : '';
    return { relDir, entries, parentRel, allDirs } satisfies BrowserListResult;
  });

  ipcMain.handle('browser:new-folder', (_e, projectId: string, relDir: string, name: string) => {
    const target = resolveInProject(projectId, relDir);
    if (!target) throw new Error('路径越界');
    const safeName = (name || '').trim();
    if (!safeName || /[\\/:*?"<>|]/.test(safeName)) throw new Error('文件夹名不能为空，且不能包含 \\ / : * ? " < > |');
    const full = path.join(target.full, safeName);
    if (fs.existsSync(full)) throw new Error('同名文件夹已存在');
    fs.mkdirSync(full);
    return true;
  });

  ipcMain.handle('browser:rename', (_e, projectId: string, relPath: string, newName: string) => {
    const target = resolveInProject(projectId, relPath);
    if (!target) throw new Error('路径越界');
    const safeName = (newName || '').trim();
    if (!safeName || /[\\/:*?"<>|]/.test(safeName)) throw new Error('名称不能为空，且不能包含 \\ / : * ? " < > |');
    const parent = path.dirname(target.full);
    const dest = path.join(parent, safeName);
    if (dest === target.full) return true;
    if (fs.existsSync(dest)) throw new Error('目标名称已存在');
    fs.renameSync(target.full, dest);
    return true;
  });

  ipcMain.handle('browser:move-into', (_e, projectId: string, relPath: string, targetRelDir: string) => {
    const src = resolveInProject(projectId, relPath);
    const dstDir = resolveInProject(projectId, targetRelDir);
    if (!src || !dstDir) throw new Error('路径越界');
    if (!fs.existsSync(src.full)) throw new Error('源文件已不存在');
    const dest = path.join(dstDir.full, path.basename(src.full));
    const relCheck = path.relative(src.root, dest);
    if (relCheck.startsWith('..')) throw new Error('路径越界');
    if (fs.existsSync(dest)) throw new Error('目标文件夹中已存在同名项');
    if (dstDir.full.startsWith(src.full + path.sep)) throw new Error('不能把文件夹移动到它自己内部');
    fs.renameSync(src.full, dest);
    return dest;
  });

  ipcMain.handle('browser:duplicate', (_e, projectId: string, relPath: string) => {
    const src = resolveInProject(projectId, relPath);
    if (!src) throw new Error('路径越界');
    if (!fs.existsSync(src.full) || fs.statSync(src.full).isDirectory()) throw new Error('仅支持复制文件');
    const parent = path.dirname(src.full);
    const base = path.basename(src.full);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let candidate = '';
    for (let i = 1; i < 200; i++) {
      candidate = path.join(parent, stem + ' - 副本' + (i > 1 ? ' (' + i + ')' : '') + ext);
      if (!fs.existsSync(candidate)) break;
    }
    fs.copyFileSync(src.full, candidate);
    return path.relative(src.root, candidate).split(path.sep).join('/');
  });

  ipcMain.handle('browser:trash', async (_e, projectId: string, relPath: string) => {
    const target = resolveInProject(projectId, relPath);
    if (!target) throw new Error('路径越界');
    if (target.full === target.root) throw new Error('不能删除项目根目录');
    if (!fs.existsSync(target.full)) throw new Error('目标已不存在');
    await shell.trashItem(target.full);
    return true;
  });

  ipcMain.handle('browser:import', (_e, projectId: string, sourcePaths: string[], targetRelDir = '') => {
    const dstDir = resolveInProject(projectId, targetRelDir);
    if (!dstDir) throw new Error('路径越界');
    if (!fs.existsSync(dstDir.full)) throw new Error('目标文件夹不存在');
    const imported: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const src of sourcePaths) {
      try {
        const abs = path.resolve(src);
        if (!fs.existsSync(abs)) {
          skipped.push({ path: src, reason: '源文件不存在' });
          continue;
        }
        const base = path.basename(abs);
        if (HIDDEN_DIRS.has(base.toLowerCase())) {
          skipped.push({ path: src, reason: '内部目录不可导入' });
          continue;
        }
        let dest = path.join(dstDir.full, base);
        if (fs.existsSync(dest)) {
          const dot = base.lastIndexOf('.');
          const stem = dot > 0 ? base.slice(0, dot) : base;
          const ext = dot > 0 ? base.slice(dot) : '';
          for (let i = 2; i < 500; i++) {
            dest = path.join(dstDir.full, stem + ' (' + i + ')' + ext);
            if (!fs.existsSync(dest)) break;
          }
        }
        // 同一磁盘用 rename（快且保留元数据），跨盘退化为复制
        try {
          fs.renameSync(abs, dest);
        } catch {
          fs.cpSync(abs, dest, { recursive: true });
        }
        imported.push(path.relative(dstDir.root, dest).split(path.sep).join('/'));
      } catch (err) {
        skipped.push({ path: src, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { imported, skipped };
  });

  ipcMain.handle('browser:reveal', (_e, projectId: string, relPath: string) => {
    const target = resolveInProject(projectId, relPath);
    if (!target) return;
    if (fs.existsSync(target.full)) shell.showItemInFolder(target.full);
    else void shell.openPath(path.dirname(target.full));
  });

  ipcMain.handle('archiveBox:drop-paths', (_e, sourcePaths: string[], action?: 'move' | 'copy') => {
    const result = manager.archiveDroppedPaths(sourcePaths, action);
    const affectedIds = new Set<string>();
    for (const item of result.succeeded) {
      if (item.projectId) affectedIds.add(item.projectId);
    }
    for (const pid of affectedIds) {
      broadcast('workspace:updated', { projectId: pid });
    }
    if (affectedIds.size === 0 && manager.getConfig().activeProjectId) {
      broadcast('workspace:updated', { projectId: manager.getConfig().activeProjectId });
    }
    return result;
  });

  ipcMain.handle('archiveBox:list', (_e, projectId: string) => {
    return manager.listArchiveBoxEntries(projectId);
  });

  ipcMain.handle('archiveBox:restore', (_e, archiveRoot: string, entryId: string) => {
    const restored = manager.restoreArchiveBoxEntry(archiveRoot, entryId);
    broadcast('workspace:updated', { projectId: restored.projectId || manager.getConfig().activeProjectId });
    return restored;
  });

  ipcMain.handle('archiveBox:update-config', (_e, partial: Partial<ArchiveBoxConfig>) => {
    const cfg = manager.updateArchiveBoxConfig(partial);
    broadcast('app:config-changed', cfg);
    return cfg;
  });

  ipcMain.handle('archiveBox:open-folder', async (_e, projectId: string) => {
    const root = manager.getArchiveBoxRoot(projectId);
    if (!root) return;
    fs.mkdirSync(root, { recursive: true });
    await shell.openPath(root);
  });

  // === 常规设置（关闭行为、开机自启动）与 Beyond Compare 集成 ===
  ipcMain.handle(
    'app:update-general-settings',
    (_e, partial: { closeBehavior?: 'tray' | 'quit'; launchAtLogin?: boolean; beyondComparePath?: string; restrictNestedFolders?: boolean; shortcuts?: { quickArchive?: string; toggleMini?: string } }) => {
      const cfg = manager.updateGeneralSettings(partial);
      if (typeof partial.launchAtLogin === 'boolean') {
        applyLoginItemSetting(partial.launchAtLogin);
      }
      if (partial.shortcuts) {
        reregisterShortcuts();
      }
      broadcast('app:config-changed', cfg);
      return cfg;
    }
  );

  ipcMain.handle('context:get-active-status', () => getActiveContextStatus());

  ipcMain.on('mini:show-context-menu', () => {
    showMiniContextMenu();
  });

  ipcMain.handle('project:toggle-pin-file', (_e, projectId: string, relPath: string) => {
    const pinned = manager.togglePinFile(projectId, relPath);
    broadcast('app:config-changed', manager.getConfig());
    return pinned;
  });

  ipcMain.handle('app:open-manual-md', async () => {
    const manualPath = path.join(__dirname, '..', '..', '使用说明书.md');
    if (fs.existsSync(manualPath)) {
      await shell.openPath(manualPath);
      return true;
    }
    const readmePath = path.join(__dirname, '..', '..', 'README.md');
    if (fs.existsSync(readmePath)) {
      await shell.openPath(readmePath);
      return true;
    }
    return false;
  });

  ipcMain.handle('bc:detect-path', () => detectBeyondComparePath());

  ipcMain.handle('bc:pick-exe', async () => {
    const win = getMainWindow();
    const opts: OpenDialogOptions = {
      title: '选择 Beyond Compare 可执行文件 (BCompare.exe)',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }]
    };
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  const resolveBcPath = (): string => {
    let exe = manager.getConfig().beyondComparePath;
    if (!exe || !fs.existsSync(exe)) {
      const detected = detectBeyondComparePath();
      if (detected) {
        manager.updateGeneralSettings({ beyondComparePath: detected });
        exe = detected;
      }
    }
    return exe;
  };

  ipcMain.handle(
    'bc:compare-file',
    (_e, projectId: string, fromId: string | null, toId: string | null, relPath: string) => {
      const exe = resolveBcPath();
      if (!exe) {
        return { launched: false, needsPath: true, message: '未检测到 Beyond Compare，请选择 BCompare.exe 路径' };
      }
      const repo = manager.getRepository(projectId);
      const pair = prepareCompareFilePair(repo, fromId, toId, relPath);
      launchBeyondCompare(exe, pair);
      return { launched: true, needsPath: false };
    }
  );

  // === 高价值效率分析引擎（重复文件体检 / 单文件里程碑 / 全局检索 / 进展周报） ===
  ipcMain.handle('analytics:find-duplicates', (_e, projectId: string) => {
    return findDuplicateFiles(manager.getRepository(projectId));
  });

  ipcMain.handle('analytics:archive-duplicate-file', (_e, projectId: string, relPath: string) => {
    const project = manager.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    const fullPath = path.join(project.rootPath, ...relPath.split('/'));
    const res = manager.archiveDroppedPaths([fullPath], 'move');
    broadcast('workspace:updated', { projectId });
    broadcast('context:active-changed', getActiveContextStatus());
    return res;
  });

  ipcMain.handle('analytics:file-milestones', (_e, projectId: string, relPath: string) => {
    return getFileMilestoneTimeline(manager.getRepository(projectId), relPath);
  });

  ipcMain.handle('analytics:global-search', (_e, query: string) => {
    return globalSearchWorkspace(manager, query, 30);
  });

  ipcMain.handle('analytics:progress-report', (_e, options: { projectId?: string | null; days: number }) => {
    return generateProgressReport(manager, options);
  });

  ipcMain.handle('analytics:export-report-md', async (_e, markdown: string, defaultName: string) => {
    const win = getMainWindow();
    const opts = {
      title: '导出项目进展汇总 (Markdown)',
      defaultPath: defaultName || '项目进展周报.md',
      filters: [{ name: 'Markdown 文档', extensions: ['md'] }]
    };
    const res = win && !win.isDestroyed()
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, markdown, 'utf-8');
    return res.filePath;
  });

  ipcMain.handle(
    'bc:compare-folder',
    (_e, projectId: string, fromId: string | null, toId: string | null) => {
      const exe = resolveBcPath();
      if (!exe) {
        return { launched: false, needsPath: true, message: '未检测到 Beyond Compare，请选择 BCompare.exe 路径' };
      }
      const repo = manager.getRepository(projectId);
      const pair = prepareCompareFolderPair(repo, fromId, toId);
      launchBeyondCompare(exe, pair);
      return { launched: true, needsPath: false };
    }
  );
}
