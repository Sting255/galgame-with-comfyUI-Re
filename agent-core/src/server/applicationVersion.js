import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const VERSION_TAG = /^v?\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/;

function readText(file) {
  try { return readFileSync(file, 'utf8').trim(); }
  catch { return ''; }
}

function stamp(file) {
  try {
    const stat = statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return ''; }
}

/** 原地更新也能识别精确版本；Git 只在 HEAD、引用或 tags 变化后执行一次。 */
export function createApplicationVersionReader(root) {
  let cachedKey;
  let cachedTag = null;
  return function readApplicationVersion() {
    const baseVersion = readText(path.join(root, 'VERSION'));
    const buildTag = readText(path.join(root, 'BUILD_TAG'));
    const dotGit = path.join(root, '.git');
    let gitDir = dotGit;
    try {
      if (statSync(dotGit).isFile()) {
        const target = readText(dotGit).match(/^gitdir:\s*(.+)$/)?.[1];
        if (!target) return buildTag || baseVersion;
        gitDir = path.resolve(root, target);
      }
    } catch { return buildTag || baseVersion; }
    const common = readText(path.join(gitDir, 'commondir'));
    const commonDir = common ? path.resolve(gitDir, common) : gitDir;
    const headPath = path.join(gitDir, 'HEAD');
    const head = readText(headPath);
    if (!head) return buildTag || baseVersion;
    const ref = head.match(/^ref: (refs\/.+)$/)?.[1];
    const refPath = ref ? path.resolve(commonDir, ref) : headPath;
    const key = [gitDir, head, stamp(headPath), readText(refPath), stamp(refPath),
      stamp(path.join(commonDir, 'packed-refs')), stamp(path.join(commonDir, 'refs', 'tags'))].join('|');
    if (key !== cachedKey) {
      cachedKey = key;
      cachedTag = null;
      const bundledGit = path.join(root, 'runtime', 'git', 'cmd', 'git.exe');
      try {
        const tag = execFileSync(existsSync(bundledGit) ? bundledGit : 'git',
          ['describe', '--tags', '--exact-match', 'HEAD'],
          { cwd: root, encoding: 'utf8', timeout: 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        cachedTag = VERSION_TAG.test(tag) ? tag.replace(/^v/, '') : '';
      } catch (error) {
        // 没有精确 tag 是正常开发态；Git 缺失或超时才使用包内版本兜底。
        if (error.status === 128) cachedTag = '';
      }
    }
    // 包内 BUILD_TAG 是构建时的快照。Git 可用时以实际 checkout 为准，避免切版本后读到旧值。
    return cachedTag === null ? (buildTag || baseVersion) : (cachedTag || baseVersion);
  };
}
