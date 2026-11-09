// 前台轮询小工具（2026-11-09 方案 B06）
//
// 解决现有各 store 里 `setInterval(fetchX, 60000)` 的三个真问题：
//
// 1. **任务重叠**：setInterval 固定间隔，请求比间隔慢时下一轮在上轮还没回来时又发出，
//    同一条数据被并发拉两次，晚到的旧响应还可能覆盖新状态。这里改成
//    「上一次结束后再排下一次」的自调度链，任何时刻只有一个在途请求。
// 2. **后台空转**：页面不可见（后台标签页 / 手机休眠）时照常每 60 秒打一次接口。
//    现在不可见时按 `backgroundFactor` 降频，可见后**立即补一次**再恢复原节奏。
// 3. **卸载不清理**：各 store 自己管 timer，容易漏 clear。统一在 stop 里清干净。

/**
 * @param {object} spec
 * @param {Function} spec.task 要周期性执行的任务（返回 Promise）
 * @param {number} [spec.intervalMs] 可见时的间隔
 * @param {number} [spec.backgroundFactor] 不可见时的间隔倍率（默认 4 = 4 倍间隔）
 * @returns {{ start: Function, stop: Function, kick: Function, isRunning: Function }}
 */
export function createPoller({ task, intervalMs, backgroundFactor = 4 }) {
  let timer = null
  let running = false
  let inFlight = false
  let stopped = false

  const isVisible = () => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden')

  const currentInterval = () => (isVisible() ? intervalMs : intervalMs * Math.max(1, backgroundFactor))

  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null }
  }

  const schedule = (delay) => {
    if (stopped) return
    clear()
    timer = setTimeout(run, delay ?? currentInterval())
  }

  const run = async () => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      await task()
    } catch (err) {
      // 单轮失败不该终止整条轮询链，下一轮照常排
      console.error('[poller] 轮询任务失败:', err?.message || err)
    } finally {
      inFlight = false
      // 上一轮结束后才排下一轮 —— 这就是「不重叠」的实现方式
      schedule()
    }
  }

  const onVisibilityChange = () => {
    if (!running) return
    if (isVisible()) {
      // 回到前台：立即补一次（否则要等一个完整间隔才看到变化），然后恢复原节奏
      if (inFlight) return
      clear()
      run()
    } else {
      // 转入后台：把下一次往后推，避免后台空转
      schedule(currentInterval())
    }
  }

  return {
    /** 立即执行一次并开始周期性轮询（幂等：重复调用不叠加） */
    start() {
      if (running) return
      running = true
      stopped = false
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
      run()
    },
    /** 停止并清干净 */
    stop() {
      running = false
      stopped = true
      clear()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    },
    /** 手动催一次（比如收到 SSE 后想立刻刷新）：不等待当前轮结束，避免堆积 */
    kick() {
      if (!running || inFlight) return
      clear()
      run()
    },
    isRunning: () => running,
  }
}