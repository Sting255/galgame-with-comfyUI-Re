/**
 * 一键导出 / 一键导入 接口
 *
 *   GET  /api/data/export?includeConfig=0|1   → 200 流式返回 linshe-backup-<YYYYMMDD-HHmm>.tar.gz
 *   GET  /api/data/export/info                → 200 { ok, dbBytes, counts, lastExportAt }
 *   POST /api/data/import                     → 200 { ok, restored, backupPath, restartRecommended, message }
 *
 * 实现口径：
 *   - 导出**先落临时文件再发**：生成过程中出错返回 500 JSON，绝不会吐半个归档给前端；
 *     发送用 res.sendFile 从磁盘流式读（不把归档读进内存），发完删临时文件。
 *   - 导入体是 .tar.gz 原始字节；先在进入路由 body 之前抢单并发槽，再流式写入
 *     独立 linshe-import-* 暂存目录，由服务直接读文件流做 gunzip/tar 校验。
 *     上限按请求现读 LINSHE_BACKUP_MAX_BYTES；超限、取消或错误都只释放一次。
 *   - 校验/落地全部在 services/dataBackup.js 里，本文件只负责 HTTP 形状。
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { scheduleSelfRestart } from '../services/procRestart.js';
import {
  createBackup, importBackup, getExportInfo, getMaxArchiveBytes, BackupError, stageImportUpload,
} from '../services/dataBackup.js';

const router = Router();

const activeImportTasks = new Set();
function trackImportTask() {
  let settle;
  const task = new Promise(resolve => { settle = resolve; });
  activeImportTasks.add(task);
  return () => {
    if (!activeImportTasks.delete(task)) return;
    settle();
  };
}

/** 退出流程在关库前等待本次导入完成暂存清理；超时由总退出 deadline 兜底。 */
export async function waitForDataImportsToSettle({ timeoutMs = 5000 } = {}) {
  if (activeImportTasks.size === 0) return true;
  let timer;
  const settled = Promise.allSettled([...activeImportTasks]).then(() => true);
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 导入并发槽必须在任何请求体读取之前取得。
 * 409 响应会关闭当前连接；服务端不会为第二个大包保留 socket 级或内存级缓冲。
 */
let importSlotBusy = false;
function acquireImportSlot(req, res, next) {
  if (importSlotBusy) {
    res.setHeader('Retry-After', '2');
    res.setHeader('Connection', 'close');
    res.status(409).json({
      error: '已有备份正在导入',
      detail: '请等当前导入完成后再试',
    });
    return;
  }

  importSlotBusy = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    importSlotBusy = false;
  };
  res.locals.releaseImportSlot = release;
  // 响应断开不代表后台恢复/暂存清理已经结束；槽只在路由 finally 中释放。
  next();
}

router.get('/export/info', asyncHandler(async (req, res) => {
  res.json(getExportInfo());
}));

router.get('/export', asyncHandler(async (req, res) => {
  const includeConfig = String(req.query.includeConfig ?? '0') === '1';
  let backup = null;
  try {
    backup = await createBackup({ includeConfig });
  } catch (err) {
    console.error('[data] 导出失败:', err.message);
    // 429 = 已经有一份在导出了（重内存操作不并发），要如实告诉用户"稍后再试"，
    // 而不是笼统的"导出失败"让人以为功能坏了
    const status = err?.status === 429 ? 429 : 500;
    return res.status(status).json({
      error: status === 429 ? err.message : '导出失败，没有生成任何归档',
      detail: err.message,
    });
  }

  // 归档已经完整落盘，这里才开始写响应头
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${backup.fileName}"`);
  res.setHeader('Content-Length', String(backup.bytes));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Linshe-Backup-Bytes', String(backup.bytes));

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    backup.cleanup().catch(() => {});
  };
  res.on('close', cleanup);

  res.sendFile(backup.file, err => {
    cleanup();
    if (!err) return;
    // 头已经发出去就没法改成 JSON 了，只能断开；至少把原因记下来
    console.error('[data] 归档发送中断:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '导出失败', detail: err.message });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });
}));

router.post('/import', acquireImportSlot, asyncHandler(async (req, res) => {
  let upload = null;
  const releaseSlot = res.locals.releaseImportSlot;
  const finishImportTask = trackImportTask();
  try {
    const maxBytes = getMaxArchiveBytes();
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.setHeader('Connection', 'close');
      return res.status(413).json({
        error: '归档超过大小上限',
        detail: `声明 ${declared} 字节 > 上限 ${maxBytes} 字节（可用环境变量 LINSHE_BACKUP_MAX_BYTES 覆盖）`,
      });
    }

    upload = await stageImportUpload(req, { maxBytes });
    // 上传刚结束时连接可能已被用户关闭；此时不要启动不可撤销的恢复。
    if (req.aborted || res.destroyed) return;

    const result = await importBackup(upload.file, {
      maxBytes,
      holdUntilRestart: req.app.locals.restoreRequiresRestart !== false,
    });
    // 重启调度必须独立于客户端是否仍在：holdUntilRestart 成功时服务已停止接单，
    // 若不在这里安排自重启，连接中途断开会让进程永久停在维护状态。
    if (result.restartRequired || result.restartRecommended) {
      scheduleSelfRestart({ delayMs: 2500, reason: '备份已恢复' });
    }
    if (res.destroyed) return;
    res.json({
      ok: true,
      restored: result.restored,
      backupPath: result.backupPath,
      restartRecommended: result.restartRecommended,
      restartRequired: result.restartRequired,
      message: result.message,
      // 前端据此显示「正在重启…」并轮询 /api/health，起来后自动刷新
      autoRestart: Boolean(result.restartRequired || result.restartRecommended),
    });
  } catch (err) {
    if (res.destroyed || res.headersSent) return;
    // 上传可能在未 EOF 时因坏头/超限提前停止；本响应结束后关闭连接，不再吞剩余字节。
    res.setHeader('Connection', 'close');
    if (err instanceof BackupError) {
      const status = err.status || 400;
      console.error(`[data] 导入失败(${status}):`, err.message, err.detail || '');
      if (status >= 500) {
        return res.status(500).json({ error: err.message, detail: err.detail || '', backupPath: err.backupPath });
      }
      return res.status(status).json({ error: err.message, detail: err.detail || '' });
    }
    console.error('[data] 导入失败(500):', err.message);
    res.status(500).json({ error: '导入失败', detail: err.message, backupPath: null });
  } finally {
    try {
      if (upload) await upload.cleanup();
    } finally {
      releaseSlot?.();
      // 客户端中途断开时这次响应不会自行 end；主动销毁才能让 HTTP 生命周期移除它。
      if (!res.writableEnded && !res.destroyed) res.destroy();
      finishImportTask();
    }
  }
}));

/**
 * 本路由内的错误兜底保留 body-parser 的既有错误形状；上传主链路已改为手动流式读取，
 * 其余错误交给全局 errorHandler。放在所有路由之后注册，只兜 /api/data 自己的请求。
 */
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: '归档超过大小上限',
      detail: `上限 ${getMaxArchiveBytes()} 字节（可用环境变量 LINSHE_BACKUP_MAX_BYTES 覆盖）`,
    });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(400).json({ error: '请求体无法解析', detail: err.message });
  }
  next(err);
});

export default router;
