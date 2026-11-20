/**
 * 自由表情词 → 她的表情名（立绘切帧用）——**纯函数，零依赖**。
 *
 * ── 为什么需要（2026-10-21 真机反馈）──────────────────────────────────
 * 用户：「动作倒是有了，表情很僵硬，都只有一个微笑，面部也没有别的反应。」
 * 真机日志（`backend-2026-10-20.log`）里 `facial_expression` 的实际取值是
 * **27 种自由组合词**：失神咬唇 / 潮红失神 / 皱眉咬唇 / 仰头失神 / 眼尾泛红 / 羞怯窃喜 …
 * 而消费端只做了「精确 → label 含 key → key 含 label」三次子串匹配，候选是她的
 * 15 个表情名（开心 / 难过 / 哭 / 生气 / 哈哈大笑 / 卖萌 / 晕倒 / 害羞 / 惊讶 / 委屈 /
 * 得意 / 比心 / 无语 / 嫌弃 / 心虚）。
 * **实测命中率 0/27** —— 一个都对不上，`driveStandingExpression` 每次都返回 null，
 * 立绘永远停在 `normal` 槽位（就是那张微笑），于是"面部没有别的反应"。
 *
 * ── 口径（两层，先硬后软）────────────────────────────────────────────
 *   ① **精确 / 包含**：模型照抄了表情名就能对上（配合 prompt 侧"必须原样照抄"的约束，
 *      这是主路径，命中即最准）；
 *   ② **语义别名**：模型写了自由组合词时，按下面的别名表落到**最近的**表情名。
 *      优先级从具体到宽泛（害羞 / 哭 / 生气 … 排在 开心 / 难过 前面），
 *      否则「失神带笑」「咬唇忍笑」会被裸的 `笑` 抢走。
 * 全都匹配不到 → 返回 null（**不猜**，调用方跳过切帧，与既有行为一致）。
 *
 * ⚠️ 改别名表要连带回归 `test/emojiExpressionMatch.test.js`：里面用**真机日志的 27 个取值**
 * 钉了每一条的落点，防止后人顺手把「失神」映射成别的。
 */

/**
 * 别名表：`[表情名, 触发词...]`。数组顺序 = 优先级（**先具体后宽泛**）。
 *
 * 说明（都从真机日志的取值推出来的，不是拍脑袋）：
 *   · 失神 / 张口 / 怔 / 喘息 → 惊讶（15 个表情里唯一"睁眼张嘴发懵"的形态；
 *     不能给 晕倒，那是圈圈眼漫画效果）
 *   · 脸红 / 潮红 / 泛红 / 咬唇 / 羞 → 害羞（占比最大的一类）
 *   · 泛泪 / 湿眼 / 眼尾泛红 → 哭（但「泛红」不算：那是潮红的近义，归害羞）
 *   · 皱眉 / 抿唇 / 怒 → 生气
 *   · 笑 / 喜 / 兴奋 → 开心（**放最后**，否则会抢走上面所有带"笑"字的组合词）
 */
export const FACIAL_EMOJI_ALIASES = Object.freeze([
  ['害羞', ['害羞', '害臊', '羞怯', '羞', '脸红', '潮红', '泛红', '发烫', '耳根', '咬唇', '抿唇含羞']],
  ['哭', ['哭', '泛泪', '湿眼', '泪光', '泪', '泣']],
  ['生气', ['生气', '皱眉', '蹙眉', '恼怒', '不悦', '发火', '怒']],
  ['委屈', ['委屈', '嘟嘴', '撇嘴', '不满', '可怜巴巴']],
  ['嫌弃', ['嫌弃', '厌恶', '嫌', '不耐烦', '恶心', '反感']],
  ['心虚', ['心虚', '躲闪', '不敢看', '移开视线', '闪躲']],
  ['无语', ['无语', '无奈', '扶额', '说不出话']],
  ['得意', ['得意', '坏笑', '挑衅', '挑眉', '狡黠']],
  ['惊讶', ['惊讶', '吃惊', '震惊', '失神', '怔', '愣', '呆住', '张口', '张嘴', '睁大', '喘息', '倒抽气', '猛地']],
  ['晕倒', ['晕倒', '晕过去', '昏过去', '眼前一黑']],
  ['比心', ['比心', '爱心', '献心']],
  ['卖萌', ['卖萌', '撒娇', '卖乖', '蹭蹭']],
  ['哈哈大笑', ['哈哈大笑', '大笑', '笑出声', '笑场']],
  ['开心', ['开心', '高兴', '快乐', '愉快', '兴奋', '满足', '喜', '笑']],
  ['难过', ['难过', '低落', '失落', '伤心', '沮丧', '郁郁']],
]);

/**
 * 把一个自由表情词落到她的某个表情名上。
 *
 * @param {Iterable<string>} keys  她的表情名（`emoji_categories.emoji_key` / `getCharacterEmojiMap().keys()`）
 * @param {string} facialExpression  模型给的自由表情词（如「失神咬唇」）
 * @returns {string|null}  命中的表情名；匹配不到返回 null（调用方跳过切帧，不猜）
 */
export function matchEmojiKey(keys, facialExpression) {
  const label = String(facialExpression || '').trim();
  if (!label) return null;
  const list = [...(keys || [])].map(k => String(k || '').trim()).filter(Boolean);
  if (list.length === 0) return null;

  // ① 精确 / 包含（模型照抄了表情名）——最长优先，避免「笑」抢走「哈哈大笑」
  if (list.includes(label)) return label;
  const contained = list
    .filter(k => label.includes(k))
    .sort((a, b) => b.length - a.length);
  if (contained.length > 0) return contained[0];
  const reverse = list
    .filter(k => k.includes(label))
    .sort((a, b) => a.length - b.length);
  if (reverse.length > 0) return reverse[0];

  // ② 语义别名（按优先级取第一个命中的类目；该类目必须是她真的拥有的表情名）
  for (const [key, aliases] of FACIAL_EMOJI_ALIASES) {
    if (!list.includes(key)) continue;
    if (aliases.some(alias => label.includes(alias))) return key;
  }
  return null;
}

/**
 * 取值要求的**正文**（不含字段名 / 列表符号），给各条链自己拼前缀用。
 * 清单为空返回空串（调用方据此保留旧文案）。
 */
export function facialExpressionChoiceText(keys) {
  const list = [...(keys || [])].map(k => String(k || '').trim()).filter(Boolean);
  if (list.length === 0) return '';
  return '**必须原样照抄**下面其中一个表情名（用于立绘切帧，不许自创组合词、不许加修饰）：'
    + list.join(' / ')
    + '。画面里的具体表情细节写在 `image_prompt` 里。';
}

/**
 * `facial_expression` 字段要求那一行的**唯一生成口径**（prompt 侧用；带反引号字段名 + 列表符号）。
 *
 * 传了她的表情名清单 → 收紧成"必须原样照抄其中一个"（这样立绘切帧一定命中）；
 * 清单为空 → 返回空串，调用方据此保留旧文案（**逐字不变**，兼容既有调用方与测试）。
 *
 * 为什么要在 prompt 侧也动：只靠消费端猜（`matchEmojiKey` 的别名表）能救回大部分真机取值，
 * 但"失神 / 潮红"这些词落到哪个表情名终究是二次猜测；让模型直接挑一个表情名才是准的，
 * 细节表情（咬唇、失神、眼角泛红）本来就该写在 `image_prompt` 里由画面承担。
 */
export function formatFacialExpressionRule(keys) {
  const body = facialExpressionChoiceText(keys);
  return body ? `- \`facial_expression\`：${body}` : '';
}
