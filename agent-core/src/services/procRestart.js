/**
 * 进程自重启（2026-11-06，用户：「导入之后自动重启软件不就行了」）
 *
 * ## 为什么需要
 *
 * 导入备份要换库、可能还要写回 `.env`，这两件事都**只有新进程才会生效**：
 * `database` 句柄是旧的、`config` 是启动时读的。恢复成功后进程进入维护锁，
 * 之后每个定时任务都在报「备份已恢复，请重启邻舍后继续使用」。
 *
 * ## 两种模式（2026-11-06 真机修）
 *
 * · **被启动器托管**（`LINSHE_MANAGED_BY_LAUNCHER=1`）：用 `RESTART_EXIT_CODE` 退出，
 *   由启动器拉起新进程。第一版是后端自己 `spawn(detached, stdio:'ignore')`，
 *   结果新进程的 stdout 对启动器不可见，启动器只看到旧进程"意外退出 code 0"，
 *   界面上就是"崩了、没重启"（用户实测反馈）。
 * · **未被托管**（命令行 `node app.js` 自己跑）：仍然 spawn 一个新进程再退出，
 *   否则没有谁来拉起它。
 *
 * ## 边界
 *
 * · 只在**导入备份**这条路径上调用；普通"保存设置"有各自的热更新，不需要重启。
 * · `delayMs` 必须大于响应发送时间，否则前端拿到的是断连而不是成功。
 * · 拉起失败不吞：打到日志里，用户仍可手动重启（维护锁本来就要求重启）。
 */

import { spawn } from 'node:child_process';

/** 与 launcher/launcher/service_runner.py 的 RESTART_EXIT_CODE 保持一致，改一处就要同步另一处 */
export const RESTART_EXIT_CODE = 75;

/**
 * 安排一次自重启：延时后退出（托管模式）或拉起新进程后退出（独立模式）。
 *
 * @param {{ delayMs?: number, reason?: string }} [options]
 * @returns {{ scheduled: boolean, delayMs: number, mode: 'launcher'|'spawn' }}
 */
export function scheduleSelfRestart({ delayMs = 2000, reason = '数据已恢复' } = {}) {
  const managed = process.env.LINSHE_MANAGED_BY_LAUNCHER === '1';
  const entry = process.argv[1];
  const wait = Math.max(200, Number(delayMs) || 2000);

  if (!managed && !entry) {
    console.error('[restart] 拿不到入口脚本路径（process.argv[1] 为空），无法自重启；请手动重启');
    return { scheduled: false, delayMs: 0, mode: 'spawn' };
  }

  console.log(`[restart] ${reason}：${Math.round(wait / 1000)} 秒后`
    + (managed ? '退出并由启动器拉起新进程' : '拉起新进程后退出'));

  const timer = setTimeout(() => {
    if (!managed) {
      try {
        const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        console.log(`[restart] 已拉起新进程 pid=${child.pid}，本进程退出`);
      } catch (err) {
        console.error('[restart] 拉起新进程失败，请手动重启邻舍：', err?.message || err);
      }
      setTimeout(() => process.exit(0), 200);
      return;
    }
    // 托管模式：把「要重启」这件事交给启动器，它能接管端口、日志与状态灯
    console.log(`[restart] 交给启动器重启（exit ${RESTART_EXIT_CODE}）`);
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 200);
  }, wait);

  // 不阻塞事件循环退出（用户可能在延时内主动关机）
  if (typeof timer.unref === 'function') timer.unref();
  return { scheduled: true, delayMs: wait, mode: managed ? 'launcher' : 'spawn' };
}
