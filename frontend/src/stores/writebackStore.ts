/**
 * 现场回传对账状态管理（Solid 原生能力）
 * 用 createStore 维护「粘贴文本 → 解析 → 对账报告 → 并入」的工作流。
 * 认现场：水位、密度、闸门实测开度回传覆盖；走水排程与目标密度不触碰。
 */
import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { applyWriteback } from '../utils/db';
import { parseInspectionText, reconcileWriteback } from '../utils/writeback';
import type { ApplyWritebackResult } from '../utils/db';
import type { WritebackReport } from '../types/writeback';
import { usePondStore } from './pondStore';

interface WritebackState {
  /** 粘贴的巡检回传文本（JSON 或行文本） */
  text: string;
  /** 对账报告（解析 + 去重 + 对账后） */
  report: WritebackReport | null;
  /** 解析失败提示 */
  parseError: string;
  /** 并入中 */
  applying: boolean;
  /** 最近一次并入结果 */
  lastApplied: ApplyWritebackResult | null;
  /** 最近操作提示 */
  lastMessage: string;
}

function createWritebackStore() {
  const pondStore = usePondStore();

  const [state, setState] = createStore<WritebackState>({
    text: '',
    report: null,
    parseError: '',
    applying: false,
    lastApplied: null,
    lastMessage: '',
  });

  function setText(text: string): void {
    setState('text', text);
  }

  function loadSample(sample: string): void {
    setState({ text: sample, report: null, parseError: '', lastApplied: null, lastMessage: '' });
  }

  /** 解析粘贴文本并生成对账报告（不触库） */
  function parse(): void {
    const result = parseInspectionText(state.text);
    if (!result.ok || result.batch === null) {
      setState({ parseError: result.message, report: null, lastMessage: '' });
      return;
    }
    const report = reconcileWriteback(result.batch, pondStore.state.ponds, pondStore.state.gates);
    report.dropped = result.dropped;
    report.parseDropped = result.dropped.length;
    setState({ report, parseError: '', lastMessage: '', lastApplied: null });
  }

  /** 确认并入：把对账报告写入库（认现场，不碰排程） */
  async function apply(): Promise<void> {
    const report = state.report;
    if (report === null) return;
    setState('applying', true);
    try {
      const result = await applyWriteback(report);
      setState({
        lastApplied: result,
        report: null,
        lastMessage: `回传并入完成：观测 ${result.observationsMerged} 条、闸门开度 ${result.gatesMatched} 条已认现场`,
      });
      await pondStore.refreshCounts();
    } finally {
      setState('applying', false);
    }
  }

  function reset(): void {
    setState({ text: '', report: null, parseError: '', lastApplied: null, lastMessage: '' });
  }

  return { state, setText, loadSample, parse, apply, reset };
}

const store = createRoot(createWritebackStore);

export function useWritebackStore() {
  return store;
}
