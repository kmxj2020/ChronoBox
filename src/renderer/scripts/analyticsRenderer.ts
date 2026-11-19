import {
  DuplicateScanResult,
  FileMilestoneItem,
  ProgressReportResult,
  ReportDailyPoint,
  ReportTypeSlice
} from './types.js';
import { formatBytes, formatTime } from './i18n.js';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 纯 SVG 每日存档与变更活跃度柱状图（响应式、零外部依赖、自动适配 6 套主题）
 */
function renderActivityBarChartSvg(points: ReportDailyPoint[]): string {
  if (points.length === 0) {
    return `<div style="height:165px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">该时间段暂无活跃数据</div>`;
  }
  const W = 380;
  const H = 175;
  const padL = 26;
  const padR = 12;
  const padT = 22;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxVal = Math.max(1, ...points.map((p) => p.changes || p.archives));

  const slotW = innerW / points.length;
  const barW = Math.min(28, Math.max(10, slotW * 0.56));

  const gridLines = [0, 0.5, 1]
    .map((ratio) => {
      const y = padT + innerH * (1 - ratio);
      const val = Math.round(maxVal * ratio);
      return `
        <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border-color)" stroke-dasharray="3 3" />
        <text x="${padL - 5}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--text-muted)">${val}</text>
      `;
    })
    .join('');

  const bars = points
    .map((p, i) => {
      const metric = p.changes || p.archives;
      const barH = metric > 0 ? Math.max(4, (metric / maxVal) * innerH) : 0;
      const x = padL + i * slotW + (slotW - barW) / 2;
      const y = padT + innerH - barH;
      const cx = x + barW / 2;
      return `
        <g>
          <title>${esc(p.fullDate)}：${p.archives} 个存档，${p.changes} 项文件变更</title>
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="var(--accent)" opacity="${metric > 0 ? '0.88' : '0.15'}" />
          ${metric > 0 ? `<text x="${cx.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="600" fill="var(--text-primary)">${metric}</text>` : ''}
          <text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="var(--text-secondary)">${esc(p.date)}</text>
        </g>
      `;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:175px;display:block;overflow:visible;">
      ${gridLines}
      ${bars}
    </svg>
  `;
}

/**
 * 纯 SVG 环形饼图 (Donut Chart) — 变更文件类型分布
 */
function renderFileTypeDonutSvg(slices: ReportTypeSlice[]): string {
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) {
    return `<div style="height:165px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;">暂无文件类型统计</div>`;
  }

  const R = 52;
  const cx = 68;
  const cy = 68;
  const circumference = 2 * Math.PI * R;
  let offset = 0;

  const rings = slices
    .map((s) => {
      const frac = s.count / total;
      const len = frac * circumference;
      const seg = `
        <circle
          cx="${cx}" cy="${cy}" r="${R}"
          fill="none"
          stroke="${s.color}"
          stroke-width="18"
          stroke-dasharray="${len.toFixed(2)} ${(circumference - len).toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"
          transform="rotate(-90 ${cx} ${cy})"
        >
          <title>${esc(s.label)}：${s.count} 次变更 (${Math.round(frac * 100)}%)</title>
        </circle>
      `;
      offset += len;
      return seg;
    })
    .join('');

  const legend = slices
    .slice(0, 6)
    .map((s) => {
      const pct = Math.round((s.count / total) * 100);
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;">
            <span style="width:9px;height:9px;border-radius:3px;background:${s.color};flex-shrink:0;"></span>
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.label)}</span>
          </span>
          <span style="color:var(--text-secondary);font-family:var(--font-mono);flex-shrink:0;">${s.count} (${pct}%)</span>
        </div>
      `;
    })
    .join('');

  return `
    <div style="display:flex;align-items:center;gap:16px;height:175px;">
      <svg viewBox="0 0 136 136" style="width:136px;height:136px;flex-shrink:0;">
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--bg-subtle)" stroke-width="18" />
        ${rings}
        <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="18" font-weight="800" fill="var(--text-primary)">${total}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10" fill="var(--text-muted)">次变更</text>
      </svg>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;">
        ${legend}
      </div>
    </div>
  `;
}

/**
 * 渲染完整的可视化项目周报看板（KPI + 柱状图 + 环形饼图 + 高频文档进度条 + 进展明细表）
 */
export function renderVisualProgressReport(container: HTMLElement, report: ProgressReportResult): void {
  const maxEdits = Math.max(1, ...report.topFiles.map((f) => f.editCount));

  const topFilesHtml =
    report.topFiles.length === 0
      ? '<div style="font-size:12px;color:var(--text-muted);padding:10px 0;">暂无高频推进文档</div>'
      : report.topFiles
          .map((f) => {
            const pct = Math.max(8, Math.round((f.editCount / maxEdits) * 100));
            return `
              <div style="display:flex;flex-direction:column;gap:4px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;gap:8px;">
                  <span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(f.projectName + ' / ' + f.relPath)}">
                    ${esc(f.name)} <span style="font-weight:400;color:var(--text-muted);font-size:11px;">· ${esc(f.projectName)}</span>
                  </span>
                  <span style="color:var(--accent);font-weight:700;flex-shrink:0;">${f.editCount} 次 · ${formatBytes(f.latestSize)}</span>
                </div>
                <div style="height:6px;background:var(--bg-subtle);border-radius:99px;overflow:hidden;">
                  <div style="width:${pct}%;height:100%;background:var(--accent-gradient);border-radius:99px;"></div>
                </div>
              </div>
            `;
          })
          .join('');

  const tableRowsHtml =
    report.milestones.length === 0
      ? `<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-muted);">所选周期内暂无正式时间盒子存档</td></tr>`
      : report.milestones
          .map(
            (m) => `
          <tr>
            <td style="white-space:nowrap;color:var(--text-secondary);font-family:var(--font-mono);font-size:11.5px;">${esc(m.date)}</td>
            <td><strong>${esc(m.title)}</strong><div style="font-size:11px;color:var(--text-muted);">${esc(m.projectName)}</div></td>
            <td style="white-space:nowrap;">
              ${m.added > 0 ? `<span class="chip add">+${m.added}</span>` : ''}
              ${m.modified > 0 ? `<span class="chip mod">~${m.modified}</span>` : ''}
              ${m.deleted > 0 ? `<span class="chip del">-${m.deleted}</span>` : ''}
              <span style="font-size:11px;color:var(--text-muted);margin-left:4px;">${m.totalFiles}文件 · ${formatBytes(m.totalSize)}</span>
            </td>
            <td style="font-size:11.5px;color:var(--text-secondary);">${esc(m.note || '—')}</td>
          </tr>`
          )
          .join('');

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px;">
      <div class="stat-box" style="padding:12px;">
        <div class="stat-value" style="font-size:22px;">${report.archiveCount}</div>
        <div class="stat-label">周期内时间盒子</div>
      </div>
      <div class="stat-box" style="padding:12px;">
        <div class="stat-value" style="font-size:22px;">${report.touchedFilesCount}</div>
        <div class="stat-label">推进核心文件数</div>
      </div>
      <div class="stat-box" style="padding:12px;">
        <div class="stat-value" style="font-size:22px;color:var(--diff-add-fg);">+${report.totalAdded} <span style="font-size:14px;color:var(--diff-mod-fg);">~${report.totalModified}</span></div>
        <div class="stat-label">新增 / 编辑累计</div>
      </div>
      <div class="stat-box" style="padding:12px;">
        <div class="stat-value" style="font-size:22px;">${report.projectCount}</div>
        <div class="stat-label">活跃推进项目</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1.15fr 1fr;gap:12px;margin-bottom:14px;">
      <div class="settings-card" style="padding:14px;margin:0;">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:6px;">📈 每日文件变更活跃度（柱状图）</div>
        ${renderActivityBarChartSvg(report.dailyActivity)}
      </div>
      <div class="settings-card" style="padding:14px;margin:0;">
        <div style="font-size:12.5px;font-weight:700;margin-bottom:6px;">🍩 变更文档类型分布（环形饼图）</div>
        ${renderFileTypeDonutSvg(report.fileTypeBreakdown)}
      </div>
    </div>

    <div class="settings-card" style="padding:14px;margin:0 0 14px;">
      <div style="font-size:12.5px;font-weight:700;margin-bottom:10px;">🔥 高频推进文档排行</div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px;">
        ${topFilesHtml}
      </div>
    </div>

    <div class="settings-card" style="padding:14px;margin:0;">
      <div style="font-size:12.5px;font-weight:700;margin-bottom:8px;">📋 里程碑进展明细表</div>
      <div style="overflow-x:auto;">
        <table class="report-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>里程碑存档 / 项目</th>
              <th>变更统计</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>${tableRowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * 单文件体积演进折线图 (SVG Sparkline)
 */
export function renderFileSizeSparklineSvg(items: FileMilestoneItem[]): string {
  const valid = items.filter((m) => m.action !== 'deleted');
  if (valid.length < 2) return '';
  const W = 580;
  const H = 88;
  const padL = 16;
  const padR = 16;
  const padT = 18;
  const padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxSz = Math.max(1, ...valid.map((m) => m.size));
  const minSz = Math.min(...valid.map((m) => m.size));
  const span = Math.max(1, maxSz - minSz);

  const coords = valid.map((m, idx) => {
    const x = padL + (idx / (valid.length - 1)) * innerW;
    const y = padT + innerH - ((m.size - minSz) / span) * innerH;
    return { x, y, m };
  });

  const poly = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area = `${padL},${padT + innerH} ${poly} ${coords[coords.length - 1].x.toFixed(1)},${padT + innerH}`;

  const dots = coords
    .map(
      (c) => `
      <g>
        <title>${esc(c.m.versionLabel)} (${esc(c.m.title)}) · ${formatBytes(c.m.size)}</title>
        <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="var(--bg-surface)" stroke="var(--accent)" stroke-width="2.2" />
        <text x="${c.x.toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="9.5" fill="var(--text-muted)">${esc(c.m.versionLabel)}</text>
      </g>`
    )
    .join('');

  return `
    <div style="background:var(--bg-subtle);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">
        <span>📉 文件体积演进趋势（共 ${items.length} 个实质变更节点）</span>
        <span>最小 ${formatBytes(minSz)} → 最大 ${formatBytes(maxSz)}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:88px;display:block;">
        <polygon points="${area}" fill="var(--accent)" opacity="0.12" />
        <polyline points="${poly}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        ${dots}
      </svg>
    </div>
  `;
}

/**
 * 重复大文件空间占比可视化条
 */
export function renderDuplicateWasteBanner(res: DuplicateScanResult): string {
  const wastePct = res.totalWorkspaceBytes > 0 ? Math.min(100, Math.round((res.totalWastedBytes / res.totalWorkspaceBytes) * 100)) : 0;
  return `
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:10px;">
      <div class="stat-box" style="padding:10px;">
        <div class="stat-value" style="font-size:19px;">${res.groups.length} 组</div>
        <div class="stat-label">完全一致的重复文件组</div>
      </div>
      <div class="stat-box" style="padding:10px;">
        <div class="stat-value" style="font-size:19px;color:var(--status-dirty);">${res.totalDuplicateFiles} 个</div>
        <div class="stat-label">可瘦身的多余副本</div>
      </div>
      <div class="stat-box" style="padding:10px;">
        <div class="stat-value" style="font-size:19px;color:var(--diff-add-fg);">${formatBytes(res.totalWastedBytes)}</div>
        <div class="stat-label">可安全释放空间（占工作区 ${wastePct}%）</div>
      </div>
    </div>
    <div style="height:8px;background:var(--bg-subtle);border-radius:99px;overflow:hidden;margin-bottom:6px;">
      <div style="width:${Math.max(wastePct, res.groups.length > 0 ? 4 : 0)}%;height:100%;background:linear-gradient(90deg,#F59E0B,#EF4444);border-radius:99px;"></div>
    </div>
  `;
}

export function formatMilestoneTime(ts: number): string {
  return formatTime(ts);
}
