# Gym Pi Foundation · 渐进

围绕个人训练数据运行的健身 Agent：从初始评估生成计划，通过对话记录执行情况，再根据每周反馈调整下一周安排。

项目采用 Pi Agent 运行时，结合跨轮任务状态和周计划工作流，目前处于开发阶段，支持本地部署与自选模型。

## 从一次评估到下一周计划

1. **建立基线**：填写目标、身体信息、训练经验、器械与时间，生成力量、有氧、饮食和恢复建议。
2. **执行与记录**：查看每日安排，记录训练、饮食、身体趋势和恢复情况，通过教练对话调用相关工具。
3. **复盘与调整**：补充本周日程约束，生成下一周草案，查看理由和内容后确认启用。

模型负责理解意图、调用工具和提出策略。训练负荷、能量计算与输入约束由业务规则和 schema 校验处理。周计划草案需要用户确认，评估或日程发生变化后会重新校验。

## Agent 如何工作

对话请求加载用户上下文和会话，路由到对应技能，再由 Pi 运行时驱动模型与工具循环。任务状态用于跨轮衔接，运行记录保存工具执行、停止原因和用量信息。

| 模块       | 职责                                   | 入口                      |
| ---------- | -------------------------------------- | ------------------------- |
| Agent 编排 | 意图路由、技能、上下文、工具、任务状态 | lib/agent/                |
| 健身领域   | 评估、日计划、周策略和计划启用         | lib/fitness/              |
| 模型接入   | 提供商适配与用户模型设置               | lib/llm/                  |
| 交互界面   | 对话、训练记录与计划预览               | app/、components/fitness/ |
| 数据持久化 | PostgreSQL schema、迁移和种子数据      | prisma/                   |

技术栈：Next.js 15、React 19、TypeScript、Tailwind CSS、Prisma 7、PostgreSQL 16、Pi Agent Core。

## 本地运行

需要 **Node.js 22.19+（22.x）**、npm 和 PostgreSQL。以下步骤用 Docker Compose 启动开发数据库。

```bash
# PowerShell 使用 Copy-Item .env.example .env
cp .env.example .env
npm ci
docker compose up -d db
npm run db:migrate
npm run db:seed
npm run dev
```

打开 http://localhost:3030。数据库宿主机端口为 5433，种子账户由 .env 中的 USER_EMAIL 和 USER_PASSWORD 指定。已有数据库升级使用 npm run db:migrate:deploy；不要为升级执行 db:reset。

运行前设置随机 JWT_SECRET 和账户密码，完整配置见 [.env.example](.env.example)。无模型密钥时可设置 LLM_PROVIDER=demo 体验固定示例响应；真实模型表现需另行验证。

## 模型与部署

应用设置支持用户配置模型。Pi Agent 的提供商包括 Anthropic、OpenRouter、DeepSeek、OpenAI、自定义兼容端点与 demo；具体工具调用兼容性以运行时校验为准。

环境变量支持默认 Anthropic、OpenRouter、DeepSeek 或 codex-lb 接入。codex-lb 用于传统 LLM 适配层，不能据此假定 Pi Agent 支持同名提供商。用户自己的模型选择优先于部署默认值。

生产部署使用 docker-compose.prod.yml，设置生产数据库密码与 JWT 密钥，并通过 HTTPS 反向代理访问。训练数据保存在自己的 PostgreSQL 中，模型请求会将必要上下文发送给配置的提供商。用户上传文件位于 uploads/，备份时同时保存数据库和该目录。

## 开发与验证

```bash
npm run db:generate
npm run lint
npm run typecheck
npm test
npm run build
```

数据库集成与 Playwright 测试需要专用数据库，步骤见 [开发说明](CONTRIBUTING.md)。真实模型评测会产生 API 费用；评测结果不能替代真实数据库与界面的集成验证。

## 阅读路线

- [周计划策略](docs/architecture/weekly-planning.md)：模型策略与确定性生成的边界。
- [详细力量计划](docs/architecture/detailed-strength.md)：候选动作、约束和验证。
- [Agent 状态](docs/architecture/agent-status.md)：已实现机制与当前限制。
- [文档导航](docs/README.md)：使用指南、开发设计和评测记录。

## 许可

代码遵循 [MIT 许可证](LICENSE)，保留原版权声明。动作媒体的来源和许可见 [媒体说明](public/exercise-media/free-exercise-db/README.md)。
