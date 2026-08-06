import { createBot as realCreateBot, loadMineflayerPluginsAsync as realLoadMineflayerPlugins } from './bot.js'
import { classifyDisconnect, nextBackoff } from './reconnect.js'
import { withTimeout } from '../util/promise-timeout.js'

const STATE_DISCONNECTED = 'disconnected'
const STATE_CONNECTING = 'connecting'
const STATE_CONNECTED = 'connected'
const STATE_RECONNECTING = 'reconnecting'

// 插件动态装载的超时（防止挂起的动态 import 卡死连接流程）
const PLUGIN_LOAD_TIMEOUT_MS = 30000

/**
 * 连接管理器：连接生命周期、断线分类、指数退避重连、spawn 超时、致命原因退出。
 * 借鉴 mindcraft 的 LoginGuard（断线分类 + isFatal 判定）与 10s 崩溃保护思想。
 */
export class ConnectionManager {
  /**
   * @param {object} cfg 完整配置
   * @param {import('pino').Logger} logger
   * @param {{ onSpawn?: (bot: import('mineflayer').Bot) => void, onStateChange?: (state: string) => void }} hooks
   * @param {{ createBot?: (cfg) => object, loadMineflayerPlugins?: (bot, cfg, logger) => Promise<object> }} deps 测试注入
   */
  constructor (cfg, logger, hooks = {}, deps = {}) {
    this.cfg = cfg
    this.log = logger
    this.hooks = hooks
    this._deps = {
      createBot: deps.createBot ?? realCreateBot,
      loadMineflayerPlugins: deps.loadMineflayerPlugins ?? realLoadMineflayerPlugins
    }

    this.bot = null
    this.plugins = null
    this.state = STATE_DISCONNECTED
    this.attempt = 0 // 1-based 重连次数
    this.reconnectCount = 0
    this.lastFailMs = 0
    this.connectedAt = 0
    this.lastError = null

    this._reconnectTimer = null
    this._connectSeq = 0 // 连接代际：陈旧异步回调（旧 bot 的 spawn 超时/end）不得影响新连接
    this._manuallyDisconnecting = false
    this._spawnPromise = null
    this._timeoutQuit = false // spawn 超时主动 quit → end 事件应走重连而非 fatal
    this._fatalExit = false // 致命原因已判定 → 后续 end 事件不得再调度重连（竞态守卫）
  }

  getStatus () {
    return {
      state: this.state,
      attempt: this.attempt,
      reconnectCount: this.reconnectCount,
      connectedAt: this.connectedAt,
      // 断线期间 uptime 展示失真（connectedAt 不重置）——非 connected 状态返回 0（P2）
      uptimeMs: this.state === STATE_CONNECTED && this.connectedAt ? Date.now() - this.connectedAt : 0,
      lastError: this.lastError
    }
  }

  _setState (state) {
    this.state = state
    this.hooks.onStateChange?.(state)
  }

  /**
   * 建立连接。顺序：同步 createBot → 立即接线事件（无丢失窗口）→ 异步插件装载。
   * 重复调用前先 disconnect()。
   */
  async connect () {
    const seq = ++this._connectSeq
    this._manuallyDisconnecting = false
    this._timeoutQuit = false // 每次全新尝试重置陈旧标记（避免误标后续正常断开）
    this._setState(STATE_CONNECTING)
    this.log.info({ host: this.cfg.host, port: this.cfg.port, mcVersion: this.cfg.mcVersion }, 'connecting')

    // 1. 同步创建 + 立即接线：连接失败事件（error/end）不会在插件装载期间丢失
    const bot = this._deps.createBot(this.cfg)
    this.bot = bot
    this.log = this.log.child({ bot: this.cfg.username })
    this._wireEvents(seq) // 内部同步注册 spawn 监听与超时兜底（必须先于插件装载，见 _wireEvents 注释）

    // 2. 异步插件装载（动态 import 可能较慢，设超时；失败为非致命网络类问题，重连重试）
    try {
      this.plugins = await withTimeout(
        this._deps.loadMineflayerPlugins(bot, this.cfg, this.log),
        PLUGIN_LOAD_TIMEOUT_MS,
        '插件装载超时'
      )
    } catch (err) {
      if (seq !== this._connectSeq) return // 陈旧连接（已换代）的失败不再调度重连
      this.log.error({ err: err.message }, '插件装载失败，断开后重试')
      this.lastFailMs = Date.now()
      this.lastError = err.message
      try { bot.quit() } catch { /* socket 可能已死 */ }
      this._scheduleReconnect()
      return
    }
  }

  /**
   * 更新配置（热重载：host/port/reconnect 参数在下次连接时生效）。
   * @param {object} cfg
   */
  updateCfg (cfg) {
    this.cfg = cfg
  }

  _wireEvents (seq) {
    const bot = this.bot

    // spawn 超时兜底必须在插件装载（await 动态 import）之前注册——否则 spawn 在装载
    // 期间已触发（本机/快速握手），后注册的监听器永远等不到事件 → 60s 后误杀正常 bot
    // 并触发重连循环（P0，实测复现）。两处 bot.once('spawn') 按注册顺序先后触发，无冲突。
    this._spawnPromise = new Promise((resolve) => {
      bot.once('spawn', resolve)
    })
    withTimeout(this._spawnPromise, this.cfg.spawnTimeoutMs, 'spawn 超时')
      .then(() => {
        if (seq === this._connectSeq) this._spawnPromise = null
      })
      .catch((err) => {
        // 代际守卫：已换代时旧 bot 的 spawn 超时不得再 quit——否则陈旧 end 触发重连 → 双 bot 并发
        if (seq !== this._connectSeq) return
        this.log.warn({ err: err.message }, 'spawn 超时，断开后重连')
        this.lastError = err.message
        this._timeoutQuit = true
        try { bot.quit() } catch { /* socket 可能已死 */ }
      })

    bot.once('spawn', () => {
      if (seq !== this._connectSeq) return // 陈旧代际（已换代）的 spawn 不生效
      this.connectedAt = Date.now()
      this.attempt = 0
      this.lastError = null
      this._setState(STATE_CONNECTED)
      this.log.info('spawned, bot online')
      this.hooks.onSpawn?.(bot)
    })

    bot.on('kicked', (reason) => {
      if (seq !== this._connectSeq) return
      this._handleDisconnect(reason, 'kicked')
    })

    bot.on('error', (err) => {
      if (seq !== this._connectSeq) return
      this._handleDisconnect(err, 'error')
    })

    bot.on('end', (reason) => {
      if (seq !== this._connectSeq) return // 陈旧 bot 的 end 不得影响新连接（代际守卫）
      // end 在 kicked/error/quit 后触发；若已手动断开、已在重连调度中或已判致命则跳过
      if (this._manuallyDisconnecting) return
      if (this._fatalExit) return
      if (this.state === STATE_RECONNECTING) return
      // spawn 超时主动 quit：这是网络问题而非致命原因，走重连
      if (this._timeoutQuit) {
        this._timeoutQuit = false
        this.reconnectCount++
        this.lastFailMs = Date.now()
        this._scheduleReconnect()
        return
      }
      this._handleDisconnect(reason, 'end')
    })
  }

  _handleDisconnect (reason, source) {
    const classified = classifyDisconnect(reason, { minecraftVersion: this.cfg.mcVersion })
    this.lastError = classified.detail
    this.lastFailMs = Date.now()
    this.reconnectCount++

    this.log.warn({ source, type: classified.type, isFatal: classified.isFatal, reason: classified.detail, attempt: this.attempt }, 'disconnected')

    if (classified.isFatal) {
      this.log.fatal({ type: classified.type, reason: classified.detail },
        '致命断线原因，退出等待人工介入（服务管理器已配置为 fatal 退出不自动重启）')
      this._fatalExit = true
      // 退出前 flush pino transport（异步，直接 exit 会丢最后一条 fatal 日志）；300ms 兜底防卡死
      let exited = false
      const exitNow = () => { if (!exited) { exited = true; process.exit(2) } }
      try { this.log.flush(exitNow) } catch { /* logger stub 可能无 flush */ }
      setTimeout(exitNow, 300)
      return
    }

    this._scheduleReconnect()
  }

  _scheduleReconnect () {
    if (this._reconnectTimer || this._manuallyDisconnecting) return

    this.attempt++
    this._setState(STATE_RECONNECTING)
    const { delayMs } = nextBackoff({
      attempt: this.attempt,
      baseMs: this.cfg.reconnect.baseMs,
      maxMs: this.cfg.reconnect.maxMs,
      factor: this.cfg.reconnect.factor,
      jitter: this.cfg.reconnect.jitter,
      minGapMs: this.cfg.reconnect.minGapMs,
      lastFailMs: this.lastFailMs
    })

    this.log.info({ attempt: this.attempt, nextInMs: delayMs }, 'scheduled reconnect')
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null
      try {
        await this.connect()
      } catch (err) {
        // connect() 内部 createBot 抛错（如参数错误）——视为非致命网络问题重试
        this.log.error({ err: err.message }, 'connect failed, will retry')
        this.lastFailMs = Date.now()
        this._scheduleReconnect()
      }
    }, delayMs)
  }

  /**
   * 手动断开（优雅退出）：清理定时器、bot.quit()。
   */
  async disconnect () {
    this._manuallyDisconnecting = true
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this.bot) {
      try {
        this.bot.quit()
      } catch { /* 已断开 */ }
    }
    // 清理残留状态：代际递增使陈旧回调（spawn 超时/end/error）全退——
    // 否则手动断开后残留的 spawn 超时定时器仍对已 quit 的 bot 二次 quit（P1-8）
    this._connectSeq++
    this._spawnPromise = null
    this._timeoutQuit = false
    this.bot = null
    this._setState(STATE_DISCONNECTED)
  }
}
