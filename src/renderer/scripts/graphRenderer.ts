import { DagGraphLayout, DagNodeLayout, TagColor } from './types.js';
import { formatTime } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAG_HEX: Record<TagColor, string> = {
  red: '#EF4444',
  yellow: '#F59E0B',
  green: '#10B981'
};

export interface GraphInteractionCallbacks {
  onSelectNode: (archiveId: string) => void;
  onDoubleClickNode: (archiveId: string) => void;
}

/**
 * 思维导图式存档关系视图 (升级版 SVG DAG 渲染器)
 * 具备柔和卡片投影、分支高亮曲线、画布拖拽平移与增量缩放
 */
export class DagGraphRenderer {
  private readonly svg: SVGSVGElement;
  private readonly wrap: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly callbacks: GraphInteractionCallbacks;

  private zoom = 1;
  private panX = 28;
  private panY = 28;
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private viewportGroup: SVGGElement | null = null;
  private lastLayout: DagGraphLayout | null = null;

  constructor(
    svg: SVGSVGElement,
    wrap: HTMLElement,
    zoomLabel: HTMLElement,
    callbacks: GraphInteractionCallbacks
  ) {
    this.svg = svg;
    this.wrap = wrap;
    this.zoomLabel = zoomLabel;
    this.callbacks = callbacks;
    this.bindInteractions();
  }

  private bindInteractions(): void {
    this.wrap.addEventListener('mousedown', (e) => {
      if ((e.target as Element)?.closest('.dag-node')) return;
      this.isDragging = true;
      this.dragStartX = e.clientX - this.panX;
      this.dragStartY = e.clientY - this.panY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.panX = e.clientX - this.dragStartX;
      this.panY = e.clientY - this.dragStartY;
      this.applyTransform();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    this.wrap.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        this.setZoom(this.zoom * factor);
      },
      { passive: false }
    );
  }

  public zoomBy(delta: number): void {
    this.setZoom(this.zoom + delta);
  }

  public setZoom(nextZoom: number): void {
    this.zoom = Math.max(0.4, Math.min(2.0, Number(nextZoom.toFixed(2))));
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.applyTransform();
  }

  public resetView(): void {
    if (!this.lastLayout) {
      this.zoom = 1;
      this.panX = 28;
      this.panY = 28;
      this.zoomLabel.textContent = '100%';
      this.applyTransform();
      return;
    }
    const rect = this.wrap.getBoundingClientRect();
    const fitX = rect.width > 0 ? Math.min(1, (rect.width - 40) / Math.max(this.lastLayout.width, 1)) : 1;
    const fitY = rect.height > 0 ? Math.min(1, (rect.height - 40) / Math.max(this.lastLayout.height, 1)) : 1;
    this.zoom = Math.max(0.5, Math.min(1, Number(Math.min(fitX, fitY).toFixed(2))));
    this.panX = 28;
    this.panY = 28;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.applyTransform();
  }

  private applyTransform(): void {
    if (this.viewportGroup) {
      this.viewportGroup.setAttribute('transform', `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`);
    }
  }

  private createEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    return el;
  }

  public render(layout: DagGraphLayout, selectedArchiveId: string | null, visibleIds?: Set<string>, activeChainIds?: Set<string>): void {
    this.lastLayout = layout;
    this.svg.innerHTML = '';

    // 柔和卡片投影滤镜
    const defs = this.createEl('defs', {});
    const filter = this.createEl('filter', { id: 'dagCardShadow', x: '-15%', y: '-15%', width: '130%', height: '140%' });
    const drop = this.createEl('feDropShadow', {
      dx: 0,
      dy: 4,
      stdDeviation: 5,
      'flood-color': '#0F172A',
      'flood-opacity': '0.09'
    });
    filter.appendChild(drop);
    defs.appendChild(filter);
    this.svg.appendChild(defs);

    const g = this.createEl('g', {
      transform: `translate(${this.panX}, ${this.panY}) scale(${this.zoom})`
    });
    this.viewportGroup = g;

    if (layout.nodes.length === 0) {
      const text = this.createEl('text', {
        x: 60,
        y: 80,
        fill: 'var(--text-muted)',
        'font-size': 13
      });
      text.textContent = '暂无存档关系节点，请先创建存档。';
      g.appendChild(text);
      this.svg.appendChild(g);
      return;
    }

    for (const edge of layout.edges) {
      const midX = (edge.fromX + edge.toX) / 2;
      const d = `M ${edge.fromX} ${edge.fromY} C ${midX} ${edge.fromY}, ${midX} ${edge.toY}, ${edge.toX} ${edge.toY}`;
      const path = this.createEl('path', {
        d,
        fill: 'none',
        stroke: edge.color,
        'stroke-width': edge.isBranch ? 2.2 : 1.8,
        'stroke-opacity': 0.62,
        'stroke-linecap': 'round'
      });
      g.appendChild(path);

      const startDot = this.createEl('circle', {
        cx: edge.fromX,
        cy: edge.fromY,
        r: 3,
        fill: edge.color,
        'fill-opacity': 0.65
      });
      const endDot = this.createEl('circle', {
        cx: edge.toX,
        cy: edge.toY,
        r: 4,
        fill: edge.color
      });
      g.appendChild(startDot);
      g.appendChild(endDot);
    }

    for (const node of layout.nodes) {
      const dimmed = visibleIds && !visibleIds.has(node.id);
      const onActive = Boolean(activeChainIds && activeChainIds.has(node.id));
      const group = this.renderNode(node, node.id === selectedArchiveId, Boolean(dimmed), onActive);
      g.appendChild(group);
    }

    this.svg.appendChild(g);
  }

  private renderNode(node: DagNodeLayout, isSelected: boolean, dimmed: boolean, onActiveBranch = false): SVGGElement {
    const NODE_W = 216;
    const NODE_H = 86;
    const group = this.createEl('g', {
      class: 'dag-node',
      transform: `translate(${node.x}, ${node.y})`,
      style: `cursor: pointer; opacity: ${dimmed ? 0.3 : 1};`
    });

    // 卡片：统一白底 + 发丝描边，仅用左侧色条与描边区分「当前 / 选中 / 旁支」，
    // 避免旧版「整块绿色填充」造成的视觉噪声（20 个节点时尤其明显）。
    const rect = this.createEl('rect', {
      class: 'dag-node-card',
      width: NODE_W,
      height: NODE_H,
      rx: 11,
      ry: 11,
      fill: 'var(--bg-surface)',
      stroke: isSelected || node.isCurrent ? 'var(--accent)' : 'var(--border-strong)',
      'stroke-width': isSelected || node.isCurrent ? 1.8 : 1,
      filter: 'url(#dagCardShadow)'
    });
    group.appendChild(rect);

    const bar = this.createEl('rect', {
      class: 'dag-node-bar',
      x: 0,
      y: 10,
      width: 3.5,
      height: NODE_H - 20,
      rx: 2,
      fill: onActiveBranch ? 'var(--status-synced)' : node.branchColor
    });
    group.appendChild(bar);

    const maxChars = 13;
    const titleStr = node.title.length > maxChars ? `${node.title.slice(0, maxChars)}…` : node.title;
    const titleEl = this.createEl('text', {
      x: 15,
      y: 28,
      fill: 'var(--text-primary)',
      'font-size': 12.5,
      'font-weight': 700
    });
    titleEl.textContent = titleStr;
    group.appendChild(titleEl);

    if (node.isCurrent) {
      const badgeBg = this.createEl('rect', {
        x: NODE_W - 48,
        y: 11,
        width: 38,
        height: 17,
        rx: 8.5,
        fill: 'var(--accent)'
      });
      const badgeTxt = this.createEl('text', {
        x: NODE_W - 29,
        y: 23,
        'text-anchor': 'middle',
        fill: '#ffffff',
        'font-size': 9.5,
        'font-weight': 700
      });
      badgeTxt.textContent = '当前';
      group.appendChild(badgeBg);
      group.appendChild(badgeTxt);
    }

    const timeEl = this.createEl('text', {
      x: 15,
      y: 48,
      fill: 'var(--text-muted)',
      'font-size': 10.5
    });
    timeEl.textContent = formatTime(node.createdAt);
    group.appendChild(timeEl);

    const statsEl = this.createEl('text', {
      x: 15,
      y: 70,
      fill: 'var(--text-secondary)',
      'font-size': 11,
      'font-weight': 500
    });
    statsEl.textContent = `+${node.summary.added}  ~${node.summary.modified}  -${node.summary.deleted}  · ${node.summary.totalFiles}文件`;
    group.appendChild(statsEl);

    node.tags.forEach((tag, idx) => {
      const dot = this.createEl('circle', {
        cx: NODE_W - 15 - idx * 13,
        cy: 66,
        r: 4.5,
        fill: TAG_HEX[tag]
      });
      group.appendChild(dot);
    });

    group.addEventListener('click', (e) => {
      e.stopPropagation();
      this.callbacks.onSelectNode(node.id);
    });

    group.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.callbacks.onDoubleClickNode(node.id);
    });

    return group;
  }
}
