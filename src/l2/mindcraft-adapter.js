// mindcraft 子进程适配器（骨架阶段，仅预留接口与通信协议）。
//
// 接入方案（详见 docs/l2.md）：
// - mindcraft 锁定 mineflayer 4.33.0 + patch-package，不适合进程内依赖
// - 以子进程模式运行独立 agent（mindcraft 的 AgentProcess 模式）
// - 通信：child_process.spawn + stdin/stdout JSONL
//   L1 → agent: {"type":"act","name":"mine-iron","params":{}}   （技能调用）
//   L1 → agent: {"type":"chat","user":"steve","text":"hi"}      （对话）
//   agent → L1: {"type":"result","ok":true,"result":{...}}
//   agent → L1: {"type":"event","event":"state","data":"..."}
// - L1 暴露给 agent 的技能 = TaskManager.startTask/stopTask + 命令系统

export class MindcraftAdapter {
  /**
   * @param {object} ctx { bot, config, logger, tasks, commands }
   */
  constructor (ctx) {
    this.ctx = ctx
    this.proc = null
  }

  async start () {
    // M4 之后接入：spawn('node', ['agent-child.js'], { stdio: ['pipe', 'pipe', 'inherit'] })
    // + JSONL 协议解析（见文件头注释）
    this.ctx.logger.info('mindcraft adapter: skeleton (not started)')
  }

  async stop () {
    this.proc?.kill()
    this.proc = null
  }
}
