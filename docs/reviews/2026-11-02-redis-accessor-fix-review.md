# Redis zrangebyscore 报错修复复审（Codex，2026-11-02）

结论：核心修复正确，未发现该修复对当前生产装配路径的新阻断问题；附带新增的pipeline入口存在P3封装保护遗漏，建议删除或统一保护。

## 根因与正确修复

access-flush.mjs通过传入的redis.zrangebyscore读取待交付分钟。server.mjs实际传入的是createBoundedAccessor返回的accessCmds，并非原始ioredis；原封装缺少zrangebyscore，因而出现“is not a function”。这不是Redis版本或服务器配置不支持该命令。

新增`zrangebyscore: limit('zrangebyscore')`补齐了真实调用契约，并保留既有并发预算、finally释放及超时supervisor通知。

针对实际模块执行的替身验证：

- 转发dirty键、-inf、结束分钟等参数与返回值一致。
- maxConcurrent=1时第二个在途调用被REDIS_INFLIGHT_LIMIT拒绝。
- 超时错误上抛并通知supervisor。
- createAccessFlusher注入实际bounded accessor及createBatchRunner，完整执行一个待交付分钟，写入替身Store成功，lastError=null。

## R-01 [P3] 附带新增pipeline返回原始对象，没有并发或超时保护

位置：src/redis-client.mjs createBoundedAccessor末尾pipeline方法及其注释。

`pipeline: () => redis.pipeline()`既不登记inflight，也不包裹exec或通知supervisor。“整个exec算一次在途”的注释与实现不符。实际替身验证maxConcurrent=1仍可同时启动两个永不完成的pipeline.exec。

当前server明确为accessStats与accessFlusher传入createBatchRunner，生产汇总不依赖该回退入口，所以不将它列为当前生产阻断。建议本次只保留必要的zrangebyscore修复；若确实支持无batch注入的回退，则应改为受保护批量接口，而不是在有界访问器上公开原始pipeline。补无batch回退路径的预算/超时测试。

### 处置结果（2026-11-02 已实施）

采用“删除回退入口、统一走受限批量执行器”方案：

1. `src/redis-client.mjs`：移除 `pipeline: () => redis.pipeline()`，`createBoundedAccessor` 只暴露有界直连命令（含补齐的 `zrangebyscore`）。
2. `src/access-flush.mjs`：移除未注入 batch 时的 `redis.pipeline()` 兼容回退（生产装配与全部测试均已注入，属死代码），改为构造期校验 `typeof batch !== 'function'` 直接抛错，避免漏注入时退化为运行期 `is not a function`。
3. 验证：`node --check` 通过；accessor 17 个直连方法齐全且 `pipeline` 为 `undefined`；构造期守卫按预期抛错；非 Redis 相关测试 32/32 通过（本地 Redis 未运行，Redis 集成用例未执行）。

## 验证边界

本轮只做上述针对性模块验证，未执行全量测试、真实Redis/MySQL集成、生产部署或落库补传验收。没有读取凭据、修改业务代码、清理共享Redis或修改服务器配置。

部署后应检查访问管理页的汇总延迟错误消失，并在完整分钟结束后确认MySQL分钟记录或汇总水位推进。仅后台实时计数正常不能证明此前失败的MySQL落库已恢复。旧待交付数据仅在其Redis桶仍保留时可重试，不能承诺已过TTL的数据会自动恢复。
