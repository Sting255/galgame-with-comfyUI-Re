/**
 * GPU 任务队列（P1-14）。
 *
 * 原始实现是一个裸 FIFO 链：
 *
 *     let tail = Promise.resolve();
 *     return work => { const r = tail.then(work); tail = r.catch(() => {}); return r; };
 *
 * 它保证了「先来先跑、后到的不会饿死前面」，但有三个洞：
 *
 *   1. **没有上界**。爆发时（用户连点、批量重绘、调度器同时触发）等待队列可以无限长，
 *      每一份都攥着闭包里的图片与提示词，内存随之外推；用户也拿不到「队太长了」的反馈，
 *      只会看到界面一直转圈。
 *   2. **没有关闭闸门**。进程开始优雅退出后，新任务仍能入队并被排到已退出进程后面，
 *      让退出流程等到超时才强杀。
 *   3. **等待中的任务无法取消**。用户点了取消、关掉了页面，已经在排队的那一份仍会
 *      在轮到它时真的跑起来，白烧一次 GPU。
 *
 * 现在补上这三件事，同时**保持调用签名兼容**：`queue(work)` 照旧可用，
 * 第二个可选参数 `{ signal }` 才启用取消。返回值仍是「work 的 Promise」。
 *
 * 队列满抛 `code='GPU_QUEUE_FULL'`；关闭后抛 `GPU_QUEUE_CLOSED`；
 * 等待期间被取消抛 `AbortError`（与 fetch 的取消语义一致，调用方已有处理）。
 */

const DEFAULT_MAX_PENDING = 24;

function queueError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * @param {object} [options]
 * @param {number} [options.maxPending] 允许同时在排队（尚未开始执行）的任务上限
 * @param {string} [options.label] 日志前缀，便于区分 image / speech 两侧
 */
export function createGpuQueue({ maxPending = DEFAULT_MAX_PENDING, label = 'gpu' } = {}) {
  let tail = Promise.resolve();
  let waiting = 0;          // 已在队列里、还没开始执行的数量
  let closed = false;
  let closedReason = '';

  /**
   * 排队执行 work。
   * @param {Function} work 实际执行体
   * @param {{signal?: AbortSignal}} [options]
   */
  function run(work, options = {}) {
    const { signal } = options;
    if (closed) {
      return Promise.reject(queueError(`GPU 队列已关闭，不再接受新任务（${closedReason || '进程正在退出'}）`, 'GPU_QUEUE_CLOSED'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? Object.assign(new Error('任务已取消'), { name: 'AbortError' }));
    }
    if (waiting >= maxPending) {
      return Promise.reject(queueError(`GPU 队列已满（${waiting}/${maxPending} 个任务在排队），请稍后重试`, 'GPU_QUEUE_FULL'));
    }

    waiting += 1;
    const result = tail.then(async () => {
      waiting -= 1;
      // 排队期间被取消 / 队列被关闭：不再执行 work，避免白烧一次 GPU
      if (closed) throw queueError(`GPU 队列已关闭（${closedReason || '进程正在退出'}）`, 'GPU_QUEUE_CLOSED');
      if (signal?.aborted) {
        throw signal.reason ?? Object.assign(new Error('任务已取消'), { name: 'AbortError' });
      }
      return work();
    });
    // 链尾只关心「这一环结束了」，不关心成败；否则一次失败会让后续任务永不启动
    tail = result.then(() => {}, () => {});
    return result;
  }

  /**
   * 关闭闸门：之后不再接受新任务；已在排队的会在轮到时直接失败。
   *
   * 不主动中断正在执行的那一个 —— GPU 上跑着的那次推理没有安全的取消点，
   * 强行中断只会留下半张图或未释放的显存锁。调用方应等它自然结束。
   */
  function close(reason = '') {
    closed = true;
    closedReason = String(reason || '');
    console.log(`[${label}] 队列已关闭（${waiting} 个任务仍在排队，将被拒绝）：${closedReason || '进程退出'}`);
  }

  function isClosed() {
    return closed;
  }

  /** 队列水位（排障与「运行状态」面板用） */
  function status() {
    return { waiting, maxPending, closed, closedReason };
  }

  // 让调用方既能 `queue(work)`，也能读到队列自身状态
  run.close = close;
  run.isClosed = isClosed;
  run.status = status;
  return run;
}

export const withGpu = createGpuQueue({ label: 'gpu' });
