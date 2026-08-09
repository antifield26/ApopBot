// 任务类型单一注册表（第六轮 C3，roadmap R1 缓做项）——此前类型清单三处手工同步：
// manager.js TASK_TYPES（工厂）+ config.js KNOWN_TASK_TYPES（名字）+ config.js
// NATURAL_COMPLETION_TYPES（完成语义），靠 tests/config.test.mjs 一致性断言防漂移。
// 统一为 name → { factory, naturalCompletion } 单点定义，两处从注册表派生。

import { MineTask } from './mine.js'
import { FarmTask } from './farm.js'
import { ChopTask } from './chop.js'
import { CombatTask } from './combat.js'
import { BreedTask } from './breed.js'
import { ExploreTask } from './explore.js'
// v1.0.0 C6+：afk/fish 已脚本化（ScriptTask + scripts/*.js）——其余任务 C7-C10 逐个切换
import { ScriptTask } from './runner.js'
import afkScript from './scripts/afk.js'
import fishScript from './scripts/fish.js'

export const TASK_TYPES = {
  mine: { factory: (id, options, ctx) => new MineTask(id, 'mine', options, ctx), naturalCompletion: true },
  fish: { factory: (id, options, ctx) => new ScriptTask(id, 'fish', options, ctx, fishScript), naturalCompletion: false },
  afk: { factory: (id, options, ctx) => new ScriptTask(id, 'afk', options, ctx, afkScript), naturalCompletion: false },
  farm: { factory: (id, options, ctx) => new FarmTask(id, 'farm', options, ctx), naturalCompletion: true },
  chop: { factory: (id, options, ctx) => new ChopTask(id, 'chop', options, ctx), naturalCompletion: true },
  combat: { factory: (id, options, ctx) => new CombatTask(id, 'combat', options, ctx), naturalCompletion: true },
  breed: { factory: (id, options, ctx) => new BreedTask(id, 'breed', options, ctx), naturalCompletion: true },
  explore: { factory: (id, options, ctx) => new ExploreTask(id, 'explore', options, ctx), naturalCompletion: false } // L2 进化 C2：螺旋探索
}
