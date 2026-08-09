# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。
**版本单一来源 = package.json**（`node scripts/release.mjs [patch|minor|major]` bump，check:compat 交叉校验 package.json ↔ lockfile）。

## [Unreleased]

### 已添加
- 任务类型单一注册表 `src/tasks/types.js`（工厂 + 自然完成语义单点定义，替代三处手工同步）
- 版本管理流程：`release.mjs`（package.json 单一来源 + lockfile 双处同步 + git 命令提示）、CHANGELOG
- GitHub Actions CI（Node 22/24 × Ubuntu + Node 22 × Windows：npm ci → 399 测试 → check:compat）
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
