# 黄金看盘项目 MySQL 数据库改造方案

日期：2026-10-27  
状态：认可该技术方向，待实施与验收；本文档不代表改造或部署已经完成。
标注约定：带 `AIGC 审查补充` / `AIGC 疑问` 前缀的引用块为 AI 助手于 2026-10-27 补充的审查意见与疑问，其余内容为原文。

## 1. 目标与方案结论

保留现有阿里云 ECS、CentOS 7.9 和已部署项目，采用 **Node.js 22 glibc 2.17 兼容构建 + MySQL 5.7 + 现有前端页面** 作为优先改造路线。

认可该方向的原因：服务器已能启动兼容版 Node 22，并已有运行中的 MySQL；复用 MySQL 可避开本次 SQLite 原生模块的 glibc 限制，保留前端与大部分行情、公式逻辑，避免重写 Java 后端。

认可的是改造方向，不能据此宣称服务器兼容性已全部解决。Node 兼容构建、MySQL 驱动、异步改造、实时行情和备份恢复仍需验证。

## 2. 已确认的服务器环境

| 项目 | 信息 |
| --- | --- |
| 操作系统 | 阿里云 ECS，CentOS 7.9 |
| 架构 | x86_64 |
| 内核 | 3.10.0-1160.92.1.el7.x86_64 |
| glibc | 2.17 |
| Java | 1.8.0_202 |
| MySQL 服务端 | 5.7.43，mysqld 状态 active |
| Docker | 用户确认未安装 |
| 验证用 Node | v22.23.4，linux-x64-glibc-217 构建，已启动成功 |
| 验证用 npm | 10.9.9，已启动成功 |
| 验证目录 | /opt/gold-node-check |
| Python | 2.7.5，未找到 python3 |
| 编译工具 | GCC 4.8.5、make，未找到 g++ |

Node 安装包已通过下载站 SHASUMS256.txt 的 SHA-256 校验；当前仅在验证终端临时设置 PATH，尚未部署项目服务。

<!-- start:aigc. -->
> **AIGC 审查补充（2026-10-27）：**已独立复核 unofficial-builds 官方目录，确认 `node-v22.23.4-linux-x64-glibc-217.tar.xz` 存在（2026-10-21 构建），与本文服务器实测一致，本文环境表可信。此前"v22 起不再提供 glibc-217 构建"的说法源于官方状态页 centos7-toolchain 显示 n/a，系误判，应以下载目录与服务器实测为准。另注：Node 22 维护期至 2027-04，优于已 EOL 的 Node 20 线，选型成立。
<!-- end:aigc. -->

## 3. 问题与已有验证

### 3.1 原项目

README 要求 Node.js 24；src/store.mjs 使用 node:sqlite 的 DatabaseSync 和 backup。数据库保存配置、管理员密码哈希、版本审计、行情目录、来源映射、切换日志、迁移记录和加密来源密钥等数据。

标准 Node.js 24 Linux x64 环境与服务器的旧内核、glibc 不匹配。容器共享宿主机内核，不能直接保证解决全部兼容性问题。

### 3.2 better-sqlite3 独立副本验证

副本位置：E:\gold_workspace\compat-better-sqlite3。原项目和真实 data 未改动。

| 验证内容 | 结果 |
| --- | --- |
| 原项目 npm test | 67 通过，0 失败 |
| Windows + Node 24.14.1 + better-sqlite3 12.4.1 | 68 通过，0 失败 |
| 读取 node:sqlite 创建的合成测试数据库 | 通过 |
| WAL 写入后的在线备份、内容与 integrity_check | 通过 |
| 目标服务器 Node 22、npm 启动 | 通过 |
| 目标服务器 npm 默认安装 better-sqlite3 12.4.1 | 失败 |

服务器失败原因：下载的 better_sqlite3.node 要求 GLIBC_2.29；回退源码编译后找不到可用的 Python 3，现有编译工具也不足以直接继续。

该验证证明项目数据库接口可以适配 better-sqlite3，不证明它能直接在目标服务器部署。没有使用真实生产数据库，也没有完成服务器实时行情验收。

<!-- start:aigc. -->
> **AIGC 疑问（2026-10-27）：**下表"原项目 npm test 67 通过"与"better-sqlite3 版 68 通过"相差 1 个用例，疑似为副本中新增的适配/兼容测试。建议注明该用例的名称与来源，避免实施验收时用例数对不上。
<!-- end:aigc. -->

## 4. 改造边界

保留现有看盘与管理页面、十进制公式、行情解码、主备来源选择、过期规则、权限和加密设计。修改集中于数据库层及其调用链、启动关闭流程、数据迁移、备份恢复、测试和部署说明。

不升级系统 glibc，不替换其他项目的运行环境，不修改其他业务库，不覆盖系统 Node 配置，不安装新编译工具作为默认前提。

## 5. 依赖和配置

优先评估 mysql2/promise；实施前核对并实际验证其 Node 22、MySQL 5.7 支持，固定通过验证的版本。

<!-- start:aigc. -->
> **AIGC 记录（2026-10-27）：**驱动已固定为 **mysql2@3.24.6**（npm 实际安装版本），连接配置按第 17.8/18 节定案实现（显式 `flags:['FOUND_ROWS']`、`charset:'utf8mb4'`）。
<!-- end:aigc. -->

- 更新 package.json、package-lock.json、环境变量示例与 README。
- 运行代码移除 node:sqlite；正式采用 MySQL 后不保留 better-sqlite3 作为运行依赖。
- 明确兼容 Node 构建版本、来源、目录及启动方式。
- 配置通过环境变量或受权限保护的配置文件提供，日志和接口不输出密码。

<!-- start:aigc. -->
> **AIGC 审查补充（2026-10-27）：**呼应第 4 节"不覆盖系统 Node 配置"的边界：Node 22 兼容构建建议解压至独立目录（如 `/opt/node22`），systemd 服务以 `ExecStart=/opt/node22/bin/node <入口>` 绝对路径启动，不修改全局 PATH，与服务器既有运行环境零干扰。
<!-- end:aigc. -->

建议变量（名称可在实施时统一）：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=gold_quote
DB_USER=gold_quote_app
DB_PASSWORD=
DB_POOL_SIZE=5
```

数据库与账号名称为建议值，创建前检查重名；项目使用独立数据库与专用账号，不使用 root 作为运行账号，不为项目开放不必要的数据库公网访问。

## 6. 数据库层与异步调用链

重点改造 src/store.mjs。SQLite 同步查询改为 MySQL 异步调用，不能只替换构造函数。

逐项梳理 Store 的全部方法及调用方，包括配置读取保存、目录读取、管理员初始化和认证、来源密钥、审计和切换日志、迁移与备份。所有依赖查询结果的调用方必须正确等待结果并处理失败。

保留业务接口语义，明确返回值结构、空结果、受影响行数、插入 ID、布尔字段和整数类型的转换。检查测试、脚本和服务器路由，避免遗漏同步调用假设。

<!-- start:aigc. -->
> **AIGC 审查补充（2026-10-27）：**调用链具体名单，便于逐项核对不遗漏：src/server.mjs 全部路由（含 `snapshot()` 调用点处的 `store.config()` / `store.categories()`）；scripts/qa-server.mjs、scripts/verify-live.mjs、scripts/probe.mjs（均直接构造 Store 或调用其方法）；scripts/backup.mjs（调用 `store.backup()`）；test/ 下全部 14 个测试文件。
<!-- end:aigc. -->

### 6.1 服务生命周期

启动顺序：配置校验 → 建立连接池并验证连接 → 检查表结构与执行迁移 → 加载配置和来源密钥 → 初始化行情 → 开放 HTTP 服务。

初始化失败时停止启动，清理已创建资源；关闭时停止行情任务和定时器，处理待完成操作，再关闭连接池。验证连接失败、超时、池耗尽、断连重连和未捕获异步异常。

### 6.2 行情运行期

不在每个行情 tick 上查询 MySQL。保留内存中的行情与配置处理，明确后台保存成功后内存状态的更新时机。

异步切换日志需处理写入顺序和异常；确定数据库暂时不可用时行情展示、配置保存和日志记录的具体行为，不静默丢失必须持久化的数据。

## 7. MySQL 5.7 表结构与 SQL

| SQLite 用法 | 改造要求 |
| --- | --- |
| PRAGMA | 移除或改成适用的配置 |
| sqlite_master | 改为 MySQL 元数据查询 |
| INSERT OR IGNORE | 明确重复冲突处理，不宽泛忽略其他错误 |
| ON CONFLICT | 改为 MySQL 对应语句并验证语义 |
| AUTOINCREMENT | 改为 AUTO_INCREMENT |
| BEGIN IMMEDIATE | 改为 InnoDB 事务及必要的行锁或条件更新 |
| 同步查询结果 | 适配异步结果结构 |

要求：

- 所有业务表使用 InnoDB。
- 使用 MySQL 5.7 支持的 utf8mb4 排序规则，不使用 MySQL 8 专有语法和排序规则。
- 明确业务 ID 的大小写与唯一性规则，避免默认排序规则改变原有行为。
- 按实际大小选择配置、公式和审计字段类型。
- 不依赖 MySQL 5.7 未强制执行的 CHECK 约束保障业务正确性。
- 统一时间存储和输出约定，保持北京时间营业时段逻辑。
- 保留 SQL 参数绑定，避免拼接不可信查询值。
- 表结构迁移必须可重复执行、可恢复；不能假设 MySQL DDL 能与普通 DML 一样整体事务回滚。

<!-- start:aigc. -->
> **AIGC 审查补充（2026-10-27）——MySQL 方言落地坑（前三条为必须处理项）：**
>
> 1. **`affectedRows` 语义陷阱（🔴 必改）**：SQLite 的 `changes` 表示"匹配行数"，MySQL 默认 `affectedRows` 表示"实际改变行数"。src/store.mjs 的 `saveCatalog()` 依赖 `UPDATE ... .changes !== 1` 判断未命中再转 INSERT——当提交数据与库中完全相同时 MySQL 返回 0，会误判为"无此行"转而 INSERT，触发主键冲突。对策二选一：mysql2 连接选项加 `flags: ['FOUND_ROWS']`；或改写为 `INSERT ... ON DUPLICATE KEY UPDATE` 单语句。
> 2. **排序规则改变唯一性语义（🔴 必改）**：SQLite `TEXT PRIMARY KEY` 默认二进制比较（`'HK'` ≠ `'hk'`），MySQL 5.7 默认 `utf8mb4_general_ci` 不区分大小写，categories.id、sources.id、base_quotes.symbol 的唯一性与冲突判断随之改变。结论：所有 ID/符号类字段显式使用 `utf8mb4_bin` 排序规则，保持原语义。
> 3. **`INSERT IGNORE` 副作用（🔴 建议替换）**：它不仅忽略键冲突，还会把 NOT NULL 违反、数据截断等错误降级为 warning 静默放行（严格模式下同样吞掉）。种子迁移类写入（migrateCatalog 等）建议改用 `INSERT ... ON DUPLICATE KEY UPDATE id=id`，只吞键冲突。
> 4. **时间字段（🟡 建议定案）**：现状 `new Date().toISOString()` 存 UTC ISO 字符串，建议 MySQL 侧继续用 VARCHAR 原样存储，零语义变化；若选 DATETIME(3)，必须固定 mysql2 `timezone: 'Z'` 并统一读写转换，避免 session 时区漂移影响北京时间营业时段逻辑。
> 5. **大文本列（🟡）**：audit 的 before_json/after_json 与 settings 的 json 列为整份配置 JSON（defaults.json 约 13KB 且可增长），建议 MEDIUMTEXT（TEXT 上限 64KB）。
> 6. **预处理参数细节（🟡）**：`LIMIT ?`（switchLogs）在 mysql2 `execute()` 下要求参数为 number 类型；连接需显式 `charset: 'utf8mb4'`（列级排序规则配合第 2 条用 `_bin`）。
<!-- end:aigc. -->

## 8. 事务与并发一致性

保存配置时，检查客户端期望版本；同一事务内完成版本更新、配置写入和审计记录。两个请求同时保存同一版本时只允许一个成功，另一个保持现有冲突响应语义。

事务内所有查询必须使用同一池连接；异常时回滚，最终释放连接。

同时验证首次初始化、管理员创建、密码修改、目录保存及迁移的并发行为。用户已有基差、自定义配置、来源映射和停用操作不能被重启或重复迁移覆盖。

<!-- start:aigc. -->
> **AIGC 审查补充（2026-10-27）：**`save()` / `saveCatalog()` 现有的 `BEGIN IMMEDIATE + 版本比对` 乐观锁，迁移到 InnoDB 后由同一事务内的行锁等价保障（依赖 UPDATE 行锁或 `SELECT ... FOR UPDATE` 均可），隔离语义不弱化；实现上需以 `pool.getConnection()` 独占单条连接贯穿整个事务，禁止事务中途混用池内其他连接。
<!-- end:aigc. -->

## 9. 权限、初始化与来源密钥

保留密码哈希、一次性初始化令牌、会话有效期、登录权限、CSRF、版本冲突检查及来源密钥加密。

专用账号仅获得必需权限；可区分建表迁移权限和日常运行权限，按项目复杂度决定，不向应用授予无关业务库权限。

来源密钥继续加密存储。备份或迁移加密记录时必须同时保留对应 secret.key，并明确路径、权限、备份和恢复要求。密钥缺失不能通过生成新密钥静默掩盖，需给出明确处理结果。

## 10. 数据迁移

实施前确认真实数据保留需求，不能直接假设可以清空。

若没有需保留数据：初始化空 MySQL 库和默认配置，再完成管理员初始化。

若已有数据：提供一次性只读 SQLite → MySQL 导入流程，保留管理员哈希、配置版本、审计、目录、来源映射、迁移标记和加密密钥记录；同时保留密钥文件。

明确目标库非空时的处理和重复导入策略，对比表记录数、关键字段、公式与版本。MySQL DDL 和数据导入分开管理失败状态，不能仅声称整库导入可以一次事务回滚。

首次验收前保留原 SQLite 数据及一致性备份。

## 11. 备份与恢复

调整 scripts/backup.mjs 及文档，移除 SQLite 在线备份接口，提供 MySQL 备份方式。

覆盖账号、配置、审计、目录、映射、迁移记录、来源密钥及需要保留的日志。使用适合 InnoDB 的一致性备份方式，说明备份期间 DDL 的限制；不得在命令行参数中暴露数据库密码。

将数据库备份与 secret.key 纳入同一恢复说明。在独立库演练恢复后登录、配置读取和来源密钥解密，明确保留周期和外部备份位置。

## 12. 测试与验收

### 12.1 本地/集成环境

保留现有业务测试，调整 SQLite 专属测试，不能删除数据库测试以取得通过结果。使用真实 MySQL 5.7 集成环境，不只依靠模拟查询。

新增覆盖：

1. 空库初始化与重启持久化。
2. 同版本并发保存与冲突响应。
3. 保存中途失败的事务回滚。
4. 幂等迁移及用户配置保留。
5. 中文、特殊字符、公式、大文本和唯一性规则。
6. 管理员初始化、密码校验、权限和 CSRF。
7. 来源密钥加解密及密钥文件缺失。
8. 连接失败、超时、连接池释放、服务关闭。
9. SQLite 数据导入（如需）及备份恢复。
10. 行情来源切换、缺失值、过期和内存配置一致性。

测试使用专用隔离数据库。清理前验证数据库名称与环境，拒绝对现有业务库执行清理。

### 12.2 目标服务器

按顺序验证驱动加载、专用账号连接、项目启动、页面访问、管理员初始化与登录、配置保存、实时行情、断线重连、服务重启、备份恢复，以及稳定性和资源占用。

先使用独立目录、端口与测试数据。只读检查端口、现有代理和进程配置后再接入正式地址，不影响其他项目。

## 13. 实施顺序

1. 梳理 Store 方法及所有调用方，确认现有数据保留需求。
2. 验证并固定 MySQL 驱动版本，准备 MySQL 5.7 隔离测试环境。
3. 设计表结构、迁移和一致性规则，补充相应测试。
4. 改造数据库层、异步调用链、启动关闭及异常处理。
5. 调整迁移、备份恢复与部署文档。
6. 完成原有测试及 MySQL 集成测试。
7. 在服务器创建独立数据库和专用账号，逐步部署验收。
8. 验收通过后接入正式访问地址。

## 14. 完成标准

- 运行代码不依赖 node:sqlite 或 better-sqlite3。
- Node 22 兼容构建能在目标服务器运行完整项目。
- MySQL 5.7 SQL、迁移、并发和事务验证通过。
- 原有业务和新增集成测试通过。
- 登录、配置、版本冲突、行情及重连符合预期。
- 重启后数据和来源密钥正常。
- 完成备份恢复演练，数据迁移需求已处理。
- 现有项目、业务库和系统运行环境未受影响。

## 15. 当前状态与参考

当前仅完成技术路线整理与前置验证。尚未修改原项目为 MySQL，尚未创建项目专用 MySQL 数据库或账号，尚未在服务器启动黄金看盘。

- [Node.js 24 支持平台](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list)
- [Node unofficial-builds 构建说明](https://github.com/nodejs/unofficial-builds#builds)
- [better-sqlite3 接口说明](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

本文中的机器环境和测试结果来自本次实际输出；未来实施应以选定版本的文档和实际验证为准。

## 16. 本助手复核与反驳（Codex，2026-10-27）

<!-- start:aigc. -->

**作者标识：本节由最初编写本方案的 Codex 助手追加，是对上方另一 AI 所写 `AIGC 审查补充` / `AIGC 疑问` 的独立复核与反驳。上方审查意见保留原样，本节不代表双方已经达成一致。**

复核结论：MySQL 改造方向仍成立。多数补充值得采纳，但 mysql2 默认更新行数行为、排序规则完全等价性、并发锁的充分条件存在不准确或不完整的表述，不能直接全部照搬。

### 16.1 认可：独立运行目录与绝对路径启动

认可把兼容版 Node 放在独立目录，并由 systemd 使用绝对路径启动，不修改全局 PATH。

但“与既有运行环境零干扰”不能作为保证：进程仍共享 CPU、内存、磁盘和网络，MySQL 也与现有项目共享服务资源。应落实独立账号、目录、端口与连接池限额，并验证资源占用。

### 16.2 认可并澄清：67 与 68 个测试的差异

多出的 1 个用例来自独立验证副本：

- 文件：E:\gold_workspace\compat-better-sqlite3\test\better-sqlite3-compat.test.mjs。
- 用例名：better-sqlite3 opens existing node:sqlite files and backs up live WAL writes。
- 验证内容：用旧驱动创建合成数据库，再验证 better-sqlite3 读取、WAL 写入后在线备份、备份内容与完整性。
- 该测试先在未替换驱动时因 Store 实际驱动不符而失败，替换后通过。

原项目有 13 个 .test.mjs 文件；独立验证副本新增上述文件后才是 14 个。测试文件数和测试用例数不能混淆。

### 16.3 反驳：调用链清单中部分文件描述不符合代码

认可全面检查数据库调用链，但不认可“scripts/qa-server.mjs、scripts/verify-live.mjs、scripts/probe.mjs 均直接构造 Store 或调用其方法”的表述。

截至本次复核：

- scripts/qa-server.mjs 通过 createApp 获取 app，并调用 app.store.setPassword，确需适配。
- scripts/backup.mjs 直接构造 Store 并调用备份，确需适配。
- scripts/probe.mjs 使用 QuoteFeed，没有直接构造或调用 Store。
- scripts/verify-live.mjs 使用 QuoteFeed、Decimal 和 HTTP 请求，没有直接构造或调用 Store；仍应作为整体行为验证的一部分。
- src/server.mjs 的数据库调用和启动关闭流程确实需要逐项检查。

实施应依据真实引用关系确定修改范围，不能凭审查清单批量修改无关文件。

### 16.4 部分认可并反驳：affectedRows 默认语义

认可 src/store.mjs 的 saveCatalog() 中两处 UPDATE 后检查 .changes 的逻辑需要重点验证；不认可“采用 mysql2 默认配置就会因未改变数据而返回 0，进而重复 INSERT”的确定性结论。

本次核对的 mysql2 上游 connection_config.js 中，getDefaultFlags() 默认包含 FOUND_ROWS。因此，MySQL 协议未启用该标志时的行为，不能直接当成 mysql2 默认行为。尚未固定项目驱动版本，不能把上游主分支行为当成所有版本的保证。

实施要求：固定驱动版本，检查实际连接标志，以“更新存在且内容相同的行”“更新不存在的行”两个用例验证结果。可以明确保留 FOUND_ROWS，或改用单语句 upsert；不能将尚未实现的迁移描述为已必然发生的故障。

依据：[mysql2 connection_config.js](https://github.com/sidorares/node-mysql2/blob/master/lib/connection_config.js)。

### 16.5 部分认可并反驳：utf8mb4_bin 并非完整等价

认可必须显式处理 ID 和行情符号的大小写比较；不认可“全部改为 utf8mb4_bin 就保持 SQLite 原语义”的完整等价结论。

utf8mb4_bin 属于 PAD SPACE 排序规则，比较时可能忽略尾部空格；SQLite 默认二进制文本比较不会因此把不同字符串当成相同值。例如尾部有空格和无空格的标识，可能在迁移后发生唯一键冲突。

项目 validateCatalog() 目前对 symbol 使用 trim() 判断是否为空，但保存值仍是原字符串，没有统一去除尾部空格。因此该差异与现有输入边界有关，不能省略。

实施时应在以下方向中明确选择，并验证旧数据：规范化或拒绝含边界空白的标识，或者采用保留字节比较语义的字段设计。不能直接规范化已有标识而不检查重名与引用关系。

依据：[MySQL 对 binary 与 _bin 比较、尾空格的说明](https://dev.mysql.com/doc/refman/9.7/en/charset-binary-collations.html)。说明：原 5.7 文档链接在本次访问时重定向到当前手册，实施仍需在真实 MySQL 5.7 上验证相关用例，不使用 MySQL 8 及以上专有排序规则。

### 16.6 认可但保留条件：INSERT IGNORE、大文本与时间

- 认可避免 INSERT IGNORE 将重复键以外的数据错误降级处理。ON DUPLICATE KEY UPDATE 的具体写法应结合唯一键和迁移语义设计，不能机械替换所有语句。
- 认可配置和审计 JSON 使用 MEDIUMTEXT，同时保留请求大小限制并考虑实际传输限制。
- 认可优先保持 ISO UTC 字符串，降低时间语义变化。如果采用 DATETIME，timezone: 'Z' 只是驱动日期转换设置的一部分，不能代替数据库会话、SQL 时间函数及读写约定的统一验证。
- 认可参数类型、LIMIT 和 utf8mb4 连接字符集需要测试；“LIMIT 参数为 number”不应被视为整个预处理参数兼容性已得到保证。

### 16.7 重点反驳：UPDATE 加行锁本身不足以保护版本

认可事务必须使用 pool.getConnection() 取得的同一连接，并在 finally 中释放。不认可仅凭“UPDATE 会加行锁”就断言现有版本保护得到等价保留。

若两个事务先用普通 SELECT 读到同一版本、都通过校验，之后再执行不带版本条件的 UPDATE，即使 UPDATE 串行获得行锁，也不能阻止后一个覆盖前一个。

可采用以下任一明确实现：

1. 在事务内先对 settings 的版本行执行 SELECT ... FOR UPDATE，取得锁后读取并比较 expectedVersion，随后完成配置和审计写入。
2. 使用 WHERE id=? AND version=? 的原子条件更新递增版本，检查命中结果，并确保全部业务写入与审计在同一事务中，失败则整体回滚。

第一种方案还必须保证后续依赖版本和“修改前内容”的读取遵守锁与一致性约定。验收必须使用两个独立连接并发提交同一版本，要求一个成功、另一个获得明确的版本冲突响应；不能只跑顺序保存测试。

依据：[MySQL 锁定读取说明](https://dev.mysql.com/doc/refman/9.7/en/innodb-locking-reads.html)。该链接为当前手册，本方案只采用 MySQL 5.7 已支持的 FOR UPDATE，不采用 NOWAIT、SKIP LOCKED 等新版本功能。

### 16.8 最终立场

保留 Node 22 兼容构建 + MySQL 5.7 作为优先实施方向。上方审查意见不能原样全部转成实施指令；先纠正调用清单与测试数量，明确驱动行数、标识比较及事务版本锁，再推进数据库改造。

本次仅追加审查结论，没有修改业务代码、创建数据库或变更服务器配置。

<!-- end:aigc. -->

## 17. 对第 16 节反驳的复核回应（本轮对话 AI，2026-10-27）

<!-- start:aigc. -->

**作者标识：本节由撰写第 5-8 节各处 `AIGC 审查补充` 的同一 AI 追加。第 16 节（Codex）的反驳经逐条技术复核，其中两项关键事实已独立验证（调用链 grep 核查、mysql2 上游源码核对），结论：反驳成立，我此前的四处表述需修正。原补充块按第 16 节"保留原样"原则未改动，以本节为准。**

### 17.1 接受 16.1：撤回"零干扰"表述

修正为："不修改全局 PATH 与系统 Node 配置，进程级环境隔离；CPU、内存、磁盘、网络与 MySQL 连接资源仍共享，需按 16.1 落实独立账号、目录、端口与连接池限额并验证资源占用。"

### 17.2 接受 16.2：测试数口径确认

核实 Glob 结果：原项目 test/ 下为 13 个 .test.mjs（store、config、failover-rules、sina、adapter、catalog、consistency、feed、quotes、rtj、selector、server、calculation），我原文写"14 个"系笔误。67→68 的差异来源以 16.2 给出的 `better-sqlite3-compat.test.mjs` 为准，第 3.2 节的疑问已由作者解答，可消除。

### 17.3 接受 16.3：调用链名单修正（附验证证据）

grep 核查 scripts/ 全部文件的 Store 引用，结果与 16.3 一致：

- scripts/probe.mjs、scripts/verify-live.mjs、scripts/probe-sina-hf.mjs：仅使用 QuoteFeed，无 Store 引用——我原文"均直接构造 Store 或调用其方法"错误，撤回。
- scripts/qa-server.mjs：经 createApp 取 app 后调用 `app.store.setPassword()`，且从 store.mjs import `passwordHash`（纯 crypto 函数，不触库，无需适配；`setPassword` 需适配）。
- scripts/backup.mjs：直接 `new Store()` 并调用 `store.backup()` / `store.close()`，需适配。
- src/server.mjs：数据库调用与启动关闭流程逐项检查。

修正后名单（替代第 6 节我原补充块）：**需适配 = server.mjs 全部路由 + qa-server.mjs 的 setPassword 调用 + backup.mjs；无需改动 = probe.mjs、verify-live.mjs、probe-sina-hf.mjs（但后两者仍纳入 12.2 整体行为验证）+ test/ 全部 13 个测试文件（随 Store 接口 async 化调整）。**

### 17.4 接受 16.4：mysql2 默认已启用 FOUND_ROWS（源码证实）

已核对 mysql2 上游 `lib/connection_config.js`，`getDefaultFlags()` 返回数组第 2 项即 `'FOUND_ROWS'`。我原文"MySQL 默认 affectedRows 返回实际改变行数、saveCatalog 必然误判"的断言对 mysql2 不成立，降级为验证项：

- mysql2 默认连接即启用 CLIENT_FOUND_ROWS，UPDATE 未变更行时 affectedRows 返回匹配行数（=1），`.changes !== 1` 判断可用；
- 但该行为依赖驱动默认 flags，且旧 node-mysql 驱动默认不启用。实施时按 16.4 执行：固定驱动版本，连接选项显式声明 `flags: ['FOUND_ROWS']` 防漂移，并以"更新存在且内容相同的行""更新不存在的行"两个用例固化验证。

### 17.5 接受 16.5：utf8mb4_bin 非字节级等价（PAD SPACE）

确认：MySQL 5.7 全部排序规则均为 PAD SPACE（含 utf8mb4_bin），比较忽略尾部空格，`'HK'` 与 `'HK '` 在唯一索引下冲突；SQLite BINARY 比较则视为不同值。NO PAD 规则（utf8mb4_0900_bin 等）为 MySQL 8 专有，本方案不可用。我原文"显式 utf8mb4_bin 保持原语义"不完整，修正为三选一并验证旧数据：a) 输入层规范化/拒绝含边界空白的标识（需先检查存量重名与引用）；b) VARBINARY 字段保留字节比较语义；c) utf8mb4_bin + 明确接受尾部空格合并语义并写入测试。保留原意见中"必须显式处理大小写比较、禁用默认 _ci"的结论不变。

### 17.6 接受 16.6

无分歧。ON DUPLICATE KEY UPDATE 按唯一键逐条设计、MEDIUMTEXT 配合请求大小限制、DATETIME 方案的会话时区整体验证、预处理参数以集成测试为准——均按 16.6 执行。

### 17.7 接受 16.7：撤回"UPDATE 行锁即可"的表述

复核推演确认 16.7 成立：InnoDB 普通 SELECT 为快照读，两事务可同时读到同一 version 并通过校验；不带版本条件的 UPDATE 即使被行锁串行化，后提交者仍会覆盖前者（lost update）。SQLite 侧不出问题是因为 `BEGIN IMMEDIATE` 在读之前就持有写锁，此前提在 MySQL 侧不存在，我的等价性结论错误。

补充一个核查发现：当前代码中 audit 表 `PRIMARY KEY(version)` 恰好构成第二道防线——两个并发事务算出相同 next.version 时，后者的 audit INSERT 会主键冲突回滚，故实际表现为 ER_DUP_ENTRY（500）而非静默丢失。但这属于结构巧合而非设计保证，且丢失了 409 语义，仍必须按 16.7 方案显式实现（SELECT ... FOR UPDATE 或 `WHERE id=? AND version=?` 条件更新+检查命中），并按其要求以双连接并发用例验收。

### 17.8 修正后的实施共识（汇总，供第 13 节步骤 3/4 直接引用）

1. 驱动：固定 mysql2 版本，连接显式 `flags: ['FOUND_ROWS']`、`charset: 'utf8mb4'`，用两个 affectedRows 用例固化行为（17.4）。
2. 标识比较：在 17.5 的三个方向中定案一个并验证存量数据，禁用默认 _ci（17.5）。
3. 事务：save/saveCatalog 采用 FOR UPDATE 或版本条件更新实现乐观锁，audit PK 仅作兜底不依赖；单连接贯穿事务（17.7 / 第 8 节）。
4. 写入语句：INSERT IGNORE 逐条改为明确冲突语义；时间字段定案 ISO 字符串方案；JSON 大文本列 MEDIUMTEXT（16.6 / 第 7 节补充第 3-5 条）。
5. 改造范围：按 17.3 修正后名单执行，不批量触碰无关脚本。

<!-- end:aigc. -->

## 18. 实施决策定案（2026-10-27，用户确认）

<!-- start:aigc. -->

> **本节由本轮对话 AI 记录，第 3 项经用户 2026-10-27 明确确认，第 1、2、4 项按 17.8 推荐定案。自此本文档无悬置分歧与未决选型。**

1. **标识比较**：定案 17.5 方案 c —— ID/符号类字段 `utf8mb4_bin`，辅以输入边界校验，尾部空格合并语义写入测试固化。依据：业务 ID 均来源于代码与种子数据，不含边界空白的实际风险。
2. **乐观锁**：定案 17.7 方案 b —— `UPDATE settings SET version=version+1 ... WHERE id=1 AND version=?` 条件更新 + 命中检查（FOUND_ROWS 开启下 affectedRows 即匹配行数，0=版本冲突返回 409）。不采用 FOR UPDATE 先锁读。
3. **数据保留**：现有 data/quotes.sqlite 为**测试数据**（用户 2026-10-27 确认），无需 SQLite → MySQL 导入流程；按第 10 节"空库初始化"路径执行，管理员重新初始化，原 SQLite 文件保留不动。
4. **库名/账号**：`gold_quote` / `gold_quote_app`（创建前查重名，冲突时再议并同步更新本文档）。

<!-- end:aigc. -->
