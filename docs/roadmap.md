# 项目路线图（2026-08-06 第二轮 / 2026-08-07 第三轮 / 2026-08-07 第四轮评估）

第二轮评估（3 Explore + 1 Plan + 逐项复核）的三档路线图 2026-08-06 全部实施；第三轮（26 条发现逐条 verdict）2026-08-07 全部实施；第三轮善后（combat 断线根因）与第四轮（9 项发现全部 CONFIRMED + 1 个代际竞态）2026-08-07 实施。本文档记录已完成项、缓做项与明确不做项。

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
