import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AppConfig,
  ArchiveBoxConfig,
  ArchiveBoxEntry,
  ArchiveBoxOperationResult,
  FileMatrixResult,
  LanguageCode,
  ThemeMode,
  TrackedProject,
  WindowMode,
  WorkspaceStatus
} from './types';
import { ChronoBoxRepository } from './repository';
import { normalizeRelPath, REPO_DIR_NAME } from './ignore';
import { ArchiveBoxEngine, DEFAULT_ARCHIVE_BOX_CONFIG } from './archiveBox';
import { buildFileEvolutionMatrix } from './fileMatrix';

const DEFAULT_CONFIG: AppConfig = {
  language: 'zh-CN',
  theme: 'light',
  projects: [],
  activeProjectId: null,
  windowMode: 'full',
  floatingEnabled: true,
  floatingStyle: 'mini-dot',
  shortcuts: {
    quickArchive: 'CommandOrControl+Shift+S',
    toggleMini: 'CommandOrControl+Shift+M'
  },
  archiveBox: { ...DEFAULT_ARCHIVE_BOX_CONFIG },
  closeBehavior: 'tray',
  launchAtLogin: false,
  beyondComparePath: '',
  restrictNestedFolders: true,
  pinnedFiles: {}
};

/**
 * 多项目工作区与全局配置管理器（ChronoBox v2.0）
 * 支持：项目重命名（可选同步重命名磁盘文件夹）、自定义文字标签、安全软归档与恢复
 */
export class WorkspaceManager {
  private readonly configDir: string;
  private readonly configPath: string;
  private config: AppConfig;
  private readonly repoCache = new Map<string, ChronoBoxRepository>();

  constructor(configDir: string) {
    this.configDir = path.resolve(configDir);
    this.configPath = path.join(this.configDir, 'config.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): AppConfig {
    if (!fs.existsSync(this.configPath)) {
      return {
        ...DEFAULT_CONFIG,
        projects: [],
        shortcuts: { ...DEFAULT_CONFIG.shortcuts },
        archiveBox: { ...DEFAULT_ARCHIVE_BOX_CONFIG }
      };
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return {
        language: parsed.language === 'en-US' ? 'en-US' : 'zh-CN',
        theme: parsed.theme === 'dark' || parsed.theme === 'system' ? parsed.theme : 'light',
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        activeProjectId: parsed.activeProjectId ?? null,
        windowMode: parsed.windowMode === 'mini-bar' || parsed.windowMode === 'mini-dot' ? parsed.windowMode : 'full',
        floatingEnabled: parsed.floatingEnabled !== undefined ? Boolean(parsed.floatingEnabled) : true,
        floatingStyle: parsed.floatingStyle === 'mini-bar' ? 'mini-bar' : 'mini-dot',
        miniPosition: parsed.miniPosition,
        shortcuts: {
          quickArchive: parsed.shortcuts?.quickArchive || DEFAULT_CONFIG.shortcuts.quickArchive,
          toggleMini: parsed.shortcuts?.toggleMini || DEFAULT_CONFIG.shortcuts.toggleMini
        },
        archiveBox: {
          ...DEFAULT_ARCHIVE_BOX_CONFIG,
          ...(parsed.archiveBox || {})
        },
        closeBehavior: parsed.closeBehavior === 'quit' ? 'quit' : 'tray',
        launchAtLogin: Boolean(parsed.launchAtLogin),
        beyondComparePath: typeof parsed.beyondComparePath === 'string' ? parsed.beyondComparePath : '',
        restrictNestedFolders: parsed.restrictNestedFolders !== undefined ? Boolean(parsed.restrictNestedFolders) : true,
        pinnedFiles: parsed.pinnedFiles && typeof parsed.pinnedFiles === 'object' ? parsed.pinnedFiles : {}
      };
    } catch {
      return {
        ...DEFAULT_CONFIG,
        projects: [],
        shortcuts: { ...DEFAULT_CONFIG.shortcuts },
        archiveBox: { ...DEFAULT_ARCHIVE_BOX_CONFIG }
      };
    }
  }

  private saveConfig(): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    const tmp = `${this.configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf-8');
    try {
      fs.renameSync(tmp, this.configPath);
    } catch {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    }
  }

  public getConfig(): AppConfig {
    return {
      ...this.config,
      projects: [...this.config.projects],
      shortcuts: { ...this.config.shortcuts },
      archiveBox: { ...this.config.archiveBox }
    };
  }

  public setLanguage(language: LanguageCode): AppConfig {
    this.config.language = language;
    this.saveConfig();
    return this.getConfig();
  }

  public setTheme(theme: ThemeMode): AppConfig {
    this.config.theme = theme;
    this.saveConfig();
    return this.getConfig();
  }

  public setFloatingEnabled(enabled: boolean): AppConfig {
    this.config.floatingEnabled = Boolean(enabled);
    this.saveConfig();
    return this.getConfig();
  }

  public setFloatingStyle(style: 'mini-dot' | 'mini-bar'): AppConfig {
    this.config.floatingStyle = style === 'mini-bar' ? 'mini-bar' : 'mini-dot';
    this.saveConfig();
    return this.getConfig();
  }

  /**
   * 检测某父文件夹下是否已包含正在跟踪的子项目（用于询问是否“升级范围到父文件夹”）
   */
  public findNestedChildProjects(parentFolderPath: string): TrackedProject[] {
    const resolvedParent = path.resolve(parentFolderPath);
    return this.config.projects.filter((p) => {
      if (p.archived) return false;
      const pRoot = path.resolve(p.rootPath);
      if (pRoot.toLowerCase() === resolvedParent.toLowerCase()) return false;
      const rel = path.relative(resolvedParent, pRoot);
      return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  /**
   * 将已有子项目平滑升级到其父文件夹：
   * - 将内部子项目设为安全软归档（保留子目录原有历史记录不丢失）
   * - 将父文件夹正式添加为统一项目进行跟踪
   */
  public upgradeToParentProject(parentFolderPath: string, customName?: string): {
    project: TrackedProject;
    archivedChildren: TrackedProject[];
  } {
    const children = this.findNestedChildProjects(parentFolderPath);
    for (const child of children) {
      this.archiveProject(child.id);
    }
    const project = this.addProject(parentFolderPath, customName, true);
    return { project, archivedChildren: children };
  }

  /**
   * 添加父文件夹为独立项目，同时自动把内部已跟踪的子项目写入父项目的忽略规则：
   * 子项目保持独立跟踪，子项目的变化绝不混入父项目，互不干扰！
   */
  public addParentExcludingChildren(parentFolderPath: string, customName?: string): {
    project: TrackedProject;
    excludedChildren: TrackedProject[];
    addedPatterns: string[];
  } {
    const resolvedParent = path.resolve(parentFolderPath);
    const children = this.findNestedChildProjects(resolvedParent);
    const addedPatterns: string[] = [];

    const tempRepo = new ChronoBoxRepository(resolvedParent);
    const manifest = tempRepo.init(customName);
    const nextPatterns = [...(manifest.ignorePatterns || [])];
    for (const child of children) {
      const rel = normalizeRelPath(path.relative(resolvedParent, path.resolve(child.rootPath)));
      if (!rel || rel.startsWith('..')) continue;
      for (const pat of [rel, `${rel}/**`]) {
        if (!nextPatterns.includes(pat)) {
          nextPatterns.push(pat);
          addedPatterns.push(pat);
        }
      }
    }
    if (addedPatterns.length > 0) {
      tempRepo.updateIgnorePatterns(nextPatterns);
    }

    const project = this.addProject(resolvedParent, customName, true, true);
    const repo = this.getRepository(project.id);
    const freshManifest = repo.loadManifest();
    if (Object.keys(freshManifest.archives).length === 0) {
      const scan = repo.scanCurrentFull(freshManifest);
      if (Object.keys(scan.files).length > 0 || scan.directories.length > 0) {
        repo.createArchive({ title: '初始存档', allowEmpty: true });
      }
    }
    return { project, excludedChildren: children, addedPatterns };
  }

  /**
   * 当磁盘文件夹在软件运行中或关闭期间被外部重命名时，
   * 通过比对原父目录下同级文件夹内 .chronobox/manifest.json 的 repoId 实现毫秒级自动无损找回！
   */
  public tryAutoRelocateProject(projectId: string): { relocated: boolean; oldPath: string; newPath: string } | null {
    const project = this.getProject(projectId);
    if (!project || fs.existsSync(project.rootPath)) return null;
    if (!project.repoId) return null;

    const parentDir = path.dirname(project.rootPath);
    if (!fs.existsSync(parentDir)) return null;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parentDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const oldBaseName = path.basename(project.rootPath);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidateDir = path.join(parentDir, entry.name);
      for (const metaName of [REPO_DIR_NAME]) {
        const mfPath = path.join(candidateDir, metaName, 'manifest.json');
        if (!fs.existsSync(mfPath)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(mfPath, 'utf-8')) as { repoId?: string };
          if (parsed && parsed.repoId === project.repoId) {
            const oldPath = project.rootPath;
            project.rootPath = candidateDir;
            // 若用户未自定义别名（显示名仍等于旧目录名），同步更新为新文件夹名
            if (project.name === oldBaseName) {
              project.name = entry.name;
            }
            this.repoCache.delete(projectId);
            this.saveConfig();
            return { relocated: true, oldPath, newPath: candidateDir };
          }
        } catch { /* ignore */ }
      }
    }
    return null;
  }

  /**
   * 手动重新定位跨盘或深层移动的项目文件夹
   */
  public relocateProject(projectId: string, newFolderPath: string): TrackedProject {
    const resolved = path.resolve(newFolderPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`目标文件夹不存在: ${resolved}`);
    }
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    project.rootPath = resolved;
    this.repoCache.delete(projectId);
    const repo = this.getRepository(projectId);
    if (repo.isInitialized()) {
      project.repoId = repo.loadManifest().repoId;
    }
    this.saveConfig();
    return project;
  }

  public setWindowMode(mode: WindowMode): AppConfig {
    this.config.windowMode = mode;
    this.saveConfig();
    return this.getConfig();
  }

  public setMiniPosition(x: number, y: number): void {
    this.config.miniPosition = { x: Math.round(x), y: Math.round(y) };
    this.saveConfig();
  }

  public updateGeneralSettings(partial: {
    closeBehavior?: 'tray' | 'quit';
    launchAtLogin?: boolean;
    beyondComparePath?: string;
    restrictNestedFolders?: boolean;
    shortcuts?: { quickArchive?: string; toggleMini?: string };
  }): AppConfig {
    if (partial.closeBehavior === 'tray' || partial.closeBehavior === 'quit') {
      this.config.closeBehavior = partial.closeBehavior;
    }
    if (typeof partial.launchAtLogin === 'boolean') {
      this.config.launchAtLogin = partial.launchAtLogin;
    }
    if (typeof partial.beyondComparePath === 'string') {
      this.config.beyondComparePath = partial.beyondComparePath.trim();
    }
    if (typeof partial.restrictNestedFolders === 'boolean') {
      this.config.restrictNestedFolders = partial.restrictNestedFolders;
    }
    if (partial.shortcuts) {
      if (partial.shortcuts.quickArchive?.trim()) {
        this.config.shortcuts.quickArchive = partial.shortcuts.quickArchive.trim();
      }
      if (partial.shortcuts.toggleMini?.trim()) {
        this.config.shortcuts.toggleMini = partial.shortcuts.toggleMini.trim();
      }
    }
    this.saveConfig();
    return this.getConfig();
  }

  public updateArchiveBoxConfig(partial: Partial<ArchiveBoxConfig>): AppConfig {
    this.config.archiveBox = {
      ...this.config.archiveBox,
      ...partial,
      folderName: (partial.folderName ?? this.config.archiveBox.folderName).trim() || DEFAULT_ARCHIVE_BOX_CONFIG.folderName
    };
    this.saveConfig();
    return this.getConfig();
  }

  public archiveDroppedPaths(sourcePaths: string[], action?: 'move' | 'copy'): ArchiveBoxOperationResult {
    const activeProj = this.config.activeProjectId ? this.getProject(this.config.activeProjectId) : undefined;
    return ArchiveBoxEngine.archivePaths(sourcePaths, {
      config: this.config.archiveBox,
      projects: this.config.projects.filter((p) => !p.archived),
      activeProjectRoot: activeProj ? activeProj.rootPath : null,
      action
    });
  }

  public listArchiveBoxEntries(projectId: string): ArchiveBoxEntry[] {
    const project = this.getProject(projectId);
    if (!project || !fs.existsSync(project.rootPath)) return [];
    return ArchiveBoxEngine.listEntries(project.rootPath, this.config.archiveBox.folderName);
  }

  public restoreArchiveBoxEntry(archiveRoot: string, entryId: string): ArchiveBoxEntry {
    return ArchiveBoxEngine.restoreEntry(archiveRoot, entryId);
  }

  public getFileMatrix(projectId: string, onlyCurrentBranch = true): FileMatrixResult {
    const repo = this.getRepository(projectId);
    const manifest = repo.loadManifest();
    const working = repo.scanCurrentFull(manifest);
    const boxEntries = this.listArchiveBoxEntries(projectId);
    return buildFileEvolutionMatrix(
      Object.values(manifest.archives),
      manifest.currentArchiveId,
      working.files,
      boxEntries,
      onlyCurrentBranch
    );
  }

  public getArchiveBoxRoot(projectId: string): string | null {
    const project = this.getProject(projectId);
    if (!project) return null;
    return path.join(project.rootPath, this.config.archiveBox.folderName);
  }

  public addProject(folderPath: string, customName?: string, createInitialArchive = true, bypassNestedCheck = false): TrackedProject {
    const resolved = path.resolve(folderPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`请选择有效的本地文件夹: ${resolved}`);
    }

    // 1. 系统高危根目录防误选保护（禁止跟踪盘符根目录或 Windows 系统目录）
    const parsedRoot = path.parse(resolved);
    if (resolved.toLowerCase() === parsedRoot.root.toLowerCase()) {
      throw new Error(`出于安全与性能保护，不允许直接跟踪磁盘根目录（${resolved}），请选择具体的项目子文件夹`);
    }
    const lowerResolved = resolved.toLowerCase();
    if (/^[a-z]:\\(windows|program files|program files \(x86\)|programdata)$/.test(lowerResolved)) {
      throw new Error(`出于系统安全保护，不允许跟踪系统目录：${resolved}`);
    }

    // 2. 嵌套父/子文件夹冲突检测（受设置中的 restrictNestedFolders 开关控制）
    if (this.config.restrictNestedFolders && !bypassNestedCheck) {
      for (const p of this.config.projects) {
        if (p.archived) continue;
        const pRoot = path.resolve(p.rootPath);
        if (pRoot.toLowerCase() === lowerResolved) continue;
        const relChild = path.relative(pRoot, resolved);
        if (relChild && !relChild.startsWith('..') && !path.isAbsolute(relChild)) {
          throw new Error(
            `已开启「禁止嵌套子文件夹跟踪」：该目录是已跟踪项目「${p.name}」的子文件夹。如需单独跟踪，可在「设置与关于」中关闭此限制开关。`
          );
        }
        const relParent = path.relative(resolved, pRoot);
        if (relParent && !relParent.startsWith('..') && !path.isAbsolute(relParent)) {
          throw new Error(
            `已开启「禁止嵌套子文件夹跟踪」：该目录包含已跟踪项目「${p.name}」。如需允许嵌套跟踪，可在「设置与关于」中关闭此限制开关。`
          );
        }
      }
    }

    const existing = this.config.projects.find(
      (p) => p.rootPath.toLowerCase() === resolved.toLowerCase()
    );
    if (existing) {
      existing.archived = false;
      delete existing.archivedAt;
      existing.lastOpenedAt = Date.now();
      this.config.activeProjectId = existing.id;
      this.saveConfig();
      return existing;
    }

    const repo = new ChronoBoxRepository(resolved);
    const wasInitialized = repo.isInitialized();
    const manifest = repo.init(customName);

    if (!wasInitialized && createInitialArchive) {
      const scan = repo.scanCurrentFull(manifest);
      if (Object.keys(scan.files).length > 0 || scan.directories.length > 0) {
        repo.createArchive({ title: '初始存档', allowEmpty: true });
      }
    }

    const now = Date.now();
    const project: TrackedProject = {
      id: `prj_${crypto.randomBytes(5).toString('hex')}`,
      repoId: manifest.repoId,
      name: customName?.trim() || manifest.name || path.basename(resolved),
      rootPath: resolved,
      addedAt: now,
      lastOpenedAt: now,
      pinned: false,
      customTags: [],
      archived: false
    };

    this.config.projects.unshift(project);
    this.config.activeProjectId = project.id;
    this.repoCache.set(project.id, repo);
    this.saveConfig();
    return project;
  }

  /**
   * 安全软归档项目：暂停跟踪并收纳到已归档区，本地文件与全部历史 100% 保留
   */
  public archiveProject(projectId: string): AppConfig {
    const found = this.config.projects.find((p) => p.id === projectId);
    if (!found) return this.getConfig();
    found.archived = true;
    found.archivedAt = Date.now();
    if (this.config.activeProjectId === projectId) {
      const nextActive = this.config.projects.find((p) => !p.archived);
      this.config.activeProjectId = nextActive ? nextActive.id : null;
    }
    this.saveConfig();
    return this.getConfig();
  }

  /**
   * 从已归档区恢复跟踪项目
   */
  public unarchiveProject(projectId: string): AppConfig {
    const found = this.config.projects.find((p) => p.id === projectId);
    if (!found) throw new Error(`项目不存在: ${projectId}`);
    found.archived = false;
    delete found.archivedAt;
    found.lastOpenedAt = Date.now();
    this.config.activeProjectId = found.id;
    this.saveConfig();
    return this.getConfig();
  }

  /**
   * 彻底永久移除项目（仅在设置面板危险区二次确认后调用）
   */
  public removeProject(projectId: string, deleteHistoryData = false): void {
    const idx = this.config.projects.findIndex((p) => p.id === projectId);
    if (idx === -1) return;

    const [removed] = this.config.projects.splice(idx, 1);
    this.repoCache.delete(projectId);

    if (deleteHistoryData) {
      for (const dirName of [REPO_DIR_NAME]) {
        const metaDir = path.join(removed.rootPath, dirName);
        if (fs.existsSync(metaDir)) {
          fs.rmSync(metaDir, { recursive: true, force: true });
        }
      }
    }

    if (this.config.activeProjectId === projectId) {
      const nextActive = this.config.projects.find((p) => !p.archived);
      this.config.activeProjectId = nextActive ? nextActive.id : null;
    }
    this.saveConfig();
  }

  public setActiveProject(projectId: string | null): AppConfig {
    if (projectId === null) {
      this.config.activeProjectId = null;
      this.saveConfig();
      return this.getConfig();
    }
    const found = this.config.projects.find((p) => p.id === projectId);
    if (!found) throw new Error(`项目不存在: ${projectId}`);
    found.lastOpenedAt = Date.now();
    this.config.activeProjectId = projectId;
    this.saveConfig();
    return this.getConfig();
  }

  /**
   * 重命名项目显示名，并可选同步重命名磁盘上的实际文件夹
   */
  public renameProject(projectId: string, newName: string, syncDiskFolder = false): TrackedProject {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('项目名称不能为空');
    const found = this.config.projects.find((p) => p.id === projectId);
    if (!found) throw new Error(`项目不存在: ${projectId}`);

    if (syncDiskFolder) {
      if (/[\\/:*?"<>|]/.test(trimmed)) {
        throw new Error('同步重命名文件夹时，名称不能包含 Windows 非法字符 \\ / : * ? " < > |');
      }
      if (!fs.existsSync(found.rootPath)) {
        throw new Error(`原磁盘文件夹不存在，无法同步重命名: ${found.rootPath}`);
      }
      const parentDir = path.dirname(found.rootPath);
      const nextPath = path.join(parentDir, trimmed);
      if (nextPath.toLowerCase() !== found.rootPath.toLowerCase()) {
        if (fs.existsSync(nextPath)) {
          throw new Error(`同级目录下已存在名为「${trimmed}」的文件夹，请更换名称`);
        }
        try {
          fs.renameSync(found.rootPath, nextPath);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
            throw new Error('无法同步重命名磁盘文件夹：文件夹内有文件正被 Word/Origin/资源管理器占用，请关闭后重试（或取消勾选“同步重命名磁盘文件夹”）');
          }
          throw err;
        }
        found.rootPath = nextPath;
        this.repoCache.delete(projectId);
      }
    }

    found.name = trimmed;
    this.saveConfig();

    const repo = this.getRepository(projectId);
    if (repo.isInitialized()) {
      const manifest = repo.loadManifest();
      if (!found.repoId && manifest.repoId) {
        found.repoId = manifest.repoId;
        this.saveConfig();
      }
      manifest.name = trimmed;
      repo.saveManifest(manifest);
    }
    return found;
  }

  public updateProjectTags(projectId: string, tags: string[]): TrackedProject {
    const found = this.config.projects.find((p) => p.id === projectId);
    if (!found) throw new Error(`项目不存在: ${projectId}`);
    const cleaned: string[] = [];
    for (const raw of tags) {
      const t = raw.trim().slice(0, 16);
      if (t && !cleaned.includes(t)) cleaned.push(t);
    }
    found.customTags = cleaned.slice(0, 8);
    this.saveConfig();
    return found;
  }

  public togglePinFile(projectId: string, relPath: string): string[] {
    if (!this.config.pinnedFiles) this.config.pinnedFiles = {};
    const list = this.config.pinnedFiles[projectId] || [];
    const exists = list.includes(relPath);
    const next = exists ? list.filter((p) => p !== relPath) : [relPath, ...list];
    this.config.pinnedFiles[projectId] = next;
    this.saveConfig();
    return next;
  }

  public getPinnedFiles(projectId: string): string[] {
    return this.config.pinnedFiles?.[projectId] || [];
  }

  public togglePinProject(projectId: string): TrackedProject {
    const found = this.config.projects.find((p) => p.id === projectId);
    if (!found) throw new Error(`项目不存在: ${projectId}`);
    found.pinned = !found.pinned;
    this.config.projects.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.lastOpenedAt - a.lastOpenedAt;
    });
    this.saveConfig();
    return found;
  }

  public getProject(projectId: string): TrackedProject | undefined {
    return this.config.projects.find((p) => p.id === projectId);
  }

  public getRepository(projectId: string): ChronoBoxRepository {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`未找到已跟踪项目: ${projectId}`);
    let repo = this.repoCache.get(projectId);
    if (!repo || repo.rootPath !== path.resolve(project.rootPath)) {
      repo = new ChronoBoxRepository(project.rootPath);
      this.repoCache.set(projectId, repo);
    }
    return repo;
  }

  public getProjectStatus(projectId: string): WorkspaceStatus {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);

    if (!fs.existsSync(project.rootPath)) {
      this.tryAutoRelocateProject(projectId);
    }
    if (!fs.existsSync(project.rootPath)) {
      this.repoCache.delete(projectId);
      return {
        projectId: project.id,
        rootPath: project.rootPath,
        name: project.name,
        exists: false,
        archived: Boolean(project.archived),
        customTags: project.customTags || [],
        pinned: Boolean(project.pinned),
        currentArchiveId: null,
        archiveCount: 0,
        changes: [],
        hasChanges: false,
        lastCheckedAt: Date.now()
      };
    }

    const repo = this.getRepository(projectId);
    if (!repo.isInitialized()) {
      repo.init(project.name);
    }

    const manifest = repo.loadManifest();
    if (!project.repoId && manifest.repoId) {
      project.repoId = manifest.repoId;
      this.saveConfig();
    }
    const working = repo.getWorkingChanges();
    const activeArchiveCount = Object.values(manifest.archives).filter((a) => !a.archived).length;
    return {
      projectId: project.id,
      rootPath: project.rootPath,
      name: project.name,
      exists: true,
      archived: Boolean(project.archived),
      customTags: project.customTags || [],
      pinned: Boolean(project.pinned),
      currentArchiveId: working.currentArchiveId,
      archiveCount: activeArchiveCount,
      changes: working.changes,
      hasChanges: working.changes.length > 0,
      lastCheckedAt: Date.now()
    };
  }

  public getAllProjectStatuses(): WorkspaceStatus[] {
    return this.config.projects.map((p) => this.getProjectStatus(p.id));
  }
}
