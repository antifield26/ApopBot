// AFK 任务脚本：周期性微小视角转动，防 Paper afk-kick-timeout 踢出。
// 语义说明：intervalMinutes ≥1 校验（校验在 task-schemas）、
// _internalWait 内部等待（stop/pause 可打断）、视角转动失败仅 warn 不中断、
// wiggles 遥测计数。
// 注意：更可靠的做法是服务端 server.properties 调大/关闭 afk-kick-timeout。

export default {
  id: 'afk',
  exclusive: false,
  naturalCompletion: false, // afk 无自然完成——scheduled 需配 options.durationMinutes（deadline 提前退出）
  maxActions: 100000, // 死循环兜底（look 是动作步）
  script: {
    steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        // durationMinutes 到时 → 自然完成（scheduled 场景）
        { ctrl: 'if', cond: { type: 'deadline', passed: true }, then: [{ ctrl: 'return', value: 'completed' }] },
        // 内部等待（stop/pause 可打断，不触碰 paused 状态）
        { ctrl: 'wait', ms: { expr: '${intervalMinutes} * 60000' } },
        // 微小视角转动即可重置 afk 计时（失败仅 warn——look 原语失败会 fail-fast，
        // 这里由原语内部兜底：bot.look 抛错转 {ok:false} 时脚本失败；实体缺失属
        // 异常态，fail 可被调度重试）
        { op: 'look', args: { yaw: 0.05, relative: true }, count: 'wiggles' }
      ] }
    ]
  }
}
