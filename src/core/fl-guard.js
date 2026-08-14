// @ts-check
// 受击响应（guard）：被怪物攻击 → 暂停任务 → combat 清理 → 范围清空后恢复。
// 实时战斗响应必须脚本化——LLM 工具循环太慢（被打时等 LLM 决策不可行）；
// LLM 感知由 fl-world 的 notifyEvent（被攻击/血量）承担（下次对话注入）。
//
// 触发链：entityHurt（hostile 源）→ 门（开关/已在清理/冷却）→ pauseAll →
//   addTask combat（guard-response：aggroRange=radius + stopWhenNoTargets）→
//   await startTask 的 run promise（combat 自然完成 = 范围内无目标）→
//   移除 guard 任务 → resumeTask 暂停的任务。
// 死亡交互：combat 中死亡 → fl-death pauseAll 暂停 combat+原任务 → 重生 resume →
//   combat 继续到完成 → 本控制器恢复逻辑幂等（resumeTask 非 paused 是 no-op）。
// 时长上限：combat 永不完成（怪物无限刷）→ 10 分钟强制恢复（防刷怪塔卡死）。
// 冷却节流：combat 完成后 cooldownMs 内的再次受击不重复触发（防怪群连续攻击刷任务）。

/**
 * 挂载受击响应。
 * @param {Record<string, any>} ctx 可变上下文（cfg.guard/tasks 实时读取）
 * @param {import('mineflayer').Bot} bot
 * @param {() => Record<string, any>} log 惰性取当前 logger
 */
export function installGuardResponse (ctx, bot, log) {
  let guardActive = false
  let lastTriggerAt = 0
  const cfg = () => ctx.cfg?.guard ?? {}
  bot.on('entityHurt', (entity, source) => {
    if (entity !== bot.entity) return
    if (!source || source === bot.entity || source.username) return // 只响应怪物攻击（玩家/环境自伤除外）
    // 显式 catch：trigger 内部虽全防御，但进程对 unhandledRejection 是
    // fatalExit 停服——fire-and-forget 不依赖"内部 catch 覆盖所有路径"的脆弱不变量
    void trigger().catch(() => {})
  })
  // 死亡重置冷却：怪物多时死亡-重生循环中，重生后受击若仍在 30s 冷却窗口内会被
  // 挡住——"死亡重生后不进入战斗"（实测 17:00:18-17:00:44 被僵尸蹲守多次死亡
  // 未触发 guard）。死亡=威胁需重新评估，重生后首次受击立即进入战斗。
  bot.on('death', () => { lastTriggerAt = 0 })
  /** 受击响应主流程（串行 await——combat 完成才恢复，防并发触发）。 */
  async function trigger () {
    const g = cfg()
    if (g.enabled === false) return
    if (guardActive) return // 已在清理中（combat 运行）
    const now = Date.now()
    const cooldown = g.cooldownMs ?? 30000
    if (now - lastTriggerAt < cooldown) return // 冷却节流
    lastTriggerAt = now
    const radius = g.radius ?? 32
    const id = 'guard-response'
    // 抢占：非 exclusive 任务 pause（战斗后 resume）；exclusive 任务 stop
    //（在飞动作取消——此前 pauseAll 只置 paused，但 startTask 的 busy 判定含
    // paused → guard combat 排队 → 被移除 → exclusive 任务运行中受击完全无响应）
    let preempted = { paused: [], stopped: [] }
    try {
      preempted = (await ctx.tasks?.preemptForCombat?.()) ?? { paused: [], stopped: [] }
    } catch (err) {
      log().warn({ err: err.message }, 'guard: preempt failed')
    }
    const paused = preempted.paused
    guardActive = true
    log().info({ paused, stopped: preempted.stopped, radius }, 'guard: 受击响应——抢占任务清理怪物')
    try {
      // enabled:false 禁用 addTask 自动启动——否则自动启动（fire-and-forget）与
      // 显式 startTask 竞态：任务 init 但 _runPromise 未赋值时 startTask 返回 null
      // → guard 跳过 await → 立即 removeTask（combat 未执行就被移除，实测）
      ctx.tasks?.addTask({ id, type: 'combat', options: { aggroRange: radius, stopWhenNoTargets: true, maxTargets: 0 }, notifyChat: false, enabled: false })
      // ignorePaused：用户手动暂停的 exclusive 任务不挡 combat（preemptForCombat
      // 已停掉/保持暂停的 running exclusive——战斗后由 restartStopped 恢复）
      const runPromise = ctx.tasks?.startTask?.(id, undefined, undefined, { ignorePaused: true })
      if (runPromise) {
        // combat 自然完成（范围清空）→ resolve；10 分钟上限防无限刷
        //（timer unref——测试/退出不被挂起的超时阻塞）
        await Promise.race([runPromise, new Promise((resolve) => {
          const t = setTimeout(resolve, 600000)
          t.unref()
        })])
      }
    } catch (err) {
      // addTask id 冲突（上次异常中断残留 guard-response）等——本次跳过，
      // finally 清理残留后下次受击正常
      log().warn({ err: err.message }, 'guard: combat failed')
    } finally {
      guardActive = false
      // 完成后清理 guard 任务（残留/完成统一清——异常中断路径幂等）
      try { await ctx.tasks?.removeTask?.(id) } catch { /* 任务可能已移除 */ }
      // 先重启被抢占的 exclusive 任务（战斗结束恢复原任务），再恢复暂停的任务
      try { await ctx.tasks?.restartStopped?.(preempted.stopped) } catch { /* 重启失败已记日志 */ }
      for (const pid of paused) {
        ctx.tasks?.resumeTask(pid).catch(() => { /* 任务可能已结束 */ })
      }
      log().info('guard: 清理完成，任务已恢复')
    }
  }
}
