// @ts-check
// 实体交互动作（协议层直连）：
// mineflayer PR 分支在 26.1（协议 775 / minecraft-data 3.112.0）下存在特性门控 bug：
// useEntityUsesEntityId=false 使 bot.attack()/bot.useOn() 回退到旧式 use_entity 包
// （{target, mouse, sneaking}），而 26.1 的 use_entity schema 是
// {target, hand, location(lpVec3 必填), sneaking} → 序列化报
// "Sizeof error: Cannot read properties of undefined (reading 'x')"。
// 同时 26.1 数据 attackUsesOwnPacket=true（独立 attack 包是正式攻击通道），
// 被 mineflayer 门控锁在 useEntityUsesEntityId 分支内永远走不到。
//
// 本项目 PR pin 锁死 26.1.2——此处直接写 26.1 的正确包绕过门控；上游升级走
// migrate-upstream 时 tests/entity-actions.test.mjs 用真实序列化器验证格式（会拦变更）。

/**
 * 近战攻击：26.1 独立 attack 包（{entityId}）+ 挥臂（{hand}）。
 * @param {import('mineflayer').Bot} bot
 * @param {{ id?: number }} target
 */
export function attackEntity (bot, target) {
  bot._client.write('attack', { entityId: target.id })
  bot._client.write('arm_animation', { hand: 0 })
}

/**
 * 右键交互实体（喂食等）：26.1 use_entity 新格式——location 必填（实体中心点）。
 * @param {import('mineflayer').Bot} bot
 * @param {{ id?: number, position?: { x, y, z }, height?: number }} target
 */
export function useEntityOn (bot, target) {
  // pos 缺失明确报错（调用方 catch 重扫）而非 TypeError 吞成
  // 无效包——目标引用残留但位置不可用时直接放弃本次喂食
  if (!target?.position) throw new Error('useEntityOn: 目标位置不可用')
  const pos = target.position
  bot._client.write('use_entity', {
    target: target.id,
    hand: 0,
    location: { x: pos.x, y: pos.y + (target.height ?? 1.8) / 2, z: pos.z },
    sneaking: false
  })
}
