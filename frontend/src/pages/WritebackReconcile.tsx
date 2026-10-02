/**
 * /writeback 现场回传对账
 * 巡检终端回传记录 → 解析 → 对账（同池去重 / 坏条目跳过 / 闸门认到已有串级）→ 确认并入。
 * 认现场：水位、密度、闸门实测开度回传覆盖；走水排程与目标密度归调度员，回传不触碰。
 * 消费模型：Observation、Gate、Pond；复用组件：<StatBadge>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { useWritebackStore } from '../stores/writebackStore';
import { summarizeReport, WRITEBACK_SAMPLE, WRITEBACK_TEMPLATE } from '../utils/writeback';
import { download } from '../utils/export';
import { DB_NAME } from '../utils/db';
import type { ReconciledEntry, ReconciledGate } from '../types/writeback';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';

export default function WritebackReconcile() {
  const pondStore = usePondStore();
  const store = useWritebackStore();
  const [showHelp, setShowHelp] = createSignal(false);

  onMount(() => {
    void pondStore.loadAll();
  });

  const summary = createMemo(() => {
    const report = store.state.report;
    if (report === null) return null;
    return summarizeReport(report);
  });

  const heldGates = createMemo(() => {
    const report = store.state.report;
    if (report === null) return [];
    return report.entries.flatMap((entry: ReconciledEntry) =>
      entry.gates
        .filter((gate: ReconciledGate) => gate.status === 'held')
        .map((gate: ReconciledGate) => ({ ref: entry.ref, pondCode: entry.pondCode, gate })),
    );
  });

  const skippedEntries = createMemo(() => {
    const report = store.state.report;
    if (report === null) return [];
    return report.entries.filter((entry: ReconciledEntry) => entry.status === 'skipped');
  });

  const handleDownloadTemplate = (): void => {
    download(`${DB_NAME}-巡检回传模板.json`, WRITEBACK_TEMPLATE, 'application/json;charset=utf-8');
  };

  return (
    <div class="space-y-3.5">
      <div class="rounded-xl border border-brine-200 bg-brine-50 px-4 py-3 text-[13px] leading-relaxed text-brine-800">
        <p class="font-semibold">现场回传，两边各管各的字段</p>
        <p class="mt-1">
          <span class="font-medium">认现场（回传覆盖）：</span>
          每口蒸发池的水位、密度，以及闸门实测开度 —— 以巡检终端回传为准。
        </p>
        <p class="mt-0.5">
          <span class="font-medium">归调度员（回传不触碰）：</span>
          走水排程、目标密度、闸门新建与串级调整 —— 回传只认已有串级，对不上的闸门先搁着，不会新建。
        </p>
      </div>

      <Show when={store.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {store.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">巡检记录回传</h2>
          <div class="flex flex-wrap gap-2">
            <button type="button" class={BTN_GHOST} onClick={() => setShowHelp((v) => !v)}>
              {showHelp() ? '收起格式说明' : '格式说明'}
            </button>
            <button
              type="button"
              class={BTN_GHOST}
              onClick={() => store.loadSample(WRITEBACK_SAMPLE)}
              disabled={pondStore.state.ponds.length === 0}
            >
              填入示例
            </button>
            <button type="button" class={BTN_GHOST} onClick={handleDownloadTemplate}>
              下载 JSON 模板
            </button>
            <button type="button" class={BTN_GHOST} onClick={() => store.reset()}>
              清空
            </button>
            <button
              type="button"
              class={BTN_PRIMARY}
              onClick={() => store.parse()}
              disabled={store.state.text.trim() === '' || pondStore.state.ponds.length === 0}
            >
              解析预览
            </button>
          </div>
        </header>

        <Show when={showHelp()}>
          <div class="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
            <p class="font-semibold text-slate-700">支持两种格式</p>
            <p class="mt-1">
              <span class="font-medium">① JSON（终端导出）：</span>
              顶层 <span class="font-mono">{'{ batchNo?, inspectedAt?, records: [...] }'}</span>，每条记录含
              <span class="font-mono"> pondCode / date / densityGcm3 / levelCm / tempC? / windLevel? / gates? </span>
              ，闸门为 <span class="font-mono">{'{ fromPondCode, toPondCode, openingPct }'}</span>。
            </p>
            <p class="mt-1">
              <span class="font-medium">② 行文本（每行一条）：</span>
              <span class="font-mono">池号,日期,密度,水位,温度,风力,上游池号&gt;下游池号@开度,上游池号&gt;下游池号@开度...</span>
              ，以 <span class="font-mono">#</span> 开头的行是注释。
            </p>
            <p class="mt-1 text-slate-500">
              同池重复传只留一条（取最新日期）；闸门按上下游池对认到已有串级，对不上先搁着；坏条目跳过并写明原因。
            </p>
          </div>
        </Show>

        <textarea
          rows="10"
          class={INPUT}
          placeholder={'粘贴巡检终端回传记录（JSON 或每行一条的文本）…\n\n北-01,2026-10-02,1.095,42,26,2,北-01>北-02@60'}
          value={store.state.text}
          onInput={(event) => store.setText(event.currentTarget.value)}
        />

        <Show when={store.state.parseError !== ''}>
          <div class="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            解析失败：{store.state.parseError}
          </div>
        </Show>
      </section>

      <Show when={summary() !== null && store.state.report !== null}>
        <div class="flex flex-wrap gap-3">
          <StatBadge label="解析记录" value={store.state.report?.entries.length ?? 0} suffix="条" tone="default" />
          <StatBadge label="可并入观测" value={summary()?.merged ?? 0} suffix="条" tone="success" />
          <StatBadge label="闸门已认到" value={summary()?.gatesMatched ?? 0} suffix="条" tone="primary" />
          <StatBadge label="闸门搁着" value={summary()?.gatesHeld ?? 0} suffix="条" tone="warning" />
          <StatBadge label="跳过条目" value={summary()?.skipped ?? 0} suffix="条" tone="danger" />
          <StatBadge label="同池去重" value={store.state.report?.dedupedCount ?? 0} suffix="条" tone="info" />
        </div>

        <section class="rounded-xl border border-slate-200 bg-white p-4">
          <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-[15px] font-semibold text-slate-800">对账明细</h2>
            <button
              type="button"
              class={BTN_PRIMARY}
              onClick={() => void store.apply()}
              disabled={(summary()?.merged ?? 0) === 0 || store.state.applying}
            >
              {store.state.applying ? '并入中…' : `确认并入（${summary()?.merged ?? 0} 条观测 / ${summary()?.gatesMatched ?? 0} 条闸门）`}
            </button>
          </header>

          <Show
            when={(store.state.report?.entries.length ?? 0) > 0}
            fallback={<EmptyPanel title="没有可对账的记录" description="请先粘贴巡检回传记录并点击「解析预览」。" />}
          >
            <div class="overflow-x-auto">
              <table class="w-full min-w-[920px] border-collapse text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                    <th class="px-3 py-2">池号</th>
                    <th class="px-3 py-2">观测日期</th>
                    <th class="px-3 py-2 text-right">密度（g/cm³）</th>
                    <th class="px-3 py-2 text-right">水位（cm）</th>
                    <th class="px-3 py-2">闸门对账</th>
                    <th class="px-3 py-2">状态 / 原因</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={store.state.report?.entries ?? []}>
                    {(entry) => (
                      <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                        <td class="px-3 py-2.5 font-medium text-slate-800">{entry.pondCode}</td>
                        <td class="px-3 py-2.5 tabular-nums">{entry.date}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{entry.densityGcm3 || '—'}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{entry.levelCm || '—'}</td>
                        <td class="px-3 py-2.5">
                          <Show
                            when={entry.gates.length > 0}
                            fallback={<span class="text-xs text-slate-400">无闸门读数</span>}
                          >
                            <div class="flex flex-wrap gap-1">
                              <For each={entry.gates}>
                                {(gate) => (
                                  <span
                                    title={gate.reason !== '' ? gate.reason : gate.gateLabel}
                                    class={`rounded px-1.5 py-0.5 text-[11px] ${
                                      gate.status === 'matched'
                                        ? 'bg-brine-50 text-brine-700'
                                        : gate.status === 'held'
                                          ? 'bg-amber-50 text-amber-700'
                                          : 'bg-rose-50 text-rose-700'
                                    }`}
                                  >
                                    {gate.fromPondCode}→{gate.toPondCode}@{gate.openingPct}
                                    {gate.status === 'matched' ? ' ✓' : gate.status === 'held' ? ' 搁着' : ' 跳过'}
                                  </span>
                                )}
                              </For>
                            </div>
                          </Show>
                        </td>
                        <td class="px-3 py-2.5">
                          <Show
                            when={entry.status === 'merged'}
                            fallback={
                              <span class="text-xs text-rose-600" title={entry.reason}>
                                跳过 · {entry.reason}
                              </span>
                            }
                          >
                            <span class="text-xs text-emerald-700">并入观测</span>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>

        <Show when={heldGates().length > 0}>
          <section class="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <h2 class="mb-2 text-[15px] font-semibold text-amber-800">闸门搁着明细（对不上已有串级，不新建）</h2>
            <ul class="space-y-1.5 text-sm">
              <For each={heldGates()}>
                {(item) => (
                  <li class="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2">
                    <span class="font-medium text-slate-700">{item.gate.fromPondCode}→{item.gate.toPondCode}</span>
                    <span class="tabular-nums text-slate-600">实测开度 {item.gate.openingPct}%</span>
                    <span class="text-xs text-amber-700">{item.gate.reason}</span>
                    <span class="ml-auto text-xs text-slate-400">来自 {item.ref}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>

        <Show when={skippedEntries().length > 0 || (store.state.report?.dropped.length ?? 0) > 0}>
          <section class="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
            <h2 class="mb-2 text-[15px] font-semibold text-rose-800">坏条目跳过明细（其余照常并入）</h2>
            <ul class="space-y-1.5 text-sm">
              <For each={skippedEntries()}>
                {(entry) => (
                  <li class="flex flex-wrap items-center gap-2 rounded-md border border-rose-200 bg-white px-3 py-2">
                    <span class="font-medium text-slate-700">{entry.pondCode}</span>
                    <span class="text-xs text-rose-700">{entry.reason}</span>
                    <span class="ml-auto text-xs text-slate-400">来自 {entry.ref}</span>
                  </li>
                )}
              </For>
              <For each={store.state.report?.dropped ?? []}>
                {(drop) => (
                  <li class="flex flex-wrap items-center gap-2 rounded-md border border-rose-200 bg-white px-3 py-2">
                    <span class="text-xs text-rose-700">{drop.reason}</span>
                    <span class="ml-auto text-xs text-slate-400">{drop.ref}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </Show>
    </div>
  );
}
