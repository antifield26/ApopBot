// 任务类型单一注册表——统一为 name → { factory, naturalCompletion } 单点定义，
// manager.js 装载与 config.js 校验均从注册表派生。

// 已切换类型经 ScriptTask + scripts/*.js
import { ScriptTask } from './runner.ts'
import afkScript from './scripts/afk.ts'
import fishScript from './scripts/fish.ts'
import mineScript from './scripts/mine.ts'
import chopScript from './scripts/chop.ts'
import farmScript from './scripts/farm.ts'
import combatScript from './scripts/combat.ts'
import breedScript from './scripts/breed.ts'
import exploreScript from './scripts/explore.ts'

export const TASK_TYPES = {
  mine: { factory: (id, options, ctx) => new ScriptTask(id, 'mine', options, ctx, mineScript), naturalCompletion: true },
  fish: { factory: (id, options, ctx) => new ScriptTask(id, 'fish', options, ctx, fishScript), naturalCompletion: false },
  afk: { factory: (id, options, ctx) => new ScriptTask(id, 'afk', options, ctx, afkScript), naturalCompletion: false },
  farm: { factory: (id, options, ctx) => new ScriptTask(id, 'farm', options, ctx, farmScript), naturalCompletion: true },
  chop: { factory: (id, options, ctx) => new ScriptTask(id, 'chop', options, ctx, chopScript), naturalCompletion: true },
  combat: { factory: (id, options, ctx) => new ScriptTask(id, 'combat', options, ctx, combatScript), naturalCompletion: true },
  breed: { factory: (id, options, ctx) => new ScriptTask(id, 'breed', options, ctx, breedScript), naturalCompletion: true },
  explore: { factory: (id, options, ctx) => new ScriptTask(id, 'explore', options, ctx, exploreScript), naturalCompletion: false } // 螺旋探索
}
