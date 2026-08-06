# 项目路线图（2026-08-06 第二轮全面评估）

第二轮评估（3 Explore + 1 Plan + 逐项复核）产出的三档路线图。完善档（P0/P1/高价值 P2）与升级档（U1/U2/U3/U4+U5）已于 2026-08-06 全部实施；本文档记录已完成项、缓做项与明确不做项。

## 已完成（2026-08-06，commit 9de9070..5423cb8）

### 测试安全网（阶段 0）
- 6 类任务 run 主循环 stub 测试（此前只测 init）、signals、plugins-loader、内置命令 handler 零覆盖补齐（172→213 项）
- **抓出 3 个生产缺陷**（随批修复）：
  - combat/breed：`undefined < maxTargets` 恒 false → 配置上限的任务第一轮即"完成"永不执行（`?? 0`）
  - farm：`it.name in 作物映射表` 永远 false（key=作物名，库存物品名是种子名）→ farm 永不种植（改查 values）
  - signals：`conn?.disconnect()` 空对象 TypeError + catch 缺 return 双 exit

### 完善档（批 A + 批 B）
- **P0** spawn 超时竞态：监听注册移入 `_wireEvents`（插件装载 await 前），消除"本机快速握手 → 60s 误杀正常 bot → 重连循环"
- **P1 ×8**：disconnect 残留清理、断线期 teardown 空转、logger 热重载分流、fish stop 10s 阻塞（取消信号 race）、manager load 互斥失效、reload 排队泄漏、顶层 `_comment` 必挂、follow_player 假成功
- **P2 ×8 组**：断线分类失真、ENV_MAP 补全、类型表一致性断言、farm 扫描 findBlocks（1600 次/cycle → 一次查询）、命令排队反馈、_lastDispatch 泄漏上限、截断常量/插件依赖校验/死代码、config.json 回退 + 文档漂移 5 处、uptime 失真

### 升级档（U1-U5 全部）
- **U2 L2 会话记忆**：按玩家多轮上下文（模块级，跨重连/热重载保留），`!agent reset`
- **U3 HTTP 状态端点**：`/health` `/metrics`（127.0.0.1 只读，默认关，零新依赖）
- **U4 farm 性能**：见批 B4
- **U5 LLM 重试 + 计量**：Ollama 网络错误单次重试（2s 退避，4xx/Abort 不重试）；usage/latency 归一化进 /metrics
- **U1 状态快照**：data/state.json（ad-hoc 任务 + 计数器跨 restart 保留，5s 防抖 + 退出 flush；不做现场恢复）

## 缓做（有测试兜底后）

### R1 任务类型单一来源（1 天内）
manager.js `TASK_TYPES` + config.js `KNOWN_TASK_TYPES` + `NATURAL_COMPLETION_TYPES` 三处手工同步（目前靠一致性断言测试防漂移）。改法：`src/tasks/types.js` 导出 `{ name → { factory, naturalCompletion } }`，两处导入；`run_task` 技能的类型提示从注册表生成。风险低（纯搬移）。

### R2 任务公共代码消重（需阶段 0 测试网之后）
- `_cancel` 三份重复（mine/farm/chop 的 collectBlock.cancelTask + pathfinder.stop）
- NoChests 处理 + collect 重试三处重复（可提 `collectWithChestFallback`）
- `_isArea` 四份重复（chop/combat/breed/farm → BaseTask 方法或 tasks/util.js）
- breed._approach 手写轮询不响应 pause（改 `_internalWait` 模式）
- 风险中：重试超时/文案/计数语义有细微差异，无测试重构是事故高发区——阶段 0 已补 run 主循环测试，可做

## 明确不做（及理由）

| 项 | 理由 |
|---|---|
| 多 bot 同进程 | ctx 单例贯穿编排层（feature-layer/commands/l2 闭包 ctx），结构性重写；8GB 机同进程双 bot 内存/CPU 不值。真多 bot 正解 = 第二进程/第二台机（配置/脚本已支持不同 username） |
| Web 管理面板 | 零新依赖约束下成本高于收益；U3 端点 + PowerShell/NSSM 已覆盖运维闭环 |
| L2 流式输出 | 10-30 tok/s 下流式只省首包时延，需改双 provider 协议解析与 chat 接口，收益/复杂度不成比例 |
| NSSM stdout 轮转 | 业务日志已 pino-roll 按天轮转（keepDays 14），stdout 仅兜底 |
| 依赖链另起升级路径 | overrides + check-compat 门禁闭环已锁死；任何上游升级走现有 `migrate-upstream`（见 docs/upstream-migration.md） |
| 运行时任务现场恢复 | mineflayer 无可靠状态导出，8GB 机不值得；U1 只保"配置即真相 + 遥测不丢" |

## 维护提示

- 加新任务类型：改 manager.js TASK_TYPES + config.js 两表（一致性测试会拦漏改）
- L2 API key 只走环境变量（l2.cloudApiKeyEnv → config/service.env → NSSM AppEnvironmentExtra），绝不进配置文件/日志；轮换后同步 service.env
- follow 插件装载在连接期，`mineflayerPlugins` 改动需 `nssm restart`（热重载不重装插件）
- 上游合并后：`npm run migrate-upstream`（自动改 pin + 同步 check-compat + 测试），部署机 smoke 人工验收
