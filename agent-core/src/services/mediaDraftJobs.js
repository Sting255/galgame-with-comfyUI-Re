/**
 * 媒体草稿生成的进程内后台任务（2026-11-08 用户要求）。
 *
 * 为什么要有它：
 *   「规划 5 家媒体」「按世界观重写这家媒体」「按想法生成草稿」都是同步 LLM 调用。
 *   同步链路被截断/审核中断时最多会自动续写 5 次（见 llm-client 的 MAX_INCOMPLETE_RETRIES），
 *   一次点击最坏要发 6 次请求、干转 1~2 分钟，而这期间界面只有一个转圈，
 *   用户既不知道在干什么也取消不了。
 *
 * 口径：
 *   · POST 立即返回 { jobId }（202），生成在后台跑，前端轮询 GET /media/jobs/:id
 *   · 任务只活在内存里 —— 草稿本来只是「预览」，进程重启丢掉没有任何损失，不落库
 *   · 保留最近 MAX_JOBS 条、超过 TTL_MS 的自动清掉，避免长跑的实例慢慢攒垃圾
 *   · 同一时间不限制并发数量：规划本来就是用户手动点、一次一个
 */

const jobs = new Map();
const MAX_JOBS = 20;
const TTL_MS = 10 * 60 * 1000;
let seq = 0;

function prune(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (now - job.startedAt > TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

/**
 * 起一个后台任务。
 * @param {string} kind 任务类型（只用于日志与前端区分：draft / plan / redesign）
 * @param {() => Promise<any>} run 真正干活的函数，返回值会作为 result 交给前端
 * @returns {{jobId: string, status: string}}
 */
export function startMediaJob(kind, run) {
  seq += 1;
  const id = `mj_${Date.now().toString(36)}_${seq}`;
  const job = {
    id,
    kind: String(kind || 'job'),
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  };
  jobs.set(id, job);
  prune();
  console.log(`[mediaJob] ▸ 开始 ${job.kind} (${id})`);
  Promise.resolve()
    .then(run)
    .then((result) => {
      job.status = 'done';
      job.result = result === undefined ? null : result;
      job.finishedAt = Date.now();
      console.log(`[mediaJob] ✓ 完成 ${job.kind} (${id}) ${job.finishedAt - job.startedAt}ms`);
    })
    .catch((err) => {
      // 不往外抛：错误通过任务状态交给前端（轮询方拿到的是一次正常响应）
      job.status = 'failed';
      job.error = err?.message || String(err);
      job.finishedAt = Date.now();
      console.warn(`[mediaJob] ✗ 失败 ${job.kind} (${id}) ${job.finishedAt - job.startedAt}ms: ${job.error}`);
    });
  return { jobId: id, status: job.status };
}

/** 查任务状态；不存在返回 null（路由据此回 404，多半是重启后旧 jobId 失效） */
export function getMediaJob(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return null;
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  };
}
