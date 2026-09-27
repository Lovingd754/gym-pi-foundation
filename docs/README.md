# 文档导航

| 目录                           | 内容                             |
| ------------------------------ | -------------------------------- |
| [architecture/](architecture/) | Agent 机制、周策略与详细力量计划 |
| [guides/](guides/)             | ChatGPT / MCP 连接说明           |
| [evals/](evals/)               | 模型评测、成本记录与失败样本     |
| [development/](development/)   | Agent 设计与实施计划             |

建议先读 [周计划](architecture/weekly-planning.md) 与 [Agent 状态](architecture/agent-status.md)。历史计划中的路径及未实现条目不应作为当前运行说明；安装、启动和验证以根目录 README 与 CONTRIBUTING 为准。

评测脚本位于 scripts/\*eval.ts，配置为 vitest.agent-eval.config.ts。真实模型评测需要配置密钥并产生调用费用；不要上传凭据或个人训练数据。
