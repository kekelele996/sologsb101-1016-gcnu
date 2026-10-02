/**
 * 现场回传（FieldReturn）
 * 盐田班组巡检终端回场后回传的现场实测台账行，与调度员的排程/目标字段分治：
 * - 认现场：每口蒸发池的水位、密度，闸门实测开度（回传只允许写这三类字段）
 * - 认调度：走水排程、目标密度、温度/风力、闸门口宽与拓扑，回传一律不碰
 * 闸门行按「上游池→下游池」对认到已有串级：对认不上先搁着（待对认），绝不新建闸门。
 */

/** 回传行类别：池况（水位/密度）/ 闸门（实测开度） */
export type FieldReturnKind = '池况' | '闸门'

export const FIELD_RETURN_KIND_OPTIONS: FieldReturnKind[] = ['池况', '闸门']

/** 对账结果：已并入台账 / 待对认（闸门串级对不上）/ 已跳过（坏行或重复行） */
export type FieldReturnStatus = '已并入' | '待对认' | '已跳过'

export const FIELD_RETURN_STATUS_OPTIONS: FieldReturnStatus[] = ['已并入', '待对认', '已跳过']

export interface FieldReturn {
  id: string
  /** 同一次粘贴回传共用一个批次号 */
  batchId: string
  /** 在原文本中的行号（空行与注释行也计入，从 1 开始） */
  seq: number
  kind: FieldReturnKind
  /** 原始文本，备查 */
  rawLine: string
  /** 池况行的池号 */
  pondCode: string
  /** 对认到的蒸发池 id；'' 表示池号在台账中不存在（坏行） */
  pondId: string
  /** 闸门行上游池号 / 对认到的 id */
  fromCode: string
  fromPondId: string
  /** 闸门行下游池号 / 对认到的 id */
  toCode: string
  toPondId: string
  /** 观测日期 YYYY-MM-DD（池况行） */
  date: string
  /** 实测水位（cm） */
  levelCm: number | null
  /** 实测密度（g/cm³） */
  densityGcm3: number | null
  /** 闸门实测开度（%） */
  openingPct: number | null
  /** 对认到的闸门 id；'' 表示待对认 */
  gateId: string
  status: FieldReturnStatus
  /** 跳过原因 / 待对认说明；已并入且覆盖既有记录时为 '' */
  reason: string
  /** 回传并入时间 */
  importedAt: string
  /** 待对认行重新对认成功的时间 */
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  revision: number
}
