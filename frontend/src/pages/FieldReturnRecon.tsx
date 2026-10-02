/**
 * /field-returns 现场回传对账
 * 盐田班组巡检终端回场后把记录粘贴回来：先预览对账，再并入晒程台账。
 * 认现场：水位、密度、闸门实测开度；认调度：走水排程、目标设定、温度/风力、闸门拓扑。
 * 闸门按上下游池对认到既有串级，对不上先搁置（可在闸门建好后「重新对认」），不新建闸门。
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useFieldReturnStore } from '../stores/fieldReturnStore';
import { usePondStore } from '../stores/pondStore';
import { FIELD_RETURN_STATUS_OPTIONS, type FieldReturn } from '../types/fieldReturn';
import type { ReconLine } from '../utils/fieldReturn';
import { nowIso } from '../utils/id';

const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const SAMPLE = '北-01,2026-10-02,1.112,38\n北-02,2026-10-02,1.175,36\n闸门,北-01,北-02,60\n闸门,北-03,南-05,45\n# 下面是坏行与重复行示例\n北-02,2026-10-02,1.180,37\n北-09,2026-10-02,1.10,30\n北-01,2026-13-40,1.1,30';

function StatusPill(status: FieldReturn['status']): string {
  if (status === '已并入') return 'border-emerald-300 bg-emerald-50 text-emerald-700';
  if (status === '待对认') return 'border-amber-300 bg-amber-50 text-amber-700';
  return 'border-rose-300 bg-rose-50 text-rose-700';
}

function formatTime(iso: string): string {
  if (iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function FieldReturnRecon() {
  const store = useFieldReturnStore();
  const pondStore = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [text, setText] = createSignal('');
  const [deleting, setDeleting] = createSignal<FieldReturn | null>(null);

  onMount(() => {
    void pondStore.loadAll();
  });

  /** 实时预览：文本一变就重新对认（纯函数，不落库） */
  const preview = createMemo(() =>
    store.preview(text(), pondStore.state.ponds, pondStore.state.gates, pondStore.state.observations),
  );

  const pondLabel = (pondId: string, code: string): string => {
    if (pondId === '') return code === '' ? '—' : `${code}（台账无此池）`;
    const pond = pondStore.state.ponds.find((item) => item.id === pondId);
    return pond === undefined ? `${code}（池已删除）` : `${pond.code} · ${pond.seriesName}`;
  };

  const gateLabel = (row: FieldReturn): string => {
    const from = pondLabel(row.fromPondId, row.fromCode);
    const to = pondLabel(row.toPondId, row.toCode);
    const gate = pondStore.state.gates.find((item) => item.id === row.gateId);
    const suffix = gate === undefined ? '' : `（已认闸门 ${gate.id.slice(0, 10)}…）`;
    return `${from} → ${to}${suffix}`;
  };

  const openDialog = (): void => {
    setText('');
    setDialogOpen(true);
  };

  const handleCommit = async (): Promise<void> => {
    await store.commit(preview().lines as ReconLine[]);
    setDialogOpen(false);
    setText('');
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await store.remove(row.id);
    setDeleting(null);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="回传记录" value={store.stats().total} suffix="行" tone="primary" />
        <StatBadge label="已并入" value={store.stats().merged} suffix="行" tone="success" hint="水位/密度与闸门开度已认现场" />
        <StatBadge label="待对认闸门" value={store.stats().pending} suffix="行" tone="warning" hint="上下游池对认不上，已搁置，不新建闸门" />
        <StatBadge label="跳过坏行/重复行" value={store.stats().skipped} suffix="行" tone="danger" hint="原因见各行说明" />
      </div>

      <section class="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-[13px] leading-relaxed text-amber-900">
        <p class="font-semibold">现场与调度字段分治</p>
        <p class="mt-1">
          巡检终端回传只认三件事：每口池的<strong>水位</strong>、<strong>密度</strong>，以及闸门的<strong>实测开度</strong>；
          温度/风力、走水排程、目标密度、计划量与闸门拓扑仍归调度员，对账一律不覆盖。
          闸门按「上游池 → 下游池」对认已有串级，对不上先搁置，可等闸门建好后重新对认——系统不会自动新建闸门。
        </p>
      </section>

      <Show when={store.lastMessage() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {store.lastMessage()}
        </div>
      </Show>

      <Show when={store.error() !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">{store.error()}</div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">回传对账历史</h2>
          <div class="flex flex-wrap items-center gap-2">
            <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
              <span>状态</span>
              <select
                class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brine-500"
                value={store.filters().status}
                onChange={(event) =>
                  store.patchFilters({ status: event.currentTarget.value as FieldReturn['status'] | 'all' })
                }
              >
                <option value="all">全部状态</option>
                <For each={FIELD_RETURN_STATUS_OPTIONS}>{(item) => <option value={item}>{item}</option>}</For>
              </select>
            </label>
            <input
              type="text"
              placeholder="按池号 / 原文筛选"
              class="w-52 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brine-500"
              value={store.filters().keyword}
              onInput={(event) => store.patchFilters({ keyword: event.currentTarget.value })}
            />
            <button type="button" class={BTN_GHOST} onClick={() => store.resetFilters()}>
              重置
            </button>
            <button type="button" class={BTN_PRIMARY} onClick={openDialog}>
              + 回场回传对账
            </button>
          </div>
        </header>

        <Show when={store.rows().length === 0 && !store.loading()}>
          <EmptyPanel
            title="还没有现场回传记录"
            description="巡检终端回场后，把「池号,日期,密度,水位」与「闸门,上游池号,下游池号,开度%」两类行整段粘贴进来，先预览对认结果再并入台账。"
            actionText="粘贴第一份回传"
            onAction={openDialog}
          />
        </Show>

        <For each={store.batches()}>
          {(batch) => (
            <div class="mb-4 overflow-hidden rounded-lg border border-slate-200">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                <span>
                  批次 {batch.batchId.slice(-6)} · 回传并入 {formatTime(batch.importedAt)} · 共 {batch.rows.length} 行
                  （并入 {batch.rows.filter((r) => r.status === '已并入').length} · 待对认{' '}
                  {batch.rows.filter((r) => r.status === '待对认').length} · 跳过{' '}
                  {batch.rows.filter((r) => r.status === '已跳过').length}）
                </span>
              </div>
              <div class="overflow-x-auto">
                <table class="w-full min-w-[1040px] border-collapse text-sm">
                  <thead>
                    <tr class="border-b border-slate-200 bg-white text-left text-xs text-slate-500">
                      <th class="px-3 py-2 w-14">行号</th>
                      <th class="px-3 py-2 w-16">类别</th>
                      <th class="px-3 py-2">池 / 串级走向</th>
                      <th class="px-3 py-2 w-28">日期</th>
                      <th class="px-3 py-2 text-right w-24">密度</th>
                      <th class="px-3 py-2 text-right w-20">水位</th>
                      <th class="px-3 py-2 text-right w-20">开度</th>
                      <th class="px-3 py-2 w-20">状态</th>
                      <th class="px-3 py-2">说明 / 跳过原因</th>
                      <th class="px-3 py-2 w-28">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={[...batch.rows].sort((a, b) => a.seq - b.seq)}>
                      {(row) => (
                        <tr class="border-b border-slate-100 align-top hover:bg-slate-50/60">
                          <td class="px-3 py-2.5 tabular-nums text-slate-400">{row.seq}</td>
                          <td class="px-3 py-2.5 text-xs text-slate-600">{row.kind}</td>
                          <td class="px-3 py-2.5 text-[13px]">
                            {row.kind === '池况' ? pondLabel(row.pondId, row.pondCode) : gateLabel(row)}
                          </td>
                          <td class="px-3 py-2.5 tabular-nums text-slate-600">{row.date === '' ? '—' : row.date}</td>
                          <td class="px-3 py-2.5 text-right tabular-nums">
                            {row.densityGcm3 === null ? '—' : `${row.densityGcm3}`}
                          </td>
                          <td class="px-3 py-2.5 text-right tabular-nums">
                            {row.levelCm === null ? '—' : `${row.levelCm} cm`}
                          </td>
                          <td class="px-3 py-2.5 text-right tabular-nums">
                            {row.openingPct === null ? '—' : `${row.openingPct}%`}
                          </td>
                          <td class="px-3 py-2.5">
                            <span class={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${StatusPill(row.status)}`}>
                              {row.status}
                            </span>
                          </td>
                          <td class="px-3 py-2.5 text-xs leading-relaxed text-slate-500">
                            {row.reason === '' ? (
                              <span class="text-emerald-600">已认现场，并入台账</span>
                            ) : (
                              <span class={row.status === '已跳过' ? 'text-rose-600' : 'text-amber-700'}>
                                {row.reason}
                              </span>
                            )}
                            <Show when={row.resolvedAt !== null}>
                              <span class="ml-1 text-slate-400">（{formatTime(row.resolvedAt ?? '')} 重新对认）</span>
                            </Show>
                          </td>
                          <td class="px-3 py-2.5">
                            <div class="flex gap-2">
                              <Show when={row.status === '待对认'}>
                                <button class="text-xs text-brine-700 hover:underline" onClick={() => void store.retry(row.id)}>
                                  重新对认
                                </button>
                              </Show>
                              <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </For>

        <Show when={store.rows().length > 0 && store.visible().length === 0}>
          <EmptyPanel title="没有符合筛选条件的回传记录" description="可以切换状态或清空关键字后再看。" />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title="巡检终端回场回传 · 对账预览"
        width="max-w-5xl"
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_GHOST} onClick={() => setText(SAMPLE)}>
              填入示例
            </button>
            <button class={BTN_PRIMARY} onClick={() => void handleCommit()} disabled={preview().lines.length === 0}>
              并入台账（{preview().merged} 行）
            </button>
          </>
        }
      >
        <p class="mb-2 text-xs leading-relaxed text-slate-500">
          每行一条，支持半角/全角逗号与制表符，<span class="font-mono">#</span> 开头忽略。
          池况行：<span class="font-mono">池号,日期(YYYY-MM-DD),密度,水位(cm)</span>；闸门行：
          <span class="font-mono">闸门,上游池号,下游池号,开度%</span>。
          同池同日重复只留首条；闸门对不上串级先搁置不新建；坏行跳过并在下表写明原因。
        </p>
        <textarea
          rows="6"
          class="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brine-500"
          placeholder={SAMPLE}
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
        />

        <div class="mt-2 flex flex-wrap gap-2 text-xs">
          <span class="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">可并入 {preview().merged}</span>
          <span class="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">闸门待对认 {preview().pending}</span>
          <span class="rounded-full bg-rose-50 px-2.5 py-1 text-rose-700">跳过 {preview().skipped}</span>
          <span class="px-1 py-1 text-slate-400">并入只写水位/密度/闸门开度，排程与目标不动</span>
        </div>

        <Show when={preview().lines.length > 0}>
          <div class="mt-2 max-h-72 overflow-y-auto rounded-md border border-slate-200">
            <table class="w-full min-w-[920px] text-xs">
              <thead class="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th class="px-2 py-1 text-left">行</th>
                  <th class="px-2 py-1 text-left">类别</th>
                  <th class="px-2 py-1 text-left">池 / 走向</th>
                  <th class="px-2 py-1 text-left">日期</th>
                  <th class="px-2 py-1 text-right">密度</th>
                  <th class="px-2 py-1 text-right">水位</th>
                  <th class="px-2 py-1 text-right">开度</th>
                  <th class="px-2 py-1 text-left">预览结果</th>
                </tr>
              </thead>
              <tbody>
                <For each={preview().lines}>
                  {(line) => (
                    <tr class="border-t border-slate-100">
                      <td class="px-2 py-1 tabular-nums text-slate-400">{line.seq}</td>
                      <td class="px-2 py-1">{line.kind}</td>
                      <td class="px-2 py-1">
                        {line.kind === '池况'
                          ? pondLabel(line.pondId, line.pondCode)
                          : `${pondLabel(line.fromPondId, line.fromCode)} → ${pondLabel(line.toPondId, line.toCode)}`}
                      </td>
                      <td class="px-2 py-1 tabular-nums">{line.date === '' ? '—' : line.date}</td>
                      <td class="px-2 py-1 text-right tabular-nums">
                        {line.densityGcm3 === null ? '—' : line.densityGcm3}
                      </td>
                      <td class="px-2 py-1 text-right tabular-nums">
                        {line.levelCm === null ? '—' : `${line.levelCm}`}
                      </td>
                      <td class="px-2 py-1 text-right tabular-nums">
                        {line.openingPct === null ? '—' : `${line.openingPct}%`}
                      </td>
                      <td class="px-2 py-1">
                        <span class={`mr-1 rounded border px-1 py-0.5 text-[10px] ${StatusPill(line.status)}`}>
                          {line.status}
                        </span>
                        <span
                          class={
                            line.status === '已跳过'
                              ? 'text-rose-600'
                              : line.status === '待对认'
                                ? 'text-amber-700'
                                : 'text-emerald-600'
                          }
                        >
                          {line.reason === '' ? '将并入台账' : line.reason}
                        </span>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
        <p class="mt-2 text-[11px] text-slate-400">预览时间 {formatTime(nowIso())}（并入后以台账实际状态为准）</p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="删除回传记录？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          仅删除回传台账中的第 {deleting()?.seq} 行留痕；已经并入观测/闸门的现场值不会被回滚。
        </p>
      </AppDialog>
    </div>
  );
}
