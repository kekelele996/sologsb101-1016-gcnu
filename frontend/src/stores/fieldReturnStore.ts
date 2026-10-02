/**
 * 现场回传对账状态管理（Solid 原生能力）
 * liveQuery 订阅 fieldReturns；解析对认用 utils/fieldReturn 的纯函数，落库走 db 事务。
 * 现场只管水位/密度/闸门实测开度；排程与目标由调度员维护，本 store 不触碰 schedules。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { liveQuery } from 'dexie';
import type { FieldReturn, FieldReturnStatus } from '../types/fieldReturn';
import { commitFieldReturns, db, initDatabase, removeFieldReturn, retryFieldReturn } from '../utils/db';
import { reconcileFieldReturn, type ReconLine, type ReconPond, type ReconGate, type ReconObservation } from '../utils/fieldReturn';
import { uuid } from '../utils/id';

/** 历史台账筛选：状态 + 关键字（池号/行原文） */
export interface FieldReturnFilters {
  status: FieldReturnStatus | 'all';
  keyword: string;
}

const EMPTY_FILTERS: FieldReturnFilters = { status: 'all', keyword: '' };

function createFieldReturnStore() {
  const [rows, setRows] = createSignal<FieldReturn[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [lastMessage, setLastMessage] = createSignal('');
  const [filters, setFilters] = createSignal<FieldReturnFilters>({ ...EMPTY_FILTERS });

  // 与 observationStore 同理：建库必须在 liveQuery 的 querier 之外发起
  void initDatabase();

  liveQuery(async () => db.fieldReturns.toArray()).subscribe({
    next: (list) => {
      setRows(
        [...list].sort((a, b) =>
          a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : b.seq - a.seq,
        ),
      );
      setLoading(false);
      setError('');
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '读取现场回传数据失败');
      setLoading(false);
    },
  });

  function patchFilters(patch: Partial<FieldReturnFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  /** 纯解析：给页面做「先预览后并入」 */
  function preview(
    text: string,
    ponds: ReconPond[],
    gates: ReconGate[],
    observations: ReconObservation[],
  ): ReturnType<typeof reconcileFieldReturn> {
    return reconcileFieldReturn(text, ponds, gates, observations);
  }

  /** 并入台账：返回成功/失败消息供页面提示 */
  async function commit(lines: ReconLine[]): Promise<void> {
    if (lines.length === 0) {
      setLastMessage('没有可并入的行：请先粘贴巡检终端回传的文本。');
      return;
    }
    const batchId = uuid('batch');
    const result = await commitFieldReturns(lines, batchId);
    setLastMessage(
      `本批共 ${result.total} 行：并入 ${result.merged} 行，闸门待对认 ${result.pending} 行，跳过坏行/重复行 ${result.skipped} 行。` +
        '水位、密度与闸门开度已认现场；走水排程与目标设定未改动。',
    );
  }

  /** 待对认闸门按当前串级重新对认一次（仍不新建闸门） */
  async function retry(id: string): Promise<boolean> {
    const ok = await retryFieldReturn(id);
    if (ok) {
      setLastMessage('已重新对认到既有闸门，实测开度并入台账。');
    } else {
      setLastMessage('仍对认不上：串级中依旧没有唯一对应的闸门，继续搁置（不会自动新建闸门）。');
    }
    return ok;
  }

  async function remove(id: string): Promise<void> {
    await removeFieldReturn(id);
    setLastMessage('已删除该条回传记录（已并入的台账数据不受影响）。');
  }

  const stats = createMemo(() => {
    const list = rows();
    return {
      total: list.length,
      merged: list.filter((row) => row.status === '已并入').length,
      pending: list.filter((row) => row.status === '待对认').length,
      skipped: list.filter((row) => row.status === '已跳过').length,
    };
  });

  /** 筛选后的历史行 */
  const visible = createMemo<FieldReturn[]>(() => {
    const current = filters();
    const keyword = current.keyword.trim().toLowerCase();
    return rows().filter((row) => {
      if (current.status !== 'all' && row.status !== current.status) return false;
      if (keyword === '') return true;
      return (
        row.pondCode.toLowerCase().includes(keyword) ||
        row.fromCode.toLowerCase().includes(keyword) ||
        row.toCode.toLowerCase().includes(keyword) ||
        row.rawLine.toLowerCase().includes(keyword)
      );
    });
  });

  /** 按批次归组（历史时间线用） */
  const batches = createMemo<Array<{ batchId: string; importedAt: string; rows: FieldReturn[] }>>(() => {
    const map = new Map<string, { batchId: string; importedAt: string; rows: FieldReturn[] }>();
    visible().forEach((row) => {
      const group = map.get(row.batchId);
      if (group === undefined) {
        map.set(row.batchId, { batchId: row.batchId, importedAt: row.importedAt, rows: [row] });
      } else {
        group.rows.push(row);
      }
    });
    return Array.from(map.values()).sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
  });

  return {
    rows,
    visible,
    batches,
    stats,
    loading,
    error,
    lastMessage,
    setLastMessage,
    filters,
    patchFilters,
    resetFilters,
    preview,
    commit,
    retry,
    remove,
  };
}

const store = createRoot(createFieldReturnStore);

export function useFieldReturnStore() {
  return store;
}
