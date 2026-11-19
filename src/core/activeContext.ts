import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { WorkspaceManager } from './workspaceManager';

export interface DetectedWindowContext {
  kind: 'explorer' | 'word' | 'excel' | 'powerpoint' | 'other';
  folderPath: string | null;
  filePath: string | null;
  appName: string;
}

export interface ActiveContextStatus {
  /** synced=绿色(已添加项目且已存档无变更), dirty=橙色(已添加项目有未存档变更或暂无存档), untracked=紫色(当前文件夹/桌面/文档未添加为项目), idle=回退到当前活动项目 */
  state: 'synced' | 'dirty' | 'untracked' | 'idle';
  matchedProjectId: string | null;
  folderPath: string | null;
  filePath: string | null;
  displayName: string;
  changeCount: number;
  archiveCount: number;
  sourceKind: DetectedWindowContext['kind'];
}

function normalizeWinPath(p: string): string {
  // 去掉末尾多余斜杠（保留盘符根目录如 C:\）并统一为小写以便 Windows 精确比对
  const resolved = path.resolve(p);
  if (resolved.length > 3 && (resolved.endsWith('\\') || resolved.endsWith('/'))) {
    return resolved.slice(0, -1).toLowerCase();
  }
  return resolved.toLowerCase();
}

function isSameOrSubPath(parentDir: string, candidatePath: string): boolean {
  const p = normalizeWinPath(parentDir);
  const c = normalizeWinPath(candidatePath);
  if (p === c) return true;
  const rel = path.relative(p, c);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 纯逻辑核心：根据当前前台检测到的文件夹、桌面或 Word/Excel/PPT 文件路径，
 * 计算悬浮球与 Mini 条应当显示的状态颜色（绿 / 橙 / 紫）
 */
export function resolveActiveContextStatus(
  detected: DetectedWindowContext | null,
  manager: WorkspaceManager
): ActiveContextStatus {
  const cfg = manager.getConfig();
  const activeProjects = cfg.projects.filter((p) => !p.archived);

  // 若检测到了具体文件夹或文档路径，优先按当前前台上下文判定
  const targetFolder = detected?.folderPath
    ? path.resolve(detected.folderPath)
    : detected?.filePath
      ? path.dirname(path.resolve(detected.filePath))
      : null;

  if (targetFolder) {
    // 匹配路径最深的已添加项目
    const matched = activeProjects
      .filter((p) => isSameOrSubPath(p.rootPath, targetFolder))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];

    if (matched) {
      const st = manager.getProjectStatus(matched.id);
      const isDirty = st.hasChanges || st.archiveCount === 0;
      const label = detected?.filePath
        ? `${path.basename(detected.filePath)} · ${st.name}`
        : st.name;
      return {
        state: isDirty ? 'dirty' : 'synced',
        matchedProjectId: matched.id,
        folderPath: matched.rootPath,
        filePath: detected?.filePath || null,
        displayName: label,
        changeCount: st.changes.length,
        archiveCount: st.archiveCount,
        sourceKind: detected?.kind || 'explorer'
      };
    }

    // 未在项目列表中 → 紫色提示，并允许右击一键添加为项目！
    const baseLabel = detected?.appName === 'desktop'
      ? '桌面'
      : detected?.filePath
        ? path.basename(detected.filePath)
        : path.basename(targetFolder) || targetFolder;
    return {
      state: 'untracked',
      matchedProjectId: null,
      folderPath: targetFolder,
      filePath: detected?.filePath || null,
      displayName: `${baseLabel}（未加）`,
      changeCount: 0,
      archiveCount: 0,
      sourceKind: detected?.kind || 'explorer'
    };
  }

  // 未检测到外部窗口路径时，回退显示当前选中的活动项目
  if (cfg.activeProjectId) {
    const proj = manager.getProject(cfg.activeProjectId);
    if (proj && !proj.archived) {
      const st = manager.getProjectStatus(proj.id);
      const isDirty = st.hasChanges || st.archiveCount === 0;
      return {
        state: isDirty ? 'dirty' : 'synced',
        matchedProjectId: proj.id,
        folderPath: proj.rootPath,
        filePath: null,
        displayName: st.name,
        changeCount: st.changes.length,
        archiveCount: st.archiveCount,
        sourceKind: 'other'
      };
    }
  }

  return {
    state: 'idle',
    matchedProjectId: null,
    folderPath: null,
    filePath: null,
    displayName: '时匣悬浮球',
    changeCount: 0,
    archiveCount: 0,
    sourceKind: 'other'
  };
}

/**
 * Windows 极速常驻上下文监听器（v2.9 升级版，零 C++ 编译依赖）：
 * - 强制开启 PowerShell UTF-8 输出编码，100% 精准识别含中文字符的路径（如 E:\项目\示例）
 * - 原生适配 Windows 11 多标签页资源管理器（通过前台窗口标题精准匹配当前激活标签页）
 * - 原生识别 Windows 桌面（Progman / WorkerW），显示桌面时准确映射真实桌面路径（未添加即显示紫色）
 * - 250ms 极速响应窗口与标签切换，未切换窗口时跳过 COM 轮询，CPU 占用 < 0.1%
 */
export class WindowsActiveContextMonitor extends EventEmitter {
  private child: ChildProcess | null = null;
  private lastRawJson = '';

  public start(): void {
    if (process.platform !== 'win32' || this.child) return;

    const selfPid = process.pid;
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinCtx {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  public static string GetCls(IntPtr hWnd) {
    var sb = new StringBuilder(256);
    GetClassName(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }
  public static string GetTitle(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }
}
"@
$shell = New-Object -ComObject Shell.Application
$desktopPath = [Environment]::GetFolderPath('Desktop')
$selfPid = ${selfPid}
$lastSig = ''
$tick = 0
while ($true) {
  try {
    $tick++
    $hwnd = [WinCtx]::GetForegroundWindow()
    $procId = 0
    [void][WinCtx]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -ne 0 -and $procId -ne $selfPid) {
      $cls = [WinCtx]::GetCls($hwnd)
      $title = [WinCtx]::GetTitle($hwnd)
      $sig = "$hwnd|$cls|$title"
      if ($sig -ne $lastSig -or ($tick % 5 -eq 0)) {
        $lastSig = $sig
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $pname = if ($p) { $p.ProcessName.ToLower() } else { '' }
        if ($pname -ne 'electron' -and $pname -ne 'chronobox') {
          $kind = 'other'
          $folderPath = $null
          $filePath = $null
          $emitApp = $pname

          if ($cls -eq 'Progman' -or $cls -eq 'WorkerW') {
            if ($desktopPath -and (Test-Path -LiteralPath $desktopPath -PathType Container)) {
              $kind = 'explorer'
              $folderPath = $desktopPath
              $emitApp = 'desktop'
            }
          } elseif ($pname -eq 'explorer') {
            $matches = @()
            foreach ($w in $shell.Windows()) {
              try {
                if ([Int64]$w.HWND -eq [Int64]$hwnd) {
                  $loc = $w.Document.Folder.Self.Path
                  if (-not $loc -and $w.LocationURL -and $w.LocationURL.StartsWith('file:///')) {
                    $loc = [Uri]::UnescapeDataString($w.LocationURL.Substring(8)).Replace('/', '\\')
                  }
                  if ($loc -and (Test-Path -LiteralPath $loc -PathType Container)) {
                    $matches += @{ path = $loc; name = [string]$w.LocationName }
                  }
                }
              } catch {}
            }
            if ($matches.Count -eq 1) {
              $kind = 'explorer'
              $folderPath = $matches[0].path
            } elseif ($matches.Count -gt 1) {
              # Windows 11 多标签页资源管理器：根据前台窗口标题精准锁定当前激活标签
              $cleanTitle = $title -replace '\\s*-\\s*(文件资源管理器|File Explorer)$', ''
              $picked = $null
              foreach ($m in $matches) {
                if ($cleanTitle -eq $m.name -or $cleanTitle -eq $m.path -or $title.StartsWith($m.name + ' ')) {
                  $picked = $m
                  break
                }
              }
              if (-not $picked) { $picked = $matches[$matches.Count - 1] }
              $kind = 'explorer'
              $folderPath = $picked.path
            }
          } elseif ($pname -eq 'winword') {
            try {
              $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
              $docPath = $word.ActiveDocument.FullName
              if ($docPath -and (Test-Path -LiteralPath $docPath -PathType Leaf)) {
                $kind = 'word'
                $filePath = $docPath
                $folderPath = Split-Path -Parent $docPath
              }
            } catch {}
          } elseif ($pname -eq 'excel') {
            try {
              $xl = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
              $wbPath = $xl.ActiveWorkbook.FullName
              if ($wbPath -and (Test-Path -LiteralPath $wbPath -PathType Leaf)) {
                $kind = 'excel'
                $filePath = $wbPath
                $folderPath = Split-Path -Parent $wbPath
              }
            } catch {}
          } elseif ($pname -eq 'powerpnt') {
            try {
              $ppt = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
              $pPath = $ppt.ActivePresentation.FullName
              if ($pPath -and (Test-Path -LiteralPath $pPath -PathType Leaf)) {
                $kind = 'powerpoint'
                $filePath = $pPath
                $folderPath = Split-Path -Parent $pPath
              }
            } catch {}
          }

          if ($folderPath -or $filePath) {
            $obj = @{ kind = $kind; folderPath = $folderPath; filePath = $filePath; appName = $emitApp }
            [Console]::WriteLine(($obj | ConvertTo-Json -Compress))
          }
        }
      }
    }
  } catch {}
  Start-Sleep -Milliseconds 250
}
`;

    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', psScript],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
      this.child = child;

      let buffer = '';
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === this.lastRawJson) continue;
          try {
            const parsed = JSON.parse(trimmed) as DetectedWindowContext;
            this.lastRawJson = trimmed;
            this.emit('detected', parsed);
          } catch { /* ignore malformed line */ }
        }
      });

      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });
    } catch {
      this.child = null;
    }
  }

  public stop(): void {
    if (this.child) {
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
    this.lastRawJson = '';
  }
}
