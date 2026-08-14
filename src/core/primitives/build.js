// @ts-check
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
// 构建（op / build / 冷却 500ms，exclusive 拒绝）
import { Vec3 } from 'vec3'
import { withTimeout } from '../../util/promise-timeout.js'
import * as discovery from '../discovery.js'
import { isArea } from '../../tasks/util.js'
import { findSurfaceBlocks } from '../movement.js'
import { CROP_PLANT_MODE, SEED_BY_CROP } from '../crops.js'
import { ACTION_COOLDOWN_MS, checkActionCooldown, raceAbort } from './common.js'
import { ensureMiningTool } from '../tool.js'
import { autoDeposit } from '../storage.js'

/**
 * 注册build族原语。register = index.js 工厂注入的注册函数（含重复注册检查）；
 * _ctx 保留供族文件间约定签名（handler 经 c 首参取 ctx，不经此参数）。
 */
export function registerBuild (register, _ctx) {
  // ============ 构建（op / build / 冷却 500ms，exclusive 拒绝） ============
  register('dig', {
    schema: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        // 坐标世界边界（同 goto 口径）：LLM 幻觉坐标在 schema 层拦截，
        // y 越界会让 prismarine-chunk 抛 TypeError（可归因性差）
        x: { type: 'integer', min: -30000000, max: 30000000 },
        y: { type: 'integer', min: -64, max: 319 },
        z: { type: 'integer', min: -30000000, max: 30000000 }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '挖掘',
    timeoutMs: 30000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { x, y, z }, runtime) => {
      if (!c.bot?.dig || !c.bot.canDigBlock) throw new Error('dig 能力不可用（插件缺失）')
      const block = c.bot.blockAt(new Vec3(x, y, z))
      if (!block) return `坐标 (${x},${y},${z}) 没有方块（区块未加载？）`
      if (!c.bot.canDigBlock(block)) {
        return `方块 ${block.name} 不可挖掘（距离过远或不可挖掘）——先 goto 靠近到 5 格内`
      }
      checkActionCooldown('dig')
      // 竞速取消（mineflayer dig 无取消 API）：stop 后调用方立即返回不再等待
      // ——底层挖掘残余由服务端自然收敛（同 tick 竞态，通常一瞬）
      await raceAbort(withTimeout(c.bot.dig(block), 30000, 'dig timeout'), runtime?.signal, '挖掘被中断') // 断线保护
      // 地形记忆失效：挖除的方块从探索记忆删除——记忆只增不减会让
      // query_map 长期返回过期坐标
      discovery.removeResourceAt(x, y, z)
      return `已挖掘 ${block.name} @ ${x},${y},${z}`
    }
  })
  register('place', {
    schema: {
      type: 'object',
      required: ['x', 'y', 'z'],
      properties: {
        x: { type: 'integer', min: -30000000, max: 30000000 },
        y: { type: 'integer', min: -64, max: 319 },
        z: { type: 'integer', min: -30000000, max: 30000000 },
        face: { type: 'string', description: '放置方向：up/down/north/south/east/west（默认 up）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '放置',
    timeoutMs: 30000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { x, y, z, face = 'up' }, runtime) => {
      if (!c.bot?.placeBlock) throw new Error('place 能力不可用（插件缺失）')
      const off = { up: [0, -1, 0], down: [0, 1, 0], north: [0, 0, 1], south: [0, 0, -1], east: [-1, 0, 0], west: [1, 0, 0] }[face]
      if (!off) return `无效的 face: ${face}（up/down/north/south/east/west）`
      const refBlock = c.bot.blockAt(new Vec3(x + off[0], y + off[1], z + off[2]))
      if (!refBlock || refBlock.boundingBox === 'empty') return '参考方块不存在（目标位置悬空？）'
      const dest = c.bot.blockAt(new Vec3(x, y, z))
      if (dest && dest.boundingBox !== 'empty') return `目标位置被 ${dest.name} 占用`
      if (!c.bot.heldItem) return '手里没有物品——先 equip <物品名>'
      checkActionCooldown('place')
      const itemName = c.bot.heldItem.name
      // 竞速取消（placeBlock 无取消 API）：stop 后不再等待放置结果
      // faceVector 是"参考块→目标"方向（恰为 off 的负向量）——mineflayer 要求
      // Vec3：字符串 face 会走到 vectorToDirection 的 assert.ok(false) 抛
      // AssertionError（发包前抛出，无服务器副作用但该动作必失败）
      await raceAbort(withTimeout(c.bot.placeBlock(refBlock, new Vec3(-off[0], -off[1], -off[2])), 30000, 'place timeout'), runtime?.signal, '放置被中断')
      return `已放置 ${itemName} @ ${x},${y},${z}`
    }
  })
  register('collect_blocks', {
    schema: {
      type: 'object',
      properties: {
        positions: { type: 'array', items: { type: 'array' }, description: '指定坐标列表 [[x,y,z],...]（与 blockNames 二选一）' },
        blockNames: { type: 'array', items: { type: 'string' }, description: '按名称批量采集（区域/半径内）' },
        blockName: { type: 'string', description: '单名称版（等价 blockNames:[x]）' },
        area: { type: 'object', description: '区域 {x1,y1,z1,x2,y2,z2}（过滤候选）' },
        maxBlocks: { type: 'integer', min: 1, max: 64, description: '单次最多采集块数（默认 16）' },
        chestLocations: { type: 'array', description: '箱子坐标列表（背包满时存入）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '采集',
    timeoutMs: 120000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { positions, blockNames, blockName, area, maxBlocks, chestLocations }, runtime) => {
      if (!c.bot?.collectBlock?.collect) throw new Error('collectBlock 插件不可用（配置 mineflayerPlugins.collectBlock=true）')
      // 解析候选：优先 positions；否则按名称扫描。
      // 契约：collectblock 的 Targets.getClosest() 访问 target.position（Block/Entity
      // 契约）——positions 必须经 blockAt 转 Block；blockAt 返回 null（跨会话坐标/
      // 区块卸载）或坐标非法（NaN）时**跳过该点**——裸 Vec3 会触发插件 collectAll
      // 的 UnknownType 崩溃（整批失败、已采数量不入账、脚本对同一批坐标无限重试）
      const toBlocks = (pts) => pts
        .map(p => {
          // 坐标边界（schema 层不校验数组内元素——此处兜底）：越界点直接跳过，
          // 否则 y 越界 blockAt 抛 TypeError 整批失败且文案不可归因
          if (!Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null
          if (Math.abs(p[0]) > 30000000 || Math.abs(p[2]) > 30000000 || p[1] < -64 || p[1] > 319) return null
          return c.bot.blockAt?.(new Vec3(p[0], p[1], p[2])) ?? null
        })
        .filter(Boolean)
      let targets
      if (Array.isArray(positions) && positions.length) {
        targets = toBlocks(positions)
      } else {
        const names = blockNames ?? (blockName ? [blockName] : null)
        if (!names?.length) throw new Error('collect_blocks 需要 positions 或 blockNames')
        let found = []
        for (const name of names) {
          try {
            const r = findSurfaceBlocks(c.bot, name, { maxDistance: 64, maxCandidates: 32 })
            found.push(...r.candidates)
          } catch { /* 未知方块类型跳过该名 */ }
        }
        if (area !== undefined && !isArea(area)) {
          throw new Error('collect_blocks 的 area 不完整（需要 x1..z2 六坐标）——与其他原语口径一致显式报错')
        }
        if (area) {
          found = found.filter(p => p.x >= area.x1 && p.x <= area.x2 && p.y >= area.y1 && p.y <= area.y2 && p.z >= area.z1 && p.z <= area.z2)
        }
        targets = toBlocks(found)
      }
      if (targets.length === 0) return { collected: 0, inventoryFull: false }
      // chestLocations 转 Vec3（collectblock 的 getClosestChest 调 c.distanceTo——配置
      // 普通对象必须转）；坐标非法/缺维度（NaN）过滤——NaN chest 距离恒不可达
      let chests = Array.isArray(chestLocations)
        ? chestLocations
          .map(c => Array.isArray(c)
            ? (c.length >= 3 && c.slice(0, 3).every(Number.isFinite) ? new Vec3(c[0], c[1], c[2]) : null)
            : (c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z) ? new Vec3(c.x, c.y, c.z) : null))
          .filter(Boolean)
        : undefined
      // 分批 ≤4（批间 pause/stop 响应延迟有界——与 mine/chop 任务同款语义）
      let collected = 0
      const cap = Math.min(maxBlocks ?? 16, targets.length)
      for (let i = 0; i < cap; i += 4) {
        if (runtime?.signal?.aborted) return { collected, stopped: true }
        const batch = targets.slice(i, i + 4)
        // 挖掘前工具保障（工具耐久管理）：空手/无对应工具/手持将坏 → 换背包
        // 里该类最优工具（只升不降）；失败不阻塞（collectblock 空手也能挖，仅慢）
        const firstBlock = batch[0] ? c.bot.blockAt(batch[0].position) : null
        if (firstBlock) await ensureMiningTool(c.bot, firstBlock.name, c.logger)
        try {
          // 竞速取消 + collectBlock.cancelTask 真取消（挖到一半 stop 不再等整批
          // 挖完才响应；batch 头部的 aborted 检查只覆盖批间窗口）
          await raceAbort(
            withTimeout(c.bot.collectBlock.collect(batch, { chestLocations: chests }), 120000, 'collect timeout'),
            runtime?.signal,
            'collect timeout',
            () => c.bot.collectBlock.cancelTask?.()
          )
          collected += batch.length
          // 地形记忆失效：收集成功的坐标从探索记忆删除（同 dig）
          for (const b of batch) {
            if (b?.position) discovery.removeResourceAt(b.position.x, b.position.y, b.position.z)
          }
        } catch (err) {
          if (err?.name === 'AbortError') return { collected, stopped: true }
          if (err.code === 'NoChests') {
            // 自动存储——背包满时附近找箱子存物品再继续（避免 mine/chop/farm
            // 脚本背包满空转；存成功重试同一批，失败回退 inventoryFull 语义
            // 由脚本处理）
            if (runtime?.signal?.aborted) return { collected, stopped: true }
            const { stored, found } = await autoDeposit(c.bot, c.logger, c.cfg)
            if (stored > 0) {
              // 新箱子并入 chestLocations（后续批次优先使用）
              for (const p of found) {
                if (!chests) chests = []
                if (!chests.some(x => x.distanceTo(p) < 0.5)) chests.push(p)
              }
              i -= 4 // 重试同一批（已挖除的 collectblock 自动跳过）
              continue
            }
            return { collected, inventoryFull: true } // 背包满（无箱子可存）
          }
          // collect 中途失败（NoPath/目标变化）时批次整体不计——blockAt 复核已挖除
          // 的块补记计数（未加载按未挖保守 0），记忆统一清（已不准确的坐标）；
          // 失败块在下一轮扫描中重试
          for (const b of batch) {
            const now = c.bot.blockAt(b.position)
            if (now && now.type === 0) collected++
            if (b?.position) discovery.removeResourceAt(b.position.x, b.position.y, b.position.z)
          }
          throw err
        }
      }
      return { collected, inventoryFull: false }
    }
  })
  register('plant_crops', {
    schema: {
      type: 'object',
      required: ['area'],
      properties: {
        area: { type: 'object', description: '区域 {x1,y1,z1,x2,y2,z2}' },
        cropTypes: { type: 'array', items: { type: 'string' }, description: '作物列表（默认全部）' },
        seedOverrides: { type: 'object', description: '作物→种子物品名覆盖（farm 任务 seedOverrides 同款）' },
        max: { type: 'integer', min: 1, max: 32, description: '单次最多种植数（默认 8）' }
      }
    },
    permission: 'op',
    exclusiveClass: 'build',
    guardText: '种植',
    timeoutMs: 60000,
    cooldownMs: ACTION_COOLDOWN_MS,
    handler: async (c, { area, cropTypes, seedOverrides, max }, runtime) => {
      if (!isArea(area)) throw new Error('plant_crops 需要完整 area（x1..z2 六坐标）')
      if (!c.bot?.placeBlock || !c.bot?.equip) throw new Error('plant 能力不可用（插件缺失）')
      // farm._seedByCrop 同款：SEED_BY_CROP + seedOverrides 合并（值 = 种子物品名）
      const seedByCrop = { ...SEED_BY_CROP, ...(seedOverrides ?? {}) }
      // 按 cropTypes 优先匹配种子（未指定 = 全部作物任意种子）——否则按背包
      // 第一颗种子乱种（farm 指定 cropTypes:['carrots'] 时若先有 wheat_seeds
      // 会种小麦进胡萝卜田）
      const wantedCrops = Array.isArray(cropTypes) && cropTypes.length > 0
        ? cropTypes
        : Object.keys(seedByCrop).filter(c => CROP_PLANT_MODE[c] !== undefined) // 默认集排除无种植模式的作物（cocoa 只收不种）
      // farm._scanArea 同款扫描（找区域内耕地）
      const diag = Math.hypot(area.x2 - area.x1, area.y2 - area.y1, area.z2 - area.z1)
      const maxDistance = Math.min(Math.ceil(diag) + 16, 256)
      let found
      try {
        found = c.bot.findBlocks({ matching: (b) => b.type !== 0, maxDistance, count: 10000 })
      } catch { return { planted: 0 } }
      // 种植目标按模式分类：farmland（耕地——wheat 类+南瓜/西瓜种子）、
      // soil（土/草——甜浆果）、waterside（水旁沙/土——甘蔗）
      const farmlandSpots = []
      const soilSpots = []
      for (const p of found) {
        if (p.x < area.x1 || p.x > area.x2 || p.y < area.y1 || p.y > area.y2 || p.z < area.z1 || p.z > area.z2) continue
        const block = c.bot.blockAt(p)
        if (!block) continue
        if (block.name === 'farmland') farmlandSpots.push(p)
        else if (/^(grass_block|dirt|coarse_dirt|podzol)$/.test(block.name)) soilSpots.push(p)
      }
      // 水旁位置（甘蔗：水块四邻的沙/土/草）
      const watersideSpots = []
      for (const p of found) {
        if (p.x < area.x1 || p.x > area.x2 || p.y < area.y1 || p.y > area.y2 || p.z < area.z1 || p.z > area.z2) continue
        const block = c.bot.blockAt(p)
        if (!block || !/^(water)$/.test(block.name)) continue
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = c.bot.blockAt(new Vec3(p.x + dx, p.y, p.z + dz))
          if (nb && /^(sand|grass_block|dirt|coarse_dirt|mud)$/.test(nb.name) &&
              !watersideSpots.some(s => s.x === nb.position.x && s.z === nb.position.z)) {
            watersideSpots.push(nb.position)
          }
        }
      }
      // 按种植模式分组作物（crops.js CROP_PLANT_MODE 单一来源）；无模式的作物
      //（如显式传入 cocoa）跳过并告警——在耕地上种可可必然失败（需丛林原木侧面）
      const modes = new Map()
      for (const crop of wantedCrops) {
        const mode = CROP_PLANT_MODE[crop]
        if (!mode) {
          c.logger.warn({ crop }, 'plant_crops: 作物无种植模式（只收不种），跳过')
          continue
        }
        if (!modes.has(mode)) modes.set(mode, [])
        modes.get(mode).push(crop)
      }
      let planted = 0
      for (const [mode, crops] of modes) {
        const spots = mode === 'waterside' ? watersideSpots : mode === 'soil' ? soilSpots : farmlandSpots
        const seedsByMode = new Set(crops.map(c => seedByCrop[c]).filter(Boolean))
        const cap = Math.min(max ?? 8, spots.length)
        for (let i = 0; i < cap; i++) {
          if (runtime?.signal?.aborted) return { planted }
          const soil = c.bot.blockAt(spots[i])
          const above = soil ? c.bot.blockAt(soil.position.offset(0, 1, 0)) : null
          if (above && above.boundingBox !== 'empty') continue // 已占用
          // 只在对应模式作物种子内选取——不取背包第一颗任意种子
          const seeds = c.bot.inventory?.items()?.find(it => seedsByMode.has(it.name))
          if (!seeds) return { planted, noSeeds: true }
          try {
            await withTimeout(c.bot.equip(seeds, 'hand'), 10000, 'equip timeout')
            // 竞速取消：stop 后不再等待放置结果（残余放置由服务端自然收敛）
            await raceAbort(
              withTimeout(c.bot.placeBlock(soil, { x: 0, y: 1, z: 0 }), 30000, 'place timeout'), // 种在方块上方
              runtime?.signal,
              '种植被中断'
            )
            planted++
          } catch (err) {
            if (err?.name === 'AbortError') throw err // 中断上抛（executor 转 ok:false——不吞成"种植失败"重试）
            c.logger.warn({ err: err.message }, '种植失败（可能没有种子或位置不可用）')
            break
          }
        }
      }
      return { planted }
    }
  })

}
