import { Menu, nativeImage, Tray } from 'electron';

export interface TrayCallbacks {
  iconPath: string;
  onOpenFull: () => void;
  onToggleFloating: () => void;
  onOpenMiniBar: () => void;
  onOpenMiniDot: () => void;
  onQuickArchive: () => void;
  onQuit: () => void;
}

let appTray: Tray | null = null;

/**
 * 创建 Windows 系统托盘图标与右键快捷菜单
 */
export function createAppTray(callbacks: TrayCallbacks): Tray {
  const icon = nativeImage.createFromPath(callbacks.iconPath).resize({ width: 16, height: 16 });
  appTray = new Tray(icon);
  appTray.setToolTip('时匣 ChronoBox — 文件历史管理');

  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: callbacks.onOpenFull },
    { type: 'separator' },
    { label: '开启 / 隐藏桌面悬浮窗', click: callbacks.onToggleFloating },
    { label: '显示为桌面悬浮归档球', click: callbacks.onOpenMiniDot },
    { label: '显示为 Mini 悬浮条', click: callbacks.onOpenMiniBar },
    { type: 'separator' },
    { label: '一键存档当前项目 (Ctrl+Shift+S)', click: callbacks.onQuickArchive },
    { type: 'separator' },
    { label: '退出时匣 ChronoBox', click: callbacks.onQuit }
  ]);

  appTray.setContextMenu(menu);
  appTray.on('double-click', callbacks.onOpenFull);

  return appTray;
}
