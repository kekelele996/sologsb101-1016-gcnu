/**
 * 巡检回传解析与对账（纯函数，不触库）
 * - 支持 JSON（终端导出）与文本（每行一条，逗号分隔）两种格式
 * - 同池重复传只留一条（取最新日期 / 采集时间，并列时后出现的覆盖）
 * - 闸门按「上游池号 → 下游池号」对认到已有串级；对不上先搁着，不新建闸门
 * - 坏条目跳过并写明原因，其余照常并入
 */
import type { Gate } from '../types/gate';
import type { Pond } from '../types/pond';
import type {
  DroppedBlock,
  InspectionBatch,
  InspectionGateReading,
  InspectionRecord,
  ParseInspectionResult,
  ReconciledEntry,
  ReconciledGate,
  WritebackReport,
} from '../types/writeback';
import { today } from './id';

/** 文本格式示例（供页面「填入示例」使用） */
export const WRITEBACK_SAMPLE = `# 巡检终端回传 · 2026-10-02
# 格式：池号,日期,密度,水位,温度,风力,上游池号>下游池号@开度,上游池号>下游池号@开度...
# 以 # 开头的行是注释，空行忽略；闸门读数可写多个，用逗号分隔。
北-01,2026-10-02,1.095,42,26,2,北-01>北-02@60
北-01,2026-10-01,1.090,43,26,2
北-02,2026-10-02,1.170,36,26,2,北-02>北-03@45
南-04,2026-10-02,1.092,44,27,3,南-04>南-05@80,南-04>南-06@55
北-99,2026-10-02,1.050,40,26,2
北-03,2026-10-02,,30,26,2`;

/** JSON 模板（供页面「下载模板」使用） */
export const WRITEBACK_TEMPLATE = `{
  "batchNo": "XJ-20261002-01",
  "inspectedAt": "2026-10-02T08:30:00.000Z",
  "records": [
    {
      "pondCode": "北-01",
      "date": "2026-10-02",
      "densityGcm3": 1.095,
      "levelCm": 42,
      "tempC": 26,
      "windLevel": 2,
      "gates": [
        { "fromPondCode": "北-01", "toPondCode": "北-02", "openingPct": 60 }
      ]
    }
  ]
}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 解析单个闸门读数 token：「上游池号>下游池号@开度」（也支持 → 作为分隔） */
export function parseGateToken(token: string): InspectionGateReading | null {
  const atIdx = token.lastIndexOf('@');
  if (atIdx < 0) return null;
  const pair = token.slice(0, atIdx).trim();
  const opening = Number(token.slice(atIdx + 1).trim());
  if (!isFiniteNumber(opening) || opening < 0 || opening > 100) return null;
  const gtIdx = pair.indexOf('>');
  const arrowIdx = pair.indexOf('→');
  const cut = gtIdx < 0 ? arrowIdx : arrowIdx < 0 ? gtIdx : Math.max(gtIdx, arrowIdx);
  if (cut < 0) return null;
  const from = pair.slice(0, cut).trim();
  const to = pair.slice(cut + 1).trim();
  if (from === '' || to === '') return null;
  return { fromPondCode: from, toPondCode: to, openingPct: opening };
}

/** 把 JSON 里的单条记录转成 InspectionRecord；坏块丢进 dropped */
function jsonRecordToInspection(item: unknown, index: number, dropped: DroppedBlock[]): InspectionRecord | null {
  const ref = `第 ${index + 1} 条`;
  if (typeof item !== 'object' || item === null) {
    dropped.push({ ref, reason: '记录不是对象' });
    return null;
  }
  const raw = item as Record<string, unknown>;
  const pondCode = typeof raw.pondCode === 'string' ? raw.pondCode.trim() : '';
  if (pondCode === '') {
    dropped.push({ ref, reason: '缺少池号（pondCode）' });
    return null;
  }
  const density = Number(raw.densityGcm3);
  if (!isFiniteNumber(density) || density <= 0) {
    dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: '密度缺失或非法' });
    return null;
  }
  const level = Number(raw.levelCm);
  if (!isFiniteNumber(level) || level < 0) {
    dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: '水位缺失或非法' });
    return null;
  }
  let date = today();
  if (raw.date !== undefined && raw.date !== null && raw.date !== '') {
    if (typeof raw.date !== 'string' || !DATE_RE.test(raw.date)) {
      dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: '日期格式不正确（应为 YYYY-MM-DD）' });
      return null;
    }
    date = raw.date;
  }
  const tempC = raw.tempC === undefined || raw.tempC === null ? undefined : Number(raw.tempC);
  const windLevel = raw.windLevel === undefined || raw.windLevel === null ? undefined : Number(raw.windLevel);
  const gates: InspectionGateReading[] = [];
  if (Array.isArray(raw.gates)) {
    raw.gates.forEach((gateItem, gateIndex) => {
      if (typeof gateItem !== 'object' || gateItem === null) {
        dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: `第 ${gateIndex + 1} 个闸门读数不是对象，已跳过该闸门` });
        return;
      }
      const g = gateItem as Record<string, unknown>;
      const from = typeof g.fromPondCode === 'string' ? g.fromPondCode.trim() : '';
      const to = typeof g.toPondCode === 'string' ? g.toPondCode.trim() : '';
      const opening = Number(g.openingPct);
      if (from === '' || to === '' || !isFiniteNumber(opening) || opening < 0 || opening > 100) {
        dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: `第 ${gateIndex + 1} 个闸门读数缺上游 / 下游池号或开度非法，已跳过该闸门` });
        return;
      }
      gates.push({ fromPondCode: from, toPondCode: to, openingPct: opening });
    });
  }
  return {
    pondCode,
    date,
    densityGcm3: density,
    levelCm: level,
    tempC: isFiniteNumber(tempC) ? tempC : undefined,
    windLevel: isFiniteNumber(windLevel) ? windLevel : undefined,
    gates,
    ref,
  };
}

/** 解析 JSON 格式回传 */
function parseInspectionJson(text: string): ParseInspectionResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认是巡检终端导出的记录（顶层为对象或数组）。', batch: null, dropped: [] };
  }
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const recordsRaw = Array.isArray(obj.records) ? obj.records : Array.isArray(raw) ? raw : null;
  if (recordsRaw === null) {
    return { ok: false, message: 'JSON 中缺少 records 数组（或顶层直接是记录数组）。', batch: null, dropped: [] };
  }
  const dropped: DroppedBlock[] = [];
  const records: InspectionRecord[] = [];
  recordsRaw.forEach((item, index) => {
    const parsed = jsonRecordToInspection(item, index, dropped);
    if (parsed !== null) records.push(parsed);
  });
  return {
    ok: true,
    message: `解析到 ${records.length} 条记录${dropped.length > 0 ? `，${dropped.length} 块丢弃` : ''}。`,
    batch: {
      batchNo: typeof obj.batchNo === 'string' ? obj.batchNo : '',
      inspectedAt: typeof obj.inspectedAt === 'string' ? obj.inspectedAt : '',
      records,
    },
    dropped,
  };
}

/** 解析文本格式回传（每行一条：池号,日期,密度,水位,温度,风力,闸门,闸门...） */
function parseInspectionLines(text: string): ParseInspectionResult {
  const dropped: DroppedBlock[] = [];
  const records: InspectionRecord[] = [];
  text.split('\n').forEach((line, index) => {
    const ref = `第 ${index + 1} 行`;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/[,，\t]/).map((item) => item.trim());
    const pondCode = parts[0] ?? '';
    if (pondCode === '') {
      dropped.push({ ref, reason: '缺少池号' });
      return;
    }
    const dateRaw = parts[1] ?? '';
    const date = dateRaw === '' ? today() : dateRaw;
    if (!DATE_RE.test(date)) {
      dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: '日期格式不正确（应为 YYYY-MM-DD）' });
      return;
    }
    const density = Number(parts[2]);
    if (!isFiniteNumber(density) || density <= 0) {
      dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: '密度缺失或非法' });
      return;
    }
    const level = Number(parts[3]);
    if (!isFiniteNumber(level) || level < 0) {
      dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: '水位缺失或非法' });
      return;
    }
    const tempRaw = parts[4];
    const tempC = tempRaw === undefined || tempRaw === '' ? undefined : Number(tempRaw);
    const windRaw = parts[5];
    const windLevel = windRaw === undefined || windRaw === '' ? undefined : Number(windRaw);
    const gates: InspectionGateReading[] = [];
    for (let k = 6; k < parts.length; k += 1) {
      const token = parts[k];
      const gate = parseGateToken(token);
      if (gate === null) {
        dropped.push({ ref: `${ref}（池号 ${pondCode}）`, reason: `闸门读数「${token}」格式坏，已跳过该闸门` });
        continue;
      }
      gates.push(gate);
    }
    records.push({
      pondCode,
      date,
      densityGcm3: density,
      levelCm: level,
      tempC: isFiniteNumber(tempC) ? tempC : undefined,
      windLevel: isFiniteNumber(windLevel) ? windLevel : undefined,
      gates,
      ref,
    });
  });
  return {
    ok: true,
    message: `解析到 ${records.length} 条记录${dropped.length > 0 ? `，${dropped.length} 块丢弃` : ''}。`,
    batch: { batchNo: '', inspectedAt: '', records },
    dropped,
  };
}

/** 解析巡检回传文本（自动识别 JSON / 行文本） */
export function parseInspectionText(text: string): ParseInspectionResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, message: '请粘贴巡检终端回传记录（JSON 或文本格式）。', batch: null, dropped: [] };
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseInspectionJson(trimmed);
  }
  return parseInspectionLines(trimmed);
}

/**
 * 对账：同池去重 → 坏条目跳过 → 闸门认到已有串级。
 * 纯函数，不触库；页面与 store 共用。
 */
export function reconcileWriteback(batch: InspectionBatch, ponds: Pond[], gates: Gate[]): WritebackReport {
  const pondByCode = new Map<string, Pond>();
  ponds.forEach((pond) => pondByCode.set(pond.code, pond));
  const gateByPair = new Map<string, Gate>();
  gates.forEach((gate) => gateByPair.set(`${gate.fromPondId}|${gate.toPondId}`, gate));

  // 同池重复传只留一条：取最新日期；日期并列时后出现的覆盖（视为更正重发）
  const bestByPond = new Map<string, { record: InspectionRecord; index: number }>();
  batch.records.forEach((record, index) => {
    const prev = bestByPond.get(record.pondCode);
    if (prev === undefined || record.date > prev.record.date || (record.date === prev.record.date && index > prev.index)) {
      bestByPond.set(record.pondCode, { record, index });
    }
  });
  const dedupedCount = batch.records.length - bestByPond.size;

  const entries: ReconciledEntry[] = [];
  bestByPond.forEach(({ record }) => {
    const pond = pondByCode.get(record.pondCode);
    if (pond === undefined) {
      entries.push({
        ref: record.ref,
        pondCode: record.pondCode,
        date: record.date,
        densityGcm3: record.densityGcm3,
        levelCm: record.levelCm,
        tempC: record.tempC,
        windLevel: record.windLevel,
        status: 'skipped',
        reason: `池号「${record.pondCode}」在台账中不存在`,
        gates: record.gates.map((g) => ({
          ...g,
          status: 'skipped' as const,
          reason: '池号不存在，闸门未对账',
        })),
      });
      return;
    }
    if (!isFiniteNumber(record.densityGcm3) || record.densityGcm3 <= 0) {
      entries.push({
        ref: record.ref,
        pondCode: record.pondCode,
        date: record.date,
        densityGcm3: record.densityGcm3,
        levelCm: record.levelCm,
        status: 'skipped',
        reason: '密度缺失或非法',
        gates: record.gates.map((g) => ({ ...g, status: 'skipped' as const, reason: '观测条目坏，闸门未对账' })),
      });
      return;
    }
    if (!isFiniteNumber(record.levelCm) || record.levelCm < 0) {
      entries.push({
        ref: record.ref,
        pondCode: record.pondCode,
        date: record.date,
        densityGcm3: record.densityGcm3,
        levelCm: record.levelCm,
        status: 'skipped',
        reason: '水位缺失或非法',
        gates: record.gates.map((g) => ({ ...g, status: 'skipped' as const, reason: '观测条目坏，闸门未对账' })),
      });
      return;
    }
    if (!DATE_RE.test(record.date)) {
      entries.push({
        ref: record.ref,
        pondCode: record.pondCode,
        date: record.date,
        densityGcm3: record.densityGcm3,
        levelCm: record.levelCm,
        status: 'skipped',
        reason: '日期格式不正确（应为 YYYY-MM-DD）',
        gates: record.gates.map((g) => ({ ...g, status: 'skipped' as const, reason: '观测条目坏，闸门未对账' })),
      });
      return;
    }

    const reconciledGates: ReconciledGate[] = record.gates.map((g) => {
      const fromPond = pondByCode.get(g.fromPondCode);
      const toPond = pondByCode.get(g.toPondCode);
      if (fromPond === undefined || toPond === undefined) {
        const missing: string[] = [];
        if (fromPond === undefined) missing.push(`上游池号「${g.fromPondCode}」不存在`);
        if (toPond === undefined) missing.push(`下游池号「${g.toPondCode}」不存在`);
        return { ...g, status: 'held' as const, reason: `${missing.join('；')}，闸门先搁着` };
      }
      const gate = gateByPair.get(`${fromPond.id}|${toPond.id}`);
      if (gate === undefined) {
        return { ...g, status: 'held' as const, reason: `未找到 ${g.fromPondCode}→${g.toPondCode} 的串级闸门，先搁着（不新建）` };
      }
      return {
        ...g,
        status: 'matched' as const,
        gateId: gate.id,
        gateLabel: `${g.fromPondCode}→${g.toPondCode}`,
        beforeOpening: gate.openingPct,
        reason: '',
      };
    });

    entries.push({
      ref: record.ref,
      pondCode: record.pondCode,
      date: record.date,
      densityGcm3: record.densityGcm3,
      levelCm: record.levelCm,
      tempC: record.tempC,
      windLevel: record.windLevel,
      status: 'merged',
      reason: '',
      gates: reconciledGates,
    });
  });

  entries.sort((a, b) => a.pondCode.localeCompare(b.pondCode, 'zh-Hans-CN'));

  return {
    batchNo: batch.batchNo,
    inspectedAt: batch.inspectedAt,
    entries,
    dedupedCount,
    parseDropped: 0,
    dropped: [],
  };
}

/** 统计报告中的各类数量 */
export function summarizeReport(report: WritebackReport): {
  merged: number;
  skipped: number;
  gatesMatched: number;
  gatesHeld: number;
  gatesSkipped: number;
} {
  let merged = 0;
  let skipped = 0;
  let gatesMatched = 0;
  let gatesHeld = 0;
  let gatesSkipped = 0;
  report.entries.forEach((entry) => {
    if (entry.status === 'merged') merged += 1;
    else skipped += 1;
    entry.gates.forEach((gate) => {
      if (gate.status === 'matched') gatesMatched += 1;
      else if (gate.status === 'held') gatesHeld += 1;
      else gatesSkipped += 1;
    });
  });
  return { merged, skipped, gatesMatched, gatesHeld, gatesSkipped };
}
