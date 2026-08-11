# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
**版本单一来源 = package.json**（`node scripts/release.mjs [patch|minor|major]` bump，check:compat 交叉校验 package.json ↔ lockfile）。

## [1.1.0] - 2026-08-11

- **第 13 轮：Bot 功能扩展 + LLM 能力深化（全档实施，见 docs/roadmap.md）**：
  - **LLM 深化（A1-A7）**：目标记忆（sessions v2：goal+plan 跨会话持久化，`!agent goal` 查看/设置/清除 + set_goal 原语）；对话滚动摘要（历史超限 LLM 压缩替代硬丢——"继续"不再断片）；检索式经验（按失败 op 匹配注入 ≤3 条 + 同教训去重合并计数）；退化状态自动注入（低血/饥饿/背包满/工具将坏，正常零成本）；observe_tasks 任务状态感知原语（注册即进工具集）；世界事件被动感知（被攻击/低血/背包满/稀有收集 → 下次对话注入）；命名地点（!home set/list/remove + set_place/remove_place 原语 + query_map place 分支，带维度）
  - **Bot 扩展（B1/B2/B4/B5+B6）**：仓库管理（`storage.chests` 配置 + store_items/fetch_items 原语 + autoDeposit 优先配置仓库）；工具耐久管理（挖掘前自动换最优工具——材料等级排序 + 将坏替换）+ combat 护甲自动装备（armorManager）；farm 作物扩展（甘蔗/南瓜/西瓜/甜浆果/可可——三种成熟判定：age/高度/果实块，四种种植模式）；sleep 原语（天黑找床睡觉，sleepAtNight 可选）+ harvest_animals（剪羊毛/捡掉落物）
  - **修复**：follow 前方岩浆防御；durationMinutes 条目级校验；observe_blocks 三选一互斥；未闭合引号文案修正；SIGHUP 与 shutdown 交错守卫；webhook fetch body 消费；auditCommand 耗时记录；reconnect 关键词精确化；entities null 距离过滤；start_task init 完成信号（轮询）；connection 手动断开期迟到错误守卫；移动卡住诊断日志（周围方块/手持/落地态——issue #1 排查数据）；LLM 文案进 webhook（死亡/任务终态）
- **注释与文档规范化（第 12 轮）**：代码注释统一为"当前代码的意图/契约/边界"（现在时态）——清除全部轮次标记（`（第 N 轮）`/`（C\d+）`/`（U\d+）` 等 262 处）与历史修复叙事；历史变更统一由 CHANGELOG/roadmap 承载。规范约定写入 docs/architecture.md「注释与文档约定」节
- **第 11 轮全面评估（5 HIGH + 20 MEDIUM + 重构 + 4 扩展主题，见 docs/roadmap.md）**：
  - **5 个确认缺陷修复**：combat 冻结 options 写 weaponName 抛 TypeError（config 装载的 combat 永不运行——BaseTask 浅复制根治 + 防未来脚本再犯）；combat maxTargets 默认 0 失效首杀即完成（evalCond config 型回退 defaultOptions）；config.example.json 过不了自身校验（l2._comment 豁免 + config.test 防漂移断言）；spawn 先于插件装载时 ctx.plugins 陈旧（onPluginsReady 补发回调）；notifier 按值捕获 reload 后 webhook 变更失效（事件时实时取值）
  - **完善 20 项**：fish caught 计数虚高（超时也 +1）/abort 监听器泄漏、审计日志多写者竞争（进程级共享单例）、plant_crops 按 cropTypes 匹配种子、collect 失败批次实采复核、mine 动作级互斥（非 exclusive 任务不 bypass 守卫）、工具调用上限 4 与提示词契约对齐（超限回填失败结果）、baseUrl `/v1` 双路径、goto/explore_step abort 贯通、云端抖动重试（429/5xx ≤2 次退避）、会话 calls 活引用拷贝、query_map 大小写归一、blockUpdate 坐标索引 O(1) 判空、http-status EADDRINUSE 可恢复、日志热重载仅 level 变化不重建 transport、deathPaused promise 化（快速重生服竞态）、respawn:false 显式（mineflayer 默认 respawn:true 此前双发）、parser JSON 转义引号
  - **工程**：mineflayer-pathfinder 补丁哨兵门禁（4/4）、blockUpdate/挖除即删接线测试、3 处空断言清理、cron 测试 pollUntil 去 flaky、CI 加部署模式（--omit=dev）job
  - **重构**：_isArea 5 份消重（tasks/util.js）、三处落盘样板提取 createDebouncedFileStore（sessions/experience/state，exit 单次注册）
  - **扩展**：**维度感知**（DiscoveryMap 记录带维度——下界/末地坐标独立，query_map 按维度过滤，快照往返保留）；**记忆被动积累**（observe_blocks 观察即记录，LLM 探索不再依赖 explore 任务）；**任务链**（任务条目 `next: {id,type,options?}`——自然完成后自动接力）；**自动存储**（collect NoChests 时附近找箱子/木桶存入再继续，替代 5 分钟干等）；**R3 落地**（任务长 idle LLM 播报——waitingReason 持续 10 分钟经 summarize 一句话解释；连续重连 ≥3 次 webhook 告警）
- **地形记忆失效三管齐下（第 10 轮，commit 67857a5）**：探索记忆（DiscoveryMap）此前只增不减（仅 explore 的 recordResource 写入、永不删除）——dig 挖掉/玩家改动的方块长期残留，query_map 返回过期坐标误导 LLM/玩家（用户实测误判 find 技能失效的根因）。三管齐下：**A 挖除即删**（dig/collect_blocks 成功后 `removeResourceAt`）；**B blockUpdate 监听**（方块变化→该坐标记忆删除，覆盖玩家/环境改动）；**C 查询验证**（query_map 返回前逐条 blockAt 核对——已加载且仍是该方块 → `verified:true`；已加载但不是 → **自动删除（记忆自愈）**；未加载 → `verified:false`，LLM 提示词说明需 observe_block 确认后行动）
- **爬升卡住彻底根治（第 9 轮，三机制）**：真服务器 packet 级诊断（完整 C→S/S→C 时间线）确认三条独立根因链并全部修复——
  - **float32 上报精度 → 贴墙拉回循环**（commit 511a170，最主要）：本地物理贴墙停在 `minX = 块 maxX`（double 精确）→ 协议 float32 上报舍入（416.3 → 416.29998779）→ 服务器算的 AABB 与墙块重叠（1.2e-5）→ Paper 位置校验拒绝 → 每 tick 拉回 → bot 钉死。修复：patch prismarine-physics 1.11.1——贴墙截断停在"块面 ± 1e-4"（`F32_EPS`，float32 ulp 3e-5 的安全余量，0.1mm 不可见）且贴墙区完全挡（不渐进）；半嵌位前进/后退**挤回块外脱嵌**（位移 = 嵌入量 ≤0.3 服务器接受）
  - **执行器起跳中停 forward → "半格高悬停"**（commit 511a170）：pathfinder 执行器每 tick 判 `canWalkJump`，bot 起跳中（onGround=false）模拟必然失败 → else 分支停 forward → bot 起跳后失去前进 → 反复原地跳。修复：patch mineflayer-pathfinder 2.4.5——else 分支保留 forward（本地物理挡在障碍前），只停 jump
  - **半嵌穿墙**（commit cf3834c）：本地 computeOffsetX/Z 允许半嵌位水平穿墙 → 服务器拒绝 → 拉回。修复：patch prismarine-physics——半嵌位水平移动挤回
  - 验证：follow 隔墙自行跳墙跟随 / goto 1 格高台目标 / 贴墙——全部 0 拉回（此前每 tick 拉回钉死、半格高悬停）；`patches/` 增至 4 个（minecraft-protocol / mineflayer / mineflayer-pathfinder / prismarine-physics），check:compat 哨兵门禁同步
  - 剩余已知边缘：跨台后偶发完全静止（疑似半嵌深 >0.3 挤回超限或树叶数据不一致，见 GitHub issue #1）
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

### 已添加（v1.0.0 前夕沉淀，随 1.0.0 发布）
- 任务类型单一注册表 `src/tasks/types.js`（工厂 + 自然完成语义单点定义，替代三处手工同步）
- 版本管理流程：`release.mjs`（package.json 单一来源 + lockfile 双处同步 + git 命令提示）、CHANGELOG
- GitHub Actions CI（Node 24/26 × Ubuntu + Windows：npm ci → 测试 → check:compat）
- 云端分层提示词（`l2.cloudMaxContextWindow` 默认 65536：cloud 发核心+扩展层，Ollama 只发核心层）
- `scheduleTimezone` IANA 时区名校验（Windows 控制面板时区名启动即报错，不再静默不调度）

### 已修复（v1.0.0 前夕沉淀）
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
