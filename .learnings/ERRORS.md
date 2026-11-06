# Errors

2026-11-05：源码查找先用 rg --files 确认路径，不按模块名猜路由文件名（上下文路由实际为 routes/context.js）。命令的相对路径必须与 workdir 对应；PowerShell 搜索通配符应交给 rg 的 -g 参数。旧 UI 源码断言应更新为共享组件的接线契约，并用真实浏览器行为覆盖替代原先的内联事件数量断言。

## 2026-11-04 · 修复交接路径定位

- 摘要中的简写路径不能直接用于读取；先用 `rg --files` 定位实际文件。LLM 客户端在 `src/llm/`，生图服务在 `src/services/`。
- PowerShell 不展开传给 rg 的路径通配符；目录参数配 `-g` 过滤，避免反复读不存在的路径。
- 后续定位已改为实际文件清单；不记录凭据或完整配置。

## 2026-11-04 · 构建和隔离测试

- PyInstaller 的 spec 放临时目录时，资源参数应使用绝对路径，否则相对路径按 spec 目录解析。
- 检查 EXE 内的 Qt 模块时，扩展模块名称是路径，先归一化路径分隔符再匹配模块名。
- config.js 新增静态依赖后，`llmConfig.test.js` 的 data URL 隔离加载器也要补映射。端口默认值测试须显式隔离用户 `.env`，不能假设用户没有设置 PORT。
- 两套全量回归曾被不同入口同时启动；首次出现 fileLogger 的 Node 测试协议反序列化错误，单测复跑通过，最终全量必须等待其它运行结束后独立执行。

## 2026-11-04 · 日志测试协议与路径边界

- 串行全量再次复现 fileLogger 反序列化错误，不能再只归因于并发。该测试吞掉 process.stdout.write 的所有写入，其中包含 node --test 的二进制协议帧；现改为独立 Console + Writable 验证原始输出，不拦截进程通道。
- 授权路径必须与 Express 的大小写和尾斜杠匹配规则一致；Windows 归档还要拒绝大小写数据库别名、尾点、设备名和 ADS 路径。

## 2026-11-04 · 奇遇事务失败路径

- Express 的同步数据库路由不要无意义声明 async：事务抛错会变成未处理的 Promise，HTTP 请求悬挂。取消奇遇路由改为同步处理，故障注入验证错误中间件能收到异常且事务回滚。
- 批量编辑脚本的相对路径与 workdir 必须对应；根路径前缀脚本在仓库根运行。

- Playwright 请求桩按 URL pathname 的 `/api/` 前缀匹配；`**/api/**` 会把 Vite 的 `/src/api/index.js` 也拦成 JSON，页面模块无法加载但未必触发 pageerror。

## 2026-11-04 · 生图队列测试的配置回填

- 全量测试把 ComfyUI 指向本机关闭端口后，assetGenerationQueue 的 3 条创建任务测试失败。已有 HTTP 桩在首次 getDb() 前写 config，首次建库从 system_settings 回填配置又覆盖了桩地址。应先完成内存库初始化，再设置桩地址；修正后 11 条队列测试独立通过。

2026-11-05：前次 PyInstaller 重建继承工具 PATH，误收集 Poppler 的 icuuc.dll 与外部 CRT，产物 QtWidgets 导入报 WinError 127。TOC 和提取 DLL 的加载试验确认根因，预加载系统 ICU 后 QtCore／Gui／Widgets 均成功。三个构建入口现共用隔离 PATH 的 builder，并要求临时空项目下真实窗口自检通过后才替换 EXE。CollapseTransition 必须传 :show；仅用外部 v-if 不会渲染其默认隐藏的内容。

2026-11-05：普通睡眠 UI 回归中，模板调用检查把 store.method() 的 method 当成顶层函数；应解析成员链的根绑定，再用浏览器实际点击证明接线。使用说明生成源更新后，应先执行 --usage-guide-only 再跑以生成文件为基线的全量回归。PowerShell 的 rg 路径不支持 shell 通配符；本轮再次误用后改为明确目录，后续搜索一律目录配 -g。
