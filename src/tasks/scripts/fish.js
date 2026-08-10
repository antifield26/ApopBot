// 钓鱼任务脚本（v1.0.0 C6）：bot.fish() 循环挂机钓鱼，按时长或背包满停止。
// 语义与原 FishTask 逐条对应：durationMinutes 必填（task-schemas 校验）、
// 60s 抛竿超时兜底（fish 原语内部 withTimeout + signal race）、失败 5s 重试
// （软失败 + wait）、背包满判定（stopWhenInventoryFull，slots ≥34）。

export default {
  id: 'fish',
  exclusive: false,
  naturalCompletion: false, // 时长到 / 背包满自然完成；scheduled 配 durationMinutes
  maxActions: 100000,
  script: {
    steps: [
      { ctrl: 'loop', max: 'infinite', body: [
        // 时长到 → 自然完成
        { ctrl: 'if', cond: { type: 'deadline', passed: true }, then: [{ ctrl: 'return', value: 'completed' }] },
        // 背包满（占用槽位 ≥34 视为满，留手持/盔甲位——原 _inventoryFull 语义：
        // 槽位数而非物品种类数——observe_inventory 的 slotsUsed 字段）
        { ctrl: 'if', cond: { type: 'config', key: 'stopWhenInventoryFull', equals: true }, then: [
          { op: 'observe_inventory', args: { maxItems: 50 }, as: 'inv' },
          { ctrl: 'if', cond: { type: 'result', ref: 'inv', field: 'slotsUsed', gte: 34 }, then: [
            { ctrl: 'return', value: 'completed' }
          ] }
        ] },
        // 抛竿（60s 超时 + 取消信号 race 由 fish 原语内部处理）。
        // 第 11 轮：count 改 {name, field} 形态——字符串形态在 ok:true 时无条件
        // +1，而 fish 原语对抛竿超时/上钩失败返回 {caught:false} 且 ok:true
        //（业务性无事可做契约）→ 超时也被计入 caught，遥测虚高
        { op: 'fish', args: { timeoutMs: 60000 }, count: { name: 'caught', field: 'caught' } },
        // 失败（抛竿超时/中断）→ 5s 后重试（原 catch 分支同款）
        { ctrl: 'if', cond: { type: 'last', ok: false }, then: [{ ctrl: 'wait', ms: 5000 }] }
      ] }
    ]
  }
}
