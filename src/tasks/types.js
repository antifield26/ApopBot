// 任务类型单一注册表（第六轮 C3，roadmap R1 缓做项）——此前类型清单三处手工同步：
// manager.js TASK_TYPES（工厂）+ config.js KNOWN_TASK_TYPES（名字）+ config.js
// NATURAL_COMPLETION_TYPES（完成语义），靠 tests/config.test.mjs 一致性断言防漂移。
// 统一为 name → { factory, naturalCompletion } 单点定义，两处从注册表派生。

// v1.0.0 C6+：任务脚本化重构——已切换类型经 ScriptTask + scripts/*.js
import { ScriptTask } from './runner.js'
import afkScript from './scripts/afk.js'
import fishScript from './scripts/fish.js'
import mineScript from './scripts/mine.js'
import chopScript from './scripts/chop.js'
import farmScript from './scripts/farm.js'
import combatScript from './scripts/combat.js'
import breedScript from './scripts/breed.js'
import exploreScript from './scripts/explore.js'

export const TASK_TYPES = {
  mine: { factory: (id, options, ctx) => new ScriptTask(id, 'mine', options, ctx, mineScript), naturalCompletion: true },
  fish: { factory: (id, options, ctx) => new ScriptTask(id, 'fish', options, ctx, fishScript), naturalCompletion: false },
  afk: { factory: (id, options, ctx) => new ScriptTask(id, 'afk', options, ctx, afkScript), naturalCompletion: false },
  farm: { factory: (id, options, ctx) => new ScriptTask(id, 'farm', options, ctx, farmScript), naturalCompletion: true },
  chop: { factory: (id, options, ctx) => new ScriptTask(id, 'chop', options, ctx, chopScript), naturalCompletion: true },
  combat: { factory: (id, options, ctx) => new ScriptTask(id, 'combat', options, ctx, combatScript), naturalCompletion: true },
  breed: { factory: (id, options, ctx) => new ScriptTask(id, 'breed', options, ctx, breedScript), naturalCompletion: true },
  explore: { factory: (id, options, ctx) => new ScriptTask(id, 'explore', options, ctx, exploreScript), naturalCompletion: false } // L2 进化 C2：螺旋探索（C10 脚本化）
}
