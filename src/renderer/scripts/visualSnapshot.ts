import { ArchiveRecord, VisualSnapshotItem } from './types.js';
import { formatBytes } from './i18n.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface FileVisualBadge {
  label: string;
  bg: string;
  fg: string;
}

function getFileBadge(item: VisualSnapshotItem): FileVisualBadge {
  if (item.kind === 'directory') {
    return { label: 'DIR', bg: '#FEF3C7', fg: '#B45309' };
  }
  const ext = item.ext.toLowerCase();
  if (['doc', 'docx', 'rtf'].includes(ext)) return { label: 'W', bg: '#DBEAFE', fg: '#1D4ED8' };
  if (['xls', 'xlsx', 'csv'].includes(ext)) return { label: 'X', bg: '#D1FAE5', fg: '#047857' };
  if (['opju', 'opj', 'ogwu', 'ogg'].includes(ext)) return { label: 'Origin', bg: '#FFEDD5', fg: '#C2410C' };
  if (['ppt', 'pptx'].includes(ext)) return { label: 'P', bg: '#FEE2E2', fg: '#B91C1C' };
  if (ext === 'pdf') return { label: 'PDF', bg: '#FCE7F3', fg: '#BE185D' };
  if (['dwg', 'dxf', 'step', 'stp', 'stl', 'mph', 'sldprt'].includes(ext)) {
    return { label: 'CAD', bg: '#E0E7FF', fg: '#4338CA' };
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'tif', 'tiff', 'webp'].includes(ext)) {
    return { label: 'IMG', bg: '#F3E8FF', fg: '#7E22CE' };
  }
  if (['md', 'txt', 'tex', 'json', 'py', 'ts', 'js'].includes(ext)) {
    return { label: ext.toUpperCase().slice(0, 4), bg: '#F1F5F9', fg: '#334155' };
  }
  return { label: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', bg: '#F1F5F9', fg: '#475569' };
}

/**
 * 提取指定子目录层级（dirPrefix 为 "" 表示根目录）下的直接文件与子文件夹
 * 完美支持多级逐层下钻，同时在万级文件场景下自动截断分页，不卡顿不凌乱
 */
export function buildArchiveLevelItems(
  arc: ArchiveRecord,
  dirPrefix = ''
): Array<VisualSnapshotItem & { childCount?: number }> {
  const prefix = dirPrefix ? `${dirPrefix}/` : '';
  const map = new Map<string, VisualSnapshotItem & { childCount?: number }>();

  for (const d of arc.directories || []) {
    if (prefix && !d.startsWith(prefix)) continue;
    const rest = prefix ? d.slice(prefix.length) : d;
    if (!rest) continue;
    const top = rest.split('/')[0];
    const fullPath = prefix ? `${prefix}${top}` : top;
    if (!map.has(top)) {
      map.set(top, { name: top, path: fullPath, kind: 'directory', ext: '', size: 0, childCount: 0 });
    }
  }

  for (const entry of Object.values(arc.files)) {
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const rest = prefix ? entry.path.slice(prefix.length) : entry.path;
    if (!rest) continue;
    const parts = rest.split('/');
    if (parts.length === 1) {
      const name = parts[0];
      const dotIdx = name.lastIndexOf('.');
      const ext = dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : '';
      map.set(name, { name, path: entry.path, kind: 'file', ext, size: entry.size });
    } else {
      const subDir = parts[0];
      const fullPath = prefix ? `${prefix}${subDir}` : subDir;
      const existing = map.get(subDir);
      if (existing) {
        existing.size += entry.size;
        existing.childCount = (existing.childCount || 0) + 1;
      } else {
        map.set(subDir, {
          name: subDir,
          path: fullPath,
          kind: 'directory',
          ext: '',
          size: entry.size,
          childCount: 1
        });
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function buildArchiveVisualItems(arc: ArchiveRecord): VisualSnapshotItem[] {
  return buildArchiveLevelItems(arc, '');
}

export function renderCompactVisualStrip(arc: ArchiveRecord, maxTiles = 6): string {
  const items = buildArchiveLevelItems(arc, '');
  if (items.length === 0) return '';

  const shown = items.slice(0, maxTiles);
  const rest = items.length - shown.length;

  const tiles = shown
    .map((item) => {
      const b = getFileBadge(item);
      return `
        <span class="visual-mini-chip" title="${escapeHtml(item.name)}${item.kind === 'file' ? ` (${formatBytes(item.size)})` : ` (文件夹 · ${item.childCount || 0} 文件)`}">
          <span class="visual-mini-badge" style="background:${b.bg};color:${b.fg};">${escapeHtml(b.label)}</span>
          <span class="visual-mini-name">${escapeHtml(item.name)}</span>
        </span>
      `;
    })
    .join('');

  return `<div class="visual-strip">${tiles}${rest > 0 ? `<span class="visual-mini-more">+${rest} 项</span>` : ''}</div>`;
}

/**
 * 渲染多级可下钻视觉目录浏览器（支持点击文件夹进入下一级 + 面包屑返回 + 60 项安全截断防万级文件卡顿）
 */
export function mountInteractiveVisualBrowser(
  container: HTMLElement,
  arc: ArchiveRecord,
  onJumpToMatrix?: (relPath: string) => void
): void {
  let currentDir = '';
  let pageLimit = 60;

  const draw = () => {
    const allItems = buildArchiveLevelItems(arc, currentDir);
    const visible = allItems.slice(0, pageLimit);
    const remaining = allItems.length - visible.length;

    const crumbs = currentDir ? currentDir.split('/') : [];
    let acc = '';
    const crumbHtml = [
      `<button class="v-crumb ${currentDir === '' ? 'active' : ''}" data-dir="">根目录</button>`,
      ...crumbs.map((seg, i) => {
        acc = acc ? `${acc}/${seg}` : seg;
        return `<span class="v-crumb-sep">/</span><button class="v-crumb ${i === crumbs.length - 1 ? 'active' : ''}" data-dir="${escapeHtml(acc)}">${escapeHtml(seg)}</button>`;
      })
    ].join('');

    const cards = visible
      .map((item) => {
        const b = getFileBadge(item);
        const iconHtml =
          item.kind === 'directory'
            ? `<div class="visual-tile-icon folder-icon" style="background:${b.bg};color:${b.fg};">
                 <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>
               </div>`
            : `<div class="visual-tile-icon" style="background:${b.bg};color:${b.fg};">${escapeHtml(b.label)}</div>`;

        const sub =
          item.kind === 'directory'
            ? `${item.childCount || 0} 文件`
            : formatBytes(item.size);

        return `
          <div class="visual-tile ${item.kind === 'directory' ? 'clickable-dir' : 'clickable-file'}" data-kind="${item.kind}" data-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)} · ${sub}${item.kind === 'directory' ? '（点击进入子文件夹）' : '（右键或双击转到表格追踪）'}">
            ${iconHtml}
            <div class="visual-tile-name">${escapeHtml(item.name)}</div>
            <div class="visual-tile-sub">${sub}</div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="v-breadcrumb">${crumbHtml}</div>
      ${
        visible.length === 0
          ? '<div style="padding:14px;color:var(--text-muted);font-size:12px;text-align:center;">空目录</div>'
          : `<div class="visual-grid">${cards}</div>`
      }
      ${
        remaining > 0
          ? `<div style="text-align:center;margin-top:8px;"><button class="btn btn-ghost btn-sm v-load-more">还有 ${remaining} 项未显示 · 点击加载更多</button></div>`
          : ''
      }
    `;

    container.querySelectorAll<HTMLButtonElement>('.v-crumb').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentDir = btn.dataset.dir || '';
        pageLimit = 60;
        draw();
      });
    });

    container.querySelectorAll<HTMLElement>('.visual-tile').forEach((tile) => {
      const kind = tile.dataset.kind;
      const p = tile.dataset.path || '';
      if (kind === 'directory') {
        tile.addEventListener('click', () => {
          currentDir = p;
          pageLimit = 60;
          draw();
        });
      } else if (onJumpToMatrix) {
        tile.addEventListener('dblclick', () => onJumpToMatrix(p));
        tile.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          onJumpToMatrix(p);
        });
      }
    });

    container.querySelector('.v-load-more')?.addEventListener('click', () => {
      pageLimit += 60;
      draw();
    });
  };

  draw();
}

export function renderVisualTileGrid(items: VisualSnapshotItem[], emptyText = '空目录', limit = 60): string {
  if (!items || items.length === 0) {
    return `<div style="padding:14px;color:var(--text-muted);font-size:12px;text-align:center;">${escapeHtml(emptyText)}</div>`;
  }

  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;

  const cards = shown
    .map((item) => {
      const b = getFileBadge(item);
      const iconHtml =
        item.kind === 'directory'
          ? `<div class="visual-tile-icon folder-icon" style="background:${b.bg};color:${b.fg};">
               <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>
             </div>`
          : `<div class="visual-tile-icon" style="background:${b.bg};color:${b.fg};">${escapeHtml(b.label)}</div>`;

      return `
        <div class="visual-tile" title="${escapeHtml(item.name)}${item.kind === 'file' ? ` · ${formatBytes(item.size)}` : ' · 文件夹'}">
          ${iconHtml}
          <div class="visual-tile-name">${escapeHtml(item.name)}</div>
          <div class="visual-tile-sub">${item.kind === 'directory' ? '文件夹' : formatBytes(item.size)}</div>
        </div>
      `;
    })
    .join('');

  return `<div class="visual-grid">${cards}</div>${rest > 0 ? `<div style="font-size:11px;color:var(--text-muted);text-align:center;margin-top:6px;">仅展示前 ${limit} 项（共 ${items.length} 项）</div>` : ''}`;
}
