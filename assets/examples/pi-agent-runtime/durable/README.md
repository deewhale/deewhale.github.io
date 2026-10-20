# Pi Durable ToolTask crash recovery

此例用官方Pi Durable 1.3.0和SQLite验证工具意图已经提交、外部模拟操作已经发生、工具结果尚未提交时的进程崩溃。

下载本目录中的durable-recovery.mjs、package.json、package-lock.json到一个新目录。本例已在Node.js 24验证，需要可直接导入的内置node:sqlite；其他Node版本请先确认该模块可用。可能显示实验性SQLite提示。执行：

```sh
npm ci --ignore-scripts
node durable-recovery.mjs
```

脚本使用os.tmpdir()下自行生成的唯一目录，输出该目录位置并保留产物；不接收删除目标路径。每组由父进程启动自己的worker，worker在写完模拟副作用后只向自身发送SIGKILL，父进程断言该signal；第二个worker重开同一数据库。每个worker最长15秒，超时视为失败。SIGKILL实验面向macOS/Linux等POSIX系统。

预期三个模式：

| mode | reopened phase | execute attempts | external effects | beforeTool count | result |
|---|---|---|---|---|---|
| unsafe | pending/execute | 1 | 1 | 1 | interrupted error |
| safe-duplicate | pending/execute | 2 | 2 | 1 | success |
| safe-idempotent | pending/execute | 2 | 1 | 1 | success |

每个目录保留session.sqlite、task.json、attempts.json、effects.json、hooks.json供检查。第三组的key查重只模拟单调用方外部幂等，不是生产并发去重实现。

此例手工写入assistant工具请求，再创建真正的官方ToolTask。没有调用模型，没有使用API密钥，没有操作真实业务。它验证SQLite进程崩溃与ToolTask恢复分支，不验证GenerationTask完整路径、partial输出保留、断电、多写者或网络分区。safe允许重做，外部幂等仍是业务系统责任。
