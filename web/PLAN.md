# 当前确认的实现方案

根据最新需求，Web 版继续使用数据库，不采用 IndexedDB 或无状态凭证 Key。

- Next.js 静态导出、Tailwind 和 Impeccable 控制台样式；管理调用使用 tRPC。
- Hono 提供管理接口及三种 `/v1` 网关协议。
- 数据访问使用 Drizzle ORM 的表定义、查询构造器和参数绑定；D1 迁移使用版本化 SQL。
- Cloudflare Workers 通过 `DB` 原生绑定访问 D1；Vercel Node Function 通过服务端 D1 API Token 访问 D1。两种后端各自运行。
- 使用已有 D1 `workbody`，ID 为 `7461d978-362a-4418-ae6b-071757d61bb2`。原生绑定已写入 Wrangler；HTTP 方式通过 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN` 配置，优先使用存在的 `DB` 绑定。
- 首次初始化创建 `admin` / `admin123`，随机盐密码哈希保存在数据库，初始化不覆盖已有哈希。
- 安全设置提供修改密码：验证当前密码、确认新密码、更新哈希并使全部旧会话失效。
- 使用 pnpm、固定锁文件及 Vitest；默认登录和修改密码按 HTTP/tRPC 边界先失败再实现，其他既有测试作为回归。
- 自动签到和定时执行仍不实施。

验收：pnpm 冻结锁文件安装、类型检查、Vitest、Next 生产构建、Worker 打包，以及本地 D1 的默认登录和密码存储验证。真实云端部署需要使用用户自己的 Cloudflare/Vercel 配置；本轮不执行生产部署。
