import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { FileEntry } from './types';

export type TempHistoryOpType = 'modified' | 'renamed' | 'created' | 'deleted';

export interface TempHistoryEntry {
  id: string;
  /** 该文件在本次未存档周期内的第 N 次临时记录（1, 2, 3...） */
  seq: number;
  path: string;
  previousPath?: string;
  opType: TempHistoryOpType;
  hash: string | null;
  size: number;
  timestamp: number;
  /** 是否与当前磁盘上的文件内容一致（读取时动态计算） */
  isCurrentOnDisk?: boolean;
}

interface TempSnapshotMeta {
  hash: string;
  size: number;
}

interface TempHistoryIndex {
  schemaVersion: number;
  baselineArchiveId: string | null;
  lastSnapshot: Record<string, TempSnapshotMeta>;
  entries: TempHistoryEntry[];
}

/**
 * 临时历史文件引擎（Staging Local Draft History）：
 * - 在两次正式「时间盒子存档」之间，自动捕捉每一次文件保存、编辑、新建、重命名与删除
 * - 压缩存储在 .chronobox/temp_history/blobs/（SHA-256 去重），不污染主界面时间轴与表格列
 * - 仅在用户点击表格中的具体文件/实时方格时，于右侧检视器中展示并支持一键回退到任意临时次数
 * - 一旦用户执行正式「存档」或切换存档，自动清空本周期临时历史文件，只保留最终存档
 */
export class TempHistoryStore {
  private readonly dirPath: string;
  private readonly blobsDir: string;
  private readonly indexPath: string;

  constructor(metaDir: string) {
    this.dirPath = path.join(metaDir, 'temp_history');
    this.blobsDir = path.join(this.dirPath, 'blobs');
    this.indexPath = path.join(this.dirPath, 'index.json');
  }

  private ensureDirs(): void {
    fs.mkdirSync(this.blobsDir, { recursive: true });
  }

  private blobPath(hash: string): string {
    return path.join(this.blobsDir, `${hash}.z`);
  }

  private putBlobFromFile(absPath: string, hash: string): void {
    this.ensureDirs();
    const dest = this.blobPath(hash);
    if (fs.existsSync(dest)) return;
    const raw = fs.readFileSync(absPath);
    const compressed = zlib.deflateSync(raw, { level: 6 });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, compressed);
    try {
      fs.renameSync(tmp, dest);
    } catch {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      if (!fs.existsSync(dest)) {
        fs.writeFileSync(dest, compressed);
      }
    }
  }

  private loadIndex(baselineArchiveId: string | null, baselineFiles: Record<string, FileEntry>): TempHistoryIndex {
    if (fs.existsSync(this.indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as TempHistoryIndex;
        if (parsed && parsed.baselineArchiveId === baselineArchiveId && Array.isArray(parsed.entries)) {
          return parsed;
        }
      } catch { /* fallback to fresh index */ }
    }
    const snap: Record<string, TempSnapshotMeta> = {};
    for (const [rel, f] of Object.entries(baselineFiles)) {
      snap[rel] = { hash: f.hash, size: f.size };
    }
    return {
      schemaVersion: 1,
      baselineArchiveId,
      lastSnapshot: snap,
      entries: []
    };
  }

  private saveIndex(index: TempHistoryIndex): void {
    this.ensureDirs();
    const tmp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
    try {
      fs.renameSync(tmp, this.indexPath);
    } catch {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    }
  }

  /**
   * 对比上次临时快照与当前磁盘扫描结果，自动记录所有新建/修改/重命名/删除的临时历史
   */
  public captureFromScan(
    currentFiles: Record<string, FileEntry>,
    baselineFiles: Record<string, FileEntry>,
    baselineArchiveId: string | null,
    rootPath: string
  ): TempHistoryEntry[] {
    const index = this.loadIndex(baselineArchiveId, baselineFiles);
    const prev = index.lastSnapshot;
    const now = Date.now();
    const addedEntries: TempHistoryEntry[] = [];

    const vanished: Array<{ path: string; meta: TempSnapshotMeta }> = [];
    const appeared: Array<{ path: string; entry: FileEntry }> = [];
    const modified: Array<{ path: string; entry: FileEntry }> = [];

    for (const [rel, oldMeta] of Object.entries(prev)) {
      const cur = currentFiles[rel];
      if (!cur) {
        vanished.push({ path: rel, meta: oldMeta });
      } else if (cur.hash !== oldMeta.hash) {
        modified.push({ path: rel, entry: cur });
      }
    }

    for (const [rel, cur] of Object.entries(currentFiles)) {
      if (!prev[rel]) {
        appeared.push({ path: rel, entry: cur });
      }
    }

    if (vanished.length === 0 && appeared.length === 0 && modified.length === 0) {
      return [];
    }

    const nextSeqFor = (relPath: string): number => {
      let maxSeq = 0;
      for (const e of index.entries) {
        if (e.path === relPath && e.seq > maxSeq) maxSeq = e.seq;
      }
      return maxSeq + 1;
    };

    // 1. 优先识别「重命名」（消失文件与新增文件 SHA-256 哈希完全一致）
    const matchedVanished = new Set<string>();
    const matchedAppeared = new Set<string>();

    for (const app of appeared) {
      const match = vanished.find(
        (v) => !matchedVanished.has(v.path) && v.meta.hash === app.entry.hash
      );
      if (match) {
        matchedVanished.add(match.path);
        matchedAppeared.add(app.path);
        const abs = path.join(rootPath, ...app.path.split('/'));
        try {
          if (fs.existsSync(abs)) this.putBlobFromFile(abs, app.entry.hash);
        } catch { /* ignore locked file */ }

        // 将旧路径在本周期的临时记录路径同步归并到新路径下，使单文件临时历史连贯不断裂
        for (const existing of index.entries) {
          if (existing.path === match.path) {
            existing.path = app.path;
          }
        }

        const rec: TempHistoryEntry = {
          id: `tmp_${now}_${crypto.randomBytes(3).toString('hex')}`,
          seq: nextSeqFor(app.path),
          path: app.path,
          previousPath: match.path,
          opType: 'renamed',
          hash: app.entry.hash,
          size: app.entry.size,
          timestamp: now
        };
        index.entries.push(rec);
        addedEntries.push(rec);
      }
    }

    // 2. 记录内容「修改」
    for (const mod of modified) {
      const abs = path.join(rootPath, ...mod.path.split('/'));
      try {
        if (fs.existsSync(abs)) this.putBlobFromFile(abs, mod.entry.hash);
      } catch {
        continue; // 文件被占用暂时跳过，下次触发再记录
      }
      const rec: TempHistoryEntry = {
        id: `tmp_${now}_${crypto.randomBytes(3).toString('hex')}`,
        seq: nextSeqFor(mod.path),
        path: mod.path,
        opType: 'modified',
        hash: mod.entry.hash,
        size: mod.entry.size,
        timestamp: now
      };
      index.entries.push(rec);
      addedEntries.push(rec);
    }

    // 3. 记录「新建」
    for (const app of appeared) {
      if (matchedAppeared.has(app.path)) continue;
      const abs = path.join(rootPath, ...app.path.split('/'));
      try {
        if (fs.existsSync(abs)) this.putBlobFromFile(abs, app.entry.hash);
      } catch {
        continue;
      }
      const rec: TempHistoryEntry = {
        id: `tmp_${now}_${crypto.randomBytes(3).toString('hex')}`,
        seq: nextSeqFor(app.path),
        path: app.path,
        opType: 'created',
        hash: app.entry.hash,
        size: app.entry.size,
        timestamp: now
      };
      index.entries.push(rec);
      addedEntries.push(rec);
    }

    // 4. 记录「删除」
    for (const van of vanished) {
      if (matchedVanished.has(van.path)) continue;
      const rec: TempHistoryEntry = {
        id: `tmp_${now}_${crypto.randomBytes(3).toString('hex')}`,
        seq: nextSeqFor(van.path),
        path: van.path,
        opType: 'deleted',
        hash: null,
        size: 0,
        timestamp: now
      };
      index.entries.push(rec);
      addedEntries.push(rec);
    }

    // 更新 lastSnapshot 为最新磁盘状态
    const nextSnap: Record<string, TempSnapshotMeta> = {};
    for (const [rel, cur] of Object.entries(currentFiles)) {
      nextSnap[rel] = { hash: cur.hash, size: cur.size };
    }
    index.lastSnapshot = nextSnap;
    this.saveIndex(index);

    return addedEntries;
  }

  /**
   * 获取指定文件在当前未存档周期内的全部临时历史记录
   */
  public getFileHistory(
    relPath: string,
    baselineArchiveId: string | null,
    baselineFiles: Record<string, FileEntry>,
    currentFiles?: Record<string, FileEntry>
  ): TempHistoryEntry[] {
    const index = this.loadIndex(baselineArchiveId, baselineFiles);
    const curFile = currentFiles ? currentFiles[relPath] : undefined;
    const list = index.entries
      .filter((e) => e.path === relPath)
      .sort((a, b) => a.seq - b.seq);

    // 标记哪一条与当前磁盘上的文件完全一致（从最新往前匹配第一条）
    let marked = false;
    const result = list.map((e) => ({ ...e, isCurrentOnDisk: false }));
    if (curFile) {
      for (let i = result.length - 1; i >= 0; i--) {
        if (!marked && result[i].hash && result[i].hash === curFile.hash) {
          result[i].isCurrentOnDisk = true;
          marked = true;
          break;
        }
      }
    }
    return result;
  }

  /**
   * 将文件回退到指定的某次临时历史版本（不触发正式存档，保留全部临时记录供随时再次切换）
   */
  public restoreEntry(
    entryId: string,
    rootPath: string,
    baselineArchiveId: string | null,
    baselineFiles: Record<string, FileEntry>
  ): { entry: TempHistoryEntry; restoredPath: string } {
    const index = this.loadIndex(baselineArchiveId, baselineFiles);
    const entry = index.entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new Error('找不到该条临时历史记录（可能已随正式存档清理）');
    }
    if (!entry.hash) {
      throw new Error('该条记录为“删除”事件，请选择其之前的修改记录进行回退');
    }

    const bPath = this.blobPath(entry.hash);
    if (!fs.existsSync(bPath)) {
      throw new Error('临时历史快照数据文件缺失，无法回退');
    }

    const raw = zlib.inflateSync(fs.readFileSync(bPath));
    const destAbs = path.join(rootPath, ...entry.path.split('/'));
    const normalizedRoot = path.resolve(rootPath);
    const normalizedDest = path.resolve(destAbs);
    if (!normalizedDest.startsWith(normalizedRoot + path.sep)) {
      throw new Error('非法目标路径');
    }

    fs.mkdirSync(path.dirname(normalizedDest), { recursive: true });
    try {
      fs.writeFileSync(normalizedDest, raw);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        throw new Error(`无法回退「${path.basename(normalizedDest)}」：文件正被 Word / Origin 等软件占用，请先关闭该文件后重试`);
      }
      throw err;
    }

    // 同步更新 lastSnapshot，避免回退动作本身被监听引擎再次误记为新修改
    index.lastSnapshot[entry.path] = { hash: entry.hash, size: raw.length };
    this.saveIndex(index);

    return { entry, restoredPath: normalizedDest };
  }

  /**
   * 正式存档或切换存档后自动清空全部临时历史文件
   */
  public clear(newBaselineArchiveId: string | null, newBaselineFiles: Record<string, FileEntry>): void {
    if (fs.existsSync(this.blobsDir)) {
      try {
        fs.rmSync(this.blobsDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    const snap: Record<string, TempSnapshotMeta> = {};
    for (const [rel, f] of Object.entries(newBaselineFiles)) {
      snap[rel] = { hash: f.hash, size: f.size };
    }
    this.saveIndex({
      schemaVersion: 1,
      baselineArchiveId: newBaselineArchiveId,
      lastSnapshot: snap,
      entries: []
    });
  }
}
