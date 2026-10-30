/**
 * `HOST` 监听地址配置的守卫（2026-10-18 新增）
 *
 * ## 为什么要有这条
 * 2026-10-18 给后端加了 `HOST` 环境变量（想只给本机用时设 `HOST=127.0.0.1`），
 * 但**默认行为必须是"监听全部接口"**——因为手机端（Android WebView 壳）访问 PC 上的
 * 服务是这个项目的刚需用法，把默认值改成 `127.0.0.1` 会**静默打断手机端**：
 * 后端日志一切正常、桌面浏览器也正常，只有手机连不上，排查起来很费时间。
 *
 * 所以本文件钉住：
 *   ① 默认（不设 `HOST`）时 `config.host` 必须是 `undefined` —— `app.listen(port, undefined)`
 *      与 `app.listen(port)` 等价，都是"监听全部接口"，与历史行为逐字节一致；
 *   ② 设了 `HOST` 时要真的生效（含首尾空格被 trim）；
 *   ③ 空串/纯空格回落成 `undefined`（不能变成"监听空地址"）；
 *   ④ 顺带确认这次改动没把 `PORT` 口径带歪。
 *
 * ⚠️ **必须用子进程**：`config.js` 在 import 时就固化了 `process.env` 的读取结果，
 *    同进程里改 `process.env.HOST` 再 import 拿不到新值（ESM 模块缓存）。
 *    这与 `dbMaintenance.test.js` 用子进程验 pragma 是同一个理由。
 * ⚠️ **子进程里 import 本仓模块必须用 `file://` URL**：Windows 绝对路径（`D:\…`）直接
 *    import 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（"Received protocol 'd:'"）。
 *    这个坑本仓在 `dbMaintenance.test.js` 里已经踩过并写了注释，这里照抄 `pathToFileURL`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 必须用仓库自带 node（PATH 上可能是 ABI 不兼容的版本） */
const NODE = path.join(CORE, '..', 'runtime', 'nodejs', 'node.exe');
const CONFIG_URL = pathToFileURL(path.join(CORE, 'src', 'config.js')).href;

/** 在干净子进程里读 `config.host`（`@undefined@` 代表确实是 undefined） */
function readHost(env) {
  const script = `
    const { config } = await import(${JSON.stringify(CONFIG_URL)});
    console.log('@@' + JSON.stringify({
      host: config.host === undefined ? '@undefined@' : config.host,
      port: config.port,
    }));
  `;
  const out = execFileSync(NODE, ['--input-type=module', '-e', script], {
    cwd: CORE,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  // 取最后一个带 @@ 前缀的行（config.js 自己可能打日志）
  const line = out.split('\n').filter((l) => l.startsWith('@@')).pop();
  assert.ok(line, `子进程没输出配置：${out.slice(-300)}`);
  return JSON.parse(line.slice(2));
}

test('① 默认不设 HOST：config.host 必须是 undefined（= 监听全部接口，手机端能连）', () => {
  // execFileSync 的 env 不传 HOST；显式构造一份不含 HOST 的环境
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'HOST'));
  const script = `
    const { config } = await import(${JSON.stringify(CONFIG_URL)});
    console.log('@@' + JSON.stringify({ host: config.host === undefined ? '@undefined@' : config.host }));
  `;
  const out = execFileSync(NODE, ['--input-type=module', '-e', script], {
    cwd: CORE, encoding: 'utf8', timeout: 60000, env,
  });
  const line = out.split('\n').filter((l) => l.startsWith('@@')).pop();
  const { host } = JSON.parse(line.slice(2));
  assert.equal(host, '@undefined@',
    '默认必须是 undefined（app.listen(port, undefined) ⇒ 监听全部接口）。改成 127.0.0.1 会静默打断手机端');
});

test('② 设了 HOST=127.0.0.1 要真的生效', () => {
  assert.equal(readHost({ HOST: '127.0.0.1' }).host, '127.0.0.1', 'HOST 环境变量必须生效');
});

test('③ HOST 首尾空格要被 trim（防 .env 里手滑多打空格）', () => {
  assert.equal(readHost({ HOST: '  127.0.0.1  ' }).host, '127.0.0.1', 'HOST 应 trim 后再用');
});

test('④ HOST 是空串/纯空格时回落到 undefined（不能变成"只监听空地址"）', () => {
  for (const v of ['', '   ']) {
    assert.equal(readHost({ HOST: v }).host, '@undefined@',
      `HOST=${JSON.stringify(v)} 应回落成 undefined（等价于监听全部接口），而不是空地址`);
  }
});

test('⑤ 加了 HOST 之后端口口径没被带歪（默认仍是 3099）', () => {
  assert.equal(readHost({ HOST: '127.0.0.1' }).port, 3099, 'PORT 默认值不该被这次改动影响');
});
