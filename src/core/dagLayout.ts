import { ArchiveRecord, DagEdgeLayout, DagGraphLayout, DagNodeLayout } from './types';

const BRANCH_PALETTE = [
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#06B6D4'
];

export function computeDagLayout(
  archives: Record<string, ArchiveRecord>,
  currentArchiveId: string | null
): DagGraphLayout {
  const all = Object.values(archives).filter((a) => !a.archived);
  if (all.length === 0) {
    return { nodes: [], edges: [], width: 640, height: 320 };
  }

  const activeMap = new Map<string, ArchiveRecord>();
  for (const arc of all) activeMap.set(arc.id, arc);

  const childrenMap = new Map<string | null, ArchiveRecord[]>();
  for (const arc of all) {
    const parentKey = arc.parentId && activeMap.has(arc.parentId) ? arc.parentId : null;
    const list = childrenMap.get(parentKey) || [];
    list.push(arc);
    childrenMap.set(parentKey, list);
  }
  for (const list of childrenMap.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }

  const NODE_W = 216;
  const NODE_H = 86;
  const COL_GAP = 72;
  const ROW_GAP = 42;
  const PAD_X = 48;
  const PAD_Y = 48;

  const nodes: DagNodeLayout[] = [];
  const nodeMap = new Map<string, DagNodeLayout>();
  const visited = new Set<string>();
  let nextLane = 0;

  const placeTree = (arc: ArchiveRecord, depth: number, lane: number, colorIdx: number): void => {
    if (visited.has(arc.id)) return;
    visited.add(arc.id);

    const x = PAD_X + depth * (NODE_W + COL_GAP);
    const y = PAD_Y + lane * (NODE_H + ROW_GAP);

    const layoutNode: DagNodeLayout = {
      id: arc.id,
      parentId: arc.parentId && activeMap.has(arc.parentId) ? arc.parentId : null,
      title: arc.title,
      createdAt: arc.createdAt,
      tags: arc.tags,
      customTags: arc.customTags || [],
      isAuto: arc.isAuto,
      isCurrent: arc.id === currentArchiveId,
      summary: arc.summary,
      depth,
      lane,
      x,
      y,
      branchColor: BRANCH_PALETTE[colorIdx % BRANCH_PALETTE.length]
    };

    nodes.push(layoutNode);
    nodeMap.set(arc.id, layoutNode);

    const children = childrenMap.get(arc.id) || [];
    children.forEach((child, idx) => {
      if (idx === 0) {
        placeTree(child, depth + 1, lane, colorIdx);
      } else {
        nextLane += 1;
        placeTree(child, depth + 1, nextLane, nextLane);
      }
    });
  };

  const roots = childrenMap.get(null) || [];
  roots.forEach((root, idx) => {
    if (idx > 0) nextLane += 1;
    placeTree(root, 0, nextLane, nextLane);
  });

  for (const arc of all) {
    if (!visited.has(arc.id)) {
      nextLane += 1;
      placeTree(arc, 0, nextLane, nextLane);
    }
  }

  const edges: DagEdgeLayout[] = [];
  for (const node of nodes) {
    if (node.parentId && nodeMap.has(node.parentId)) {
      const parent = nodeMap.get(node.parentId)!;
      edges.push({
        fromId: parent.id,
        toId: node.id,
        fromX: parent.x + NODE_W,
        fromY: parent.y + NODE_H / 2,
        toX: node.x,
        toY: node.y + NODE_H / 2,
        color: node.branchColor,
        isBranch: node.lane !== parent.lane
      });
    }
  }

  const maxX = nodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 0) + PAD_X;
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), 0) + PAD_Y;

  return { nodes, edges, width: Math.max(maxX, 640), height: Math.max(maxY, 320) };
}
