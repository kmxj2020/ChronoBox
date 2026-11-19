import * as fs from 'fs';
import { EventEmitter } from 'events';
import { WorkspaceManager } from './workspaceManager';
import { REPO_DIR_NAME } from './ignore';

/**
 * Windows 友好型防抖文件监听器 + 定时自动存档调度器
 * - Windows 原生支持 fs.watch({ recursive: true })，零 C++ 编译依赖
 * - 遇到不支持 recursive 的平台自动降级为轮询检测，确保跨平台测试稳定
 */
export class WorkspaceWatcher extends EventEmitter {
  private readonly manager: WorkspaceManager;
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly autoArchiveTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastDocSaveAt = new Map<string, number>();
  private readonly docSaveDelayTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;

  constructor(manager: WorkspaceManager, debounceMs = 450) {
    super();
    this.manager = manager;
    this.debounceMs = debounceMs;
  }

  public syncAll(): void {
    const config = this.manager.getConfig();
    const activeProjects = config.projects.filter((p) => !p.archived);
    const validIds = new Set(activeProjects.map((p) => p.id));

    // 停止已移除项目的监听
    for (const [id] of this.watchers) {
      if (!validIds.has(id)) {
        this.unwatchProject(id);
      }
    }

    for (const project of activeProjects) {
      if (!this.watchers.has(project.id) && fs.existsSync(project.rootPath)) {
        this.watchProject(project.id, project.rootPath);
      }
      this.syncAutoArchiveTimer(project.id);
    }
  }

  public watchProject(projectId: string, rootPath: string): void {
    this.unwatchProject(projectId);
    if (!fs.existsSync(rootPath)) return;

    try {
      const watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
        if (filename && String(filename).includes(REPO_DIR_NAME)) {
          return;
        }
        this.scheduleNotify(projectId);
      });

      watcher.on('error', () => {
        this.unwatchProject(projectId);
      });

      this.watchers.set(projectId, watcher);
    } catch {
      // 非 Windows/macOS 环境（如 Linux 测试环境）可能不支持 recursive，启用轻量轮询兜底
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => {
          const active = this.manager.getConfig().activeProjectId;
          if (active) {
            this.emit('change', active);
          }
        }, 3000);
      }
    }
  }

  public unwatchProject(projectId: string): void {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      this.watchers.delete(projectId);
    }
    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }
    const autoTimer = this.autoArchiveTimers.get(projectId);
    if (autoTimer) {
      clearInterval(autoTimer);
      this.autoArchiveTimers.delete(projectId);
    }
  }

  public syncAutoArchiveTimer(projectId: string): void {
    const existing = this.autoArchiveTimers.get(projectId);
    if (existing) {
      clearInterval(existing);
      this.autoArchiveTimers.delete(projectId);
    }

    try {
      const repo = this.manager.getRepository(projectId);
      if (!repo.isInitialized()) return;
      const manifest = repo.loadManifest();
      if (!manifest.autoArchive?.enabled) return;

      const intervalMs = Math.max(1, manifest.autoArchive.intervalMinutes) * 60 * 1000;
      const timer = setInterval(() => {
        try {
          const working = repo.getWorkingChanges();
          if (working.changes.length > 0) {
            const record = repo.createArchive({ isAuto: true });
            this.emit('auto-archived', { projectId, archive: record });
          }
        } catch {
          // 自动存档失败静默忽略，不影响用户工作
        }
      }, intervalMs);

      this.autoArchiveTimers.set(projectId, timer);
    } catch {
      // ignore
    }
  }

  private scheduleNotify(projectId: string): void {
    const existing = this.debounceTimers.get(projectId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(projectId);
      try {
        this.manager.getRepository(projectId).captureTempHistory();
      } catch { /* ignore */ }
      this.emit('change', projectId);
      this.maybeTriggerDocSaveArchive(projectId);
    }, this.debounceMs);

    this.debounceTimers.set(projectId, timer);
  }


  private maybeTriggerDocSaveArchive(projectId: string): void {
    try {
      const repo = this.manager.getRepository(projectId);
      if (!repo.isInitialized()) return;
      const manifest = repo.loadManifest();
      const cfg = manifest.docSaveAutoArchive;
      if (!cfg?.enabled) return;

      const working = repo.getWorkingChanges();
      if (working.changes.length === 0) return;

      const matched = working.changes.filter((c) => {
        if (c.entryType === 'directory') return false;
        const lower = c.path.toLowerCase();
        return cfg.extensions.some((ext) => lower.endsWith(ext));
      });
      if (matched.length === 0) return;

      const now = Date.now();
      const cooldownMs = Math.max(0, cfg.cooldownMinutes) * 60 * 1000;
      const last = this.lastDocSaveAt.get(projectId) || 0;
      const waitMs = Math.max(2500, cooldownMs - (now - last));

      const existingDelay = this.docSaveDelayTimers.get(projectId);
      if (existingDelay) clearTimeout(existingDelay);

      const timer = setTimeout(() => {
        this.docSaveDelayTimers.delete(projectId);
        try {
          const fresh = repo.getWorkingChanges();
          if (fresh.changes.length === 0) return;
          const names = fresh.changes.slice(0, 2).map((x) => x.path.split('/').pop()).join('、');
          const record = repo.createArchive({
            title: `[文档自动存档] ${names}${fresh.changes.length > 2 ? ' 等' : ''}`,
            isAuto: true
          });
          this.lastDocSaveAt.set(projectId, Date.now());
          this.emit('auto-archived', { projectId, archive: record });
        } catch { /* ignore */ }
      }, waitMs);

      this.docSaveDelayTimers.set(projectId, timer);
    } catch { /* ignore */ }
  }

  public dispose(): void {
    for (const id of Array.from(this.watchers.keys())) {
      this.unwatchProject(id);
    }
    for (const timer of this.autoArchiveTimers.values()) {
      clearInterval(timer);
    }
    this.autoArchiveTimers.clear();
    for (const dt of this.docSaveDelayTimers.values()) clearTimeout(dt);
    this.docSaveDelayTimers.clear();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
