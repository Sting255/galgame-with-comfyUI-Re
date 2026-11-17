/**
 * 备份秘密分类与脱敏（P0-04）
 *
 * 背景：导出面板原来只有一个「包含模型配置（含 API Key）」开关，它只决定要不要附带 `.env`。
 * 但 SQLite 主库本身就是秘密载体——`llm_profiles`、`novelai_profiles`、`memory_settings`、
 * `tts_api_key`、`maibot_webui_token`、`llm_vertex_service_account` 全在 system_settings 里。
 * 于是「不勾选 = 不含密钥」是一句假话：用户把所谓「无配置备份」发出去，对方照样能读出 Key。
 *
 * 现行口径（三类，与 02-目标架构 §8 一致）：
 *   data           业务数据（角色、聊天、图片、音频）——默认包含
 *   runtime-config 非秘密运行配置（端口、模型名、provider URL、尺寸）——默认包含
 *   secrets        一切凭据——必须显式选择；未选择时**在快照副本上清空秘密值**
 *
 * 脱敏不是「删字段」：删掉 apiKey 键会让 llm_profiles 解析后缺字段，
 * 导入端再校验就会失败。这里保留结构、只把值置空，并额外写一个布尔标记，
 * 让导入端能明确告诉用户「这份归档不含密钥，需要重新填写」。
 *
 * 只操作快照文件，绝不触碰运行中的库。
 */
import Database from 'better-sqlite3';

/** 直接存放单个秘密的 system_settings 键 */
const SECRET_SETTING_KEYS = Object.freeze([
  'novelai_api_key',
  'tts_api_key',
  'maibot_webui_token',
  'llm_vertex_service_account',
]);

/** JSON 结构里带秘密的 system_settings 键，值按字段名递归清空 */
const SECRET_JSON_SETTING_KEYS = Object.freeze([
  'llm_profiles',
  'novelai_profiles',
  'memory_settings',
]);

/** 这些字段名一旦出现就视为秘密（不区分大小写，比较时去掉下划线与连字符） */
const SECRET_FIELD_NAMES = new Set([
  'apikey',
  'key',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'clientsecret',
  'password',
  'authorization',
  'vertexserviceaccount',
]);

/** 秘密类别：manifest 只写类别名，不写值，也不写具体是哪个键 */
export const SECRET_CLASSES = Object.freeze({
  env: 'config/.env 中的密钥（LLM / NovelAI 等）',
  settings: '数据库内保存的 provider 凭据（LLM / NovelAI / TTS / MaiBot / Vertex）',
});

function normalizedFieldName(name) {
  return String(name || '').toLowerCase().replace(/[_\-\s]/g, '');
}

function isSecretField(name) {
  return SECRET_FIELD_NAMES.has(normalizedFieldName(name));
}

/** 递归清空对象里的秘密字段；返回是否有改动。保留键与类型，避免下游解析缺字段。 */
function scrubValue(value, changed) {
  if (Array.isArray(value)) {
    for (const item of value) scrubValue(item, changed);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (isSecretField(key)) {
      if (value[key]) { value[key] = ''; changed.hit = true; }
      continue;
    }
    scrubValue(value[key], changed);
  }
}

/**
 * 扫描快照库里的秘密并（可选）清空。
 *
 * **失败必须阻断导出（fail-closed）**：脱敏是「不带秘密」这个承诺的唯一执行点，
 * 扫描出错时若按「没检出」继续打包，就会把 Key 原样装进一个自称脱敏的归档。
 * 因此这里只在**结构上确实没有 system_settings**（例如极旧的库）时返回空结果，
 * 其余异常一律抛出，由 createBackup 中止导出。
 *
 * @param {string} dbFile 快照数据库绝对路径（VACUUM INTO 产物，可以随便改）
 * @param {{scrub?:boolean}} options scrub=true 时清空秘密值
 * @returns {{classes:string[], keys:string[]}} 命中的秘密类别与键名（键名只给日志与 UI，不含值）
 */
export function inspectSnapshotSecrets(dbFile, { scrub = false } = {}) {
  const classes = new Set();
  const keys = [];
  let db;
  try {
    db = new Database(dbFile);
  } catch (error) {
    throw new Error(`无法打开备份快照以检查凭据：${error.message}`);
  }
  try {
    const hasTable = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_settings'`,
    ).get();
    // 没有 system_settings 的库不可能在表里存秘密（.env 走另一条路径），可以安全放行
    if (!hasTable) return { classes: [], keys: [] };

    const read = db.prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?');
    const write = db.prepare('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?');
    const tx = db.transaction(() => {
      for (const key of SECRET_SETTING_KEYS) {
        const row = read.get(key);
        if (!row || !String(row.setting_value || '').trim()) continue;
        keys.push(key);
        classes.add('settings');
        if (scrub) write.run('', key);
      }

      for (const key of SECRET_JSON_SETTING_KEYS) {
        const row = read.get(key);
        if (!row || !String(row.setting_value || '').trim()) continue;
        let parsed;
        // 解析失败不能跳过：这段 JSON 里可能正躺着 Key，跳过等于让它原样进入归档
        try { parsed = JSON.parse(row.setting_value); } catch (error) {
          throw new Error(`${key} 不是合法 JSON，无法确认其中凭据已清空：${error.message}`);
        }
        const changed = { hit: false };
        scrubValue(parsed, changed);
        if (!changed.hit) continue;
        keys.push(key);
        classes.add('settings');
        if (scrub) write.run(JSON.stringify(parsed), key);
      }
    });
    tx();
  } catch (error) {
    // fail-closed：无法确认已清空，就不能声称「未包含凭据」而继续导出
    throw new Error(`检查或清空备份凭据失败，已中止导出：${error.message}`);
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  return { classes: [...classes], keys };
}

/** `.env` 是否存在本身就算一类秘密（里面必然有 Key） */
export function envSecretClasses() {
  return ['env'];
}
