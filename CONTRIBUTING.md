# Contributing to KineWeave

KineWeave 目前处于基础能力与创作工作流快速演进期。仓库当前版本是代码、工程格式和测试 Fixture 的唯一事实来源；如果设计改变，请直接修改当前 Schema、实现、全部调用方和 Golden，不增加只服务旧开发数据的兼容层。

## 开发流程

1. 使用 Node.js 22+ 与仓库声明的 pnpm 版本执行 `pnpm install`。
2. 修改前先确认领域语义由哪一个共享服务拥有；CLI、Studio 和测试不得复制 Project、History、Evaluation 或 Render 规则。
3. 为行为变化补充最靠近契约的单元测试；跨格式/求值/Renderer 的变化同时更新 Golden 或 Conformance。
4. 使用 `pnpm quality` 做快速静态检查。完整的 `pnpm check`、`pnpm test:e2e` 和性能工作负载由 GitHub CI 提供权威结果。
5. 生成文件只通过对应命令更新：Schema Validator 使用 `pnpm generate:schema-validators`，Golden 使用 `pnpm generate:goldens`。

## 提交边界

- 一个提交应表达可解释的领域或工程意图，并包含使该意图成立的测试和文档。
- 不提交 `dist/`、Coverage、E2E 临时工程或 Benchmark Report。
- 不手改 `src/generated/`、`examples/golden/**/expected/` 或 Golden History；修改它们的生成源并重新生成。
- 新依赖必须说明属于运行时还是开发工具，并使用精确版本或 `workspace:*`。
- 安全、数据持久化和正常关闭失败不得降级为静默日志。

更完整的门禁与 Fixture 约定见 [持续质量策略](docs/testing/quality-strategy.md)，架构施工原则见 [Foundation Blueprint](docs/architecture/foundation-blueprint.md)。
