# NovelAI 接入与排错

在设置页「图片生成服务 → NovelAI」选择连接方式：

| 连接方式 | 生成接口 | 检测方式 |
| --- | --- | --- |
| NovelAI 官方 | `https://image.novelai.net/ai/generate-image` | `/user/subscription` 订阅鉴权 |
| NovelAI 原生协议中转 | 自定义地址下的 `/ai/generate-image` | `/user/subscription`，中转可能未开放 |
| OpenAI 兼容中转 | 自定义地址下的 `/v1/images/generations` | `/v1/models`，中转可能未开放 |

旧配置保留原行为：`official` 对应官方域名，`relay` 对应 OpenAI 兼容中转；`native` 是新增原生中转模式。协议和地址应按中转站文档选择，不通过多次试生图猜测协议。

地址支持域名、带服务前缀的路径、`/v1`（兼容模式）、`/ai`（原生模式）或完整生图地址。不会重复拼接 `/v1`；自定义前缀保留。地址不能包含凭据、查询参数或片段。接口若重定向，会提示填写最终地址，不自动转发凭据。

官方填写账户设置中的 Persistent API Token；中转填写该中转站签发的 Key。粘贴的 `Bearer ` 前缀会自动去除，请求统一发送一次 Bearer。原生生成支持 ZIP、JSON Base64 和直接图片；兼容生成支持 `data[].b64_json` 和 `data[].url`。下载图片 URL 时不附带服务 Key。

官方与原生模式显示内置绘图模型，也允许手动输入。检测成功只说明订阅接口鉴权成功，不保证每个模型可用。中转的模型/订阅检测返回 401、403、404、405 或 501 时显示「尚未验证」，保留 HTTP 状态、目标端点和提示，不断言生图 Key 无效。可按服务商文档手动填写模型，用图片实验室验证实际生成（会消耗相应服务额度）。

## 后端网络代理

点击默认折叠的「网络代理」后填写代理地址，例如 `http://127.0.0.1:7890`，支持 HTTP/HTTPS 代理。此地址是从**运行后端的机器**连接：远程服务器或容器中的 `127.0.0.1` 不代表浏览器所在电脑。收起入口不会清空或停用已填写的代理。

留空时显式读取后端进程环境中的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（含小写形式）；未设置则直连。显式填写的代理优先。代理仅用于 NovelAI 生成、检测及返回图片下载，不修改其他服务的全局网络配置。

也可使用 `NOVELAI_API_FORMAT=official|native|relay`、`NOVELAI_URL`、`NOVELAI_API_KEY`、`NOVELAI_PROXY_URL` 设置初始值；已保存的数据库配置优先。

连接检测总超时为 30 秒，生成及图片读取总超时为 180 秒。DNS、TLS、连接拒绝与超时分别提示；不自动重试生成，避免重复计费。浏览器可访问官网并不意味着后端已经使用同一代理。

## 实现参考与验证

- 本地 SillyTavern 的 `src/endpoints/novelai.js`：原生参数、Bearer 认证、ZIP 图片处理。
- 本地 SillyTavern 的 `src/request-proxy.js`：显式配置出站代理的思路。邻舍使用原生 fetch，采用 Undici dispatcher，不能照搬 `http.globalAgent`。
- [NovelAI 当前官方 schema](https://image.novelai.net/docs/doc.json)：官方 JSON 响应与订阅路径；没有照搬本地旧酒馆的 `api.novelai.net/user/subscription`。
- 回归验证：在 `agent-core` 执行 `node --test test/novelaiClient.test.js test/llmConfig.test.js`。测试使用本地 HTTP 代理及模拟上游，不调用付费生成。
