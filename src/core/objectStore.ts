import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

/**
 * 基于 SHA-256 的本地内容寻址对象存储 (Content-Addressable Storage)
 * - 相同内容文件全局仅存储一份（去重增量存储）
 * - 使用 zlib deflate 压缩存储，显著减少文档、文本与工程文件空间占用
 * - 写入采用 临时文件 + 原子重命名，防止断电或异常中断导致对象损坏
 */
export class ObjectStore {
  private readonly objectsDir: string;

  constructor(repoMetaDir: string) {
    this.objectsDir = path.join(repoMetaDir, 'objects');
  }

  public init(): void {
    fs.mkdirSync(this.objectsDir, { recursive: true });
  }

  /**
   * 校验哈希格式，防止路径遍历攻击
   */
  private assertValidHash(hash: string): void {
    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error(`无效的对象哈希格式: ${hash}`);
    }
  }

  public getObjectPath(hash: string): string {
    this.assertValidHash(hash);
    const prefix = hash.slice(0, 2).toLowerCase();
    const rest = hash.slice(2).toLowerCase();
    return path.join(this.objectsDir, prefix, rest);
  }

  public hasObject(hash: string): boolean {
    return fs.existsSync(this.getObjectPath(hash));
  }

  /**
   * 计算文件 SHA-256 哈希
   */
  public static hashBuffer(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * 流式计算大文件 SHA-256 哈希（避免超大文件占满内存）
   */
  public static hashFileSync(filePath: string): { hash: string; size: number; isBinary: boolean } {
    const fd = fs.openSync(filePath, 'r');
    const hash = crypto.createHash('sha256');
    const chunkSize = 1024 * 1024; // 1MB 分块读取
    const buffer = Buffer.allocUnsafe(chunkSize);
    let totalSize = 0;
    let isBinary = false;
    let checkedBinary = false;

    try {
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null);
        if (bytesRead <= 0) break;
        const slice = bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead);
        hash.update(slice);
        if (!checkedBinary) {
          isBinary = ObjectStore.detectBinary(slice);
          checkedBinary = true;
        }
        totalSize += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }

    return {
      hash: hash.digest('hex'),
      size: totalSize,
      isBinary
    };
  }

  /**
   * 检测缓冲区是否为二进制文件（检查前 8KB 是否包含 NUL 字节或高比例控制字符）
   */
  public static detectBinary(buf: Buffer): boolean {
    const checkLen = Math.min(buf.length, 8192);
    if (checkLen === 0) return false;
    let suspicious = 0;
    for (let i = 0; i < checkLen; i++) {
      const byte = buf[i];
      if (byte === 0) return true;
      if (byte < 7 || (byte > 14 && byte < 32)) {
        suspicious++;
      }
    }
    return suspicious / checkLen > 0.3;
  }

  /**
   * 将本地文件压缩存入对象库（若哈希已存在则直接复用，实现零冗余增量存储）
   */
  public putFile(filePath: string, knownHash?: string): { hash: string; size: number; isBinary: boolean; existed: boolean } {
    const info = knownHash
      ? {
          hash: knownHash,
          size: fs.statSync(filePath).size,
          isBinary: ObjectStore.detectBinary(this.readHeadBytes(filePath, 8192))
        }
      : ObjectStore.hashFileSync(filePath);

    const objPath = this.getObjectPath(info.hash);
    if (fs.existsSync(objPath)) {
      return { ...info, existed: true };
    }

    const parentDir = path.dirname(objPath);
    fs.mkdirSync(parentDir, { recursive: true });

    const raw = fs.readFileSync(filePath);
    const compressed = zlib.deflateSync(raw, { level: zlib.constants.Z_BEST_SPEED });
    const tmpPath = `${objPath}.${process.pid}.${Date.now()}.tmp`;

    fs.writeFileSync(tmpPath, compressed);
    try {
      fs.renameSync(tmpPath, objPath);
    } catch (err) {
      // 并发写入同一对象时目标可能已存在
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      if (!fs.existsSync(objPath)) {
        throw err;
      }
    }

    return { ...info, existed: false };
  }

  private readHeadBytes(filePath: string, maxBytes: number): Buffer {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * 读取对象原始内容并校验 SHA-256 完整性
   */
  public readObject(hash: string): Buffer {
    const objPath = this.getObjectPath(hash);
    if (!fs.existsSync(objPath)) {
      throw new Error(`历史对象缺失，无法读取: ${hash.slice(0, 12)}`);
    }
    const compressed = fs.readFileSync(objPath);
    const raw = zlib.inflateSync(compressed);
    const actualHash = ObjectStore.hashBuffer(raw);
    if (actualHash !== hash.toLowerCase()) {
      throw new Error(`历史对象完整性校验失败: 期望 ${hash.slice(0, 12)}, 实际 ${actualHash.slice(0, 12)}`);
    }
    return raw;
  }

  /**
   * 将对象原子恢复写入目标文件路径
   */
  public restoreToFile(hash: string, targetPath: string, mtimeMs?: number): void {
    const raw = this.readObject(hash);
    const parentDir = path.dirname(targetPath);
    fs.mkdirSync(parentDir, { recursive: true });

    // Windows 下如果目标文件是只读属性，先解除只读
    if (fs.existsSync(targetPath)) {
      try {
        fs.chmodSync(targetPath, 0o666);
      } catch { /* ignore */ }
    }

    const tmpPath = `${targetPath}.ec_restore_${process.pid}_${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, raw);
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch {
      // Windows 偶发跨卷或文件句柄占用时回退为直接覆盖写入
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      fs.writeFileSync(targetPath, raw);
    }

    if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) && mtimeMs > 0) {
      const dt = new Date(mtimeMs);
      try {
        fs.utimesSync(targetPath, dt, dt);
      } catch { /* ignore */ }
    }
  }

  /**
   * 统计对象库实际压缩占用空间与对象数量
   */
  public getDiskStats(): { objectCount: number; compressedBytes: number } {
    if (!fs.existsSync(this.objectsDir)) {
      return { objectCount: 0, compressedBytes: 0 };
    }
    let objectCount = 0;
    let compressedBytes = 0;

    for (const prefix of fs.readdirSync(this.objectsDir)) {
      const subDir = path.join(this.objectsDir, prefix);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(subDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      for (const file of fs.readdirSync(subDir)) {
        if (file.endsWith('.tmp')) continue;
        const full = path.join(subDir, file);
        try {
          const fStat = fs.statSync(full);
          if (fStat.isFile()) {
            objectCount++;
            compressedBytes += fStat.size;
          }
        } catch {
          continue;
        }
      }
    }

    return { objectCount, compressedBytes };
  }

  /**
   * 垃圾回收 (GC)：清理不再被任何存档引用的孤立对象
   */
  public garbageCollect(referencedHashes: Set<string>): { removedObjects: number; freedBytes: number } {
    if (!fs.existsSync(this.objectsDir)) {
      return { removedObjects: 0, freedBytes: 0 };
    }

    const normalizedRefs = new Set<string>();
    for (const h of referencedHashes) {
      normalizedRefs.add(h.toLowerCase());
    }

    let removedObjects = 0;
    let freedBytes = 0;

    for (const prefix of fs.readdirSync(this.objectsDir)) {
      const subDir = path.join(this.objectsDir, prefix);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(subDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const entries = fs.readdirSync(subDir);
      for (const file of entries) {
        const full = path.join(subDir, file);
        const hash = `${prefix}${file}`.toLowerCase();
        if (file.endsWith('.tmp') || !normalizedRefs.has(hash)) {
          try {
            const fStat = fs.statSync(full);
            fs.unlinkSync(full);
            removedObjects++;
            freedBytes += fStat.size;
          } catch {
            // 忽略占用失败
          }
        }
      }

      // 清理空桶目录
      try {
        if (fs.readdirSync(subDir).length === 0) {
          fs.rmdirSync(subDir);
        }
      } catch { /* ignore */ }
    }

    return { removedObjects, freedBytes };
  }
}
