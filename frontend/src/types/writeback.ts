/**
 * 巡检终端现场回传（Writeback）
 * 班组巡池后把记录回传，调度员在对账页确认并入。
 * 认现场：水位、密度、闸门实测开度以回传为准；走水排程与目标密度归调度员，回传不触碰。
 */

/** 闸门实测开度读数：按「上游池号 → 下游池号」认到已有串级 */
export interface InspectionGateReading {
  /** 上游池号（台账 Pond.code） */
  fromPondCode: string;
  /** 下游池号（台账 Pond.code） */
  toPondCode: string;
  /** 闸门实测开度（%） */
  openingPct: number;
}

/** 巡检终端回传的单口池记录 */
export interface InspectionRecord {
  /** 池号（台账 Pond.code） */
  pondCode: string;
  /** 观测日期 YYYY-MM-DD（缺省取批次日期或今天） */
  date: string;
  /** 密度（g/cm³）—— 现场字段，认回传 */
  densityGcm3: number;
  /** 水位（cm）—— 现场字段，认回传 */
  levelCm: number;
  /** 温度（℃）—— 现场字段，缺省沿用台账或默认值 */
  tempC?: number;
  /** 风力等级（0–8）—— 现场字段，缺省沿用台账或默认值 */
  windLevel?: number;
  /** 该池相关的闸门实测开度（按上下游池对认到已有串级） */
  gates: InspectionGateReading[];
  /** 原始行号 / 序号，用于对账提示 */
  ref: string;
}

/** 巡检批次：终端一次回传的整体 */
export interface InspectionBatch {
  /** 批次号（终端导出，可空） */
  batchNo: string;
  /** 现场采集时间 ISO（同池重复时取最新） */
  inspectedAt: string;
  /** 解析出的记录（尚未去重 / 对账） */
  records: InspectionRecord[];
}

/** 单条闸门读数的对账结果 */
export interface ReconciledGate {
  fromPondCode: string;
  toPondCode: string;
  openingPct: number;
  /** matched=认到已有串级并更新开度；held=对不上先搁着（不新建）；skipped=读数本身坏了 */
  status: 'matched' | 'held' | 'skipped';
  /** 认到的闸门 id（status=matched 时有值） */
  gateId?: string;
  /** 认到的闸门展示名（status=matched 时有值） */
  gateLabel?: string;
  /** 开度调整前值（status=matched 时有值） */
  beforeOpening?: number;
  /** 原因（held / skipped 时写明） */
  reason: string;
}

/** 单口池记录的对账结果 */
export interface ReconciledEntry {
  ref: string;
  pondCode: string;
  date: string;
  densityGcm3: number;
  levelCm: number;
  tempC?: number;
  windLevel?: number;
  /** merged=并入卤水日观测；skipped=坏条目跳过（写明原因） */
  status: 'merged' | 'skipped';
  /** 跳过原因（status=skipped 时写明） */
  reason: string;
  gates: ReconciledGate[];
}

/** 解析阶段就丢弃的坏块（无法解析的行 / JSON 块） */
export interface DroppedBlock {
  ref: string;
  reason: string;
}

/** 回传对账报告：解析 + 去重 + 对账后的结果，供页面展示与并入 */
export interface WritebackReport {
  batchNo: string;
  inspectedAt: string;
  entries: ReconciledEntry[];
  /** 同池重复被去掉的条数（只留一条） */
  dedupedCount: number;
  /** 解析时丢弃的坏块数 */
  parseDropped: number;
  /** 解析阶段丢弃的坏块明细 */
  dropped: DroppedBlock[];
}

/** 解析原始结果 */
export interface ParseInspectionResult {
  ok: boolean;
  message: string;
  batch: InspectionBatch | null;
  /** 无法解析的行 / 块（写明原因） */
  dropped: DroppedBlock[];
}
