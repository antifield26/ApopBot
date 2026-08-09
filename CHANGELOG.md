# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
**版本单一来源 = package.json**（`node scripts/release.mjs [patch|minor|major]` bump，check:compat 交叉校验 package.json ↔ lockfile）。

## [Unreleased]

- **L2 预设切换 DeepSeek**：`l2.model` 默认 `deepseek-v4-flash`、`l2.cloudBaseUrl` 默认 `https://api.deepseek.com/anthropic`（Anthropic 兼容端点——裸域名补全会落到 OpenAI 路由 404）；新增 `l2.thinking`（默认 `disabled`：显式发 `thinking:{type:"disabled"}` 且**不传 reasoning_effort**——DeepSeek 端点将两者视为互斥 400）/ `l2.effort`（默认 `low`，`thinking: enabled` 时注入 `reasoning_effort`）。ENV_MAP 新增 `MCBOT_L2_THINKING`/`MCBOT_L2_EFFORT`；l2 白名单同步扩展，向后兼容

## [1.0.0] - 2026-08-09

v1.0.0 革命性重构（第七轮）：依赖供应链根治 + LLM 直接操作协议 + 任务脚本化统一执行层 + 持久化/版本化/可观测性。

### 破坏性变更（Breaking）

- **移除本地 provider**：Ollama/auto 删除，L2 仅云端 Anthropic 兼容 API（non-reasoning 模式）——配置残留 `provider`/`ollama*` 键启动即报错（l2 键白名单契约冻结）
- **LLM 直接操作协议**：20 个固定技能 → 28 个动作原语（`src/core/primitives.js`）；工具集 = act（动作数组 ≤8）+ 观察/回复；提示词重写为行动协议（观测优先/行动-观察循环/异常恢复）——彻底打破「提示词→固定技能」映射
- **任务脚本化**：8 个任务全部重写为动作原语脚本（`src/tasks/scripts/*.js`），与 LLM act 共用执行层（`core/executor.js`）；BaseTask 状态机外壳保留（暂停/恢复/取消/调度/防重叠不变）；旧任务类文件删除
- **依赖供应链**：mineflayer/protocol 切官方 npm + patch-package 补丁承载 26.1.2 适配（零 git 依赖、CI 删 git+ssh hack、audit 正常）；`allow-git` 移除
- **持久化/版本化**：state.json schemaVersion 2 + 迁移器（未来版本拒绝加载）；会话记忆落盘（data/sessions.json）；经验记忆库（data/experience.json）；配置契约 `CONFIG_SCHEMA_VERSION=2`
- **动作审计**：logs/audit.log JSONL 全量动作记录（LLM/脚本/命令统一挂点）

### 已添加
- 动作原语层：观察族（observe_*/query_map/map_status）/ 移动 / 构建（collect_blocks/plant_crops）/ 战斗（attack targetGone）/ 交互 / 物品 / 流程 / 任务管理（start_task/stop_task）
- 脚本 DSL：loop/if/break/continue/return/count + 条件六型（last/result/counter/config/deadline/not）+ 模板求值（$引用/${options}/{expr}）+ 任务局部 op（explore 螺旋）
- 反思与经验记忆：动作失败 → LLM 一句话总结教训 → 跨会话注入提示词
- 动作审计日志（JSONL 按天轮转，args/result 截断，来源 llm|script|act|command）
- 会话/经验/状态三层持久化（原子写 + 防抖 + exit flush + 未来版本拒绝）

### 已修复
- collect_blocks 契约：positions 必须经 blockAt 转 Block（collectblock 读 target.position）；chestLocations Vec3 化
- 脚本模板求值：`${options}` 与 `$引用` 分支顺序（'${x}' 曾被误判为结果引用）；loop max 模板化（'${maxCycles}'）；cond 的 gte/equals 模板化（ref 的 '$last' 是语义标识不解析）
- 冷却语义回归：移回原语 handler「只对实际执行生效」（业务性校验失败不占）
- follow_player off 不受 exclusive 限制（C3 回归）

## [Unreleased]

### 已添加
- 任务类型单一注册表 `src/tasks/types.js`（工厂 + 自然完成语义单点定义，替代三处手工同步）
- 版本管理流程：`release.mjs`（package.json 单一来源 + lockfile 双处同步 + git 命令提示）、CHANGELOG
- GitHub Actions CI（Node 24/26 × Ubuntu + Windows：npm ci → 测试 → check:compat）
- 云端分层提示词（`l2.cloudMaxContextWindow` 默认 65536：cloud 发核心+扩展层，Ollama 只发核心层）
- `scheduleTimezone` IANA 时区名校验（Windows 控制面板时区名启动即报错，不再静默不调度）

### 已修复
- core→l2 上向引用（实体遍历/资源白名单归位 `core/{entities,resources}.js`）
- 幽灵依赖声明：vec3 / minecraft-protocol 显式声明
- Windows：SIGBREAK 优雅退出 + NSSM 停止窗口对齐（`AppStopMethodConsole 20s`）
- deploy.ps1：依赖哈希门控恒失效（每次部署重跑 npm ci）、service.env 非 ASCII 值 ANSI 乱码、无 `=` 格式校验
- state.json 非原子写 → tmp+rename
- smoke.mjs 默认配置路径 CWD 相对 → ROOT 解析

## [0.2.0] - 2026-08-09

前五轮评估（L2 深度控制 / L2 进化 / 第四轮 / 第三轮 / 第二轮）成果归纳：

### 已添加
- **L2 完整控制面**：20 个技能（查询/移动/挖掘/放置/攻击/跟随/探索/任务管理）+ 会话记忆（LRU 32）+ 环境感知自动注入 + 探索记忆（DiscoveryMap 持久化）
- **L2 双 Provider**：云端 Anthropic API + 本地 Ollama（native /api/chat + 上下文预算裁剪，超窗不再静默截断）
- **主动播报**：死亡/任务终态 LLM 一句话总结 + 玩家上线模板问候
- **任务系统 8 种**：挖矿/钓鱼/AFK/种植/伐木/战斗/养殖/螺旋探索 + cron 调度 + 移动权仲裁器
- **生产设施**：webhook 运维通知、/health /metrics 只读端点、状态快照持久化（U1）、统一移动层

### 已修复
- 26.1 协议门控 bug（use_entity 缺 location 序列化 Sizeof error → 攻击/喂食断线）——entity-actions 原始包
- bot.entities 为 Map 的下标访问恒空（nearby_entities/attack 恒空/未发出）
- 断线类（goto 挂死/微任务饿死/漂浮 rejection）、§ 颜色码被 Paper 踢出
- 仲裁器 owner 泄漏、exclusive 任务挂死、进程退出状态丢失
