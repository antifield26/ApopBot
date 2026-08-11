// @ts-check
// 任务/原语公共工具。

/** 区域对象校验（farm/collect/combat/breed/explore 与原语共用；六坐标整数）。 */
export function isArea (a) {
  return a && ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].every(k => Number.isInteger(a[k]))
}
