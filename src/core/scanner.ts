import * as fs from 'fs';
import * as path from 'path';
import { FileEntry } from './types';
import { IgnoreMatcher, normalizeRelPath } from './ignore';
import { ObjectStore } from './objectStore';

const RACY_MTIME_WINDOW_MS = 2000;

export interface WorkspaceScanResult {
  files: Record<string, FileEntry>;
  /** 完整记录所有非忽略子文件夹（包含空文件夹），解决仅新建文件夹无法被检测的问题 */
  directories: string[];
}

/**
 * 快速目录扫描器（同时扫描文件与空文件夹）
 */
export function scanWorkspaceFull(
  rootDir: string,
  ignoreMatcher: IgnoreMatcher,
  baselineFiles?: Record<string, FileEntry>
): WorkspaceScanResult {
  const files: Record<string, FileEntry> = {};
  const directories: string[] = [];

  if (!fs.existsSync(rootDir)) {
    return { files, directories };
  }

  const now = Date.now();

  const walk = (currentDir: string, relPrefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPath = normalizeRelPath(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      if (ignoreMatcher.isIgnored(relPath)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(relPath);
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }

        const mtimeMs = Math.floor(stat.mtimeMs);
        const baseline = baselineFiles?.[relPath];
        const isSafeToTrustStatCache = now - mtimeMs > RACY_MTIME_WINDOW_MS;

        if (
          isSafeToTrustStatCache &&
          baseline &&
          baseline.size === stat.size &&
          Math.floor(baseline.mtimeMs) === mtimeMs
        ) {
          files[relPath] = {
            path: relPath,
            hash: baseline.hash,
            size: stat.size,
            mtimeMs,
            isBinary: baseline.isBinary
          };
        } else {
          try {
            const hashed = ObjectStore.hashFileSync(fullPath);
            files[relPath] = {
              path: relPath,
              hash: hashed.hash,
              size: hashed.size,
              mtimeMs,
              isBinary: hashed.isBinary
            };
          } catch {
            continue;
          }
        }
      }
    }
  };

  walk(rootDir, '');
  directories.sort((a, b) => a.localeCompare(b));
  return { files, directories };
}

/**
 * 兼容旧接口：仅返回文件映射表
 */
export function scanWorkspace(
  rootDir: string,
  ignoreMatcher: IgnoreMatcher,
  baselineFiles?: Record<string, FileEntry>
): Record<string, FileEntry> {
  return scanWorkspaceFull(rootDir, ignoreMatcher, baselineFiles).files;
}
