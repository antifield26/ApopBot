// 移动权仲裁器（重构档 R2 根治版）：!find/!follow/任务统一登记"谁在移动"。
// 此前 exclusive 互斥只覆盖任务之间（manager._pendingExclusive），!follow 与
// exclusive 任务无任何防线（S：双控制器冲突——follow 的 setControlState 与任务
// pathfinder 打架，!find 只有口头警告而 !follow 连警告都没有）。
//
// 只做登记/查询，不改变既有命令行为：!find 仍是警告非拒绝；!follow 在
// exclusive 任务运行中拒绝并提示。登记只在任务运行期间存在——重连重建功能层
// 时任务随之 stop/重建，无跨代际残留（模块级单例，单 bot 架构）。
//
// 为什么不登记 !find/!follow 自身：find 是短时移动（秒级），follow 是用户手动
// 开关（有明确 off）——二者与 exclusive 任务的冲突由命令层查询本仲裁器处理。

let exclusiveOwner = null // 当前运行中的 exclusive 任务 id（同一时刻至多一个）

/** exclusive 任务启动/终态时登记/清除（manager startTask 调用）。 */
export function setExclusiveOwner (id) {
  exclusiveOwner = id ?? null
}

/** 当前 exclusive 任务 id（无则 null）。 */
export function getExclusiveOwner () {
  return exclusiveOwner
}

/** 是否有 exclusive 任务在运行（!follow 拒绝、!find 警告用）。 */
export function hasExclusiveActive () {
  return exclusiveOwner !== null
}
