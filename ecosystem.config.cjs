/**
 * ⚠️ **本文件当前不是承重配置**（2026-10-17 复查 §P2-2）。
 *
 * 真实启动方式：`scripts/autostart-core.ps1`（计划任务「登录时」触发，node 直起、自带重复守卫）
 * 或根目录启动器 `邻舍.EXE.exe`。README 里原来把它写成「PM2 生产配置」，那是**误导**。
 *
 * 为什么把它降级：`vector-svc` 那条原来带 `wait_ready: true`，而 PM2 的 `wait_ready` 等的是
 * 进程主动 `process.send('ready')` —— **uvicorn 永远不发这个信号** ⇒ 15s 后必然被判启动失败、
 * 进重启循环。也就是说按这份配置起向量服务是**起不来的**（实测口径与 autostart-core.ps1 一致）。
 *
 * 已去掉 `wait_ready`，并显式关掉 PM2 的 ready 探测；保留 PM2 的目的只是**给想用 PM2 的人一个起点**。
 * 要用的话先跑一遍 `pm2 start ecosystem.config.cjs` 自测，别当成开箱即用。
 */
module.exports = {
  apps: [
    {
      name: 'agent-core',
      script: 'app.js',
      cwd: './agent-core',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'vector-svc',
      script: 'uvicorn',
      args: 'server:app --host 0.0.0.0 --port 8765',
      interpreter: './venv/Scripts/python.exe',
      cwd: './vector-service',
      // ⚠️ 不要加回 `wait_ready: true` —— uvicorn 不会发 PM2 的 ready 信号，加了就永远起不来。
      wait_ready: false,
      listen_timeout: 15000,
      env: {
        PYTHONUNBUFFERED: '1',
      },
    },
  ],
};
