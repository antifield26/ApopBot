// 动作原语注册表（按族拆分）：LLM act 动作数组与任务脚本共用的原子动作层。
// 每个原语 { schema, permission, exclusiveClass, guardText, timeoutMs, cooldownMs?, handler }。
// 约定（与 skills.execute 同源，由 executor 统一执行管线保证）：
// - handler(ctx, args, runtime) 返回 result（成功）；业务性"无事可做"（无目标/
//   无物品/冷却）也返回文案（ok:true——动作已有效执行）；真正的异常 throw
//   （executor 转 { ok:false, result: err.message }）
// - runtime = { signal: AbortSignal|null, user, taskId }——signal 贯通长时等待
//   （fish/eat/wait 的 race；movement 的 isInterrupted 组合谓词）
// - exclusive 守卫统一上提 executor（按 exclusiveClass），handler 不再自查
// 权限分级：观察/流程类 all；会改变世界状态（移动/构建/战斗/交互/物品/任务）op。
// 观察类返回结构化对象（LLM 收到 JSON、脚本读字段）；动作类返回简短中文文案。
// 流程（all / flow，不拦 exclusive）
import { Vec3 } from 'vec3'
import { withTimeout } from '../../util/promise-timeout.js'
import { sendChat } from '../chat.js'

/**
 * 注册flow族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerFlow (register, _ctx) {
  // ============ 流程（all / flow，不拦 exclusive） ============
  register('wait', {
    schema: {
      type: 'object',
      required: ['ms'],
      properties: { ms: { type: 'integer', min: 100, max: 300000, description: '等待毫秒数（10ms 步进，最大 5 分钟）' } }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 305000,
    handler: async (c, { ms }, runtime) => {
      // stop/pause/断线可打断（signal race——与任务 _internalWait 同语义）；
      // 监听器必须配对移除——同一 AbortSignal 跨长任务（farm 30s 等待循环数小时）
      // 累积 listener → 内存线性增长、abort 时触发数百次无意义回调
      let onAbort = null
      const wait = new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        if (!runtime?.signal) return
        onAbort = () => {
          clearTimeout(timer)
          reject(new Error('等待被中断'))
        }
        runtime.signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        await wait
      } finally {
        if (onAbort) runtime.signal.removeEventListener('abort', onAbort)
      }
      return { waited: ms }
    }
  })
  register('look', {
    schema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
        yaw: { type: 'number', description: '目标朝向（弧度；与坐标二选一）' },
        pitch: { type: 'number', description: '俯仰角（弧度，默认 0）' },
        relative: { type: 'boolean', description: 'yaw/pitch 为相对增量（afk 防踢用）' }
      }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { x, y, z, yaw, pitch, relative }) => {
      // relative 分支必须在 yaw 分支之前——否则 afk 传 {yaw:0.05, relative:true}
      // 会命中 yaw 绝对分支，每次转动都把视角 snap 回绝对 0.05（并非增量漂移）
      if (relative === true) {
        const e = c.bot.entity
        await withTimeout(c.bot.look(e.yaw + (yaw ?? 0.05), e.pitch + (pitch ?? 0), true), 5000, 'look timeout')
        return '已转向（相对增量）'
      }
      if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
        await withTimeout(c.bot.lookAt(new Vec3(x, y, z), true), 5000, 'look timeout')
        return `已转向 (${Math.floor(x)},${Math.floor(y)},${Math.floor(z)})`
      }
      if (typeof yaw === 'number') {
        await withTimeout(c.bot.look(yaw, pitch ?? 0, true), 5000, 'look timeout')
        return `已转向 yaw=${yaw}`
      }
      return 'look 需要 x,y,z 或 yaw（+可选 pitch）'
    }
  })
  register('reply', {
    description: '以 Bot 身份向当前对话的玩家发送一句话（聊天）。用于回答玩家或汇报状态。',
    schema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', description: '要发送的消息内容，不超过 250 字符' } }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 5000,
    handler: async (c, { text }) => {
      await sendChat(c.bot, String(text).slice(0, 250), c.cfg.chat?.maxLength)
      return '已发送'
    }
  })
  register('fish', {
    schema: {
      type: 'object',
      properties: { timeoutMs: { type: 'integer', min: 5000, max: 300000, description: '单次钓鱼超时（默认 60s）' } }
    },
    permission: 'all',
    exclusiveClass: 'flow',
    guardText: '',
    timeoutMs: 305000,
    handler: async (c, { timeoutMs }, runtime) => {
      if (!c.bot?.fish) return { caught: false, reason: 'fish 能力不可用（插件缺失）' }
      // FishTask 同款：bot.fish() 无超时——withTimeout + 取消信号 race 使任务
      // stop/断线能打断抛竿（60s 超时由调用方控制）
      // abort 监听器必须配对移除（wait 原语同款纪律）——fish 任务挂机数小时
      //（60s/次抛竿）会在同一 AbortSignal 上累积上百个监听器
      let onAbort = null
      let caught
      try {
        await Promise.race([
          withTimeout(c.bot.fish(), timeoutMs ?? 60000, 'fish timeout'),
          new Promise((_, reject) => {
            if (runtime?.signal?.aborted) return reject(new Error('等待被中断'))
            onAbort = () => reject(new Error('等待被中断'))
            runtime?.signal?.addEventListener('abort', onAbort, { once: true })
          })
        ])
        caught = true
      } catch (err) {
        if (err?.name === 'AbortError' || err?.message?.includes('中断')) throw err
        // 上钩失败/超时不算错误——返回 false 供脚本重试
        caught = false
      } finally {
        if (onAbort) runtime?.signal?.removeEventListener('abort', onAbort)
      }
      return { caught }
    }
  })

}
