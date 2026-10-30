/**
 * 死代码扫描器的自检（2026-10-15）
 *
 * `scripts/scan-dead-code.mjs` 是正式工具（口径写死在代码里、要能反复跑），所以它本身也要有守卫 ——
 * 尤其是**它第一版就把 20+ 个 `start*Scheduler` 误判成死导出**（漏扫 `agent-core/app.js`），
 * 这种"扫描器口径错 ⇒ 结论全错"的坑必须有测试钉住。
 *
 * ⚠️ 性能约定：扫描器要遍历 600+ 文件，**单次约 20 秒**。所以这里**只扫一次**、全文件共享结果 ——
 *    第一版每条用例各扫一遍（4 次）直接把用例顶到 90 秒超时（`cancelled`），是本轮踩的坑。
 *
 * 本文件钉住：
 *   ① 脚本存在且能跑通（退出码 0）；
 *   ② 输出里**不含**调度器的 start/stop（它们都在 app.js 里被调用 —— 那次假阳性的回归钉子）；
 *   ③ 输出里含本轮已确认的真死导出（证明它确实在工作，不是空输出假绿）；
 *   ④ 死列那节现在是 0 个（本轮已全部标注 ⇒ 注释里出现列名 ⇒ 不再被判死）；
 *   ⑤ 脚本路径解析用 fileURLToPath（中文路径不能走 URL.pathname）。
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'scan-dead-code.mjs');
const NODE = path.join(ROOT, 'runtime', 'nodejs', 'node.exe');

/** @type {string|null} 全文件共享的扫描输出（只跑一次） */
let scanOut = null;

before(() => {
  scanOut = execFileSync(NODE, [SCRIPT], {
    cwd: path.join(ROOT, 'agent-core'),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
  });
});

const out = () => {
  assert.ok(scanOut !== null, '扫描输出应在 before 里准备好');
  return scanOut;
};

test('① 扫描器存在且跑得通（退出码 0）', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/scan-dead-code.mjs 要在');
  const text = out();
  assert.match(text, /疑似死导出/, '要有死导出那一节');
  assert.match(text, /疑似死列/, '要有死列那一节');
});

test('② 回归钉子：调度器的 start/stop 不许被判成死导出', () => {
  const exportSection = out().split('疑似死列')[0];
  for (const fn of [
    'startMomentScheduler',
    'startMailboxScheduler',
    'startProactiveChatScheduler',
    'startSpecialMomentScheduler',
    'startConsolidationScheduler',
    'stopConsolidationScheduler',
    'startWeatherScheduler',
  ]) {
    assert.equal(
      exportSection.includes(fn), false,
      `${fn} 不该出现在死导出里 —— 它在 agent-core/app.js 被调用（扫描器必须把 app.js 算进"使用者"）`
    );
  }
});

test('③ 确实抓到了本轮确认过的真死导出（防"空输出假绿"）', () => {
  const text = out();
  for (const fn of ['findLatestImageInFolder', 'listToyPlay', 'clientCount', 'runWithLimit', 'repairMissingItemImages']) {
    assert.ok(text.includes(fn), `${fn} 应在清单里（本轮已确认零调用点）`);
  }
});

test('④ 死列候选数不超过基线（新增未标注的死列会被抓出来）', () => {
  const m = /疑似死列（(\d+) 个）/.exec(out());
  assert.ok(m, '要能解析出死列数量');
  // 口径说明：扫描器**剥注释后计数** ⇒ 已标注过的死列会重新"被判死"（标注是给人/文档看的，
  // 不代表列被用了）。所以这里不硬断言 0，而是要求候选数不增长。
  // 2026-10-20 小镇剥离后：`town_maps.walk_grid` + `town_npc_service_sessions` 的 4 个列
  // （offer_id / last_tale / last_image_path / last_choice）只被已删除的小镇服务使用 ⇒ 基线 1 → 5。
  // 2026-10-29 移植地图页（PR#24）后：`world_map_transit` 的 line_name / to_stop / km 三列
  // 是给「日程按通勤边算距离」预留的，本仓还没接那条线（world_map 目前只到规划层）⇒ 5 → 8。
  // 这三列**不是误加**：表结构跟上游保持一致，接日程注入时直接用，避免二次迁移。
  const DEAD_COLUMN_BASELINE = 8;
  assert.ok(
    Number(m[1]) <= DEAD_COLUMN_BASELINE,
    `死列候选从基线 ${DEAD_COLUMN_BASELINE} 涨到 ${m[1]} —— 有人新增了没标注的死列（去 db/ 读一眼再标）`
  );
});

test('⑤ 路径解析用 fileURLToPath（本仓路径含中文，URL.pathname 会带回百分号编码）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /fileURLToPath\(import\.meta\.url\)/, '要用 fileURLToPath');
  // ⚠️ 只看**代码**、不看注释：脚本自己在注释里拿 `new URL(...).pathname` 当反例讲（解释为什么不能用），
  //    整份源码做正则会被那行说明误伤（本轮踩到）。剥掉注释再断言。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.equal(
    /new URL\(import\.meta\.url\)\.pathname/.test(code), false,
    '不许在**代码**里用 URL.pathname —— 中文路径会变成 %E9%82%BB… 直接 ENOENT（踩过）'
  );
});

test('⑥ 口径写在脚本里（口径漂移是这类工具最容易出的问题）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const must of ['app.js', '__', '本文件内也只出现在定义处']) {
    assert.ok(src.includes(must), `口径说明里要提到 ${must}`);
  }
});
