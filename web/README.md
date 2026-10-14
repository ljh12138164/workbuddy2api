# WorkBuddy Web

Next.js + Tailwind 管理界面、Hono API、tRPC 管理调用、Drizzle ORM 和 Cloudflare D1。使用 pnpm 管理依赖。`web/` 是独立应用，所有源码、依赖、迁移与部署配置都在本目录内。

## 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fljh12138164%2Fworkbuddy2api%2Ftree%2Fmaster%2Fweb&env=ADMIN_JWT_SECRET,DATA_ENCRYPTION_KEY,CLOUDFLARE_ACCOUNT_ID,D1_DATABASE_ID,D1_API_TOKEN&project-name=workbuddy-web&repository-name=workbuddy-web)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fljh12138164%2Fworkbuddy2api%2Ftree%2Fmaster%2Fweb)

按钮从当前 fork 的 `master/web` 读取源码，必须先将本目录推送到该分支。若发布到其他仓库或分支，请同步替换两个按钮的仓库 URL。克隆到新仓库后，本目录会成为新仓库的根目录。仍需登录部署平台并填写自己的密钥。

| 平台 | 前端 | 后端 | 持久化 |
| --- | --- | --- | --- |
| Vercel | Next 静态导出 | Node.js Function / Hono | D1 HTTP API / Drizzle SQLite Proxy |
| Cloudflare | Workers Static Assets | 原生 Worker / Hono | D1 原生绑定 / Drizzle D1 |

两种部署的页面和 API 各自独立运行。按最新要求统一使用 D1，Vercel 需要 Cloudflare 的 D1 数据库及 API Token，调用数据库无需另行部署 Worker。Next 只负责界面，动态请求统一进入 Hono；这里不使用 SSR、Server Actions 或 Next 服务端运行时。[Next 静态导出](https://nextjs.org/docs/app/guides/static-exports)、[D1 HTTP API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/raw/)

### 必填配置

| 名称 | 用途 |
| --- | --- |
| `ADMIN_JWT_SECRET` | 至少 32 字符的随机会话签名密钥 |
| `DATA_ENCRYPTION_KEY` | 至少 32 字符的独立随机凭证加密密钥 |
| `CLOUDFLARE_ACCOUNT_ID` | D1 HTTP 模式：D1 所属 Cloudflare Account ID |
| `D1_DATABASE_ID` | D1 HTTP 模式：数据库 ID，本项目使用 `7461d978-362a-4418-ae6b-071757d61bb2` |
| `D1_API_TOKEN` | D1 HTTP 模式：具备目标账号 D1 编辑权限的 API Token，仅供服务端使用 |

生成密钥（分别执行两次）：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`WORKBUDDY_DEVICE_TOKEN` 可选：填入自己获授权客户端取得的真实设备令牌；云端不会生成原项目依赖本机原生 SDK 的风控令牌。是否必须提供取决于上游风控，不能保证手机号授权或模型调用始终成功。

首次初始化自动创建管理员 **`admin` / `admin123`**。数据库只保存随机盐和 PBKDF2-SHA256 密码哈希，不保存明文密码，重复初始化不会重置已修改的密码。登录后从侧栏进入“安全设置”，校验当前密码并输入两次新密码（至少 8 字符）；保存后所有旧管理会话失效，需要重新登录。

凭证以 AES-GCM 加密写入数据库。修改 `ADMIN_JWT_SECRET` 会使原登录会话失效；修改 `DATA_ENCRYPTION_KEY` 会使旧账号凭证无法解密，需先导出账号备份，再重新导入。不要把 API Token 或任一密钥放进 `NEXT_PUBLIC_*`。

### Vercel

1. 使用已有 D1 数据库 `workbody`（`7461d978-362a-4418-ae6b-071757d61bb2`），取得它所属的 Account ID 和具备 D1 编辑权限的 API Token。其他用户部署时可填写自己的数据库 ID。
2. 点击按钮填写五项配置。若直接导入完整仓库，Root Directory 选择 `web`，Framework Preset 使用 **Other**，构建命令 `pnpm build`，输出目录 `out`；配置已写在 `vercel.json`。
3. 部署后用 `admin` / `admin123` 登录。首次管理请求会自动创建初始数据库表并保存默认管理员的密码哈希。

`api/index.ts` 使用 Vercel 的 Web-standard `fetch` 入口，重写保留 tRPC 的路由及批量参数，流式响应直接返回 Response。函数最长执行 300 秒，网关上游请求最长 250 秒。[Vercel Node 入口](https://vercel.com/docs/functions/runtimes/node-js)

### Cloudflare Workers

1. 点击按钮，确认 build 为 `pnpm build`、deploy 为 `pnpm deploy`，依赖安装使用 `pnpm install --frozen-lockfile`。
2. 填写 `.dev.vars.example` 的两项密钥。`wrangler.jsonc` 已将 `DB` 绑定到已有的 `workbody`（`7461d978-362a-4418-ae6b-071757d61bb2`）；部署账号须有该库访问权限。
3. 部署脚本先发布 Worker，再通过 `DB` 绑定名执行 D1 迁移；登录也会检查初始表是否存在。

如直接关联完整仓库，构建 Root Directory 设为 `web`。其他账号使用一键部署按钮时，需要将 `database_name` 和 `database_id` 改为自己的库；若要让平台自动创建新库，删除 `database_id` 并设置自己的 `database_name`。[Cloudflare 部署按钮与自动资源创建](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

### 通过环境变量连接 D1

Vercel 在项目的服务端环境变量中配置以下三项；也可以在无 `DB` 绑定的 Worker 中配置相同的变量与 secret：

```dotenv
CLOUDFLARE_ACCOUNT_ID=你的Cloudflare账号ID
D1_DATABASE_ID=7461d978-362a-4418-ae6b-071757d61bb2
D1_API_TOKEN=你的D1编辑权限Token
```

仍需提供 `ADMIN_JWT_SECRET` 与 `DATA_ENCRYPTION_KEY`。`D1_API_TOKEN` 应保存在部署平台的 Secret / 服务端环境变量中。数据访问通过 Drizzle ORM 的 D1 HTTP 驱动完成。

如果存在 `env.DB`，优先使用原生绑定；此时上述三个 HTTP 变量不生效。Workers 的 D1 原生绑定不是字符串环境变量，需要在 `wrangler.jsonc` 或控制台 Bindings 中设置；本项目已配置对应名称与 ID。[D1 绑定说明](https://developers.cloudflare.com/d1/get-started/#3-bind-your-worker-to-your-d1-database)

本地开发默认使用模拟 D1，即使配置了生产数据库 ID，也不会写入远程 `workbody`。连接真实 D1 请使用下文的 `pnpm dev:d1`。已创建 D1 API Token 并将三项 HTTP 变量保存在本地忽略的 `.env.local` 与 `.dev.vars` 中；真实 `workbody` 的登录及 ORM 读写已验证。尚未执行生产部署或 Wrangler 远程迁移命令。

### CLI 部署

CLI 部署需要自己的 Cloudflare 登录态，先配置两项 secret：

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put ADMIN_JWT_SECRET
pnpm exec wrangler secret put DATA_ENCRYPTION_KEY
pnpm build
pnpm deploy
```

## 功能与迁移范围

- 数据库管理员登录、密码修改、HttpOnly 会话 Cookie、同源管理操作；修改密码后全部旧会话失效。
- 账号凭证导入 / 批量导入 / 导出、手机号验证码登录、名称和启用状态管理、手动刷新凭证。
- 积分快照与套餐明细、模型目录同步与启停、模型分组。
- API Key 创建 / 停用 / 删除、账号绑定、模型分组绑定、原子请求次数配额、用量和日志。
- `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 的文本、图片和 function 工具转换，支持真正的增量 SSE。
- 手动查询成长任务、领取任务和奖励；完成条件需在官方客户端满足。

自动签到与定时调度本轮不启用：没有 `scheduled` 处理器、Cron 路由或部署任务配置。平台调研保留在 [CRON-RESEARCH.md](CRON-RESEARCH.md)。界面已按 [Impeccable 的 Operate 模式](IMPECCABLE.md)优化，使用 Next.js + Tailwind 实现响应式控制台、登录页和统一的表单、表格与状态反馈。

Web 版覆盖上述网关与管理功能，不是 Python 版所有行为的逐项复刻：本机扫描、拆包、原生设备 SDK、桌面更新、客户端业务事件自动完成成长任务、猫猫旅行和原有 MySQL 数据库迁移未包含。导入账号后请手动同步积分与模型，然后创建 API Key。

Key 配额按**网关受理并分配到账号的请求次数**计数，凭证刷新或上游调用失败也占配额，不等同于原 Python 版按积分收费。每 Key 每分钟最多 60 次、并发最多 4 个；每账号同时最多 1 个请求，通过数据库租约协调多个实例。账号冷却 60 秒后可参与下次请求；同一次请求不自动切号重发，避免重复生成和重复扣费。

积分读取 `/v2/billing/meter/get-user-resource` 中的 credits 套餐快照；不自动同步，不保证包含其他活动接口的数据。`/v1/balance` 返回缓存汇总。日志只保存模型、账号 / Key ID、状态、Token 用量和耗时，不保存提示词或原始上游错误内容。

Responses 使用完整历史输入；不保存 `previous_response_id` 会话，不提供平台托管的 `web_search` 等工具。客户端自行执行 function 工具。新版 `$wbEncrypted` 桌面凭证请先在桌面版导入后导出。Web 数据独立保存，不会读取本地真实账号库。

## 本地运行

需要 Node.js 24 和 pnpm 10.34.5（版本已写入 `packageManager`）。在 `web/` 下：

```sh
pnpm install --frozen-lockfile
```

复制 `.dev.vars.example` 为 `.dev.vars` 并填好两项配置，随后：

```sh
pnpm db:local
pnpm dev
```

打开 Wrangler 输出的地址（默认 `http://localhost:8787`），使用 `admin` / `admin123` 登录。`pnpm dev` 先构建 Next，再启动本地 Worker 与 D1，保持页面和 API 同源。后端改动会热更新；页面改动后先停止 Wrangler，再重新执行 `pnpm dev` 并刷新浏览器（Windows 的静态资源监听会占用 `out` 目录）。`pnpm dev:ui` 仅用于 Next 界面开发，不包含同源 API；完整联调使用 Wrangler。已构建后可用 `pnpm start` 快速启动。

连接真实远程 D1 时，在 `.dev.vars` 中补充 `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`D1_API_TOKEN`，然后运行：

```sh
pnpm dev:d1
```

该命令使用不带 `DB` 绑定的 `wrangler.http.jsonc`，通过环境变量与 Drizzle ORM 访问真实 D1，后台操作会写入远程数据库。Vercel 本地配置保存在 `.env.local`；两份文件均被 Git 忽略。已构建时可直接执行 `pnpm exec wrangler dev --config wrangler.http.jsonc --port 8789`。

## 验证

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:worker
```

测试覆盖默认管理员、密码哈希和盐、重复初始化、修改密码与旧会话失效、加密、账号归属校验、SMS 会话持久化 / 一次性 token、管理认证 / CSRF、配额并发、删除绑定后的隔离、三种协议转换、SSE 分片和中断记账。上游全部使用模拟响应；不自动访问真实账号、发短信或领取奖励。TDD 过程见 [TESTING.md](TESTING.md)。

`/health` 只确认进程可响应，不代表数据库、账号或上游可用。当前未进行真实 Vercel / Cloudflare 生产部署，也未使用真实账号验证上游协议。生产发布后应检查后台登录、导入、模型同步及一次正常模型调用。
