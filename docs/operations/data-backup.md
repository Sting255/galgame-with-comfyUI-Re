# 全量数据备份与恢复

入口：电脑本机「设置 → 数据备份」。2026-11-04 更新：补齐音频、数据库完整性校验、恢复隔离和失败回滚。手机配对设备不开放备份管理接口，页面直接提示到电脑本机操作。摘要读取失败会显示重试入口，不再显示成没有数据。

## 归档内容

| 路径 | 内容 |
| --- | --- |
| manifest.json | 版本、文件清单、大小与 SHA256 |
| data/agent.db | SQLite 一致性快照 |
| data/avatars、data/images、data/town | 头像、立绘、配图及仍被引用的历史素材 |
| data/audio | 原录音、预览、参考片段与已生成语音 |
| config/.env | 可选，含模型凭据，默认不导出 |

格式仍为 version 1 的 tar.gz，兼容旧归档。旧归档没有的音频无法凭空恢复，需用新版本重新导出。

TTS_AUDIO_DIR 自定义目录统一映射成归档 data/audio，恢复时映射到本机音频目录。DB_PATH 自定义位置也会备份。向量派生索引、运行时、日志、产物和 data/backups 不导出；设备配对密钥不允许从归档替换。

## 恢复顺序

1. 在系统临时 staging 解压，检查 gzip、tar 类型、路径、大小、manifest 双向清单与逐文件哈希；只接受已知素材目录，拒绝链接、路径穿越、WAL、数据库大小写别名及 Windows 特殊文件名。
2. 以只读方式打开 staging 数据库，执行 SQLite 完整性检查、验证邻舍核心表字段。失败返回 400，不创建回滚备份、不改现有库。
3. 进入维护状态，成功 checkpoint 后关闭旧句柄。其他任务不能重开库，旧持有句柄也不能继续写。
4. 复制现有数据到 data/backups/pre-import-日期时间，包含自定义数据库、音频与原配置。
5. 替换库、合并素材、按需恢复 .env。素材逐文件记录覆盖前副本，归档里没有的旧素材保留。
6. 换库失败自动恢复旧库；素材/配置失败同时回滚已覆盖文件与数据库。自动回滚不完整时保持维护状态并返回备份位置。
7. HTTP 恢复成功后关闭数据库并保持维护状态，要求重启。恢复前仍在运行的异步任务不能把旧结果写入新库。

## 接口与边界

| 接口 | 返回 |
| --- | --- |
| GET /api/data/export?includeConfig=0或1 | 先完整生成归档，再流式下载；发送结束清临时文件 |
| GET /api/data/export/info | 数据库大小估算、记录数、本进程上次导出时间 |
| POST /api/data/import | 原始 gzip body；成功含 restored、backupPath、restartRecommended、restartRequired、message |

导入仍一次将归档读入内存，默认上限 2 GiB，解压总大小也受限。磁盘需要 staging、现有数据备份与覆盖日志空间；备份失败不会继续换库。

导出期间素材仍可能变化：数据库快照一致，但素材不是文件系统快照。重要归档应先等待生图和语音完成；后续可把导出接入全局任务排空。

恢复后的页面和后台状态以重启为边界。收到 restartRequired 后，备份面板保留重启提示并禁用导入、导出和配置开关。

## 实现与验证

- web-ui/src/components/settings/DataBackupPanel.vue：独立备份面板、设备权限、文件预检与结果反馈。
- agent-core/src/services/dataBackup.js：导入导出流程。
- agent-core/src/services/backup/：数据库只读检查、素材覆盖日志。
- agent-core/src/db/maintenance.js：维护锁与恢复任务所有权。
- agent-core/test/dataBackup.test.js：归档往返、损坏文件、并发隔离、失败回滚、音频、HTTP 重启边界。

验证只用合成临时库和 HTTP 桩，不调用真实模型。
