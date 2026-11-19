import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distCoreDir = process.env.CHRONOBOX_TEST_CORE_DIR
  ? path.resolve(process.env.CHRONOBOX_TEST_CORE_DIR)
  : path.resolve(process.cwd(), 'dist', 'core');

if (!fs.existsSync(distCoreDir)) {
  console.error(`[ERROR] 未找到已编译的核心模块目录: ${distCoreDir}`);
  console.error('请先运行: npm run build');
  process.exit(1);
}

const { IgnoreMatcher, normalizeRelPath } = require(path.join(distCoreDir, 'ignore.js'));
const { ObjectStore } = require(path.join(distCoreDir, 'objectStore.js'));
const { computeTextDiff } = require(path.join(distCoreDir, 'diffEngine.js'));
const { ChronoBoxRepository, WORKING_TREE_ID } = require(path.join(distCoreDir, 'repository.js'));
const { WorkspaceManager } = require(path.join(distCoreDir, 'workspaceManager.js'));
const { ArchiveBoxEngine, DEFAULT_ARCHIVE_BOX_CONFIG } = require(path.join(distCoreDir, 'archiveBox.js'));
const { prepareCompareFilePair, prepareCompareFolderPair } = require(path.join(distCoreDir, 'beyondCompare.js'));
const { resolveActiveContextStatus } = require(path.join(distCoreDir, 'activeContext.js'));
const { findDuplicateFiles, getFileMilestoneTimeline, globalSearchWorkspace, generateProgressReport } = require(path.join(distCoreDir, 'analyticsEngine.js'));
const { exportProjectBundle, importProjectBundle, BUNDLE_DESCRIPTOR_FILENAME } = require(path.join(distCoreDir, 'projectBundle.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error('        ', err?.stack || err);
    failed++;
  }
}

function makeTempDir(prefix = 'chronobox-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

console.log('=== 时匣 ChronoBox 核心引擎全链路自动化测试 ===\n');

// 1. Ignore rules
test('01. 忽略规则：Office 临时锁、系统垃圾、Windows 路径与自定义 Glob', () => {
  const matcher = new IgnoreMatcher(['build/', 'logs/*.log', '*.cache']);
  assert.equal(normalizeRelPath('docs\\方案\\test.docx'), 'docs/方案/test.docx');
  assert.equal(matcher.isIgnored('.chronobox/manifest.json'), true);
  assert.equal(matcher.isIgnored('docs/~$论文定稿.docx'), true);
  assert.equal(matcher.isIgnored('Thumbs.db'), true);
  assert.equal(matcher.isIgnored('sub/desktop.ini'), true);
  assert.equal(matcher.isIgnored('build/output.bin'), true);
  assert.equal(matcher.isIgnored('logs/app.log'), true);
  assert.equal(matcher.isIgnored('a/b/data.cache'), true);
  assert.equal(matcher.isIgnored('docs/论文定稿.docx'), false);
});

// 2. ObjectStore CAS & Integrity
test('02. 对象存储：SHA-256 内容寻址去重、zlib 压缩与完整性防篡改校验', () => {
  const tmp = makeTempDir();
  const store = new ObjectStore(path.join(tmp, '.chronobox'));
  store.init();

  const f1 = writeFile(tmp, 'a.txt', '时匣 ChronoBox 增量存储测试内容\n'.repeat(200));
  const f2 = writeFile(tmp, 'b.txt', '时匣 ChronoBox 增量存储测试内容\n'.repeat(200));

  const r1 = store.putFile(f1);
  const r2 = store.putFile(f2);
  assert.equal(r1.existed, false);
  assert.equal(r2.existed, true);
  assert.equal(r1.hash, r2.hash);

  const stats = store.getDiskStats();
  assert.equal(stats.objectCount, 1);
  assert.ok(stats.compressedBytes < r1.size, 'zlib 压缩后体积应小于原始体积');

  const restored = store.readObject(r1.hash).toString('utf-8');
  assert.equal(restored, '时匣 ChronoBox 增量存储测试内容\n'.repeat(200));

  // 篡改对象内容触发 SHA-256 校验异常
  const objPath = store.getObjectPath(r1.hash);
  const corrupted = Buffer.from(fs.readFileSync(objPath));
  corrupted[corrupted.length - 1] ^= 0xff;
  fs.writeFileSync(objPath, corrupted);
  assert.throws(() => store.readObject(r1.hash));

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 3. Binary detection
test('03. 二进制文件识别：区分中文 UTF-8 文本与含 NUL 字节的二进制文件', () => {
  assert.equal(ObjectStore.detectBinary(Buffer.from('中文方案文档 Hello 123\r\n', 'utf-8')), false);
  assert.equal(ObjectStore.detectBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])), true);
});

// 4. Racy-mtime same-millisecond same-size edit detection
test('04. 扫描器 Racy-mtime 防护：同毫秒同字节长度修改也能准确检出', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'note.txt', 'AAA');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('测试项目');
  repo.createArchive({ title: 'v1' });

  // 立即用相同字节长度覆盖
  writeFile(tmp, 'note.txt', 'BBB');
  const changes = repo.getWorkingChanges();
  assert.equal(changes.changes.length, 1);
  assert.equal(changes.changes[0].status, 'modified');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 5. Full lifecycle: archive, switch, restore, cleanup empty dirs
test('05. 核心闭环：一键存档、修改/新增/删除、时间机器回溯与空目录清理', () => {
  const tmp = makeTempDir();
  writeFile(tmp, '设计说明.md', '# 第一版设计\n尺寸: 100mm\n');
  writeFile(tmp, '结构/底座.bin', Buffer.from([0, 1, 2, 3, 4, 5]));
  writeFile(tmp, '~$临时锁.docx', 'should be ignored');

  const repo = new ChronoBoxRepository(tmp);
  repo.init('机械狗项目');

  const a1 = repo.createArchive({ title: '第一版方案', tags: ['green'] });
  assert.equal(a1.summary.totalFiles, 2);
  assert.equal(a1.summary.added, 3); // 2 files + 1 directory (结构/)
  assert.throws(() => repo.createArchive({ title: '无变更重复存档' }));

  // 修改 + 新增嵌套文件 + 删除文件
  writeFile(tmp, '设计说明.md', '# 第二版设计\n尺寸: 120mm\n新增散热孔\n');
  writeFile(tmp, '临时模块/子目录/测试.txt', 'extra file');
  fs.unlinkSync(path.join(tmp, '结构', '底座.bin'));

  const a2 = repo.createArchive({ title: '第二版迭代' });
  assert.equal(a2.parentId, a1.id);
  assert.equal(a2.summary.added, 3); // 1 file + 2 nested directories
  assert.equal(a2.summary.modified, 1);
  assert.equal(a2.summary.deleted, 1);

  // 一键切回第一版
  const sw = repo.switchToArchive(a1.id);
  assert.equal(sw.switchedTo.id, a1.id);
  assert.equal(fs.readFileSync(path.join(tmp, '设计说明.md'), 'utf-8'), '# 第一版设计\n尺寸: 100mm\n');
  assert.ok(fs.existsSync(path.join(tmp, '结构', '底座.bin')));
  assert.equal(fs.existsSync(path.join(tmp, '临时模块', '子目录', '测试.txt')), false);
  assert.equal(fs.existsSync(path.join(tmp, '临时模块')), false, '残留空目录应被清理');
  assert.ok(fs.existsSync(path.join(tmp, '~$临时锁.docx')), '被忽略的临时锁文件不应被误删');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 6. Switch dirty protection & auto backup
test('06. 切换保护机制：工作区未保存时拦截误覆盖并支持自动保护存档', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'doc.txt', 'v1');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('保护测试');
  const a1 = repo.createArchive({ title: 'v1' });
  writeFile(tmp, 'doc.txt', 'v2');
  const a2 = repo.createArchive({ title: 'v2' });

  // 制造未保存改动
  writeFile(tmp, 'doc.txt', 'v3-unsaved');
  assert.throws(() => repo.switchToArchive(a1.id, { autoBackupIfDirty: false, force: false }));

  const res = repo.switchToArchive(a1.id, { autoBackupIfDirty: true });
  assert.ok(res.backupArchive, '应自动生成保护存档');
  assert.equal(fs.readFileSync(path.join(tmp, 'doc.txt'), 'utf-8'), 'v1');

  // 切回保护存档，确认未保存改动丝毫未丢
  repo.switchToArchive(res.backupArchive.id);
  assert.equal(fs.readFileSync(path.join(tmp, 'doc.txt'), 'utf-8'), 'v3-unsaved');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 7. Natural branching & DAG mind-map layout
test('07. 历史节点自然分叉与思维导图关系视图 (DAG) 多泳道布局', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'plan.txt', 'root');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('分支测试');
  const a1 = repo.createArchive({ title: '初始方案' });

  writeFile(tmp, 'plan.txt', 'main-2');
  const a2 = repo.createArchive({ title: '方案A' });

  // 回到初始方案并分叉出方案B
  repo.switchToArchive(a1.id);
  writeFile(tmp, 'plan.txt', 'branch-2');
  const b2 = repo.createArchive({ title: '方案B' });

  assert.equal(b2.parentId, a1.id);
  const dag = repo.getDagLayout();
  assert.equal(dag.nodes.length, 3);
  assert.equal(dag.edges.length, 2);

  const nodeA2 = dag.nodes.find((n) => n.id === a2.id);
  const nodeB2 = dag.nodes.find((n) => n.id === b2.id);
  assert.equal(nodeA2.lane, 0);
  assert.equal(nodeB2.lane, 1);
  assert.equal(nodeB2.isCurrent, true);
  assert.notEqual(nodeA2.branchColor, nodeB2.branchColor);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 8. Single file restore & archive export
test('08. 单文件精准恢复与整存档导出到外部目录', () => {
  const tmp = makeTempDir();
  const exportDir = makeTempDir('chronobox-export-');
  writeFile(tmp, 'a.txt', 'a-v1');
  writeFile(tmp, 'b.txt', 'b-v1');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('单文件测试');
  const a1 = repo.createArchive({ title: 'v1' });

  writeFile(tmp, 'a.txt', 'a-v2');
  writeFile(tmp, 'b.txt', 'b-v2');
  repo.createArchive({ title: 'v2' });

  // 仅恢复 a.txt 到 v1，b.txt 保持 v2
  repo.restoreSingleFile(a1.id, 'a.txt', 'overwrite');
  assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf-8'), 'a-v1');
  assert.equal(fs.readFileSync(path.join(tmp, 'b.txt'), 'utf-8'), 'b-v2');

  // 导出 v1 到外部目录
  const exp = repo.exportArchive(a1.id, exportDir);
  assert.equal(exp.exportedFiles, 2);
  assert.equal(fs.readFileSync(path.join(exportDir, 'b.txt'), 'utf-8'), 'b-v1');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(exportDir, { recursive: true, force: true });
});

// 9. Archive diff & LCS text diff
test('09. 存档差异对比与 LCS 行级文本对比（含 Windows CRLF）', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'code.txt', 'line1\r\nline2\r\nline3');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('对比测试');
  const a1 = repo.createArchive({ title: 'v1' });

  writeFile(tmp, 'code.txt', 'line1\r\nline2-edited\r\nline3\r\nline4');
  const diff = repo.diffArchives(a1.id, WORKING_TREE_ID);
  assert.equal(diff.summary.modified, 1);

  const textDiff = repo.diffFileText(a1.id, WORKING_TREE_ID, 'code.txt');
  assert.equal(textDiff.isBinary, false);
  assert.equal(textDiff.additions, 2);
  assert.equal(textDiff.deletions, 1);

  const quick = computeTextDiff('t.txt', 'a\nb', 'a\nc');
  assert.equal(quick.additions, 1);
  assert.equal(quick.deletions, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 10. Tags, search, delete reparenting & GC
test('10. 3色标签筛选、关键词检索、删除节点自动续接与孤立对象 GC', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'f.txt', 'content-1-'.repeat(100));
  const repo = new ChronoBoxRepository(tmp);
  repo.init('标签与GC测试');
  const a1 = repo.createArchive({ title: '初始版本', tags: ['red', 'invalid-color'] });
  assert.deepEqual(a1.tags, ['red']);

  writeFile(tmp, 'f.txt', 'content-2-'.repeat(100));
  const a2 = repo.createArchive({ title: '中间草稿', tags: ['yellow'] });

  writeFile(tmp, 'f.txt', 'content-3-'.repeat(100));
  const a3 = repo.createArchive({ title: '最终定稿', note: '已通过评审', tags: ['green'] });

  assert.equal(repo.listArchives({ tag: 'green' }).length, 1);
  assert.equal(repo.listArchives({ query: '评审' }).length, 1);
  assert.equal(repo.listArchives({ query: 'f.txt' }).length, 3);

  // 删除中间节点 a2，确认 a3 自动挂接到 a1 且 GC 释放 a2 独有对象
  repo.deleteArchive(a2.id);
  const manifest = repo.loadManifest();
  assert.equal(manifest.archives[a3.id].parentId, a1.id);

  const gc = repo.runGarbageCollection();
  assert.equal(gc.removedObjects, 1);
  assert.ok(gc.freedBytes > 0);

  const stats = repo.getStorageStats();
  assert.equal(stats.archiveCount, 2);
  assert.equal(stats.objectCount, 2);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 11. Corrupt manifest auto-recovery from .bak
test('11. 元数据损坏自动容灾：manifest.json 损坏时从 .bak 自动恢复', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'x.txt', 'v1');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('容灾测试');
  repo.createArchive({ title: 'v1' });
  writeFile(tmp, 'x.txt', 'v2');
  repo.createArchive({ title: 'v2' });

  // 故意破坏主 manifest.json
  fs.writeFileSync(repo.manifestPath, '{corrupted json!!!', 'utf-8');
  const recovered = repo.loadManifest();
  assert.ok(Object.keys(recovered.archives).length >= 1, '应从 .bak 恢复存档元数据');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 12. Security path traversal guard
test('12. 路径越界安全防护：拒绝恢复项目根目录之外的路径', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'ok.txt', 'safe');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('安全测试');
  const a1 = repo.createArchive({ title: 'v1' });

  assert.throws(() => repo.restoreSingleFile(a1.id, '../../etc/passwd'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 13. WorkspaceManager multi-project & persistence
test('13. 多项目工作区管理与配置持久化', () => {
  const cfgDir = makeTempDir('chronobox-cfg-');
  const p1Dir = makeTempDir('chronobox-p1-');
  const p2Dir = makeTempDir('chronobox-p2-');
  writeFile(p1Dir, 'readme.md', 'project 1');
  writeFile(p2Dir, 'spec.md', 'project 2');

  const wm = new WorkspaceManager(cfgDir);
  const p1 = wm.addProject(p1Dir, '项目一');
  const p2 = wm.addProject(p2Dir, '项目二');
  // 重复添加同一目录应去重
  const p1Dup = wm.addProject(p1Dir);
  assert.equal(p1Dup.id, p1.id);

  wm.renameProject(p2.id, '项目二-重命名');
  wm.togglePinProject(p2.id);
  wm.setLanguage('en-US');
  wm.setTheme('dark');

  // 重新实例化验证磁盘持久化
  const wm2 = new WorkspaceManager(cfgDir);
  const cfg = wm2.getConfig();
  assert.equal(cfg.projects.length, 2);
  assert.equal(cfg.language, 'en-US');
  assert.equal(cfg.theme, 'dark');
  assert.equal(cfg.projects[0].id, p2.id);
  assert.equal(cfg.projects[0].name, '项目二-重命名');

  wm2.removeProject(p1.id, false);
  assert.ok(fs.existsSync(path.join(p1Dir, '.chronobox')), '默认移除跟踪应保留本地历史目录');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(p1Dir, { recursive: true, force: true });
  fs.rmSync(p2Dir, { recursive: true, force: true });
});

// 14. Stress test with 120 files
test('14. 压力与完整性测试：120 个嵌套文件批量存档、修改与字节级精准还原', () => {
  const tmp = makeTempDir();
  for (let i = 0; i < 120; i++) {
    const folder = `mod_${Math.floor(i / 20)}`;
    writeFile(tmp, `${folder}/file_${i}.txt`, `initial-content-${i}\n`.repeat(10));
  }

  const repo = new ChronoBoxRepository(tmp);
  repo.init('压力测试');
  const a1 = repo.createArchive({ title: '120文件基线' });
  assert.equal(a1.summary.totalFiles, 120);

  for (let i = 0; i < 15; i++) {
    writeFile(tmp, `mod_0/file_${i}.txt`, `modified-${i}`);
  }
  const a2 = repo.createArchive({ title: '修改15个文件' });
  assert.equal(a2.summary.modified, 15);

  const stats = repo.getStorageStats();
  assert.equal(stats.objectCount, 135, '应仅新增15个增量对象（120+15）');

  repo.switchToArchive(a1.id);
  assert.equal(fs.readFileSync(path.join(tmp, 'mod_0', 'file_0.txt'), 'utf-8'), 'initial-content-0\n'.repeat(10));
  assert.equal(repo.getWorkingChanges().changes.length, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
});


// 15. Read-only file restoration & deletion
test('15. 只读文件属性处理：切换存档时可安全覆盖或删除只读文件', () => {
  const tmp = makeTempDir();
  const f1 = writeFile(tmp, 'readonly.txt', 'v1-locked');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('只读测试');
  const a1 = repo.createArchive({ title: 'v1' });

  fs.chmodSync(f1, 0o444);
  fs.chmodSync(f1, 0o666);
  writeFile(tmp, 'readonly.txt', 'v2-changed');
  const a2 = repo.createArchive({ title: 'v2' });

  // 设为只读后再切回 v1
  fs.chmodSync(f1, 0o444);
  repo.switchToArchive(a1.id);
  assert.equal(fs.readFileSync(f1, 'utf-8'), 'v1-locked');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 16. Special characters & spaces in Chinese filenames
test('16. 特殊字符与空格文件名：中文括号、空格与井号路径全链路兼容', () => {
  const tmp = makeTempDir();
  const special = '方案汇报 (最终版)/材料 #2 [已确认].txt';
  writeFile(tmp, special, 'hello special v1');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('特殊路径测试');
  const a1 = repo.createArchive({ title: 'v1' });

  writeFile(tmp, special, 'hello special v2');
  const a2 = repo.createArchive({ title: 'v2' });
  const diff = repo.diffArchives(a1.id, a2.id);
  assert.equal(diff.items.length, 1);
  assert.equal(diff.items[0].path, special);

  repo.switchToArchive(a1.id);
  assert.equal(fs.readFileSync(path.join(tmp, ...special.split('/')), 'utf-8'), 'hello special v1');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 17. Auto-archive clamping & live custom ignore rules
test('17. 自动存档参数边界裁剪与自定义忽略规则实时生效', () => {
  const tmp = makeTempDir();
  writeFile(tmp, 'main.txt', 'ok');
  writeFile(tmp, 'scratch.customtmp', 'ignore me');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('规则测试');

  const m1 = repo.updateAutoArchive(true, 99999);
  assert.equal(m1.autoArchive.enabled, true);
  assert.equal(m1.autoArchive.intervalMinutes, 1440);

  const m2 = repo.updateAutoArchive(true, -5);
  assert.equal(m2.autoArchive.intervalMinutes, 1);

  repo.updateIgnorePatterns(['*.customtmp']);
  const changes = repo.getWorkingChanges();
  assert.equal(changes.changes.length, 1);
  assert.equal(changes.changes[0].path, 'main.txt');

  fs.rmSync(tmp, { recursive: true, force: true });
});


// 18. ArchiveBox: move file to 00【Archive】/YYYY-MM-DD/ preserving relative path
test('18. 00【Archive】归档箱：拖入嵌套文件自动移入当天日期目录并保留相对路径', () => {
  const proj = makeTempDir('chronobox-box-');
  const f = writeFile(proj, '实验数据/XRD/sample1.csv', '2theta,intensity\n10,100');
  const now = new Date('2026-11-18T14:30:00');

  const res = ArchiveBoxEngine.archivePaths([f], {
    config: DEFAULT_ARCHIVE_BOX_CONFIG,
    projects: [{ id: 'p1', name: 'P1', rootPath: proj, addedAt: 1, lastOpenedAt: 1 }],
    activeProjectRoot: proj,
    action: 'move',
    now
  });

  assert.equal(res.succeeded.length, 1);
  assert.equal(fs.existsSync(f), false, '原文件应已移走');
  const expectedDest = path.join(proj, '00【Archive】', '2026-11-18', '实验数据', 'XRD', 'sample1.csv');
  assert.equal(res.succeeded[0].archivedPath, expectedDest);
  assert.ok(fs.existsSync(expectedDest));

  fs.rmSync(proj, { recursive: true, force: true });
});

// 19. ArchiveBox: same-day duplicate collision auto-renames with timestamp
test('19. 00【Archive】归档箱：同日多次归档同名文件自动加时间戳防覆盖', () => {
  const proj = makeTempDir('chronobox-box-dup-');
  const f1 = writeFile(proj, '草稿.docx', 'version-morning');
  const t1 = new Date('2026-11-18T09:15:20');
  const t2 = new Date('2026-11-18T15:42:08');

  const r1 = ArchiveBoxEngine.archivePaths([f1], {
    config: DEFAULT_ARCHIVE_BOX_CONFIG,
    projects: [{ id: 'p1', name: 'P1', rootPath: proj, addedAt: 1, lastOpenedAt: 1 }],
    activeProjectRoot: proj,
    action: 'move',
    now: t1
  });

  // 同天再创建一个同名文件并归档
  writeFile(proj, '草稿.docx', 'version-afternoon');
  const r2 = ArchiveBoxEngine.archivePaths([f1], {
    config: DEFAULT_ARCHIVE_BOX_CONFIG,
    projects: [{ id: 'p1', name: 'P1', rootPath: proj, addedAt: 1, lastOpenedAt: 1 }],
    activeProjectRoot: proj,
    action: 'move',
    now: t2
  });

  assert.equal(r1.succeeded.length, 1);
  assert.equal(r2.succeeded.length, 1);
  assert.notEqual(r1.succeeded[0].archivedPath, r2.succeeded[0].archivedPath);
  assert.equal(fs.readFileSync(r1.succeeded[0].archivedPath, 'utf-8'), 'version-morning');
  assert.equal(fs.readFileSync(r2.succeeded[0].archivedPath, 'utf-8'), 'version-afternoon');

  fs.rmSync(proj, { recursive: true, force: true });
});

// 20. ArchiveBox: copy mode keeps original intact
test('20. 00【Archive】归档箱：按住 Ctrl 复制模式保留原文件并生成日期副本', () => {
  const proj = makeTempDir('chronobox-box-copy-');
  const f = writeFile(proj, '论文定稿.txt', 'important draft');

  const res = ArchiveBoxEngine.archivePaths([f], {
    config: DEFAULT_ARCHIVE_BOX_CONFIG,
    projects: [{ id: 'p1', name: 'P1', rootPath: proj, addedAt: 1, lastOpenedAt: 1 }],
    activeProjectRoot: proj,
    action: 'copy',
    now: new Date('2026-11-18T10:00:00')
  });

  assert.equal(res.succeeded.length, 1);
  assert.ok(fs.existsSync(f), '复制模式原文件应保留');
  assert.ok(fs.existsSync(res.succeeded[0].archivedPath));
  fs.rmSync(proj, { recursive: true, force: true });
});

// 21. ArchiveBox: one-click restore (Undo) back to original path & clean empty date dirs
test('21. 00【Archive】归档箱：一键放回原位 (Undo) 并清理空日期子目录', () => {
  const proj = makeTempDir('chronobox-box-undo-');
  const f = writeFile(proj, '图纸/旧版方案.txt', 'old blueprint');

  const res = ArchiveBoxEngine.archivePaths([f], {
    config: DEFAULT_ARCHIVE_BOX_CONFIG,
    projects: [{ id: 'p1', name: 'P1', rootPath: proj, addedAt: 1, lastOpenedAt: 1 }],
    activeProjectRoot: proj,
    action: 'move',
    now: new Date('2026-11-18T11:00:00')
  });

  const entry = res.succeeded[0];
  assert.equal(fs.existsSync(f), false);

  const restored = ArchiveBoxEngine.restoreEntry(entry.archiveRoot, entry.id);
  assert.equal(restored.restored, true);
  assert.ok(fs.existsSync(f), '文件应已放回原始路径');
  assert.equal(fs.readFileSync(f, 'utf-8'), 'old blueprint');
  assert.equal(fs.existsSync(path.join(entry.archiveRoot, '2026-11-18')), false, '空的日期目录应自动清理');

  fs.rmSync(proj, { recursive: true, force: true });
});

// 22. ArchiveBox: recursion guard & untracked folder smart routing
test('22. 00【Archive】归档箱：防无限递归套娃与未跟踪目录就近归档', () => {
  const randomDir = makeTempDir('chronobox-untracked-');
  const f = writeFile(randomDir, 'temp_note.txt', 'untracked file');

  const r1 = ArchiveBoxEngine.archivePaths([f], {
    config: DEFAULT_ARCHIVE_BOX_CONFIG,
    projects: [],
    activeProjectRoot: null,
    action: 'move',
    now: new Date('2026-11-18T12:00:00')
  });
  assert.equal(r1.succeeded.length, 1);
  assert.ok(r1.succeeded[0].archivedPath.startsWith(path.join(randomDir, '00【Archive】')));

  // 尝试把 00【Archive】本身或其内部文件再拖进去，必须被安全跳过
  const r2 = ArchiveBoxEngine.archivePaths(
    [path.join(randomDir, '00【Archive】'), r1.succeeded[0].archivedPath],
    {
      config: DEFAULT_ARCHIVE_BOX_CONFIG,
      projects: [],
      activeProjectRoot: null,
      action: 'move'
    }
  );
  assert.equal(r2.succeeded.length, 0);
  assert.equal(r2.skipped.length, 2);

  fs.rmSync(randomDir, { recursive: true, force: true });
});

// 23. WorkspaceManager integration with ArchiveBox & default ignore
test('23. 归档箱与时间盒子协同：00【Archive】目录默认不重复进入快照对象库', () => {
  const cfgDir = makeTempDir('chronobox-wm-box-cfg-');
  const projDir = makeTempDir('chronobox-wm-box-prj-');
  const f1 = writeFile(projDir, 'active.txt', 'active');
  const f2 = writeFile(projDir, 'obsolete.txt', 'obsolete');

  const wm = new WorkspaceManager(cfgDir);
  const proj = wm.addProject(projDir, '协同项目');

  // 将 obsolete.txt 拖入 00【Archive】
  const dropRes = wm.archiveDroppedPaths([f2], 'move');
  assert.equal(dropRes.succeeded.length, 1);

  // 检查工作区变更：obsolete.txt 表现为 deleted，而 00【Archive】 内部文件不会被重复扫描进快照
  const status = wm.getProjectStatus(proj.id);
  assert.equal(status.changes.length, 1);
  assert.equal(status.changes[0].path, 'obsolete.txt');
  assert.equal(status.changes[0].status, 'deleted');

  const list = wm.listArchiveBoxEntries(proj.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].fileName, 'obsolete.txt');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});


// 24. Empty directory tracking, diffing, and restoration
test('24. 空文件夹完整追踪：仅新建空文件夹可被识别、存档、对比并精准还原', () => {
  const tmp = makeTempDir('chronobox-emptydir-');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('空目录测试');
  const a1 = repo.createArchive({ title: '空基线', allowEmpty: true });

  // 仅新建空文件夹（不放任何文件）
  fs.mkdirSync(path.join(tmp, '01_原始数据', 'XRD'), { recursive: true });
  const working = repo.getWorkingChanges();
  assert.equal(working.changes.length, 2, '应检测到 01_原始数据/ 和 01_原始数据/XRD/');
  assert.equal(working.changes[0].entryType, 'directory');

  const a2 = repo.createArchive({ title: '搭建目录骨架' });
  assert.equal(a2.directories.length, 2);

  // 切回 a1，空目录应被清理
  repo.switchToArchive(a1.id);
  assert.equal(fs.existsSync(path.join(tmp, '01_原始数据')), false);

  // 再切回 a2，空目录应被精准重建
  repo.switchToArchive(a2.id);
  assert.ok(fs.existsSync(path.join(tmp, '01_原始数据', 'XRD')));

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 25. Visual directory snapshot in diffArchives
test('25. 视觉目录快照：存档对比自动返回前后大图标网格快照数据', () => {
  const tmp = makeTempDir('chronobox-visual-');
  writeFile(tmp, 'Word模板.docx', 'docx-v1');
  writeFile(tmp, 'Origin Lab.opju', 'opju-v1');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('视觉快照测试');
  const a1 = repo.createArchive({ title: '基线' });

  writeFile(tmp, 'New Excel.csv', 'a,b\n1,2');
  const a2 = repo.createArchive({ title: '新增CSV' });

  const diff = repo.diffArchives(a1.id, a2.id);
  assert.equal(diff.fromVisual.length, 2);
  assert.equal(diff.toVisual.length, 3);
  assert.ok(diff.toVisual.some((v) => v.ext === 'opju'));

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 26. Dual-mode restore: new folder & single-file copy without overwriting
test('26. 双模式无损恢复：恢复到全新独立文件夹与单文件新副本不覆盖原稿', () => {
  const tmp = makeTempDir('chronobox-dual-');
  const parentOut = makeTempDir('chronobox-dual-out-');
  writeFile(tmp, '论文.docx', 'v1-content');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('双模式恢复测试');
  const a1 = repo.createArchive({ title: '初稿' });

  writeFile(tmp, '论文.docx', 'v2-today-work');
  repo.createArchive({ title: '今日定稿' });

  // 模式1：单文件恢复为全新副本
  const copyRes = repo.restoreSingleFile(a1.id, '论文.docx', 'copy');
  assert.equal(fs.readFileSync(path.join(tmp, '论文.docx'), 'utf-8'), 'v2-today-work', '原稿绝不被覆盖');
  assert.equal(fs.readFileSync(copyRes.restoredPath, 'utf-8'), 'v1-content', '新副本包含历史内容');

  // 模式2：整存档恢复到全新独立文件夹
  const folderRes = repo.restoreArchiveToNewFolder(a1.id, parentOut);
  assert.equal(folderRes.exportedFiles, 1);
  assert.equal(fs.readFileSync(path.join(folderRes.destinationDir, '论文.docx'), 'utf-8'), 'v1-content');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(parentOut, { recursive: true, force: true });
});

// 27. Soft-archive recycle bin for archives & projects
test('27. 安全软归档机制：归档隐藏存档与项目并支持一键还原', () => {
  const cfgDir = makeTempDir('chronobox-soft-cfg-');
  const projDir = makeTempDir('chronobox-soft-prj-');
  writeFile(projDir, 'data.txt', 'v1');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(projDir, '实验项目');
  const repo = wm.getRepository(p.id);
  writeFile(projDir, 'data.txt', 'v2');
  const a2 = repo.createArchive({ title: '第二版', customTags: ['导师审阅', '重要'] });

  // 软归档存档
  repo.softArchiveRecord(a2.id);
  assert.equal(repo.listArchives().length, 1);
  assert.equal(repo.listArchives({ onlyArchived: true }).length, 1);
  repo.restoreSoftArchivedRecord(a2.id);
  assert.equal(repo.listArchives({ customTag: '导师审阅' }).length, 1);

  // 软归档项目
  wm.archiveProject(p.id);
  assert.equal(wm.getProject(p.id).archived, true);
  wm.unarchiveProject(p.id);
  assert.equal(wm.getProject(p.id).archived, false);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});

// 28. Project rename with optional disk folder sync & custom project tags
test('28. 左侧栏重命名（可选同步重命名磁盘文件夹）与自定义项目标签', () => {
  const cfgDir = makeTempDir('chronobox-ren-cfg-');
  const baseParent = makeTempDir('chronobox-ren-parent-');
  const origDir = path.join(baseParent, 'OldFolder');
  fs.mkdirSync(origDir, { recursive: true });
  writeFile(origDir, 'a.txt', 'hello');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(origDir, '旧显示名');

  // 仅改显示名，不改磁盘目录
  wm.renameProject(p.id, '仅改标签名', false);
  assert.ok(fs.existsSync(origDir));
  assert.equal(wm.getProject(p.id).name, '仅改标签名');

  // 勾选同步重命名磁盘文件夹
  wm.renameProject(p.id, 'NewSyncedFolder', true);
  const newDir = path.join(baseParent, 'NewSyncedFolder');
  assert.equal(fs.existsSync(origDir), false);
  assert.ok(fs.existsSync(newDir));
  assert.equal(wm.getProject(p.id).rootPath, newDir);

  // 自定义项目标签
  wm.updateProjectTags(p.id, ['论文', '进行中']);
  assert.deepEqual(wm.getProject(p.id).customTags, ['论文', '进行中']);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(baseParent, { recursive: true, force: true });
});

// 29. 仓库目录定位：只认项目内 .chronobox，不被其它隐藏目录干扰
test('29. 仓库目录定位：只认项目内 .chronobox，其它隐藏目录不会被误接管', () => {
  const tmp = makeTempDir('chronobox-meta-');
  const otherDir = path.join(tmp, '.other-tool-repo');
  fs.mkdirSync(path.join(otherDir, 'objects'), { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1, repoId: 'other1', name: '其它工具的目录', createdAt: 1, updatedAt: 1,
      currentArchiveId: null, archives: {}, ignorePatterns: [], autoArchive: { enabled: false, intervalMinutes: 30 }
    })
  );

  const repo = new ChronoBoxRepository(tmp);
  assert.equal(repo.isInitialized(), false, '不应接管其它工具的隐藏目录');
  assert.equal(path.basename(repo.metaDir), '.chronobox');

  fs.rmSync(tmp, { recursive: true, force: true });
});


// 30. File Evolution Matrix: initial, edit, add (new row), delete (keep row, absent afterwards)
test('30. 表格视图矩阵：每文件一行、新增追加行、删除保留历史行后续留空', () => {
  const cfgDir = makeTempDir('cb-mat-cfg-');
  const projDir = makeTempDir('cb-mat-prj-');
  writeFile(projDir, '结题.docx', 'jt-v1');
  writeFile(projDir, '验收.pdf', 'ys-v1');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(projDir, '矩阵测试', false);
  const repo = wm.getRepository(p.id);
  repo.createArchive({ title: 'V1' });

  // V2: 编辑验收.pdf，新增方案.jpg
  writeFile(projDir, '验收.pdf', 'ys-v2-edited');
  writeFile(projDir, '方案.jpg', 'img-v1');
  repo.createArchive({ title: 'V2' });

  // V3: 删除验收.pdf
  fs.unlinkSync(path.join(projDir, '验收.pdf'));
  repo.createArchive({ title: 'V3' });

  // V4: 编辑结题.docx
  writeFile(projDir, '结题.docx', 'jt-v4-edited');
  repo.createArchive({ title: 'V4' });

  const matrix = wm.getFileMatrix(p.id);
  assert.equal(matrix.columns.length, 4);
  assert.equal(matrix.rows.length, 3);

  const jtRow = matrix.rows.find((r) => r.displayPath === '结题.docx');
  assert.deepEqual(jtRow.cells.map((c) => c.status), ['initial', 'unchanged', 'unchanged', 'modified']);

  const ysRow = matrix.rows.find((r) => r.displayPath === '验收.pdf');
  assert.deepEqual(ysRow.cells.map((c) => c.status), ['initial', 'modified', 'deleted', 'absent']);
  assert.equal(ysRow.currentState, 'deleted');

  const imgRow = matrix.rows.find((r) => r.displayPath === '方案.jpg');
  assert.deepEqual(imgRow.cells.map((c) => c.status), ['absent', 'added', 'unchanged', 'unchanged']);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});

// 31. File Evolution Matrix: SHA-256 Rename detection stays on SAME ROW
test('31. 表格视图矩阵：重命名文件（验收.pdf → 验收报告.pdf）自动保持在同一行追踪', () => {
  const cfgDir = makeTempDir('cb-ren-cfg-');
  const projDir = makeTempDir('cb-ren-prj-');
  writeFile(projDir, '验收.pdf', 'same-binary-content-12345');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(projDir, '重命名矩阵', false);
  const repo = wm.getRepository(p.id);
  repo.createArchive({ title: 'V1' });

  fs.renameSync(path.join(projDir, '验收.pdf'), path.join(projDir, '验收报告.pdf'));
  repo.createArchive({ title: 'V2-重命名' });

  const matrix = wm.getFileMatrix(p.id);
  assert.equal(matrix.rows.length, 1, '重命名后仍应只占 1 行');
  assert.equal(matrix.rows[0].displayPath, '验收报告.pdf');
  assert.equal(matrix.rows[0].cells[0].status, 'initial');
  assert.equal(matrix.rows[0].cells[1].status, 'renamed');
  assert.equal(matrix.rows[0].cells[1].previousPath, '验收.pdf');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});

// 32. File Evolution Matrix: distinguishes Archived (00【Archive】) vs Deleted
test('32. 表格视图矩阵：联动 00【Archive】日志精准区分「已归档」与「直接删除」', () => {
  const cfgDir = makeTempDir('cb-arc-cfg-');
  const projDir = makeTempDir('cb-arc-prj-');
  const fArch = writeFile(projDir, '旧版方案.docx', 'archived-doc');
  const fDel = writeFile(projDir, '废弃草稿.txt', 'deleted-doc');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(projDir, '归档区分测试', false);
  const repo = wm.getRepository(p.id);
  repo.createArchive({ title: 'V1' });

  // 一个拖入 00【Archive】，另一个直接删除
  wm.archiveDroppedPaths([fArch], 'move');
  fs.unlinkSync(fDel);
  repo.createArchive({ title: 'V2-清理' });

  const matrix = wm.getFileMatrix(p.id);
  const rowArch = matrix.rows.find((r) => r.displayPath === '旧版方案.docx');
  const rowDel = matrix.rows.find((r) => r.displayPath === '废弃草稿.txt');

  assert.equal(rowArch.cells[1].status, 'archived');
  assert.equal(rowArch.currentState, 'archived');
  assert.ok(rowArch.cells[1].archivedDateFolder, '应附带归档日期子目录');

  assert.equal(rowDel.cells[1].status, 'deleted');
  assert.equal(rowDel.currentState, 'deleted');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});


// 33. General settings persistence (closeBehavior, launchAtLogin, beyondComparePath)
test('33. 常规设置持久化：关闭窗口行为、开机自启动与 Beyond Compare 路径保存', () => {
  const cfgDir = makeTempDir('cb-gen-cfg-');
  const wm = new WorkspaceManager(cfgDir);
  wm.updateGeneralSettings({
    closeBehavior: 'quit',
    launchAtLogin: true,
    beyondComparePath: 'C:\\Program Files\\Beyond Compare 4\\BCompare.exe'
  });

  const wm2 = new WorkspaceManager(cfgDir);
  const cfg = wm2.getConfig();
  assert.equal(cfg.closeBehavior, 'quit');
  assert.equal(cfg.launchAtLogin, true);
  assert.equal(cfg.beyondComparePath, 'C:\\Program Files\\Beyond Compare 4\\BCompare.exe');
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

// 34. Beyond Compare file & folder pair preparation from historical archives
test('34. Beyond Compare 对比准备：自动解包两个历史版本文件与整目录供外部对比', () => {
  const tmp = makeTempDir('cb-bc-prj-');
  writeFile(tmp, '报告.docx', 'v1-doc-bytes');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('BC测试');
  const a1 = repo.createArchive({ title: '初稿' });

  writeFile(tmp, '报告.docx', 'v2-doc-bytes-updated');
  const a2 = repo.createArchive({ title: '定稿' });

  const filePair = prepareCompareFilePair(repo, a1.id, a2.id, '报告.docx');
  assert.equal(fs.readFileSync(filePair.leftPath, 'utf-8'), 'v1-doc-bytes');
  assert.equal(fs.readFileSync(filePair.rightPath, 'utf-8'), 'v2-doc-bytes-updated');
  assert.equal(filePair.leftTitle, '初稿');
  assert.equal(filePair.rightTitle, '定稿');

  const dirPair = prepareCompareFolderPair(repo, a1.id, WORKING_TREE_ID);
  assert.ok(fs.existsSync(path.join(dirPair.leftPath, '报告.docx')));
  assert.equal(dirPair.rightPath, repo.rootPath);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.dirname(filePair.leftPath), { recursive: true, force: true });
  fs.rmSync(path.dirname(dirPair.leftPath), { recursive: true, force: true });
});


// 35. Nested folder restriction toggle & system root protection
test('35. 嵌套子文件夹限制开关：开启时拦截父/子目录重复跟踪，关闭后允许', () => {
  const cfgDir = makeTempDir('cb-nest-cfg-');
  const parentDir = makeTempDir('cb-nest-parent-');
  const childDir = path.join(parentDir, 'sub_project');
  fs.mkdirSync(childDir, { recursive: true });
  writeFile(childDir, 'a.txt', 'hello');

  const wm = new WorkspaceManager(cfgDir);
  wm.addProject(parentDir, '父项目', false);

  // 默认开启 restrictNestedFolders === true，添加子目录应被拦截
  assert.throws(() => wm.addProject(childDir, '子项目', false));

  // 关闭开关后允许跟踪子目录
  wm.updateGeneralSettings({ restrictNestedFolders: false });
  const childProj = wm.addProject(childDir, '子项目', false);
  assert.ok(childProj.id);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(parentDir, { recursive: true, force: true });
});

// 36. File pinning persistence & matrix lastModifiedAt tracking
test('36. 表格视图文件置顶持久化与最近修改时间记录', () => {
  const cfgDir = makeTempDir('cb-pin-cfg-');
  const projDir = makeTempDir('cb-pin-prj-');
  writeFile(projDir, 'doc1.docx', 'v1');
  writeFile(projDir, 'sub/doc2.docx', 'v1');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(projDir, '置顶测试');
  const pinned1 = wm.togglePinFile(p.id, 'sub/doc2.docx');
  assert.deepEqual(pinned1, ['sub/doc2.docx']);

  const wm2 = new WorkspaceManager(cfgDir);
  assert.deepEqual(wm2.getPinnedFiles(p.id), ['sub/doc2.docx']);

  const matrix = wm2.getFileMatrix(p.id);
  assert.ok(matrix.rows.every((r) => typeof r.lastModifiedAt === 'number' && r.lastModifiedAt > 0));

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});


// 37. Doc-save auto-archive config normalization & persistence
test('37. 文档保存自动存档配置：后缀标准化、冷却窗口裁剪与持久化', () => {
  const tmp = makeTempDir('cb-docauto-');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('文档自动存档测试');
  const m = repo.updateDocSaveAutoArchive(true, ['docx', '.PDF', 'opju'], 5);
  assert.equal(m.docSaveAutoArchive.enabled, true);
  assert.deepEqual(m.docSaveAutoArchive.extensions, ['.docx', '.pdf', '.opju']);
  assert.equal(m.docSaveAutoArchive.cooldownMinutes, 5);

  const mZero = repo.updateDocSaveAutoArchive(true, ['.docx'], 0);
  assert.equal(mZero.docSaveAutoArchive.cooldownMinutes, 0, '支持 0 分钟即每次保存都存档');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 38. Custom global shortcuts persistence
test('38. 全局快捷键自定义持久化：窗口形态切换与一键存档快捷键', () => {
  const cfgDir = makeTempDir('cb-sc-cfg-');
  const wm = new WorkspaceManager(cfgDir);
  wm.updateGeneralSettings({
    shortcuts: {
      toggleMini: 'Alt+Shift+M',
      quickArchive: 'Alt+Shift+S'
    }
  });
  const wm2 = new WorkspaceManager(cfgDir);
  assert.equal(wm2.getConfig().shortcuts.toggleMini, 'Alt+Shift+M');
  assert.equal(wm2.getConfig().shortcuts.quickArchive, 'Alt+Shift+S');
  fs.rmSync(cfgDir, { recursive: true, force: true });
});


// 39. File Evolution Matrix: onlyCurrentBranch excludes side-branch phantom deletions
test('39. 表格视图仅看当前分支路径：排除旁支文件干扰，绝不产生虚假删除记录', () => {
  const cfgDir = makeTempDir('cb-br-cfg-');
  const projDir = makeTempDir('cb-br-prj-');
  writeFile(projDir, 'Markdown.md', 'v1');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(projDir, '分支表格测试', false);
  const repo = wm.getRepository(p.id);
  const v1 = repo.createArchive({ title: 'V1' });

  // 旁支 A：新增 2 个文件
  writeFile(projDir, 'Word模板.docx', 'w1');
  writeFile(projDir, 'Origin.opju', 'o1');
  repo.createArchive({ title: '旁支A' });

  // 回到 V1 分叉出当前分支 B：只新增 Python.py
  repo.switchToArchive(v1.id);
  writeFile(projDir, 'Python.py', 'print(1)');
  repo.createArchive({ title: '当前分支B' });

  // 仅看当前分支路径：应只有 V1 和 当前分支B 两列，且没有 Word/Origin 的虚假删除行！
  const branchMat = wm.getFileMatrix(p.id, true);
  assert.equal(branchMat.columns.length, 2);
  assert.equal(branchMat.rows.length, 2);
  assert.equal(branchMat.stats.deletedFiles, 0);

  // 查看全部分支：应有 3 列
  const allMat = wm.getFileMatrix(p.id, false);
  assert.equal(allMat.columns.length, 3);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
});


// 40. Context-aware 3-color status for Windows Explorer folders (Green / Orange / Purple)
test('40. 悬浮球三色上下文感知（文件夹）：已存档绿色、未存档橙色、未跟踪紫色', () => {
  const cfgDir = makeTempDir('cb-ctx-cfg-');
  const trackedDir = makeTempDir('cb-ctx-tracked-');
  const untrackedDir = makeTempDir('cb-ctx-untracked-');
  writeFile(trackedDir, 'a.txt', 'v1');
  writeFile(untrackedDir, 'b.txt', 'v1');

  const wm = new WorkspaceManager(cfgDir);
  wm.addProject(trackedDir, '已跟踪项目');

  // 已跟踪且已存档无变更 → synced（绿色）
  const s1 = resolveActiveContextStatus({ kind: 'explorer', folderPath: trackedDir, filePath: null, appName: 'explorer' }, wm);
  assert.equal(s1.state, 'synced');

  // 修改文件未存档 → dirty（橙色）
  writeFile(trackedDir, 'a.txt', 'v2-dirty');
  const s2 = resolveActiveContextStatus({ kind: 'explorer', folderPath: trackedDir, filePath: null, appName: 'explorer' }, wm);
  assert.equal(s2.state, 'dirty');
  assert.equal(s2.changeCount, 1);

  // 打开未跟踪文件夹 → untracked（紫色）
  const s3 = resolveActiveContextStatus({ kind: 'explorer', folderPath: untrackedDir, filePath: null, appName: 'explorer' }, wm);
  assert.equal(s3.state, 'untracked');
  assert.equal(s3.folderPath, untrackedDir);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(trackedDir, { recursive: true, force: true });
  fs.rmSync(untrackedDir, { recursive: true, force: true });
});

// 41. Context-aware 3-color status for open Word/Excel/PPT documents
test('41. 悬浮球三色上下文感知（Word等单文档）：自动归属所在项目并区分绿/橙/紫', () => {
  const cfgDir = makeTempDir('cb-docctx-cfg-');
  const trackedDir = makeTempDir('cb-docctx-tracked-');
  const outsideDir = makeTempDir('cb-docctx-outside-');
  const trackedWord = writeFile(trackedDir, '章节/第三章.docx', 'doc-v1');
  const outsideWord = writeFile(outsideDir, '外部简历.docx', 'outside-v1');

  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(trackedDir, '博士论文');

  // Word 打开项目内已存档文档 → 绿色 synced
  const w1 = resolveActiveContextStatus({ kind: 'word', folderPath: path.dirname(trackedWord), filePath: trackedWord, appName: 'winword' }, wm);
  assert.equal(w1.state, 'synced');
  assert.equal(w1.matchedProjectId, p.id);

  // 修改该 Word 文档尚未存档 → 橙色 dirty
  writeFile(trackedDir, '章节/第三章.docx', 'doc-v2-modified');
  const w2 = resolveActiveContextStatus({ kind: 'word', folderPath: path.dirname(trackedWord), filePath: trackedWord, appName: 'winword' }, wm);
  assert.equal(w2.state, 'dirty');

  // Word 打开项目外的文档 → 紫色 untracked，右击即可一键将其所在目录加入跟踪
  const w3 = resolveActiveContextStatus({ kind: 'word', folderPath: outsideDir, filePath: outsideWord, appName: 'winword' }, wm);
  assert.equal(w3.state, 'untracked');
  assert.equal(w3.folderPath, outsideDir);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(trackedDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});


// 42. External folder rename auto-recovery via repoId (while app is open OR after restart)
test('42. 外部重命名文件夹自动识别与无损重连（打开中或关闭后改名均自动找回历史）', () => {
  const cfgDir = makeTempDir('cb-rename-cfg-');
  const parentDir = makeTempDir('cb-rename-parent-');
  const origDir = path.join(parentDir, '测试数据');
  const renamedDir = path.join(parentDir, '测试数据文件');
  fs.mkdirSync(origDir, { recursive: true });
  writeFile(origDir, 'exp.csv', 'x,y\n1,2');

  const wm1 = new WorkspaceManager(cfgDir);
  const proj = wm1.addProject(origDir);
  assert.equal(proj.name, '测试数据');
  assert.ok(proj.repoId, '应自动记录仓库唯一 repoId');

  // 模拟软件关闭后，用户在 Windows 资源管理器把「测试数据」改名为「测试数据文件」
  fs.renameSync(origDir, renamedDir);

  // 重新启动新的 WorkspaceManager 实例并检查项目状态
  const wm2 = new WorkspaceManager(cfgDir);
  const status = wm2.getProjectStatus(proj.id);
  assert.equal(status.exists, true, '通过同级目录 repoId 扫描应自动无损重连');
  assert.equal(path.resolve(status.rootPath), path.resolve(renamedDir));
  assert.equal(status.name, '测试数据文件', '未自定义别名时应自动同步新文件夹名');
  assert.equal(status.archiveCount, 1, '原有时间盒子历史 100% 保留');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(parentDir, { recursive: true, force: true });
});

// 43. Child -> Parent folder upgrade without losing child history
test('43. 子文件夹升级为父级项目：自动软归档子项目保留历史并统一跟踪父目录', () => {
  const cfgDir = makeTempDir('cb-upgrade-cfg-');
  const parentDir = makeTempDir('cb-upgrade-parent-');
  const childDir = path.join(parentDir, '实验子目录');
  fs.mkdirSync(childDir, { recursive: true });
  writeFile(childDir, 'data.txt', 'child-v1');
  writeFile(parentDir, 'readme.md', 'parent-v1');

  const wm = new WorkspaceManager(cfgDir);
  const childProj = wm.addProject(childDir, '实验子目录');
  assert.equal(wm.findNestedChildProjects(parentDir).length, 1);

  const upgraded = wm.upgradeToParentProject(parentDir);
  assert.equal(upgraded.archivedChildren.length, 1);
  assert.equal(upgraded.archivedChildren[0].id, childProj.id);
  assert.equal(wm.getProject(childProj.id)?.archived, true, '原子项目应被软归档，保留其历史且不再双重监听');
  assert.equal(path.resolve(upgraded.project.rootPath), path.resolve(parentDir));

  // 父项目立即可正常工作
  const parentStatus = wm.getProjectStatus(upgraded.project.id);
  assert.equal(parentStatus.exists, true);
  assert.equal(parentStatus.archiveCount, 1);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(parentDir, { recursive: true, force: true });
});

// 44. Independent floating window toggle & style persistence
test('44. 悬浮窗独立开关与形态持久化（与主窗口解耦不冲突）', () => {
  const cfgDir = makeTempDir('cb-float-cfg-');
  const wm1 = new WorkspaceManager(cfgDir);
  assert.equal(wm1.getConfig().floatingEnabled, true);
  assert.equal(wm1.getConfig().floatingStyle, 'mini-dot');

  wm1.setFloatingStyle('mini-bar');
  wm1.setFloatingEnabled(false);

  const wm2 = new WorkspaceManager(cfgDir);
  assert.equal(wm2.getConfig().floatingEnabled, false);
  assert.equal(wm2.getConfig().floatingStyle, 'mini-bar');

  wm2.setFloatingEnabled(true);
  assert.equal(new WorkspaceManager(cfgDir).getConfig().floatingEnabled, true);

  fs.rmSync(cfgDir, { recursive: true, force: true });
});


// 45. Desktop untracked (purple) -> Chinese tracked folder (green) rapid switching
test('45. 悬浮球桌面识别与中文路径切换：显示桌面呈紫色未加，切回中文已跟踪目录立即变绿', () => {
  const cfgDir = makeTempDir('cb-desk-cfg-');
  const desktopDir = makeTempDir('cb-desk-root-');
  const zhProjDir = path.join(desktopDir, '测试');
  fs.mkdirSync(zhProjDir, { recursive: true });
  writeFile(zhProjDir, 'Markdown.md', '# hi');

  const wm = new WorkspaceManager(cfgDir);
  wm.addProject(zhProjDir);

  // 1. 显示桌面（桌面本身未添加为项目） → 紫色 untracked，绝不误判为绿色
  const deskCtx = resolveActiveContextStatus(
    { kind: 'explorer', folderPath: desktopDir, filePath: null, appName: 'desktop' },
    wm
  );
  assert.equal(deskCtx.state, 'untracked');
  assert.ok(deskCtx.displayName.includes('桌面'));

  // 2. 切回中文路径项目「测试」（已存档无变更） → 绿色 synced
  const zhCtx = resolveActiveContextStatus(
    { kind: 'explorer', folderPath: zhProjDir, filePath: null, appName: 'explorer' },
    wm
  );
  assert.equal(zhCtx.state, 'synced');
  assert.equal(zhCtx.displayName, '测试');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(desktopDir, { recursive: true, force: true });
});


// 46. Temporary History Engine: capture edits & rename, rollback to #2, auto-clear on archive
test('46. 临时历史文件功能：自动记录多次修改/重命名、支持随时回退、正式存档后自动清空', () => {
  const tmp = makeTempDir('cb-temphist-');
  writeFile(tmp, 'Origin Lab.opju', 'base-v0');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('临时历史测试');
  repo.createArchive({ title: '基线' });

  // 连续修改 3 次（尚未正式存档）
  writeFile(tmp, 'Origin Lab.opju', 'edit-1');
  repo.captureTempHistory();
  writeFile(tmp, 'Origin Lab.opju', 'edit-2-best');
  repo.captureTempHistory();
  writeFile(tmp, 'Origin Lab.opju', 'edit-3-regret');
  repo.captureTempHistory();

  // 重命名为 Origin Lab_v2.opju（同内容哈希）
  fs.renameSync(path.join(tmp, 'Origin Lab.opju'), path.join(tmp, 'Origin Lab_v2.opju'));
  repo.captureTempHistory();

  const hist = repo.getFileTempHistory('Origin Lab_v2.opju');
  assert.equal(hist.length, 4, '应连续记录 3 次修改 + 1 次重命名共 4 条临时历史');
  assert.equal(hist[0].opType, 'modified');
  assert.equal(hist[1].opType, 'modified');
  assert.equal(hist[2].opType, 'modified');
  assert.equal(hist[3].opType, 'renamed');
  assert.equal(hist[3].previousPath, 'Origin Lab.opju');
  assert.equal(hist[3].isCurrentOnDisk, true);

  // 后悔了：回退到第 2 次临时修改（未正式存档）
  repo.restoreTempHistoryEntry(hist[1].id);
  assert.equal(fs.readFileSync(path.join(tmp, 'Origin Lab_v2.opju'), 'utf-8'), 'edit-2-best');
  const afterRollback = repo.getFileTempHistory('Origin Lab_v2.opju');
  assert.equal(afterRollback[1].isCurrentOnDisk, true, '回退后应标记第 2 次为当前磁盘版本');

  // 正式点击存档：存为当前磁盘状态，并自动清空本周期所有临时历史
  const arc = repo.createArchive({ title: '正式定稿' });
  assert.ok(arc.files['Origin Lab_v2.opju']);
  const afterArchive = repo.getFileTempHistory('Origin Lab_v2.opju');
  assert.equal(afterArchive.length, 0, '正式存档后应自动清空临时历史文件');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// 47. Parent folder A excluding child project B (independent management)
test('47. 父子项目独立管理：添加父项目 A 时自动排除子项目 B，B 保持独立且变更不混入 A', () => {
  const cfgDir = makeTempDir('cb-parexcl-cfg-');
  const dirA = makeTempDir('cb-parexcl-A-');
  const dirB = path.join(dirA, 'SubProjectB');
  fs.mkdirSync(dirB, { recursive: true });
  writeFile(dirA, 'root_note.md', 'A-v1');
  writeFile(dirB, 'sub_data.csv', 'B-v1');

  const wm = new WorkspaceManager(cfgDir);
  const projB = wm.addProject(dirB, '项目B');
  assert.equal(wm.findNestedChildProjects(dirA).length, 1);

  const res = wm.addParentExcludingChildren(dirA, '项目A');
  assert.equal(res.excludedChildren.length, 1);
  assert.equal(wm.getProject(projB.id)?.archived, false, '子项目 B 应保持独立活跃状态');

  // 修改子项目 B 中的文件：B 应检测到变更，但父项目 A 绝不受影响！
  writeFile(dirB, 'sub_data.csv', 'B-v2-changed');
  const statusB = wm.getProjectStatus(projB.id);
  const statusA = wm.getProjectStatus(res.project.id);
  assert.equal(statusB.hasChanges, true, '项目 B 正常检测到自身变更');
  assert.equal(statusA.hasChanges, false, '项目 A 已自动排除 B，B 的变更不会出现在 A 中');

  // 修改父项目 A 自身的文件：A 正常检测到变更
  writeFile(dirA, 'root_note.md', 'A-v2-changed');
  assert.equal(wm.getProjectStatus(res.project.id).hasChanges, true);

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(dirA, { recursive: true, force: true });
});


// 48. Project Bundle Export & 1-Click Reload Round-Trip
test('48. 项目结项导出与一键加载续上：打包最终版+历史+归档箱，删除原目录后一键无损恢复续接', () => {
  const cfgDir = makeTempDir('cb-bundle-cfg-');
  const srcProjDir = makeTempDir('cb-bundle-src-');
  const exportParent = makeTempDir('cb-bundle-exp-');
  const reloadParent = makeTempDir('cb-bundle-reload-');

  writeFile(srcProjDir, '论文.docx', 'draft-v1');
  writeFile(srcProjDir, '旧草稿.txt', 'old-draft');
  const wm = new WorkspaceManager(cfgDir);
  const proj = wm.addProject(srcProjDir, '结题项目');
  const repo = wm.getRepository(proj.id);

  // 把旧草稿拖入 00【Archive】，再修改论文（保持未存档，测试自动定稿）
  wm.archiveDroppedPaths([path.join(srcProjDir, '旧草稿.txt')], 'move');
  writeFile(srcProjDir, '论文.docx', 'final-v2-published');

  // 1. 执行结项导出（自动先存最终定稿，展开当前分支历史）
  const expRes = exportProjectBundle(repo, proj, {
    destinationParentDir: exportParent,
    historyScope: 'current-branch',
    archiveBoxFolderName: '00【Archive】',
    autoArchiveFinalIfDirty: true
  });
  assert.equal(expRes.autoArchivedFinal, true, '应自动将未存档改动存为结项最终定稿');
  assert.equal(expRes.exportedHistoryCount, 2, '应展开 V01 初始存档与 V02 结项最终定稿');
  assert.equal(expRes.copiedArchiveBox, true, '应一并带走 00【Archive】归档箱');
  assert.ok(fs.existsSync(path.join(expRes.bundleDir, '01_最终版本', '论文.docx')));
  assert.ok(fs.existsSync(path.join(expRes.bundleDir, '02_历史版本')));
  assert.ok(fs.existsSync(path.join(expRes.bundleDir, '结项清单.md')));
  assert.ok(fs.existsSync(path.join(expRes.bundleDir, BUNDLE_DESCRIPTOR_FILENAME)));

  // 2. 模拟半年后原项目已删除，换目录从结项包一键加载恢复
  wm.removeProject(proj.id, false);
  fs.rmSync(srcProjDir, { recursive: true, force: true });

  const impRes = importProjectBundle(expRes.descriptorPath, reloadParent, wm);
  assert.equal(impRes.archiveCount, 2, '恢复后应完整保留全部 2 个历史时间盒子');
  assert.equal(fs.readFileSync(path.join(impRes.restoredPath, '论文.docx'), 'utf-8'), 'final-v2-published');
  assert.ok(fs.existsSync(path.join(impRes.restoredPath, '00【Archive】')), '00【Archive】归档箱应一并还原');

  // 3. 在恢复后的项目中继续修改并创建 V3 存档，无缝续接历史！
  writeFile(impRes.restoredPath, '论文.docx', 'revised-v3-after-review');
  const recV3 = wm.getRepository(impRes.project.id).createArchive({ title: '审稿返修版' });
  assert.ok(recV3.parentId, '新存档应无缝衔接在原 V2 结项定稿之后');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(exportParent, { recursive: true, force: true });
  fs.rmSync(reloadParent, { recursive: true, force: true });
});


// 49. Move the project folder away while app is open, then move it back -> 0 archives lost!
test('49. 文件夹移走再移回原位防丢失保护：历史绝不重置为初始状态', () => {
  const cfgDir = makeTempDir('cb-moveback-cfg-');
  const parentDir = makeTempDir('cb-moveback-p-');
  const otherDir = makeTempDir('cb-moveback-other-');
  const projDir = path.join(parentDir, '测试12');
  const movedDir = path.join(otherDir, '测试12');
  fs.mkdirSync(projDir, { recursive: true });
  writeFile(projDir, 'doc.md', 'v1');

  const legacyRepo = new ChronoBoxRepository(projDir);
  legacyRepo.init('测试12');
  legacyRepo.createArchive({ title: 'V1' });
  writeFile(projDir, 'doc.md', 'v2');
  legacyRepo.createArchive({ title: 'V2' });

  const wm = new WorkspaceManager(cfgDir);
  const proj = wm.addProject(projDir, '测试12', false);
  assert.equal(wm.getProjectStatus(proj.id).archiveCount, 2);

  // 软件运行期间：把文件夹移到其他盘/目录 → 状态显示不存在
  fs.renameSync(projDir, movedDir);
  const missingStatus = wm.getProjectStatus(proj.id);
  assert.equal(missingStatus.exists, false);

  // 再把文件夹移回原位 → 必须完整恢复全部 2 个历史存档，绝不重置为 0 存档！
  fs.renameSync(movedDir, projDir);
  const backStatus = wm.getProjectStatus(proj.id);
  assert.equal(backStatus.exists, true);
  assert.equal(backStatus.archiveCount, 2, '移回原位后必须 100% 保留原全部历史存档');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(parentDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});


// 50. Duplicate large files scan via SHA-256
test('50. 相似/重复大文件体检：基于 SHA-256 精确识别重复副本并统计可省空间', () => {
  const tmp = makeTempDir('cb-dup-');
  writeFile(tmp, 'data/exp1.csv', 'SAME-CONTENT-PAYLOAD-1234567890');
  writeFile(tmp, 'backup/exp1_copy.csv', 'SAME-CONTENT-PAYLOAD-1234567890');
  writeFile(tmp, 'unique.md', 'ONLY-ONE');

  const repo = new ChronoBoxRepository(tmp);
  repo.init('重复体检');
  const res = findDuplicateFiles(repo);
  assert.equal(res.groups.length, 1);
  assert.equal(res.groups[0].paths.length, 2);
  assert.equal(res.totalDuplicateFiles, 1);
  assert.equal(res.totalWastedBytes, Buffer.byteLength('SAME-CONTENT-PAYLOAD-1234567890'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 51. Single-file milestone timeline with rename tracking
test('51. 单文件里程碑时间线：精准过滤无变化版本并跨重命名追踪演进节点', () => {
  const tmp = makeTempDir('cb-ms-');
  writeFile(tmp, 'paper.docx', 'v1');
  writeFile(tmp, 'other.txt', 'o1');
  const repo = new ChronoBoxRepository(tmp);
  repo.init('里程碑');
  repo.createArchive({ title: '初稿' });

  // 仅改 other.txt，不改 paper.docx → 不应出现在 paper 的里程碑中
  writeFile(tmp, 'other.txt', 'o2');
  repo.createArchive({ title: '改其他文件' });

  // 修改 paper.docx
  writeFile(tmp, 'paper.docx', 'v2-revised');
  repo.createArchive({ title: '论文二稿' });

  // 重命名为 paper_final.docx
  fs.renameSync(path.join(tmp, 'paper.docx'), path.join(tmp, 'paper_final.docx'));
  repo.createArchive({ title: '定稿改名' });

  const ms = getFileMilestoneTimeline(repo, 'paper_final.docx');
  assert.equal(ms.length, 3, '应只包含初稿、论文二稿、定稿改名 3 个实质变更节点');
  assert.equal(ms[0].action, 'initial');
  assert.equal(ms[1].action, 'modified');
  assert.equal(ms[2].action, 'renamed');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 52. Global search across multiple projects
test('52. 跨项目全局快速检索：跨多项目秒搜文件名、存档标题与备注', () => {
  const cfgDir = makeTempDir('cb-gs-cfg-');
  const d1 = makeTempDir('cb-gs-p1-');
  const d2 = makeTempDir('cb-gs-p2-');
  writeFile(d1, '膜分离_XRD图谱.opju', 'xrd');
  writeFile(d2, '专利交底书.docx', 'patent');

  const wm = new WorkspaceManager(cfgDir);
  wm.addProject(d1, '博士课题');
  wm.addProject(d2, '发明专利');

  const hits1 = globalSearchWorkspace(wm, 'XRD');
  assert.ok(hits1.some((h) => h.kind === 'file' && h.relPath === '膜分离_XRD图谱.opju'));

  const hits2 = globalSearchWorkspace(wm, '专利');
  assert.ok(hits2.some((h) => h.kind === 'project' && h.projectName === '发明专利'));

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(d1, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

// 53. Progress report Markdown auto-generation
test('53. 项目周报/科研进展自动汇总：自动统计周期存档、高频文档并生成 Markdown 表格', () => {
  const cfgDir = makeTempDir('cb-rep-cfg-');
  const d1 = makeTempDir('cb-rep-p1-');
  writeFile(d1, '第三章.docx', 'c1');
  const wm = new WorkspaceManager(cfgDir);
  const p = wm.addProject(d1, '论文写作');
  writeFile(d1, '第三章.docx', 'c2-done');
  wm.getRepository(p.id).createArchive({ title: '完成实验分析小节', note: '补充了热重曲线' });

  const rep = generateProgressReport(wm, { projectId: p.id, days: 7 });
  assert.equal(rep.projectCount, 1);
  assert.equal(rep.archiveCount, 2);
  assert.ok(rep.markdown.includes('近 7 天项目周报'));
  assert.ok(rep.markdown.includes('完成实验分析小节'));
  assert.ok(rep.markdown.includes('第三章.docx'));

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(d1, { recursive: true, force: true });
});

console.log(`\n测试完成：通过 ${passed} 项，失败 ${failed} 项。`);
if (failed > 0) {
  process.exit(1);
}
