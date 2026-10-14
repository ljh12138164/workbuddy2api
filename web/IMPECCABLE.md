# Impeccable 调研与界面优化

核对日期：2026-10-14。来源：作者仓库 `pbakaus/impeccable`，核对时 main 提交 `2f98774f86bc05563876643db37e6c37c322850f`。

## 它是什么

Impeccable 是给 AI 编程 agent 使用的前端设计技能与工具集，**不是 Tailwind 组件库**。README 介绍一项技能、24 个设计命令、浏览器内视觉迭代及 59 条确定性检测规则；技能文件标注版本 4.5.2，覆盖界面设计、可访问性、响应式、性能和错误状态等工作。[作者 README](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/README.md)、[作者 SKILL.md](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/SKILL.md)

它适合指导 agent 编写 Next.js + Tailwind 界面，不能替代 Next.js、Tailwind、tRPC 或 Hono。技能文档把后台、设置页等归为 Operate 模式，强调任务完成、可扫描性、一致性和实际使用场景；“The brief wins” 要求遵从用户明确的设计要求。[作者技能模式与设计原则](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/SKILL.md)

## 与本次迁移的适配

用户最新要求明确进行样式优化。本次直接读取作者的 `SKILL.md` 及 `reference/craft-floor.md`、`reference/operate.md`、`reference/polish.md`，按 Operate 模式重做管理界面，使用 Next.js + Tailwind 实现。

以下命令用途作为后续维护参考，本次未通过命令行执行它们：

| 命令 | 官方用途 | 本项目适用阶段 |
| --- | --- | --- |
| `audit` | 检查可访问性、性能和响应式质量 | 功能迁移完成后的质量检查 |
| `harden` | 改善错误处理、国际化、文本溢出及边界状态 | 功能验收后的界面健壮性专项 |
| `polish` | 发布前质量整理和设计体系对齐 | 用户要求视觉完善时 |

来源：[作者命令表](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/SKILL.md#commands)、[README 命令说明](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/README.md#24-commands)。

尝试执行技能规定的 `context --target web/app/page.tsx` 时，本地缺少 `.agents/skills/impeccable/scripts/impeccable.cmd`。按技能允许的退路读取现有应用上下文继续实施，没有安装 hooks，也没有声称自动设计检查已通过。它属于开发指导，不是应用运行时依赖。[作者安装及使用说明](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/README.md#installation)、[技能说明](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/SKILL.md)

## 已应用的设计规范

- 深色固定侧栏和浅色工作区，窄屏改为横向滚动导航；明确区分页面标题、统计、地址和具体操作。
- 绿色主操作、统一的间距与控件尺寸，表格数字对齐，状态使用文字和颜色共同表达。
- 账号列表优先展示，导入及手机号登录表单按需展开；视觉顺序与键盘顺序一致。
- 登录页使用双栏布局，手机端保留精简表单；输入框保留明确标签及浏览器自动填充属性。
- 模型选择、手动任务、日志和空状态统一处理；任务列表优先显示可读信息，原始接口结果可展开。
- 使用真实统计数据，保留加载、失败、成功和禁用状态；可见键盘焦点与减少动画偏好支持。

自动签到仍未实施。视觉验证使用本地 Worker 和空数据库，不添加虚构账号或统计值。
