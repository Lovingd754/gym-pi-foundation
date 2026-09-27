# 开发说明

环境准备与启动见 [README](README.md)。使用 npm 和 Node.js 22.19+（22.x）。

## 修改约定

- 保留 TypeScript strict，API 输入使用 Zod 校验。
- 数据查询和写入按用户隔离，模型输出在写入前校验。
- 计划草案与正式启用分开，保留用户确认和过期检查。
- 复用 components/ui/，界面文案放入 messages/。
- schema 改动提交迁移文件，升级已有数据库不要使用 reset。
- 不提交 .env、密钥、上传文件、构建产物或个人数据。

提交前运行 Prisma generate、lint、typecheck、单元测试和 production build。Bash 环境也可执行 bash scripts/verify.sh。

照片存储测试依赖 Unix 文件权限和符号链接行为；Windows 本机可能因路径分隔符、权限模式或符号链接权限失败，完整验证请使用 Linux 环境（CI 使用 Ubuntu）。

## 数据库集成与端到端测试

```bash
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://gympi_test:gympi_test@localhost:5434/gympi_test npx prisma migrate deploy
npm run test:integration
npm run build
npm run test:e2e
```

PowerShell 中使用 $env:DATABASE_URL='postgresql://gympi_test:gympi_test@localhost:5434/gympi_test'，然后分别执行迁移和 npx vitest run --config vitest.integration.config.ts；结束后使用 Remove-Item Env:DATABASE_URL 清除该临时变量。

测试只能指向独立测试库。CI 保留质量检查、数据库集成、构建与端到端验证。
