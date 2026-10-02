/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：新增 fieldReturns 现场回传对账表（旧数据不动，升级后照常打开）
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { FieldReturn } from '../types/fieldReturn';
import type { ReconLine } from './fieldReturn';
import { estimateEvapMm, stateFromOpening } from './brine';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  fieldReturns!: Table<FieldReturn, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(2)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：新增 fieldReturns 现场回传对账表（只建新表，旧数据不动） ----------
    this.version(DB_SCHEMA_VERSION).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
      gates: 'id, fromPondId, toPondId, state, openingPct',
      observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
      assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
      schedules: 'id, pondId, planDate, state, orderIndex',
      fieldReturns:
        'id, batchId, kind, status, pondId, gateId, importedAt, seq, [fromPondId+toPondId], [pondId+date]',
    });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与现场回传 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.fieldReturns],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      await db.fieldReturns.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    },
  );
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 现场回传对账 ------------------------------ */

export async function listFieldReturns(): Promise<FieldReturn[]> {
  const rows = await db.fieldReturns.toArray();
  return rows.sort((a, b) => (a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : b.seq - a.seq));
}

export async function removeFieldReturn(id: string): Promise<void> {
  await db.fieldReturns.delete(id);
}

export interface FieldReturnCommitResult {
  /** 实际落库的回传行数（全部） */
  total: number
  /** 并入台账的行数 */
  merged: number
  /** 待对认（闸门对不上，搁置未建闸） */
  pending: number
  /** 跳过的坏行/重复行 */
  skipped: number
}

/**
 * 把一次回传批次对账并入：
 * - 池况行只覆盖观测的水位/密度（现场字段）；温度、风力等调度字段保持现值；
 *   当日无观测时按现场值新建，温度/风力取保守默认值并在 reason 里提示补录
 * - 闸门行只改对认到的既有闸门开度/状态；对不上的行原样以「待对认」落库，不新建闸门
 * - 坏行/重复行只落账（状态=已跳过），不影响其余行
 * 台账写入与回传落账在同一个事务内：任何一行失败整批回滚。
 */
export async function commitFieldReturns(lines: ReconLine[], batchId: string): Promise<FieldReturnCommitResult> {
  const stamp = nowIso();
  await db.transaction(
    'rw',
    db.fieldReturns,
    db.observations,
    db.gates,
    async () => {
      for (const line of lines) {
        if (line.status === '已并入' && line.kind === '池况') {
          if (line.densityGcm3 === null || line.levelCm === null) continue;
          const existing = await db.observations
            .where('[pondId+date]')
            .equals([line.pondId, line.date])
            .first();
          if (existing === undefined) {
            // 台账无当日观测：现场只能补水位/密度，温度与风力取保守默认值，等调度员补录
            const tempC = 25;
            const windLevel = 2;
            const row: Observation = {
              id: uuid('obs'),
              pondId: line.pondId,
              date: line.date,
              densityGcm3: line.densityGcm3,
              tempC,
              levelCm: line.levelCm,
              windLevel,
              evapMm: estimateEvapMm(line.densityGcm3, tempC, line.levelCm, windLevel),
              createdAt: stamp,
              updatedAt: stamp,
              revision: ROW_REVISION,
            };
            await db.observations.put(row);
          } else {
            // 只认现场字段（水位/密度）；温度、风力、id、日期等一律不动
            const densityGcm3 = line.densityGcm3;
            const levelCm = line.levelCm;
            await db.observations.update(existing.id, {
              densityGcm3,
              levelCm,
              evapMm: estimateEvapMm(densityGcm3, existing.tempC, levelCm, existing.windLevel),
              updatedAt: stamp,
            });
          }
        } else if (line.status === '已并入' && line.kind === '闸门' && line.gateId !== '') {
          if (line.openingPct === null) continue;
          // 只认现场字段（实测开度）；口宽、走向、备注保持调度配置
          await db.gates.update(line.gateId, {
            openingPct: line.openingPct,
            state: stateFromOpening(line.openingPct),
            updatedAt: stamp,
          });
        }

        const row: FieldReturn = {
          id: uuid('ret'),
          batchId,
          seq: line.seq,
          kind: line.kind,
          rawLine: line.rawLine,
          pondCode: line.pondCode,
          pondId: line.pondId,
          fromCode: line.fromCode,
          fromPondId: line.fromPondId,
          toCode: line.toCode,
          toPondId: line.toPondId,
          date: line.date,
          levelCm: line.levelCm,
          densityGcm3: line.densityGcm3,
          openingPct: line.openingPct,
          gateId: line.gateId,
          status: line.status,
          reason: line.reason,
          importedAt: stamp,
          resolvedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        };
        await db.fieldReturns.put(row);
      }
    },
  );
  return {
    total: lines.length,
    merged: lines.filter((line) => line.status === '已并入').length,
    pending: lines.filter((line) => line.status === '待对认').length,
    skipped: lines.filter((line) => line.status === '已跳过').length,
  };
}

/**
 * 待对认闸门重新对认：按当前闸门表再认一次（不改文本，不新建闸门）。
 * - 对认到唯一闸门 → 回写开度，回传行置为「已并入」
 * - 仍对不上 → 原样搁置，返回 false
 */
export async function retryFieldReturn(rowId: string): Promise<boolean> {
  const stamp = nowIso();
  return db.transaction('rw', db.fieldReturns, db.gates, async () => {
    const row = await db.fieldReturns.get(rowId);
    if (row === undefined || row.status !== '待对认' || row.kind !== '闸门') return false;
    const hits = (await db.gates.toArray()).filter(
      (gate) => gate.fromPondId === row.fromPondId && gate.toPondId === row.toPondId,
    );
    if (hits.length !== 1 || row.openingPct === null) return false;
    const gate = hits[0];
    await db.gates.update(gate.id, {
      openingPct: row.openingPct,
      state: stateFromOpening(row.openingPct),
      updatedAt: stamp,
    });
    await db.fieldReturns.update(row.id, {
      gateId: gate.id,
      status: '已并入',
      reason: '',
      resolvedAt: stamp,
      updatedAt: stamp,
    });
    return true;
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  /** v3 新增；v1/v2 旧存档里没有该字段，导入时按空数组处理 */
  fieldReturns?: FieldReturn[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, fieldReturns] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.fieldReturns.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    fieldReturns,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.fieldReturns],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.fieldReturns.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      // 旧版存档（v1/v2）没有现场回传数据：空数组合并，旧数据照常打开
      await db.fieldReturns.bulkPut(
        (snapshot.fieldReturns ?? []).map((row) => ({ ...row, revision: ROW_REVISION })),
      );
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.fieldReturns],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.fieldReturns.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, fieldReturns] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.fieldReturns.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, fieldReturns };
}
