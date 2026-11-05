/**
 * 进程自重启（2026-11-06，用户：「导入之后自动重启软件不就行了」）
 *
 * ## 为什么需要
 *
 * 导入备份要换库、可能还要写回 `.env`，这两件事都**只有新进程才会生效**：
 * `database` 句柄是旧的、`config` 是启动时读的。所以恢复成功后进程会进入维护锁，
 * 之后每个定时任务都在报「备份已恢复，请重启邻舍后继续使用」—— 设计如此，但让用户
 * 自己去关窗口、杀进程、重新点启动，实际踩过：启动器被重复点，第二次的端口清理把
 * 刚起来的新进程当成残留杀掉，来回报 code 15 / code 1。
 *
 * 与其让用户手工操作，不如恢复完这一轮**自己换一个进程**：
 *   ① 先把 HTTP 响应发出去（前端要拿到「已恢复」再去轮询健康）；
 *   ② 再 spawn 一个同参数的新进程并 unref，让它活得比本进程久；
 *   ③ 本进程正常退出，端口随即释放，新进程重新 listen。
 *
 * ## 边界
 *
 * · 只在**导入备份**这条路径上调用；普通"保存设置"不需要重启（各自有热更新）。
 * · `delayMs` 必须大于响应发送时间，否则前端拿到的是断连而不是成功。
 * · 拉起失败不吞：打到日志里，用户仍可手动手动重启（维护锁本来就要求重启）。
 * · 不处理"启动器监测到子进程退出后报错"：启动器的状态灯会显示已停止，
 *   但新进程是独立的，服务照常在跑 —— 下一次点启动会先清端口把它收掉再起，结果也正确。
 */

import { spawn } from 'node:child_process';

/**
 * 安排一次自重启：延时后拉起新进程并退出当前进程。
 *
 * @param {{ delayMs?: number, reason?: string }} [options]
 * @returns {{ scheduled: true, delayMs: number }}
 */
export function scheduleSelfRestart({ delayMs = 2000, reason = '数据已恢复' } = {}) {
  const entry = process.argv[1];
  const wait = Math.max(200, Number(delayMs) || 2000);

  if (!entry) {
    console.error('[restart] 拿不到入口脚本路径（process.argv[1] 为空），无法自重启；请手动重启');
    return { scheduled: false, delayMs: 0 };
  }

  console.log(`[restart] ${reason}：${Math.round(wait / 1000)} 秒后自动重启（新进程会接管端口）`);

  const timer = setTimeout(() => {
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
      // 拉不起来也别让用户以为重启成功了 —— 维护锁会继续拦住所有写入，重启是必需的
      console.error('[restart] 拉起新进程失败，请手动重启邻舍：', err?.message || err);
    }
    // 留一点点时间让上面那行日志进文件，再退出
    setTimeout(() => process.exit(0), 200);
  }, wait);

  // 不阻塞事件循环退出（用户可能在延时内主动关机）
  if (typeof timer.unref === 'function') timer.unref();
  return { scheduled: true, delayMs: wait };
}
