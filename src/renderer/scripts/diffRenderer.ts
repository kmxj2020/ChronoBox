import { ArchiveDiffResult, FileDiffItem, TextDiffResult } from './types.js';
import { formatBytes } from './i18n.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染差异汇总条
 */
export function renderDiffSummaryBar(container: HTMLElement, diff: ArchiveDiffResult): void {
  container.innerHTML = `
    <span><strong>${escapeHtml(diff.fromTitle)}</strong> → <strong>${escapeHtml(diff.toTitle)}</strong></span>
    <span class="chip add">+${diff.summary.added} 新增</span>
    <span class="chip mod">~${diff.summary.modified} 修改</span>
    <span class="chip del">-${diff.summary.deleted} 删除</span>
    <span class="chip neutral">共 ${diff.items.length} 项变化</span>
  `;
}

/** 统一的空状态块：图标 + 主标题 + 说明，避免大片纯空白 */
function emptyBlock(title: string, desc: string, iconSvg: string): string {
  return `
    <div class="empty-block">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconSvg}</svg>
      <strong>${title}</strong>
      <span>${desc}</span>
    </div>`;
}

/**
 * 渲染差异文件清单
 */
export function renderDiffFileList(
  container: HTMLElement,
  diff: ArchiveDiffResult,
  selectedPath: string | null,
  onSelectFile: (item: FileDiffItem) => void
): void {
  container.innerHTML = '';

  if (diff.items.length === 0) {
    container.innerHTML = emptyBlock(
      '两个版本完全一致',
      '没有任何文件新增、修改或删除',
      '<path d="M20 6 9 17l-5-5"/>'
    );
    return;
  }

  for (const item of diff.items) {
    const row = document.createElement('div');
    row.className = `diff-file-item ${item.path === selectedPath ? 'active' : ''}`;

    const badgeClass = item.status === 'added' ? 'add' : item.status === 'modified' ? 'mod' : 'del';
    const badgeSymbol = item.status === 'added' ? '+' : item.status === 'modified' ? '~' : '-';
    const sizeText =
      item.status === 'added'
        ? formatBytes(item.newSize || 0)
        : item.status === 'deleted'
          ? formatBytes(item.oldSize || 0)
          : `${formatBytes(item.oldSize || 0)} → ${formatBytes(item.newSize || 0)}`;

    row.innerHTML = `
      <span class="chip ${badgeClass}">${badgeSymbol}</span>
      <div class="diff-file-path">
        <div>${escapeHtml(item.path)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${sizeText}${item.isBinary ? ' · 二进制' : ''}</div>
      </div>
    `;

    row.addEventListener('click', () => onSelectFile(item));
    container.appendChild(row);
  }
}

/**
 * 渲染右侧文件内容对比区（文本行级 Diff 或二进制元信息对比）
 */
export function renderTextDiffViewer(
  container: HTMLElement,
  item: FileDiffItem | null,
  textDiff: TextDiffResult | null
): void {
  if (!item) {
    container.innerHTML = emptyBlock(
      '选择一个变更文件',
      '点击左侧清单里的任意条目，即可逐行查看文本差异或二进制元信息',
      '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4"/><path d="M9 3v6h6V3"/><path d="M7 14h10M7 18h6"/>'
    );
    return;
  }

  if (!textDiff || textDiff.isBinary || item.isBinary) {
    container.innerHTML = `
      <div style="padding:18px 20px;">
        <h4 style="margin:0 0 8px;font-size:13.5px;font-weight:700;word-break:break-all;">${escapeHtml(item.path)}</h4>
        <div class="chip neutral" style="margin-bottom:14px;display:inline-block;">二进制文件（Office / CAD / PDF / 图片）· 按大小与 SHA-256 比对</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px;">
          <div class="stat-box">
            <div class="stat-label">基准版本大小</div>
            <div class="stat-value" style="font-size:15px;">${item.oldSize !== undefined ? formatBytes(item.oldSize) : '不存在'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--font-mono);">${item.oldHash ? item.oldHash.slice(0, 14) : '-'}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">目标版本大小</div>
            <div class="stat-value" style="font-size:15px;">${item.newSize !== undefined ? formatBytes(item.newSize) : '已删除'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--font-mono);">${item.newHash ? item.newHash.slice(0, 14) : '-'}</div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const headerHtml = `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
      <strong style="font-size:12.5px;">${escapeHtml(textDiff.path)}</strong>
      <div class="diff-chips">
        <span class="chip add">+${textDiff.additions} 行</span>
        <span class="chip del">-${textDiff.deletions} 行</span>
        ${textDiff.truncated ? '<span class="chip neutral">已截断超大文本</span>' : ''}
      </div>
    </div>
  `;

  const rowsHtml = textDiff.lines
    .map((line) => {
      const cls = line.type === 'add' ? 'diff-row-add' : line.type === 'remove' ? 'diff-row-remove' : '';
      const sign = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      return `
        <tr class="${cls}">
          <td class="diff-line-no">${line.oldLineNumber ?? ''}</td>
          <td class="diff-line-no">${line.newLineNumber ?? ''}</td>
          <td style="width:18px;user-select:none;">${sign}</td>
          <td>${escapeHtml(line.content)}</td>
        </tr>
      `;
    })
    .join('');

  container.innerHTML = `${headerHtml}<table class="diff-table"><tbody>${rowsHtml}</tbody></table>`;
}
