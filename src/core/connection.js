import { createBotWithPlugins } from './bot.js'
import { classifyDisconnect, nextBackoff } from './reconnect.js'
import { withTimeout } from '../util/promise-timeout.js'

const STATE_DISCONNECTED = 'disconnected'
const STATE_CONNECTING = 'connecting'
const STATE_CONNECTED = 'connected'
const STATE_RECONNECTING = 'reconnecting'

/**
 * 连接管理器：连接生命周期、断线分类、指数退避重连、spawn 超时、致命原因退出。
 * 借鉴 mindcraft 的 LoginGuard（断线分类 + isFatal 判定）与 10s 崩溃保护思想。
 */
export class ConnectionManager {
  /**
   * @param {object} cfg 完整配置
   * @param {import('pino').Logger} logger
   * @param {{ onSpawn?: (bot: import('mineflayer').Bot) => void, onStateChange?: (state: string) => void }} hooks
   */
  constructor (cfg, logger, hooks = {}) {
    this.cfg = cfg
    this.log = logger
    this.hooks = hooks

    this.bot = null
    this.plugins = null
    this.state = STATE_DISCONNECTED
    this.attempt = 0 // 1-based 重连次数
    this.reconnectCount = 0
    this.lastFailMs = 0
    this.connectedAt = 0
    this.lastError = null

    this._reconnectTimer = null
    this._manuallyDisconnecting = false
    this._spawnPromise = null
    this._timeoutQuit = false // spawn 超时主动 quit → end 事件应走重连而非 fatal
  }

  getStatus () {
    return {
      state: this.state,
      attempt: this.attempt,
      reconnectCount: this.reconnectCount,
      connectedAt: this.connectedAt,
      uptimeMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
      lastError: this.lastError
    }
  }

  _setState (state) {
    this.state = state
    this.hooks.onStateChange?.(state)
  }

  /**
   * 建立连接（含插件装载与事件接线）。重复调用前先 disconnect()。
   */
  async connect () {
    this._manuallyDisconnecting = false
    this._setState(STATE_CONNECTING)
    this.log.info({ host: this.cfg.host, port: this.cfg.port, mcVersion: this.cfg.mcVersion }, 'connecting')

    const { bot, plugins } = await createBotWithPlugins(this.cfg, this.log)
    this.bot = bot
    this.plugins = plugins
    this.log = this.log.child({ bot: this.cfg.username })

    this._wireEvents()

    // spawn 超时兜底：超时则主动断开，由 end 事件走重连路径
    this._spawnPromise = new Promise((resolve) => {
      bot.once('spawn', resolve)
    })
    withTimeout(this._spawnPromise, this.cfg.spawnTimeoutMs, 'spawn 超时')
      .then(() => {
        this._spawnPromise = null
      })
      .catch((err) => {
        this.log.warn({ err: err.message }, 'spawn 超时，断开后重连')
        this.lastError = err.message
        this._timeoutQuit = true
        try { bot.quit() } catch { /* socket 可能已死 */ }
      })
  }

  _wireEvents () {
    const bot = this.bot

    bot.once('spawn', () => {
      this.connectedAt = Date.now()
      this.attempt = 0
      this.lastError = null
      this._setState(STATE_CONNECTED)
      this.log.info('spawned, bot online')
      this.hooks.onSpawn?.(bot)
    })

    bot.on('kicked', (reason) => {
      this._handleDisconnect(reason, 'kicked')
    })

    bot.on('error', (err) => {
      this._handleDisconnect(err, 'error')
    })

    bot.on('end', (reason) => {
      // end 在 kicked/error/quit 后触发；若已手动断开或已在重连调度中则跳过
      if (this._manuallyDisconnecting) return
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

    this.log.warn({ source, type: classified.type, isFatal: classified.isFatal, reason: classified.detail, attempt: this.attempt + 1 }, 'disconnected')

    if (classified.isFatal) {
      this.log.fatal({ type: classified.type, reason: classified.detail },
        '致命断线原因，退出等待人工介入（systemd 会按 StartLimitBurst 停止服务）')
      // 给日志 flush 留时间
      setTimeout(() => process.exit(2), 500)
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
    this._setState(STATE_DISCONNECTED)
  }
}
