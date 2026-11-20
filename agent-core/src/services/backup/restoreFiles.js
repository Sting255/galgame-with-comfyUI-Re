import fs from 'node:fs/promises';
import path from 'node:path';

/** 为本次覆盖保留逐文件回滚副本；归档中不存在的旧素材继续保留。 */
export function createRestoreJournal(directory) {
  const entries = [];
  return {
    async copy(source, target, root) {
      const absoluteRoot = path.resolve(root);
      const absoluteTarget = path.resolve(target);
      if (!absoluteTarget.startsWith(absoluteRoot + path.sep)) throw new Error('恢复路径超出目标目录');
      // 目标现有的软链/junction 不能把归档写到配置目录之外。
      let current = absoluteRoot;
      for (const part of ['', ...path.relative(absoluteRoot, absoluteTarget).split(path.sep)]) {
        if (part) current = path.join(current, part);
        const stat = await fs.lstat(current).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (stat?.isSymbolicLink()) throw new Error(`恢复目标含符号链接：${current}`);
      }
      await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
      const previous = path.join(directory, String(entries.length));
      let existed = true;
      await fs.mkdir(directory, { recursive: true });
      try { await fs.copyFile(absoluteTarget, previous); }
      catch (error) { if (error.code === 'ENOENT') existed = false; else throw error; }
      entries.push({ target: absoluteTarget, previous: existed ? previous : null });
      await fs.copyFile(source, absoluteTarget);
    },
    async rollback() {
      const errors = [];
      for (const entry of entries.reverse()) {
        try {
          if (entry.previous) await fs.copyFile(entry.previous, entry.target);
          else await fs.rm(entry.target, { force: true });
        } catch (error) { errors.push(error.message); }
      }
      if (errors.length) throw new Error(errors.join('; '));
    },
  };
}
