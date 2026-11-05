# 设备访问

电脑通过 `http://localhost:<PORT>` 或 `http://127.0.0.1:<PORT>` 直连，无需登录。手机使用电脑的局域网 IP，首次打开进入配对页。

在电脑「设置 → 设备连接」复制配对码，输入手机配对页。成功后写入 HttpOnly、SameSite=Strict Cookie，保存 30 天。所有 API、图片和头像都需要本机访问或设备凭证；健康检查与前端静态文件不包含用户内容，可在配对前加载。

备份导入、备份导出、API Key 明文复制和关闭服务只允许电脑本机操作。配对设备不能调用这些管理接口。

配对主密钥保存在 `agent-core/data/.access-token`，不进入用户导出归档。重置方法：停止后端，备份并移除该文件，再启动；已有远程设备需要重新配对。不要把此文件提交 Git 或随公开分发包发布。

高级集成可发送 `Authorization: Bearer <配对码>`。代理需要保留 `Forwarded` 或 `X-Forwarded-*` 来源信息，不能伪装成本机直连；自定义域名须通过 `LINSHE_ALLOWED_HOSTS` 显式列出，逗号分隔。公网部署仍须 HTTPS；本项目默认面向本机与可信局域网。

默认拒绝跨站 Origin 与非本机/非本机网卡 Host，防止外部网页读取本地服务。开发模式额外允许已知本机地址的 Vite 5173 Origin。配对接口每地址每分钟允许 10 次错误尝试。

实现：`agent-core/src/server/accessControl.js`、`web-ui/src/components/DeviceAccessGate.vue`。回归：`agent-core/test/accessControl.test.js`、`web-ui/test/deviceAccess.browser.test.js`。
