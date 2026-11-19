/**
 * 忽略规则匹配器
 * 默认过滤内部仓库目录（.chronobox）、00【Archive】、Office 临时锁文件与系统缓存
 */

export const REPO_DIR_NAME = '.chronobox';
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  REPO_DIR_NAME,
  REPO_DIR_NAME,
  '00【Archive】',
  '.git',
  '.svn',
  'node_modules',
  '~$*',
  '*.tmp',
  '*.temp',
  '*.swp',
  '*.swo',
  '*.bak',
  '*.lnk',
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store',
  '__pycache__'
];

export function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function globToRegExp(pattern: string): RegExp {
  const cleaned = normalizeRelPath(pattern.trim());
  let regexStr = '^';
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === '*') {
      if (cleaned[i + 1] === '*') {
        regexStr += '.*';
        i += 2;
        if (cleaned[i] === '/') {
          regexStr += '(?:/)?';
          i += 1;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if ('\\^$+?.()|[]{}'.includes(ch)) {
      regexStr += '\\' + ch;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr, 'i');
}

export class IgnoreMatcher {
  private readonly segmentRegexes: RegExp[] = [];
  private readonly pathRegexes: RegExp[] = [];

  constructor(customPatterns: string[] = []) {
    const combined = [...DEFAULT_IGNORE_PATTERNS, ...customPatterns];
    const seen = new Set<string>();

    for (const raw of combined) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const normalized = normalizeRelPath(trimmed);
      if (!normalized) continue;

      if (normalized.includes('/')) {
        this.pathRegexes.push(globToRegExp(normalized));
      } else {
        this.segmentRegexes.push(globToRegExp(normalized));
      }
    }
  }

  public isIgnored(relPath: string): boolean {
    const normalized = normalizeRelPath(relPath);
    if (!normalized) return false;

    const segments = normalized.split('/');
    for (const seg of segments) {
      for (const re of this.segmentRegexes) {
        if (re.test(seg)) return true;
      }
    }

    for (const re of this.pathRegexes) {
      if (re.test(normalized)) return true;
    }

    return false;
  }
}
