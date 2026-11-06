import { AsyncLocalStorage } from 'node:async_hooks';

// 换库时关闭旧句柄；只有本次恢复任务可以重开库。成功后可保持关闭直到重启，
// 避免恢复前发出的 LLM/定时任务把旧世界的结果写入新库。
const context = new AsyncLocalStorage();
let owner = null;
let reason = null;
let recoveryRequired = null;

export function maintenanceStatus() { return reason; }
export function requireDatabaseRecovery(message) { recoveryRequired = message; }

export function assertDatabaseAvailable() {
  if (reason && (!owner || context.getStore() !== owner)) {
    const error = new Error(reason);
    error.status = 503;
    error.code = 'DATABASE_MAINTENANCE';
    throw error;
  }
}

export async function withDatabaseMaintenance(task, { holdUntilRestart = false } = {}) {
  assertDatabaseAvailable();
  if (owner) throw new Error('数据库维护不可嵌套');
  const token = Symbol('database-restore');
  owner = token;
  reason = '正在恢复备份，请稍后再试';
  let completed = false;
  try {
    const result = await context.run(token, task);
    completed = true;
    return result;
  } finally {
    owner = null;
    reason = recoveryRequired || (completed && holdUntilRestart ? '备份已恢复，请重启邻舍后继续使用' : null);
  }
}
