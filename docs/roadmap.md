# 项目路线图（第二轮..第九轮）

第二轮评估（3 Explore + 1 Plan + 逐项复核）的三档路线图 2026-08-06 全部实施；第三轮（26 条发现逐条 verdict）2026-08-07 全部实施；第三轮善后（combat 断线根因）与第四轮（9 项发现全部 CONFIRMED + 1 个代际竞态）2026-08-07 实施；L2 进化（环境感知 + 自由探索）2026-08-07 实施；第五轮（L2 深度控制与易用性，10 项全部 CONFIRMED）2026-08-07 实施；第六轮（工程治理六领域，12 commit）2026-08-09 实施；**第七轮（v1.0.0 革命性重构，12 commit）2026-08-09 实施**；**第八轮（全面审查，约 24 项确认修复）2026-08-09 实施**；**第九轮（爬升卡住彻底根治 + 时间映射修复，cf3834c..511a170）2026-08-10 实施**。本文档记录已完成项、缓做项与明确不做项。

## 第九轮已完成（2026-08-10，爬升卡住彻底根治，cf3834c..511a170）

用户需求：彻底解决 Bot 移动遇 1 格爬升卡住（此前多轮 self-heal 缓解未根治，用户实测"半格高悬停"/"停在爬升点前"）。真服务器 packet 级诊断（完整 C→S/S→C 时间线，7 个临时诊断脚本）确认三条独立根因链：

- **半嵌穿墙 → 服务器拉回**（cf3834c）：本地 prismarine-physics `computeOffsetX/Z` 对"位置与方块重叠"的水平移动不拦截（1.8 移植语义）→ 本地穿墙 → 服务器拒绝 → 拉回 → mineflayer position 处理把 onGround 置 false → 起跳冻结卡死。修复：半嵌位水平移动挤回（patch prismarine-physics 1.11.1）
- **float32 上报精度 → 贴墙拉回循环**（511a170，最主要）：本地物理贴墙停在 `minX = 块 maxX`（double 精确）→ 协议 float32 上报舍入（416.3 → 416.29998779）→ 服务器算的 AABB 与墙块重叠（1.2e-5）→ Paper 位置校验拒绝 → 每 tick 拉回 → bot 钉死（30 tick 拉回 15+ 次实测）。真实玩家贴墙后位移 0（不触发校验）所以没事。修复：贴墙截断停在"块面 ± 1e-4"（F32_EPS）且贴墙区完全挡（不渐进）——否则"钳 0 挡"会让半嵌 bot 死锁（spawn 半嵌位 follow 直接卡死实测）
- **执行器起跳中停 forward → "半格高悬停"**（511a170）：pathfinder 执行器每 tick 判 `canWalkJump`，bot 起跳中（onGround=false）模拟必然失败 → else 分支停 forward → bot 起跳后失去前进 → 反复原地跳。修复：patch mineflayer-pathfinder 2.4.5——else 分支保留 forward，只停 jump

**验证**（真服务器）：follow 隔墙自行跳墙跟随 / pathfinder goto 1 格高台目标 / 贴墙——全部 0 拉回（此前每 tick 拉回钉死、半格高悬停）；全量测试 456 + physics 8 条 + check:compat（4 patch 门禁）全绿。**剩余已知边缘**（GitHub issue #1）：跨台后偶发完全静止（疑似半嵌深 >0.3 挤回超限或树叶数据不一致）待专项；区块未加载致 pathfinder 模拟用空数据（movement.js 注释，patch 未覆盖）。

**关键修复沉淀**：① 本地物理必须与服务器 vanilla 语义一致（穿墙/贴墙/半嵌——否则服务器拉回循环）；② 协议 float32 精度是隐蔽的物理边界（贴墙/挤回必须留 ulp 级余量）；③ 执行器控制状态切换必须考虑"起跳中"（onGround=false 的瞬时态）

## 第七轮已完成（2026-08-09，v1.0.0 革命性重构，12 commit）

用户需求：v1.0.0 正式版——根治 PR 分支依赖 + LLM 直接操作协议（打破「提示词→固定技能」映射）+ 由我设计的更多方面。用户四项决策：patch-package 依赖治理 / 移除本地 provider 仅云端 non-reasoning / 任务系统脚本化重写 / 附加四项全选（反思记忆、审计日志、状态版本化、会话落盘）：

- **C1 依赖根治**：mineflayer 4.37.1 + protocol 1.66.2 + minecraft-data 3.113.0 全切官方 npm，26.1.2 适配以 patches/ 补丁承载（postinstall 自动应用，零 git 依赖——CI 删 git+ssh hack、audit 正常）；check:compat 3.7 补丁哨兵门禁
- **C2 单 provider**：删 Ollama/auto/分层提示词（-624 行）；config 契约冻结（l2 子键白名单，残留 ollama 键启动即报错；CONFIG_SCHEMA_VERSION=2）
- **C3 原语+执行器**：core/primitives.js（28 原语）+ core/executor.js（统一管线：权限/exclusive/校验/冷却/超时/审计）+ core/audit.js（JSONL 按天轮转）；environment.js 归位 core（破 core→l2）
- **C4 act 协议**：工具集 = act（动作数组 ≤8）+ 观察/回复；CORE_SYSTEM_PROMPT 重写为行动协议；删 skills.js（-548 行净删）
- **C5 持久化**：sessions.js 会话落盘 + state.js schemaVersion 2 + 迁移器（未来版本拒绝加载）+ 命令层审计挂点
- **C6-C10 任务脚本化**：runner.js（ScriptTask + ScriptRunner——BaseTask 状态机外壳保留，DSL：loop/if/break/continue/return/count + 条件六型 + 模板求值 + 任务局部 op）；8 个任务全部重写为 scripts/*.js，旧类文件删除；任务与 LLM act 共用执行层
- **C11 反思与经验记忆**：experience.js（失败→一句话总结→跨会话注入 system）
- **C12 发布收口**：CHANGELOG 1.0.0（Breaking 清单）+ docs 全面更新 + tag v1.0.0

**关键修复沉淀**：collect_blocks 契约（positions 转 Block/chestLocations Vec3）；${options} 与 $引用分支顺序；loop max 模板化；cond 的 gte/equals 模板化（ref 的 '$last' 不解析）；validateParams 联合 type；冷却移回原语 handler（只对实际执行生效）；follow_player off 不受 exclusive 限制；脚本动作软失败语义 + maxActions 死循环兜底

## 第六轮已完成（2026-08-09，c55fa6e..115e5d9 共 12 commit）

用户需求：探索/理解/评估/规划 + 方案覆盖六领域（依赖治理 / Windows 兼容 / 结构规范化 / CI / 版本管理 / LLM 深化）。3 Explore + 1 Plan（对抗性核验修正 10 项事实）+ 用户决策（LLM 提示词按 provider 分层；版本管理做 CHANGELOG + 流程）：

- **C1 依赖治理**：幽灵依赖 vec3/minecraft-protocol 显式声明（vec3 是 mineflayer 传递依赖 hoist 顶层——运气性可用）；axios 0.21.4 评估后文档化接受（覆盖有破坏 prismarine-auth 风险，offline 不触达）
- **C2 结构**：core→l2 上向引用破除——nearbyEntities/资源白名单归位 `core/{entities,resources}.js`（scanEntities 依赖 l2 是历史归位错误）
- **C3 结构（R1 缓做项）**：任务类型单一注册表 `src/tasks/types.js`（factory + naturalCompletion 单点，config 派生键集，run_task 提示从注册表生成）
- **C4 版本管理**：CHANGELOG.md（Keep a Changelog）+ scripts/release.mjs（package.json 单一来源 + lockfile 双处同步 + git 命令只打印不执行）+ check:compat 3.6 改交叉校验 + docs/l2.md 版本硬编码消除
- **C5 Windows**：SIGBREAK 优雅退出（NSSM Ctrl+C 超时后发 CTRL_BREAK 不再硬杀）+ AppStopMethodConsole 10s→20s（覆盖 15s 优雅预算，两处互引声明不变量）
- **C6 Windows**：deploy.ps1 三连——哈希门控恒失效（Set-Content 尾换行 vs -Raw 含尾换行 → 每次重跑 npm ci；改 WriteAllText 无尾换行 + 读取归一）、service.env UTF8 读取 + KEY=VALUE 校验 + 引号包裹、UTF-8 BOM（PS 5.1 按 ANSI 读中文乱码）
- **C7 Windows**：scheduleTimezone IANA 名校验（Intl.supportedValuesOf + 放行 UTC——Windows 时区名此前静默不调度）
- **C8 Windows**：state.json 原子写（tmp+rename，锁文件不再静默丢快照）+ smoke 默认配置路径 ROOT 解析
- **C9**：清理 tests/logs/bot.log.1 工作树残留
- **C10 LLM 深化（核心）**：分层提示词——核心层（Ollama 共用）+ 云端扩展层（多步意图示例 5 条/技能选择策略/任务规划与异常恢复/安全边界，≈620 tokens）；buildSystem 按 provider.kind() 动态分支（每轮重生成支持 auto 粘滞切换）；auto 回退与粘滞分支剥除扩展层（ollama 从不收到）；`l2.cloudMaxContextWindow`（默认 65536）→ 云端也走预算守卫（此前 provider=cloud 无窗口裁剪路径跳过）
- **C11 结构**：exclusive 守卫样板提 assertNoExclusive helper（5 处）+ putBounded/setSession LRU 去重
- **C12 CI**：GitHub Actions（ubuntu×Node22/24 + windows×Node22；git+ssh→https 重写前置；npm test + check:compat 门禁；audit 信息性不门禁）

## 第五轮已完成（2026-08-07）

用户需求：LLM 在指令约束下完全控制 Bot + 更聪明更易用。三路 Explore（控制深度/新代码/易用性）+ Plan 验证（10 项全部 CONFIRMED + 3 个关联缺口）：

### 完善档（P1+P2）
- **P1 nearby_entities 恒失效根治**：filter 的 AND 语义 + entity.kind 大写分类（'Hostile mobs'）三连 bug——OR 语义 + 比对 e.type；**并发现 bot.entities 是 Map——Object.values(Map) 恒空，整个 nearby_entities 技能此前恒空**（双形态遍历）；scanEntities 敌对检测死代码同根修复
- **P2 webhook 配置实时化**：feature-layer 改 ctx.notifier（reload 不重建 feature layer——闭包按值捕获是死配置）；manager getConfig 实时 getter（任务构造冻结的 cfg 引用）
- **P2 move_to 仲裁器防线**（15 技能唯一漏网）+ act() busy 前置（!agent act 可打进进行中 chat 工具循环）
- **P2 ExploreTask 站点地面 y 采样**（悬崖/山顶站点大量 NoPath）
- **P2 预算修正**：estimateTokens 工具轮计入参数 JSON；2048 窗口 warn 带调参建议
- **F1-b busy 反馈附带已进行秒数**（60-120s 阻塞窗口玩家感知不是卡死）

### 升级档（U13-U17）
- **U13 动作技能组**（LLM 完全控制核心）：dig/place/equip/use_item/attack——26.1 包安全性实测（dig 缺 sequence 补 0、block_place 全字段、use_item rotation 必填均序列化 OK），只有攻击走 entity-actions 原始包；统一守卫（exclusive 拒绝/前置检查/冷却只对实际执行生效/参数 example）
- **U13 善后（部署机实测"打僵尸原地不动"根因）**：attack 技能两个叠加缺陷——① `entities[id]` 下标检查在 Map 下恒 false → attack 从未真正发出（P1 Map bug 同根漏网，U13 无测试覆盖）；② 无接近逻辑——5 格外攻击包被服务端 reach 校验拒绝。修复：Map 双形态存在检查 + approachEntity 接近（combat 同款三件套）+ 有界连击（至多 5 次，600ms 反作弊冷却），补 3 个测试
- **U14 工具结果精简**：task_status 行式、status 去运维指标、inventory Top-N、空态转文本（固定 prompt 占预算 54% 下的最大 token 单点）
- **U15 会话工具记录**：SESSIONS 升级 {history, calls}——跨对话注入"最近工具操作"≤3 条（"继续"不再失忆）
- **U16 玩家上线问候**：playerJoined 固定模板欢迎（首包洪峰去重 + 独立 60s 冷却；只问候不告别——离场玩家不可见；纯模板、LLM 不参与）
- **U17 意图引导**：SYSTEM_PROMPT 意图→技能 few-shot（含 run_task 目标→类型映射/不确定→list_skills）；maxSteps 默认 8（真实动作链条 7 步）；config.example 补新键；README 自然语言示例

## L2 进化已完成（2026-08-07，A1-A3 + B1/B2 + C1/C2 + D）

用户需求：让 LLM 获取更多信息、提高环境感知、像玩家一样自由探索。两路 Explore 审计现状 + Plan 逐项验证（biome/Ollama num_ctx/螺旋算法/记忆容量/token 预算均读源码核实）：

- **A1 provider 改 native `/api/chat`**：compat 端点不处理 num_ctx（官方 wont-fix，超窗静默截断）→ native options.num_ctx/num_predict；`l2.ollamaNumCtx`（默认 4096）；contextWindow() 供预算裁剪
- **A2 上下文预算裁剪**：estimateTokens（CJK×1.0+ASCII×0.25）+ 三级裁剪（历史整轮 → 工具结果动态截短 → 用户消息）——环境注入的前置硬前提
- **A3 环境感知**：environment/nearby_entities 技能 + 环境自动注入（每次对话 system 尾部环境行，`l2.envInjection`）；数据源 26.1 核实（bot.isRaining 非 bot.weather、blockAt().biome、实体 health 不可读）
- **B1 空间记忆**：DiscoveryMap（anchors 256 + resources 512 条 chunk 去重）+ state.json memory 键持久化 + 重建回灌
- **B2 查询技能**：query_map（已知资源坐标，不重扫）/ map_status
- **C1 explore 技能**：单步游走（8 向/random）+ 采样记录 + 报告；exclusive 运行中拒绝
- **C2 ExploreTask**：方形螺旋（step 32、第 r 环 8r 站、256 → 288 站），stopWhenDone 环满完成/有界漫游重启，area 裁剪；四件套联动（TASK_TYPES/schema/一致性断言）
- **D 收尾**：重要资源 webhook 推送（10 分钟/类型节流）、/metrics discovery 统计、文档

## 第四轮已完成（2026-08-07，commit 93812b8..c1b4cb0）

第四轮重点：既往问题（断线类/踢人类/微任务饿死/goto 挂死/漂浮 rejection）同类残留 + 第三轮新增模块（arbiter/task-schemas/entity-actions）集成死角。**主面确认干净**（§ 踢人、微任务饿死、goto 挂死、fishing/auto-eat 包路径安全），剩余问题集中在集成死角：

### 完善档（A1-A6）
- **A1 仲裁器 owner 泄漏根治**（本轮最高价值）：exclusive 任务 run 挂死（stop 超时强制结束）→ 释放点唯一挂在 run settle 上 → owner 永不释放 → !follow 永久被拒跨重连不愈；stopTask/stopAll/removeTask 停止后无条件释放 + startTask 代际比对（同 id 重启后旧代晚 settle 不误清新 owner）；顺带修复 base.js start() 返回被新代覆盖的 _runPromise（旧调用方挂到新代）与旧代协程污染新代状态
- **A2 schema 与 config 校验统一**：chop schema 漂移（blockTypes 必填但代码读 logTypes）→ 改 logTypes 可选；mine 补 area；mine/chop radius 上限 256（同步 findBlocks 枚举防冻结，farm _scanArea 同款钳制）；config 路径任务 options 接入 validateTaskOptions（非法配置启动即报错而非静默不运行）
- **A3 技能层防线**：follow_player 仲裁器拒绝（命令层有、技能层绕过——R2 根治目标复活）、find_block 告警、move_to 世界边界 ±30000000 + isFinite
- **A4 实体动作防御补齐**：breed 两次喂食前目标存在检查（combat 同源竞态的另一面）、equip/autoEat 10s 超时（A1 触发面收敛）、useEntityOn pos 缺失明确报错、!task new failed 反馈
- **A5 承错与生命周期**：queue(teardown)/croner onTrigger/follow tick 三处 catch（漂浮 rejection 与 uncaughtException 纵深防线）、summarize 全局 60s 冷却（死亡播报绕过 manager 侧冷却）、stopTask 清理排队队列、config 任务计数器回灌（快照写了不读 = 数据丢失）、_reset 清孤儿 timer、!agent chat 空文本拦截
- **A6 文档漂移**：deploy.md 指令表、l2.md summarize 播报说明、本文件

### 升级档（U10-U12，随 A 档同批实施）
- **U10 运维 webhook 通知**：任务完成/失败、断线重连、死亡重生、fatal 停服推送（企业微信/Server酱，零依赖 fetch POST，5s 超时失败静默）
- **U11 deploy.ps1 -Update 一键更新**：git pull → npm ci --omit=dev → check:compat → nssm restart
- **U12 http /metrics 补字段**：bot 当前坐标 + 任务等待原因（运维看"卡在哪"）

## 第三轮善后（2026-08-07，combat 断线根因，commit ecd7241/13ee453/d8bf90a）

部署机实测定位：mineflayer PR 分支在 26.1 特性门控 bug（useEntityUsesEntityId=false 使 bot.attack/useEntity 回退旧式 use_entity 缺 location → 序列化 Sizeof error → 攻击/喂食即断线）。修复：`src/core/entity-actions.js` 项目层写正确包（attack 独立包 + use_entity 新格式），combat/breed 接入，真实序列化器回归测试。

## 第三轮已完成（2026-08-07，commit 74b619b..8aed83d，共 12 个 commit）

### 完善档（P0/P1/高价值 P2，8 个 commit C1-C8）
- **C1 聊天通道安全（P0）**：裸 § 聊天三处改走 sendChat（feature-layer 未知命令/重连广播、follow 目标消失）——含 § 被 Paper 踢出 → fatal 停服（53d3352 回归）；空文本不发包
- **C2 断线一致性（P1）**：goto 与 bot end 事件 race（断线后 path_stop 永不到达 → 挂死/轮询器泄漏/findBusy 不复发）；死亡 → 暂停任务 + 自动重生；process exit 同步落盘
- **C3 命令反馈与调度链路（P1）**：!task start 不再 await run 完成 promise（常驻任务回复挂到结束）；scheduled 排队保留 durationMinutes（drain 补挂）；croner 漂浮 rejection → fatal exit 杜绝（runScheduled 容错 + combat 触发源判空）；!reload 运行时异常如实反馈
- **C4 任务状态机显式化（重构 R1）**：per-wait token（跨代际串扰根治）、pause-init 窗口伪死锁、start() 采纳窗口关闭；mine/chop/farm collect 分批响应 pause
- **C5 配置 schema 化（重构 R3）**：src/core/task-schemas.js（!task new/run_task options 零校验根治）；find_block maxDistance 16-256（主线程冻结防护）；afk intervalMinutes ≥ 1；combat 同格零向量/aggroRange 陷阱
- **C6 热重载与持久化**：httpChanged 赋值前计算（热重载死代码）；U1 计数器回灌 + removeTask 清理
- **C7 L2 会话治理**：SESSIONS LRU 上限 32、冷却按玩家、maxSteps 耗尽显式文案、auto 粘滞回退、!agent chat 开放全员（buildSystem 普通玩家分支转活跃）
- **C8 移动权仲裁器（重构 R2）**：src/core/arbiter.js——exclusive 任务登记/查询，!follow 冲突拒绝、!find 警告统一信息源；farm anchor 区域中心 + 距离告警；实际到达坐标汇报；gotoNearest 空数组守卫

### 升级档（U6-U9，4 个 commit）
- **U6 死亡重生 + LLM 播报**：death 经 summarize 一句话播报死因；respawn 自动恢复任务
- **U7 L2 主动播报**：任务终态 LLM 一句话总结（固定模板之后，1 分钟冷却防刷屏，失败回退）
- **U8 !task list 增强**：排队位置/时长剩余/cron 下次触发（croner.nextRun）
- **U9 !agent doctor**：cloud/ollama 连通性诊断（5s 短超时探测，缺 key 明确报未配置）

## 第二轮已完成（2026-08-06，commit 9de9070..3c4255d）

## 已完成（2026-08-06，commit 9de9070..3c4255d）

### 统一移动层重构 + !find（commit f57ff75..3c4255d）
- **src/core/movement.js**：统一寻路封装——createMovements（统一 Movements 配置）、stopPathfinding/clearGoal（统一清理）、goto（事件驱动到达 + 谓词中断 + 墙钟超时 + 失败分类 + A* 预算超时重试）、gotoPoint/gotoNearest（GoalCompositeAny 多候选选最近可达）、approachEntity（轮询接近 + noPath 立即放弃）、findSurfaceBlocks（地表候选查询）
- **collectBlock Movements 覆盖修复**：collect() 自建 Movements 覆盖全局配置——注入共享实例后仅 resetPath
- **任务迁移**：combat/breed 接近与撤退、五任务 _cancel、move_to 阻塞式反馈（消除"接近目标"4 份复制与 3 种清理写法）
- **!find 命令**：地表方块定位 + 行走报告 + 防重入 + exclusive 警告

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

### R2 任务公共代码消重（部分已完成，剩余可选）
- ~~`_cancel` 三份重复~~：已完成（统一 stopPathfinding）
- ~~breed._approach 手写轮询~~：已完成（统一 approachEntity，C2 迁移）
- NoChests 处理 + collect 重试三处重复（可提 `collectWithChestFallback`）
- `_isArea` 四份重复（chop/combat/breed/farm → BaseTask 方法或 tasks/util.js）

### R3 后续可选增强（第四轮遗留观察）
- L2 主动播报扩展：任务长 idle（waitingReason 持续 N 分钟）经 LLM 播报原因（U7 已做终态播报，idle 播报未做）
- 死亡播报/任务总结的 webhook 推送模板（U10 已做事件推送，LLM 文案进 webhook 可后续加）

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
