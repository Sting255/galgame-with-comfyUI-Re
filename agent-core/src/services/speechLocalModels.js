import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LOCAL_TTS_MODELS, localTtsModel } from './localTtsModels.js';
import { getSpeechSettings, setSpeechSettings } from './speechService.js';
import { restartSpeechService } from './speechServiceProcess.js';
import { speechComfyUrl } from './speechGpuPolicy.js';

const root = fileURLToPath(new URL('../../../tts-service/', import.meta.url));
const execute = promisify(execFile);

/**
 * 本次安装/检查要使用的 ComfyUI 地址。
 *
 * 优先用环境变量里显式配置的值（用户可能单独指定一台机器跑显存调度），
 * 否则用项目当前生效的 config.comfyui.url —— 而不是让子进程去猜默认值。
 * 导出一份纯函数便于验证：安装器拿到的一定是"此刻实际在用"的那个地址。
 */
function __comfyUrlForSpeech(env = process.env) {
  return String(env.TTS_COMFYUI_URL || '').trim() || speechComfyUrl();
}
export const resolveSpeechComfyUrl = __comfyUrlForSpeech;
export async function inspectLocalModels() {
  let python;
  try {
    const runtime = JSON.parse(readFileSync(path.join(root, 'runtime/runtime.json'), 'utf8'));
    const base = path.resolve(root, 'runtime', runtime.python_home);
    if (!base.startsWith(path.join(root, 'runtime') + path.sep)) throw new Error('Invalid Python path');
    python = path.join(base, 'python.exe');
  } catch { /* A fresh install has no bundled Python yet. */ }
  const runtimeFiles = ['runtime/runtime.json', 'runtime/tools/ffmpeg/bin/ffmpeg.exe', 'runtime/tools/ffmpeg/bin/ffprobe.exe'];
  if (!python || !existsSync(python) || runtimeFiles.some(file => !existsSync(path.join(root, file)))) {
    return Object.values(LOCAL_TTS_MODELS).map(({ id, label }) => ({ id, label, installed: false, error: '尚未安装完整的本地语音运行环境' }));
  }
  try {
    const { stdout } = await execute(python, ['-X', 'utf8', path.join(root, 'deployment.py'), 'inspect'], {
      windowsHide: true, timeout: 20000, env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' }, maxBuffer: 256 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    return Object.values(LOCAL_TTS_MODELS).map(({ id, label }) => ({ id, label, installed: false, error: `无法检查本地安装：${String(error.stderr || error.message).trim().slice(0, 800)}` }));
  }
}

export function createLocalSpeechModelManager({ inspect = inspectLocalModels, launch = spawn,
  restart = restartSpeechService, settings = getSpeechSettings, configure = setSpeechSettings,
  platform = process.platform, env = process.env } = {}) {
  let installation = { status: 'idle', model: null, log: '', error: '' }, using = null;
  /**
 * 本地语音现状（A10）：除了逐模型的 installed/error，再给出一个**诊断结论**，
 * 让前端能区分「没装」「装了但服务没重启」「装了但连不上」「版本不匹配」这四种，
 * 而不是统一显示一句"不可用"。
 *
 * 判定顺序按用户能自己解决的成本从低到高：
 *   not_installed → 运行环境或模型缺失
 *   service_offline → 装了但声音服务没起（多半是没重启）
 *   version_mismatch → 服务在跑但不是所选模型
 *   ok
 */
const status = async () => {
  const selected = settings().local_model || '2.0';
  let models = [];
  let modelsError = '';
  try { models = await inspect(); } catch (err) { modelsError = err?.message || String(err); }
  const target = models.find(m => m.id === selected);
  const anyInstalled = models.some(m => m.installed);
  let diagnosis = 'ok';
  if (!target?.installed) {
    diagnosis = anyInstalled ? 'not_installed' : 'runtime_missing';
  }
  return {
    selected,
    models,
    installation: { ...installation },
    using,
    diagnosis,
    diagnosisHint: diagnosisHint(diagnosis, selected, modelsError),
    // 显式报出本次会用的 ComfyUI 地址，排查"语音装好了却调度到别处"时一眼能看出来
    comfyUrl: __comfyUrlForSpeech(),
  };
};

function diagnosisHint(diagnosis, selected, modelsError) {
  if (modelsError) return `无法检查本地安装：${modelsError}`;
  switch (diagnosis) {
    case 'runtime_missing': return '尚未安装本地语音运行环境，请先执行一键安装';
    case 'not_installed': return `所选模型 ${selected} 尚未安装，请在一键安装里选择它`;
    default: return '';
  }
}
  function install(model) {
    localTtsModel(model);
    if (platform !== 'win32') throw new Error('一键安装目前支持 Windows，请运行对应的部署脚本');
    if (using || (installation.status === 'running' && installation.model !== model)) throw new Error('另一项本地语音操作正在进行');
    if (installation.status === 'running') return { ...installation };
    installation = { status: 'running', model, log: '正在准备安装…', error: '' };
    const active = installation;
    try {
      const child = launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'setup.ps1'), '-ModelVersion', model],
        {
          windowsHide: true,
          cwd: root,
          // A10：把实际配置的 ComfyUI 地址传给安装器。不传的话，本地语音侧的
          // speechGpuPolicy 读不到 TTS_COMFYUI_URL 会退回 config 默认值 —— 用户在设置里
          // 改了 ComfyUI 端口/主机，安装与显存调度判断就会指向一个不存在的地址。
          env: { ...env, TTS_LOCAL_MODEL: model, TTS_COMFYUI_URL: __comfyUrlForSpeech(env) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      const append = chunk => { if (installation === active) installation.log = (installation.log + String(chunk)).slice(-12000); };
      child.stdout?.on('data', append); child.stderr?.on('data', append);
      child.once('error', error => { if (installation === active) { installation.status = 'failed'; installation.error = `安装启动失败：${error.message}`; } });
      child.once('close', async code => {
        if (installation !== active || installation.status !== 'running') return;
        try {
          const models = code === 0 ? await inspect() : [];
          if (installation !== active) return;
          const installed = models.find(m => m.id === model)?.installed;
          installation.status = installed ? 'completed' : 'failed';
          installation.error = installed ? '' : models.find(m => m.id === model)?.error || `安装未完成（退出码 ${code}），可重试，已下载文件会保留`;
        } catch (error) { installation.status = 'failed'; installation.error = error.message; }
      });
    } catch (error) { installation.status = 'failed'; installation.error = error.message; }
    return { ...installation };
  }
  async function use(model) {
    const desired = localTtsModel(model);
    if (using || installation.status === 'running') throw new Error('请等待当前本地语音操作结束');
    if (settings().mode !== 'local') throw new Error('请先切换到全局本地语音模式');
    using = model;
    const previous = settings().local_model || '2.0';
    let changed = false;
    try {
      const installed = (await inspect()).find(m => m.id === model);
      if (!installed?.installed) throw new Error(`请先安装 ${desired.label}`);
      configure({ local_model: model }); changed = true;
      const health = await restart();
      if (!health.online || !health.ready || health.model_version !== desired.version) throw new Error(health.error || '声音服务未运行所选模型');
      return { settings: settings(), health };
    } catch (error) {
      if (changed) {
        configure({ local_model: previous });
        try { await restart(); } catch { /* Preserve the original startup failure. */ }
      }
      throw error;
    } finally { using = null; }
  }
  return { status, install, use };
}
export const localSpeechModels = createLocalSpeechModelManager();
