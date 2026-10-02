/**
 * 现场回传解析与对账（纯函数，不触碰 IndexedDB）
 * 文本格式（每行一条，支持半角/全角逗号与制表符，# 开头忽略）：
 *   池况行：池号,日期,密度,水位          例：北-01,2026-10-02,1.112,38
 *   闸门行：闸门,上游池号,下游池号,开度%  例：闸门,北-01,北-02,60
 * 对认规则：
 *   - 池况按「池号+日期」对认到已有观测；只覆盖水位/密度，其余字段保持台账现值
 *   - 闸门按「上游池→下游池」对认唯一已有串级；对不上或不唯一 → 待对认，不新建闸门
 *   - 同一口池同一天在本次回传里重复出现，只留首条，其余跳过并写明行号
 *   - 坏行（字段不全、池号不存在、数值越界等）跳过并写明原因，其余照常并入
 */
import type { FieldReturnKind, FieldReturnStatus } from '../types/fieldReturn';

/** 解析阶段需要的台账最小结构（按需从 Pond / Gate / Observation 抽取） */
export interface ReconPond {
  id: string
  code: string
}
export interface ReconGate {
  id: string
  fromPondId: string
  toPondId: string
}
export interface ReconObservation {
  id: string
  pondId: string
  date: string
}

/** 解析后的一行（尚未写库，gateId/并入结果先留空，commit 阶段再补） */
export interface ReconLine {
  seq: number
  kind: FieldReturnKind
  rawLine: string
  pondCode: string
  pondId: string
  fromCode: string
  fromPondId: string
  toCode: string
  toPondId: string
  date: string
  levelCm: number | null
  densityGcm3: number | null
  openingPct: number | null
  gateId: string
  status: FieldReturnStatus
  reason: string
}

/** 预览汇总 */
export interface ReconPreview {
  lines: ReconLine[]
  /** 可并入（池况并入 + 闸门对认成功） */
  merged: number
  /** 闸门待对认 */
  pending: number
  /** 跳过（坏行/重复行） */
  skipped: number
}

const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

/** 校验并归一化日期为 YYYY-MM-DD；非法日期（含 2 月 30 日等）返回 null */
export function normalizeDate(token: string): string | null {
  const match = DATE_RE.exec(token.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 数值列解析：去空白、去掉末尾 %；空串/非数字/非有限值返回 null */
function parseNumber(token: string | undefined): number | null {
  if (token === undefined) return null;
  const text = token.trim().replace(/%$/, '');
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function splitLine(line: string): string[] {
  return line.split(/[,，\t]+/).map((item) => item.trim());
}

function blankLine(seq: number, rawLine: string, kind: FieldReturnKind): ReconLine {
  return {
    seq,
    kind,
    rawLine,
    pondCode: '',
    pondId: '',
    fromCode: '',
    fromPondId: '',
    toCode: '',
    toPondId: '',
    date: '',
    levelCm: null,
    densityGcm3: null,
    openingPct: null,
    gateId: '',
    status: '已跳过',
    reason: '',
  };
}

/** 按池号查池（池号大小写不敏感、去空白比较） */
function resolvePond(code: string, ponds: ReconPond[]): ReconPond | undefined {
  const target = code.trim().toLowerCase();
  return ponds.find((pond) => pond.code.trim().toLowerCase() === target);
}

/** 按上下游池对认唯一闸门；0 条或多条都算对认不上 */
function resolveGate(fromPondId: string, toPondId: string, gates: ReconGate[]): ReconGate | undefined {
  const hits = gates.filter((gate) => gate.fromPondId === fromPondId && gate.toPondId === toPondId);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * 解析终端回传文本并完成对认（不写库）。
 * @param batchId 本次批次号
 */
export function reconcileFieldReturn(
  text: string,
  ponds: ReconPond[],
  gates: ReconGate[],
  observations: ReconObservation[],
): ReconPreview {
  const rawLines = text.split('\n');
  const lines: ReconLine[] = [];
  /** 本次回传内已见过的「池号+日期」，值为首见行号（同池同日只留一条） */
  const seenPondDate = new Map<string, number>();

  rawLines.forEach((raw, index) => {
    const seq = index + 1;
    const rawLine = raw.trim();
    if (rawLine === '' || rawLine.startsWith('#')) return;

    const parts = splitLine(rawLine);
    const kind: FieldReturnKind = parts[0] === '闸门' ? '闸门' : '池况';
    const line = blankLine(seq, rawLine, kind);

    if (kind === '闸门') {
      // 闸门,上游池号,下游池号,开度%
      if (parts.length < 4) {
        line.reason = `字段不全：闸门行应为「闸门,上游池号,下游池号,开度%」，实际 ${parts.length} 列`;
        lines.push(line);
        return;
      }
      line.fromCode = parts[1] ?? '';
      line.toCode = parts[2] ?? '';
      if (line.fromCode === '' || line.toCode === '') {
        line.reason = '闸门行缺少上游池号或下游池号';
        lines.push(line);
        return;
      }
      const opening = parseNumber(parts[3]);
      if (opening === null) {
        line.reason = `开度无法识别：${parts[3] ?? ''}`;
        lines.push(line);
        return;
      }
      if (opening < 0 || opening > 100) {
        line.reason = `开度越界：${opening}%（允许 0–100）`;
        lines.push(line);
        return;
      }
      line.openingPct = opening;
      const from = resolvePond(line.fromCode, ponds);
      const to = resolvePond(line.toCode, ponds);
      if (from === undefined || to === undefined) {
        line.reason = `池号台账中不存在：${from === undefined ? line.fromCode : ''}${
          from === undefined && to === undefined ? '、' : ''
        }${to === undefined ? line.toCode : ''}`;
        lines.push(line);
        return;
      }
      line.fromPondId = from.id;
      line.toPondId = to.id;
      if (from.id === to.id) {
        line.reason = `上下游不能是同一口池（${from.code}）`;
        lines.push(line);
        return;
      }
      const gate = resolveGate(from.id, to.id, gates);
      if (gate === undefined) {
        const count = gates.filter((item) => item.fromPondId === from.id && item.toPondId === to.id).length;
        line.status = '待对认';
        line.reason =
          count === 0
            ? `串级中没有「${line.fromCode} → ${line.toCode}」，先搁置不新建闸门`
            : `「${line.fromCode} → ${line.toCode}」对应 ${count} 条闸门，无法唯一对认，先搁置`;
        lines.push(line);
        return;
      }
      line.gateId = gate.id;
      line.status = '已并入';
      lines.push(line);
      return;
    }

    // 池况行：池号,日期,密度,水位
    if (parts.length < 4) {
      line.pondCode = parts[0] ?? '';
      line.reason = `字段不全：池况行应为「池号,日期,密度,水位」，实际 ${parts.length} 列`;
      lines.push(line);
      return;
    }
    line.pondCode = parts[0] ?? '';
    if (line.pondCode === '') {
      line.reason = '池号为空';
      lines.push(line);
      return;
    }
    const date = normalizeDate(parts[1] ?? '');
    if (date === null) {
      line.reason = `日期无法识别：${parts[1] ?? ''}（需为 YYYY-MM-DD）`;
      lines.push(line);
      return;
    }
    line.date = date;
    const density = parseNumber(parts[2]);
    if (density === null) {
      line.reason = `密度无法识别：${parts[2] ?? ''}`;
      lines.push(line);
      return;
    }
    if (density < 1 || density > 1.4) {
      line.reason = `密度越界：${density} g/cm³（允许 1.000–1.400）`;
      lines.push(line);
      return;
    }
    const level = parseNumber(parts[3]);
    if (level === null) {
      line.reason = `水位无法识别：${parts[3] ?? ''}`;
      lines.push(line);
      return;
    }
    if (level < 0 || level > 500) {
      line.reason = `水位越界：${level} cm（允许 0–500）`;
      lines.push(line);
      return;
    }
    line.densityGcm3 = density;
    line.levelCm = level;

    const pond = resolvePond(line.pondCode, ponds);
    if (pond === undefined) {
      line.reason = `池号台账中不存在：${line.pondCode}`;
      lines.push(line);
      return;
    }
    line.pondId = pond.id;

    // 同池同日：本次回传内只留首条
    const dedupeKey = `${pond.id}@${date}`;
    const firstSeq = seenPondDate.get(dedupeKey);
    if (firstSeq !== undefined) {
      line.reason = `与第 ${firstSeq} 行重复：同池（${pond.code}）同日（${date}）只留一条，本行跳过`;
      lines.push(line);
      return;
    }
    seenPondDate.set(dedupeKey, seq);

    const exists = observations.some((item) => item.pondId === pond.id && item.date === date);
    line.status = '已并入';
    line.reason = exists ? '' : '台账无当日观测，按现场水位/密度新建（温度/风力请调度员补录）';
    lines.push(line);
  });

  return {
    lines,
    merged: lines.filter((line) => line.status === '已并入').length,
    pending: lines.filter((line) => line.status === '待对认').length,
    skipped: lines.filter((line) => line.status === '已跳过').length,
  };
}
