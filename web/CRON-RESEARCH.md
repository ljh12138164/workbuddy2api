# Vercel / Cloudflare 定时签到调研

核对日期：2026-10-14。平台事实仅采用官方文档；迁移建议另行标明。此轮未请求真实账号的签到接口、未部署。

后续范围更新：用户明确暂不实现自动签到。本文保留调研记录；当前 Web 版本未配置 Cron 或任何自动签到入口。

## 结论

两平台均支持定时触发签到业务。Vercel Hobby 适合每天一次、允许一小时触发窗口的小账号池；Cloudflare 能更频繁唤醒业务服务，为当天失败账号安排应用层补偿。能调度不等于保证签到成功：设备风控令牌、上游活动有效期、资格和认证状态仍须验证。

迁移采用用户选定的 Next.js 前端、Hono API、tRPC 管理调用。未来若恢复自动签到，可让平台 Cron 入口和管理界面的手动补跑调用共用业务服务；当前没有实现这部分定时业务。

## Vercel 官方事实

| 套餐 | Cron 数量 | 每条任务最短间隔 | 触发精度 |
| --- | --- | --- | --- |
| Hobby | 每项目 100 条 | 每日一次 | 指定小时内触发 |
| Pro | 每项目 100 条 | 每分钟一次 | 分钟级 |
| Enterprise | 每项目 100 条 | 每分钟一次 | 分钟级 |

例如 `0 1 * * *` 在 Hobby 上会于 UTC 01:00–01:59 触发。高于每日一次的表达式会导致 Hobby 部署失败。Cron 本身包含于套餐，函数执行仍受用量及计费规则约束。[官方用量和套餐](https://vercel.com/docs/cron-jobs/usage-and-pricing)

Vercel 向生产部署 URL 的配置路径发出 HTTP GET；表达式使用 UTC。生产任务配置与本地手动调用须分开理解，预览环境不作为自动签到环境。[官方 Cron 工作方式](https://vercel.com/docs/cron-jobs)

设置 `CRON_SECRET` 后，平台自动附加 `Authorization: Bearer <secret>`；入口必须校验且缺少密钥时拒绝。执行失败不会自动重试；投递为 best effort，可能漏触发，也可能重复触发，并可能发生并行执行。需持久化锁和幂等记录；本地开发服务器不自动执行 Cron，可手动请求入口测试。[官方任务管理](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

启用 Fluid Compute 的 Node.js / Bun / Python 函数默认最长 300 秒：Hobby 上限 300 秒，Pro / Enterprise 常规上限 800 秒。1800 秒扩展上限为 Beta，要求指定运行时版本及函数级配置，且有 Secure Compute / Static IPs 限制。`maxDuration` 衡量调用经过时间，包含请求处理及响应发送；不能把这些数字当作 Cloudflare CPU 配额。[官方函数限制](https://vercel.com/docs/functions/limitations)

**迁移建议：** 默认仅设置一条每日任务；不要利用 100 条任务名额绕过套餐频率限制。Hobby 每日任务失败后，当天补偿需人工补跑、应用内有限重试，或另选可靠调度机制。高频任务用 Pro / Enterprise 或 Cloudflare。

## Cloudflare 官方事实

| 项目 | Workers Free | Workers Paid | 官方来源 |
| --- | --- | --- | --- |
| Cron 数量 | 每账号 5 条 | 每账号 250 条 | [账户限制表](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits) |
| Cron 最短表达式间隔 | 1 分钟 | 1 分钟 | [表达式及每分钟示例](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions) |
| Cron CPU 时间 | 10 ms | 间隔小于 1 小时：30 秒；至少 1 小时：15 分钟 | [CPU 限制](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) |
| Cron wall time | 15 分钟 | 15 分钟 | [按调用类型划分的 wall time](https://developers.cloudflare.com/workers/platform/limits/#wall-time-limits-by-invocation-type) |
| 子请求 | 每调用 50 次 | 每调用 10,000 次 | [账户限制表](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits) |

CPU 是代码实际执行时间，等待 `fetch()` / 数据库等 I/O 不计入；wall time 包含这些等待。Free 的 10 ms 不代表只能发起持续 10 ms 的网络请求，也不能由 15 分钟 wall time 推导有 15 分钟 CPU。[官方 CPU 说明](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

数量口径采用 limits 页明确的 **per account** 表格；Cron 概览页 Limits 段仍有“per Worker”措辞，勿据此按 Worker 累加额度。[官方限制](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits)

Cron 使用 UTC；新增、修改、删除配置传播最多可能耗时 15 分钟。配置一分钟间隔不构成硬实时触发保证。[官方配置说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

入口为 `scheduled(controller, env, ctx)`，`controller.scheduledTime` 是原定触发时刻的 UTC 毫秒数。运行时等待异步 handler 返回的 Promise，单项任务可直接 `await runner()`；`ctx.waitUntil(promise)` 适合登记并发任务，其首个失败会记入 Cron Past Events。两者仍受 Cron 的 15 分钟限制；不要套用 HTTP 响应后最多延长 30 秒的规则。[官方 Scheduled Handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)

**未承诺事项：** 所核对 Cron 文档没有给出生产失败重试次数、退避间隔或 exactly-once 投递保证。文档展示了本地测试返回的 `noRetry` 字段及 `controller.noRetry()`，不足以推导完整生产重试策略。因此不承诺“平台一定重试”“完全不重试”或“绝不重复”；恢复与幂等由业务服务实现。[官方 Cron 本地测试说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)、[官方 Scheduled Handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)

## 可选可靠执行升级

账号池扩大、需要逐账号独立重试时，可由 Cron 将工作发往 Cloudflare Queues。Queues 默认至少一次投递，可能重复，仍需账号日级幂等。[官方投递保证](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

Queues 投递失败默认重试 3 次，可配置 `max_retries`；耗尽后删除消息或转到已配置的死信队列。需显式处理失败，避免把业务失败结果当成功确认。[官方队列重试](https://developers.cloudflare.com/queues/configuration/batching-retries/)

多步骤认证、等待和补偿可考虑 Workflows。`step.do` 默认重试配置为 limit 5、初始延迟 10 秒、指数退避、每次尝试超时 10 分钟；永久错误可用 `NonRetryableError` 停止重试。外部领取副作用仍需幂等核对，工作流不保证上游只执行一次。[官方 Workflow 重试](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)

以上是后续升级选项，首次迁移无需默认引入队列或工作流。

## 现有代码核对

以下为本仓库源码观察，不视为上游签到服务的官方承诺：

- [admin/scheduler.py](../admin/scheduler.py) 通过常驻守护线程每 15 秒扫描数据库；默认签到间隔 1440 分钟；`start_scheduler()` 的锁仅在进程内，无法协调不同 serverless 实例。
- 同文件 `run_daily_checkin()` 遍历 active 账号，查询 `today_checked_in` 后决定是否领取；处理 `stop_after`，遇活动结束置停止时间；结果包含逐账号状态，并写回可能刷新的认证信息。外层总体 `ok: true` 不意味着每账号签到都成功。
- [admin/backend.py](../admin/backend.py) 使用 `/v2/billing/meter/checkin-activity-status` 与 `/v2/billing/meter/daily-checkin`；当前映射 1001 为已领取，1002 为无资格，1003 为活动结束。
- [admin/turing_token.py](../admin/turing_token.py) 和 [turing_helper.js](../turing_helper.js) 从本机 WorkBuddy 的原生 Turing Shield SDK 生成 `X-Device-Token`，涉及 `.node` / DLL 与桌面安装目录；当前缓存时长并不能证明令牌的上游有效期。

## 跨平台迁移建议与验收边界

1. 把日常签到、状态查询、凭证更新和日志收敛到共享 runner。Vercel 的受密钥保护 GET 入口和 Cloudflare 的 `scheduled()` 各自提供存储与时间参数，再直接调用 runner。tRPC 负责管理任务、查询结果和手动执行，无需 Cron 经 HTTP 调用自己。
2. 用数据库原子语句或事务领取 lease，保存 owner、到期时间及完成状态。续租、释放和写完成状态均检查 owner；租约期限覆盖有界执行时间，接近预算时停止开始新账号。不能使用全局变量或进程锁防跨实例并发。跨平台若指向同一账号池，也必须共享该锁和记录。
3. 唯一工作键采用 `(account_id, task, local_date)`，本地日期由任务明确配置的业务时区计算，建议初始 `Asia/Shanghai`。UTC 存计划时间与日志。以实际执行日核对上游“今日”状态，原定日期另记审计字段，避免迟到的昨日任务被当成可补领昨日奖励。
4. 每账号成功或“今日已领”即落库；失败保持当天可补偿。网络超时或响应不明时先查 `today_checked_in` 再判断是否领取。lease 失效后的旧执行者、上游成功而本地写入失败等窗口仍可能重复请求，不能承诺端到端 exactly-once。
5. UTC `0 1 * * *` 对应北京时间每天 09:00；Vercel Hobby 实际窗口为 09:00–09:59。Cloudflare 可每小时唤醒 runner，扫描当天到期且未成功账号作为补偿。每小时扫描无需每小时重复领取已成功账号；不得承诺昨日签到奖励仍可补领。
6. Cloudflare Free 需实测 10 ms CPU 和 50 子请求能否容纳目标批次；Paid 更适合较大账号池。按剩余执行时间控制批量，持久化进度；不能承诺固定可支持账号数量。Vercel 需在 maxDuration 前停止接新账号并保存进度。
7. 保留活动停止时间、资格判断、认证过期和逐账号失败说明。活动结束后停止领取；人工补跑也走同样规则。
8. 云端无法沿现有路径读取用户桌面的原生 SDK。可以设计显式导入设备令牌的能力，但其有效期、设备绑定及更新方式须单独验证；纯 Workers 不能把 `.node` / Windows DLL 直接搬入运行时。不要把仅导入 access token 描述成保证云端签到成功，也不要伪造设备令牌。

迁移后应以模拟上游和持久化存储验证：并发触发只领取一个有效 lease；已成功日期不重复领取；上游已领但本地未知时查询并收敛；跨上海午夜、活动过期、401 / 429 / 超时、执行预算耗尽及租约失效均留下可理解记录。真实账号联调另行进行，当前没有签到成功验证结果。

**当前交付状态：仅完成调研及迁移建议，尚未实现 Next.js / Hono / tRPC 重写、部署按钮或云端签到调度。**
