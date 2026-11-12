## 运行与验收环境（要点）

- LLM 网关：`http://127.0.0.1:7863/v1`，模型 `cn:deepseek-v4.1-flash`（Key 与其余参数在 `agent-core/.env`，不要在会话里另猜）
- 生图 ComfyUI：`http://127.0.0.1:8199`
- 后端端口取自 `.env` 的 `PORT`（默认 `3099`）；向量服务 `8765`；前端开发态 Vite `5173`
- 验证一律用内存库（`DB_PATH=:memory:`），不许落 `agent-core/data/agent.db`

## UI / UX

涉及 UI 时：

1. 优先复用现有组件和设计模式
2. 新功能必须融入现有设计语言，不得自行引入新的视觉风格
3. 修改完成后检查与现有 Toast、世界观、信箱等页面的一致性
4. UI 切换（如页面、页签、内容区域切换）需要考虑 0.3 秒的过渡动画，避免生硬跳变
5. 窗口（含弹窗）打开时使用 0.3 秒的渐入动画，关闭时使用 0.3 秒的渐出动画；关闭动画完成后再隐藏或卸载窗口

除非任务明确要求，不要随意重做已有设计或引入新的 UI 体系。
Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## 小镇（已剥离）

小镇（世界页）已于 2026-10-20 整个剥离：页面、渲染器、store、路由、调度器与专属服务均删除；本节原有的游戏化 UI 约定作废。仍被聊天/事件/朋友圈引用的 5 个 town 组件按普通组件维护，不再新增小镇玩法。

## 统一组件（Linshe）

按钮、输入框、选择框、开关、分段选择与弹窗一律使用 `web-ui/src/components/ui/` 下的 Linshe 组件，禁止写裸 `<button>` / `<input>` / `<select>` 或遮罩面板皮肤。

以下各小节只写**接入口径**（引入方式、prop 行为、特例白名单、改哪个文件），不重复描述皮肤语言（软糖立体 / 软糖凹陷）、变体语义与色值归属。

## 按钮（LinsheButton）

web-ui 中所有常规按钮必须使用统一组件 `web-ui/src/components/ui/LinsheButton.vue`，禁止写裸 `<button>` 标签或全局 button 样式。

1. 引入：`import LinsheButton from '.../components/ui/LinsheButton.vue'`，模板中写 `<linshe-button>`
2. 按层级选 variant：`primary`（主操作实心，每屏至多一个）/ `secondary`（默认）/ `danger`（危险操作）/ `ghost`（弱操作）/ `icon`（圆形图标钮，如弹窗关闭 ✕）/ `chip`（胶囊选择、页签，配 `:active`）/ `link`（文字链接）；尺寸用 `size="sm|md|lg"`
3. 禁用与加载用 `:disabled` / `loading` prop，不要手写禁用样式
4. 特殊交互元素（长按手势、动态配色、整卡热区、下拉菜单项、已有独立设计的控件）不套组件：用 `<div role="button" tabindex="0">` + 自包含样式，补齐 `cursor/text-align` 等基础属性，禁用态用 `.is-disabled` class + `aria-disabled` + 点击守卫
5. 调整按钮风格只改 `LinsheButton.vue`，不要在各页面里覆盖组件皮肤

## 输入框（LinsheInput）

web-ui 中所有文本输入框 / 文本域统一使用组件 `web-ui/src/components/ui/LinsheInput.vue`，禁止手写 input/textarea 皮肤样式（背景、边框、圆角、focus 光环等）。

1. 引入：`import LinsheInput from '.../components/ui/LinsheInput.vue'`，模板中写 `<linshe-input>`；文本域用 `type="textarea"`（配 `rows`）
2. `v-model` 与原生一致，支持 `.number` / `.trim` 修饰符；`id`、`min/max/step`、`maxlength`、`autocomplete`、`@keyup.enter` 等原生属性和事件直接透传；`ref` 拿到组件实例，已 expose `focus()` / `blur()` / `select()`
3. 尺寸用 `size="sm|md|lg"`（与 LinsheButton 对齐）；校验错误态用 `invalid` prop（红色描边），不要手写 `.xx-error` 样式；禁用用 `:disabled`
4. 组件上遗留的 `class="fi"` 只承担部分页面的表单间距（margin/width）布局，新页面不要依赖它
5. 特殊输入界面不套组件，保持自包含样式：聊天主输入框（`.chat-input`）、信纸 textarea（`.paper-textarea`）、透明嵌入输入（`.vn-input`、`.fav-input`、日程筛选胶囊搜索）、深色玻璃输入（TavernView `.inline-input`）、测试画风折叠输入（`.free-scene-textarea`）、提示词预览盒（`.generated-prompt-box`）
6. 需要自动增高、或收起时单行省略的长文本域用 `LinsheAutoTextarea.vue`（`collapsible` / `min-height`，SettingsView 在用），不要自己写 auto-resize
7. 调整输入框风格只改 `LinsheInput.vue`；`App.vue` 里的全局 `input, textarea` 样式只是少数未组件化控件的兜底

## 选择框（LinsheSelect）

web-ui 中所有下拉选择统一使用组件 `web-ui/src/components/ui/LinsheSelect.vue`（原 `DropdownSelect.vue` 已改名收编），禁止手写 `<select>` 或下拉皮肤样式。

1. 引入：`import LinsheSelect from '.../components/ui/LinsheSelect.vue'`，模板中写 `<linshe-select>`；`v-model` 绑定选中值，`options` 为 `{ label, value }` 数组
2. 触发器与 LinsheInput 同皮肤；尺寸用 `size="sm|md|lg"`（与按钮/输入框对齐）；禁用用 `:disabled`
3. `searchable` 开启搜索过滤；`allow-free-input` 允许自由输入（输入即值，选项仅作联想）；`ref` 拿到组件实例，已 expose `open()`（程序化展开，如获取模型列表后自动弹出）
4. 特殊下拉界面（已有独立设计的胶囊搜索等）不套组件；调整选择框风格只改 `LinsheSelect.vue`，不要在各页面里覆盖组件皮肤

## 开关（LinsheSwitch）

web-ui 中所有拨动开关（toggle switch）统一使用组件 `web-ui/src/components/ui/LinsheSwitch.vue`，禁止手写 `input[type=checkbox]` + slider 的开关皮肤（全局 `.switch`、`.toggle-switch`、`.lora-toggle-switch`、`.lora-enable-toggle`、MemorySettingsView 局部 `.switch` 等旧实现已全部收口删除）。

1. 引入：`import LinsheSwitch from '.../components/ui/LinsheSwitch.vue'`，模板中写 `<linshe-switch>`；`v-model` 绑定布尔值
2. `@change` 在值更新后触发（参数为新布尔值）；`title` / `aria-label` 等属性透传到内部 input；禁用用 `:disabled`；需要「已启用/已禁用」这类状态文字用 `on-text` / `off-text`（传其一即显示，文字在开关左侧，不要在外面再包一层 label）
3. 尺寸用 `size="sm|md|lg"`（默认 md），与 LinsheButton / LinsheInput 尺寸档位对齐
4. 调整开关风格只改 `LinsheSwitch.vue`，不要在各页面里覆盖组件皮肤

## 分段选择（LinsheTabs）

web-ui 中所有分段选择 / 页签统一使用组件 `web-ui/src/components/ui/LinsheTabs.vue`，禁止手写裸 div 或 button 分段控件。

1. 引入：`import LinsheTabs from '.../components/ui/LinsheTabs.vue'`，模板中写 `<linshe-tabs>`；`v-model` 绑定选中值，`options` 为 `{ label, value }` 数组，选项可带 `disabled` / `title`
2. 尺寸用 `size="sm|md"`：`md` 页签式（同级内容切换）、`sm` 小分段（筛选 / 模式切换）；整体禁用用 `:disabled`
3. 调整分段选择风格只改 `LinsheTabs.vue`，不要在各页面里覆盖组件皮肤

## 弹窗（LinsheModal）

web-ui 中所有弹窗统一使用组件 `web-ui/src/components/ui/LinsheModal.vue`（原 `BaseModal.vue` 已改名收编），禁止手写遮罩 / 面板皮肤。

1. 引入：`import LinsheModal from '.../components/ui/LinsheModal.vue'`，模板中写 `<linshe-modal>`；`v-model` 控制显隐（旧代码仍可传 `:visible`），`title` 为标题
2. 尺寸用 `wide`（加宽）/ `full`（大型管理面板）；内容用默认插槽，底部操作区用 `#footer`，头部右侧附加内容（如计数）用 `#header-extra`；需要局部布局差异用 `panel-class` / `body-class`；需要「相对所属页面而不是整个视口居中」时传 `anchor`（宿主选择器，如小镇页传 `anchor=".page-host"`，宿主须为定位元素；留空＝视口居中）
3. 暖色为暖纸外壳 + 白色内衬（标题栏与 `#footer` 留在外壳上、白色内衬只包正文），暗夜保持 Cel Glow 深色玻璃；主题色值一律走 `styles/tokens.css` 的 `--modal-*`；Esc / 点遮罩关闭
4. 调整弹窗风格只改 `LinsheModal.vue` 与 `tokens.css` 的 `--modal-*`，不要在各页面里覆盖组件皮肤


## LLM 输出

编写或修改 LLM 生成相关的 prompt 时：

1. 如果要求模型输出 JSON 格式，必须在 prompt 中举例说明 JSON 输出的完整格式（字段名 + 示例值），不能只口头描述
2. 示例中每个字段的值要写明该字段的内容要求与约束（如字数、语气、格式、禁止项），让模型照着填，参考 `agent-core/src/services/eventGenerator.js` 中 `formatPrompt` 的写法
3. 必须明确要求模型严格按示例格式输出，不要输出任何解释或 JSON 以外的文字
4. 新增或修改输出字段时，同步更新 prompt 中的 JSON 示例与解析代码，保持两者一致
5. **输出被截断或审核中断时不要自己写兜底**：`llm-client.chatSync` 收口已经有「自动继续 + 拼接」循环（判据 `classifyIncomplete`、文本用 `mergeContinuationText`、JSON 用 `concatJsonContinuation`，最多 5 次、短任务 2 次、每次放大 1.6 倍额度）。业务层再包一层「格式不对请重新生成」只会让同一次失败被重试两轮。
6. 需要「一定拿到合法 JSON」的调用，用 `response_format: { type: 'json_object' }` + 解析后做字段校验（如 `normalizeMediaOutletDraft`），不要靠提示词保证格式。
7. **判「输出是否完整」必须容忍 ``` 围栏，但不容忍截断**：模型经常整段套 ` ```json … ``` `，裸 `JSON.parse` 会把它判成没写完，于是每轮生成都白烧 5 次续写（2026-11-08 真机：一个 327 tokens 的完整答案被重试 5 次）。判完整性一律走 `llm-client` 的 `isCompleteJsonText`（内部先剥围栏再严格 parse），**不要**用会补齐结构的 `repairJsonText` 去判——它会把半截 JSON 修成合法，截断续写就再也不会触发。
8. **流式也有截断续写，别再各自兜**：`chatStream`（文本流）与 `chatAgentStream`（主聊天/神说的原生工具流）遇到 `finish_reason=length` 会自己追加「继续」把下半段接上，最多 2 次（`MAX_STREAM_CONTINUATIONS`，指令是 `STREAM_CONTINUE_INSTRUCTION`）。流式撤不回已推给用户的内容，所以口径是**只追加不重发**；`readAgentResponse` 的 `length` 也不再抛错（除非调用方没传 `softLength`）。调这两条链时不要另写一套截断续写。

## 角色作用域（characters.is_system）

内置角色（目前只有默认助手 `name='default'`）是 `characters` 表里的一行，所以任何「遍历所有角色」的链路都会顺手把它带上——批量覆盖设置、日程、朋友圈、事件、主动性、立绘台词……以前靠各调用点自己写 `name != 'default'`，加一条新链路就会漏一次（2026-11-08 用户因此要求根治）。

口径：

1. `characters.is_system = 1` = 系统内置角色，不属于用户的角色集合。迁移与标记在 `db/index.js` 的 `migrateCharacterScope`（在 `seedAll` 之后跑，幂等）。
2. **面向用户的角色集合一律带作用域**：`import { USER_SCOPE, USER_SCOPE_ALIASED } from '../services/characterScope.js'`，拼进 WHERE。别再用 `name != 'default'` 这种按名字的特判。
3. **按 id 取单个角色**（`WHERE id = ?`）不过滤：用户点到它时仍可查看/编辑/聊天。批量任务显式点名（`character_ids`）同样放行。
4. 默认助手开关（`system_settings.default_assistant_enabled`，设置页「功能开关」）只决定它**是否出现在角色列表**（`userVisibleScope`）；后台自动化永远跳过系统角色，不受开关影响。
5. 已全量覆盖（2026-11-08 收尾）：除下列**写法例外**，其余 `FROM characters` 的集合查询都带作用域。例外都是无害的：按 id 取单体（`WHERE id = ?`）、按名取单体（`WHERE name = ?`）、`NOT IN (SELECT id FROM characters)` 这种只用 id 集合的清理、以及同居房间成员 id→名字的映射表。新增查询请照口径带作用域。

## 后台生成的角色状态校验（2026-11-08 用户定）

凡是**后台自动产生内容、用户能在界面上看到**的入口（朋友圈、群聊、奇遇、媒体、报纸、信箱、日记、共同生活…），必须在落库前用**代码**校验参与角色此刻的状态；prompt 里写的「睡着的人不要说话」只负责自然，不负责正确。

1. 睡眠判定一律用 `scheduleManager.isSleeping()`（全仓唯一判定点），不要自己拿时间算睡眠；角色开关看 `characters` 行的 `moments_disabled` / `proactive_disabled` / `events_disabled` / `schedule_enabled`。
2. 调度层先拦：全员睡眠/全部关闭时不该发起这一轮（参考 `groupIdleScheduler.countAwakeMembers`，0 人醒着就跳过并把下次时间推迟，**不扣当日额度**）。
3. 解析层再拦一次：多角色同场的入口（群聊）要按说话人过滤，睡着的人不许自己开口，只有「被点名」或「本轮有人喊她+带唤醒动作」才放行（`groupChatEngine.canAsleepSpeakerTalk`，与 `applyGroupWake` 同口径）。
4. 异步交互要排队而不是丢弃：她睡着时被私聊/被评论，进延迟队列，醒后 5~15 分钟补上（`reply_queue` 与 `moment_comment_queue` 各一套）。
5. 新增入口照抄现有实现，不要重新发明：`momentScheduler`（候选筛选 SQL）、`proactiveChatScheduler`（`is_sleeping = 0`）、`momentInteractionService`（逐个好友判定）、`mediaService.pickActiveCharacters`（排除睡眠与关朋友圈）。

## 临时测试脚本

调试过程中产生的临时验证脚本（`test.js`、`debug-*.js`、根目录散落的 scratch 脚本等）默认用完即删，不要留在仓库里污染 `git status` 和搜索结果。

1. 临时脚本只用于当场验证，跑完、结论确认后就删除；随手生成的调试日志（如 `*.log`）一并清理
2. 临时脚本用完即删。项目以真机验收为主（解压交付包真启动 + 真机点一遍）。2026-11-12 合并上游 v4.3.0 时按「能独立跑通才留」筛选，只保留两类回归测试：`agent-core/test/photoStudio*.test.js`（照相馆）与 `memoryThinking.test.js`，入口 `npm --prefix agent-core test`；其余 `*.test.js` 不再新增，跑不通的直接删
3. 判断口径：没有「正式测试」这一层。要留的验证逻辑写成文档里的复现步骤，或留成可按需手动跑的独立脚本放 `scripts/`，不要伪装成测试收集链

## 交付前的验收（2026-11-06 用户定，必做）

只跑语法检查和"服务能起来"不算验收。历史上因此把一个**所有生图都抛 `opts is not defined`** 的包发了出去，也把"动作面板被 flex 压成一条线"这种 DOM 完全正常的界面问题留到了用户手里。交付前固定做三步：

1. **生图冒烟**（十几秒）：
   `cd agent-core && DB_PATH=":memory:" ../runtime/nodejs/node.exe ../scripts/smoke-image.mjs`
   退出码 0=出图成功、2=ComfyUI 未开（环境问题）、1=代码链路有错。
2. **浏览器截图巡检**：起临时库后端，用 `playwright-cli`（`--browser=chrome`，会话放后台 shell 保活）打开页面，
   **桌面宽度与移动端 390×844 各截一遍**关键页面（聊天、群聊、朋友圈、设置），再看两套主题。
   理由：flex 压缩、overflow 裁切、z-index 遮挡、对比度这几类问题，DOM 快照和自动化断言全都会通过，只有眼睛能看出来。
3. **解压真启动**：交付包解压到干净目录，起 vector-service 与 agent-core，抽查 `/api/health`、`/api/characters`，
   再看一眼包内是否带上了 `.env`（不该带）与 `launcher_config.json`（不该带）。

三步都过再说交付；哪一步没做，汇报时必须写明没做。


## 角色身份锚点（2026-11-08 用户定）

角色「是谁」有独立存储位，**不再寄生在服装表里**。起因：`character_outfits` 的 work（默认）那套同时被当作角色外观真源，任何一次「自动生成本套」都会把发色发型瞳色与 `Name (Series)` 识别 tag 换成一句衣服描述，冷门 / LoRA 角色随即画成路人，且污染会沿 base_prompt 扩散到聊天、亲密、立绘、朋友圈全部生图。

1. **存储**：`characters.identity_anchor`（身份 tag + 身体特征，英文 tag 串）与 `identity_anchor_source`（`auto` 自动维护 / `manual` 用户手改过）。启动时按 `PRAGMA` + `ALTER TABLE` 惰性迁移，**不新增表**。
2. **提取**：`services/identityAnchor.js` 是唯一入口。正则优先（`Name (Series) has ...` 与 danbooru tag 串两种形态），提不到时 LLM 抽一次；提取时剥掉身份 tag 前缀、过滤配饰/表情/构图/负面权重写法。**不要在各处另写正则截取**。
3. **写入时机**：新建角色（异步，允许 LLM）、保存角色且 `base_prompt` 变化（只跑正则）、`POST /:id/identity-anchor/extract`（强制，可选 overwrite）、启动补齐（只处理空锚点行，不调 LLM，幂等）。`manual` 永不被自动覆盖。
4. **注入**：唯一收口在 `imageSkill._execute`，调用方传 `opts.identity`（角色行，至少要 id）。传入后 `applyIdentityAnchorToPrompt` 把锚点前置；prompt 已有同名身份 tag 时不重复；梦境前缀插在冒号后。**新增生图入口必须传 identity，否则那个场景的角色会飘**（当前已接：聊天配图、触摸亲密、立绘、头像、梦话、朋友圈、礼物反应、日程拍照、日记、主动聊天、报纸、媒体、信箱）。
5. **身体唯一真源**：`listSceneOutfits` 在读取层把 `body` 与 `text` 统一成「本体身体」（`getIdentityBody`），`character_outfits.body` 只在锚点缺失时回退。不要再从外观段反推身体（会把旧衣服带进 body）。
6. **禁止**：work（默认那套）不可被任何生成覆盖（前后端双重拒绝）；场景服装注入 `bodyLocked`，只换衣服不换发型发色瞳色体型；换装道具 / 角色专属形态仍可整体替换。
7. **前端**：角色详情卡三分区「人设提示词 / 角色本体 / 外观服装」，本区块可编辑、可一键重提取、显示 auto/manual 来源。手改随角色保存提交并标记 manual。

## 角色生图人格组装（characterPersona）

所有「配合生图」的角色人格拼接——整卡 `base_prompt`，或 `short_prompt + ## 你的外观` 段——必须统一走 `agent-core/src/services/characterPersona.js`，禁止在各模块内写 `match(/##\s*你的外观/)` 之类的正则自行截取（历史上 16+ 处内联实现口径不一，已全部收口）。

**什么时候用哪种：**

1. `buildCharacterPersona(character, opts)` 是主入口：
   - `variant: 'short'`（默认）＝ `short_prompt + 外观段`，用于多角色参考（事件/朋友圈 otherPersona）、群聊成员资料卡、梦境 system3、maibot 桥生图描述器等紧凑场景
   - `variant: 'full'` ＝ 整卡 `base_prompt`（缺失回退 `short_prompt`），用于角色以完整人格出场的生图：私聊 needImage 配图、主动聊天、日程拍照、事件一/二期、礼物反应、信件、AI 头像、发帖 LLM
   - `person`：把「你」替换为指定名（`display_name`、`'角色'` 等），`null` 保持第一人称；short 只替换外观段（short_prompt 本就是第三人称），full 替换整卡
   - `outfits`：默认 `'auto'` 自动注入生效外观并附优先级说明；传 `null` 显式关闭；单测可显式传 `{limited, exclusive}`
2. 只要外观段（不含人格，如表情包 system3、主动聊天配图的外观块）用 `buildCharacterAppearanceSection(character, opts)`（含 `## 你的外观` 标题行与注入，标题自行取舍）；画面交叉参考（图中出现其他角色）用 `buildImageCrossRefInfo(char, opts)`，不要再引用已删除的 `extractImageCrossRefInfo`
3. **传入对象的 `id` 必须是角色 id**（自动注入按它查外观）。JOIN/别名行要先重映射：如 mailboxScheduler 传 `{ id: letter.char_id, base_prompt: letter.base_prompt, short_prompt: ... }`

**什么时候不用：** 非生图用途不套本入口，保持原逻辑——聊天人格稳定块（chat.js 身份块）、记忆整理、关系图谱、日程模板与字体分配（取外观段之前/之后文本）、`cropPersonalityForEmotion` 等 short_prompt 维护逻辑。`appendOathRing` 仍由各调用方在组装结果之后追加，职责不并入本入口。

**角色外观系统：**

1. 数据源两张表：`character_outfits`（角色专属形态/装甲/衣服，每角色同时只启用一套，启用互斥由 `outfitService` 保证；详情卡 UI 入口暂注释隐藏在 `CharacterDetailModal.vue`，搜「暂时隐藏」）、`global_outfits`（通用限时服饰如女仆装 tag 组合，可多套叠加；管理方式未定，`condition_json` 预留注入条件，当前 `enabled` 即生效）
2. 查询生效外观只走 `outfitService.getActiveOutfits(characterId)`；注入文本格式与着装优先级说明（两者都有 / 只有限时 / 只有专属三种）只改 `buildOutfitInjectionBlocks`，不要在调用点拼
3. 修改拼接口径（正则、连接符、注入格式）只改 `characterPersona.js`；改完在真机上换一次衣服确认五套身体没漂

## 分支结构与上游同步

上游仓库 `icecranberry/galgame-with-comfyUI`（remote 名 `origin`）会持续发版，本地 fork 在 `Sting255/galgame-with-comfyUI-Re`（remote 名 `mine`）。

本仓历史曾在 2026-11-06 重建为三层，**从此与上游有共同祖先，可以直接 merge**（在此之前只能 `git diff 旧tag..新tag` 打补丁，14 文件 24 处冲突全靠手工挑边）：

| 分支 | 角色 | 规则 |
|---|---|---|
| `upstream` | 上游纯净镜像，永远等于某个 `vX.Y.Z` 标签 | 只读：只做 `reset --hard <tag>`，永不 commit |
| `local` | 本地全部改动，父提交链挂在上游标签之上 | 日常开发都在这里 |
| `archive/pre-421` | 改成三层结构之前的完整历史 | 只读存档，查历史用 |

### 跟上游更新（日常流程）

```bash
node scripts/上游-同步.mjs            # fetch + upstream 对齐最新标签 + 合进 local
node scripts/上游-同步.mjs --dry-run  # 只看会做什么
node scripts/上游-同步.mjs --tag v4.2.2
```

脚本会在冲突时停下并列出冲突文件。手工解决后 `git add` + `git commit` 收尾。

手动等价命令：

```bash
git fetch origin --tags
git checkout upstream && git reset --hard v4.2.2
git checkout local && git merge upstream
```

### 冲突解决口径

1. **本地特性优先保留**：世界观优先前缀、世界钟（`toProgramTime`）、角色级负面提示词、服装手动指定、运行状态面板、离线编年等，都是本仓刻意加的，不能因为上游没写就丢
2. **上游新增能力必须吸收**：新参数、新模块、新提示词规则要接进来（例如 `forceThinkingMode`、`ensureImagePromptIdentity`、`hasActiveWorldLanguageStyle`）
3. **两边都改同一段时**：先看 `git diff v4.2.0..v4.2.1 -- <文件>` 弄清上游到底改了什么，再决定合，不要直接选一边
4. **冲突解决完必须验证**：frontend `npx vite build`、后端临时库启动 `/api/health` 返回 200。历史上出现过补丁"报 cleanly 应用"但导出缺失、启动即崩的情况

### 首次初始化（分支丢了或换机器）

```bash
git fetch origin --tags
git branch upstream v4.2.1                      # 换成当时的标签
PARENT=$(git rev-parse v4.2.1^{commit})
TREE=$(git rev-parse HEAD^{tree})
git branch local $(git commit-tree "$TREE" -p "$PARENT" -m "本地改动基线")
git checkout local
```

关键点：`local` 的父提交必须指向上游标签的 **commit**（用 `^{commit}`，标签是 annotated tag 时直接引用会报 not a valid commit）。

### 推到自己的 fork

```bash
git push mine local:main --force-with-lease
```

历史被重建过，第一次推新结构必须 force；用 `--force-with-lease` 而不是 `--force`，避免覆盖掉别处新推的提交。

## git commit 提交

commit提交必须按照大功能划分，大功能里如果还有小功能点，划分到一起写进注释里的要点，不要把其他功能的改动混在同一个commit中，每个commit中文注释作用或功能

## 最终结论输出格式要求

运用第一性原理思考，拒绝经验主义和路径盲从，不要假设我完全清楚目标，保持审慎，从原始需求和问题出发，若目标模糊请停下和我讨论，若目标清晰但路径非最优，请直接建议更短、更低成本的办法。
所有最终结论必须分为两个部分：
• ​直接执行：按照我当前的要求和逻辑，直接给出任务结果。
• ​深度交互：基于底层逻辑对我的原始需求进行“审慎挑战”。包括但不限于：质疑我的动机是否偏离目标（XY问题）、分析当前路径的弊端、并给出更优雅的替代方案。