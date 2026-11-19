import { LanguageCode } from './types.js';

const DICT: Record<LanguageCode, Record<string, string>> = {
  'zh-CN': {
    appName: '时匣 ChronoBox',
    appTagline: '本地文件时间盒与视觉快照',
    addFolder: '添加项目',
    trackedFolders: '项目列表',
    miniBar: 'Mini 条',
    miniDot: '悬浮球',
    welcomeTitle: '让每一次文件演变都有迹可循',
    welcomeDesc: '选择一个工作文件夹，开启本地增量时间盒、视觉目录快照与 00【Archive】悬浮归档球。无论是论文稿件、Origin 绘图还是工程图纸，都能安全留痕、直观对比、无损回溯。',
    addFirstFolder: '添加第一个项目',
    refresh: '刷新',
    search: '检索',
    oneClickArchive: '一键存档',
    viewTimeline: '时间轴',
    viewGraph: '关系视图',
    viewDiff: '存档对比',
    viewSettings: '设置',
    allTags: '全部',
    graphHint: '拖拽画布平移 · 滚轮缩放 · 单击检视 / 双击直接恢复存档',
    resetView: '适配',
    diffFrom: '基准版本',
    diffTo: '对比版本',
    createArchiveTitle: '创建新存档（时间盒子）',
    archiveTitleLabel: '存档说明（留空将自动生成）',
    archiveNoteLabel: '详细备注（可选）',
    archiveTagLabel: '颜色标记（红/黄/绿）与自定义文字标签',
    cancel: '取消',
    confirmArchive: '立即存档',
    switchArchiveTitle: '恢复历史存档（双安全模式）',
    confirmSwitch: '确认执行恢复',
    synced: '已同步',
    dirtyCount: '有 {n} 项变化',
    currentBadge: '当前',
    autoBadge: '自动',
    workingTree: '当前工作区（实时）',
    noArchives: '暂无存档，点击右上角「一键存档」创建第一个时间盒子。'
  },
  'en-US': {
    appName: 'ChronoBox',
    appTagline: 'Local File Time-Box & Visual Snapshots',
    addFolder: 'Add Project',
    trackedFolders: 'Projects',
    miniBar: 'Mini Bar',
    miniDot: 'Drop Orb',
    welcomeTitle: 'Keep Every File Iteration Safe & Visual',
    welcomeDesc: 'Pick a local folder to start incremental snapshots, visual directory grids, and the 00【Archive】 floating drop-orb.',
    addFirstFolder: 'Add Your First Project',
    refresh: 'Refresh',
    search: 'Search',
    oneClickArchive: 'Archive Now',
    viewTimeline: 'Timeline',
    viewGraph: 'Relation Map',
    viewDiff: 'Compare',
    viewSettings: 'Settings',
    allTags: 'All',
    graphHint: 'Drag canvas to pan · Scroll to zoom · Click to inspect / Double-click to restore',
    resetView: 'Fit',
    diffFrom: 'Base Version',
    diffTo: 'Target Version',
    createArchiveTitle: 'Create Archive (Time Box)',
    archiveTitleLabel: 'Archive Title (auto-generated if blank)',
    archiveNoteLabel: 'Notes (optional)',
    archiveTagLabel: 'Color Marks & Custom Tags',
    cancel: 'Cancel',
    confirmArchive: 'Save Archive',
    switchArchiveTitle: 'Restore Historical Archive',
    confirmSwitch: 'Confirm Restore',
    synced: 'Synced',
    dirtyCount: '{n} changed items',
    currentBadge: 'Current',
    autoBadge: 'Auto',
    workingTree: 'Current Workspace (Live)',
    noArchives: 'No archives yet. Click "Archive Now" to create your first time box.'
  }
};

let currentLang: LanguageCode = 'zh-CN';

export function setCurrentLanguage(lang: LanguageCode): void {
  currentLang = lang;
  document.documentElement.lang = lang;
  const elements = document.querySelectorAll<HTMLElement>('[data-i18n]');
  elements.forEach((el) => {
    const key = el.dataset.i18n;
    if (key && DICT[lang][key]) {
      el.textContent = DICT[lang][key];
    }
  });
}

export function t(key: string, params?: Record<string, string | number>): string {
  let str = DICT[currentLang]?.[key] ?? DICT['zh-CN'][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val < 10 && idx > 0 ? val.toFixed(1) : Math.round(val)} ${units[idx]}`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
