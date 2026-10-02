/**
 * 现场回传对账与 v3 升级的行为校验（Node + fake-indexeddb，手工执行）
 * 运行：npx tsx scripts/test-field-returns.ts
 */
import 'fake-indexeddb/auto';
import { db, commitFieldReturns, exportSnapshot, importSnapshot, initDatabase, retryFieldReturn, ROW_REVISION } from '../src/utils/db';
import { reconcileFieldReturn } from '../src/utils/fieldReturn';
import { seedDatabase } from '../src/utils/seed';

let failures = 0;
function assert(cond: boolean, message: string): void {
  if (cond) {
    console.log(`  ✅ ${message}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${message}`);
  }
}

async function main(): Promise<void> {
  // ---------- 场景 1：全新 v3 播种 ----------
  console.log('场景 1：全新库播种与回传对账');
  await initDatabase();
  await seedDatabase();

  const ponds = await db.ponds.toArray();
  const gates = await db.gates.toArray();
  const observationsBefore = await db.observations.toArray();
  assert(ponds.length === 5, `播种 5 口池（实际 ${ponds.length}）`);
  assert(gates.length === 4, `播种 4 条闸门（实际 ${gates.length}）`);
  assert(ROW_REVISION === 3, `行修订号为 3（实际 ${ROW_REVISION}）`);

  const text = [
    '# 班组回传 10-02',
    '北-01,2026-09-22,1.112,38', // 已并入（覆盖既有观测，温度/风力不动）
    '北-02,2026-10-02,1.175,36', // 已并入（新建观测，默认温度/风力）
    '闸门,北-01,北-02,90', // 已并入（认到 gate-a-b，只改开度）
    '闸门,北-03,南-05,45', // 待对认（无此串级，不新建）
    '闸门,北-01,北-02,80', // 待对认?——不：能认到同一闸门，第二行闸门不做去重，照常并入
    '北-01,2026-09-22,1.2,30', // 重复：同池同日只留首条
    '北-09,2026-10-02,1.1,30', // 坏行：池不存在
    '北-01,2026-13-40,1.1,30', // 坏行：日期非法
    '北-02,2026-10-02,1.9,36', // 坏行：密度越界
    '闸门,北-01,北-02', // 坏行：字段不全
  ].join('\n');

  const preview = reconcileFieldReturn(text, ponds, gates, observationsBefore);
  assert(preview.merged === 4, `预览并入 4 行（实际 ${preview.merged}）`);
  assert(preview.pending === 1, `预览待对认 1 行（实际 ${preview.pending}）`);
  assert(preview.skipped === 5, `预览跳过 5 行（实际 ${preview.skipped}）`);

  const result = await commitFieldReturns(preview.lines, 'batch-test-1');
  assert(result.merged === 4 && result.pending === 1 && result.skipped === 5, 'commit 返回 4/1/5');

  const returns = await db.fieldReturns.toArray();
  assert(returns.length === 10, `回传落账 10 行（实际 ${returns.length}）`);
  assert(
    returns.filter((r) => r.status === '待对认').length === 1,
    '恰好 1 行待对认',
  );
  const pending = returns.find((r) => r.status === '待对认');
  assert(pending?.gateId === '' && pending?.fromCode === '北-03', '待对认行未绑定闸门且保留上游池号');

  // 现场字段覆盖：北-01 2026-09-22 原有温度 26 / 风力 3 不变，水位密度变现场值
  const obsA = await db.observations.where('[pondId+date]').equals(['pond-north-01', '2026-09-22']).first();
  assert(obsA?.levelCm === 38 && obsA.densityGcm3 === 1.112, '北-01 水位/密度已认现场');
  assert(obsA?.tempC === 26 && obsA.windLevel === 3, '北-01 温度/风力保持台账现值（调度字段未被覆盖）');

  // 新建观测：默认温度/风力，reason 提示补录
  const obsB = await db.observations.where('[pondId+date]').equals(['pond-north-02', '2026-10-02']).first();
  assert(obsB?.levelCm === 36 && obsB.densityGcm3 === 1.175, '北-02 新观测水位/密度为现场值');
  assert(obsB?.tempC === 25 && obsB.windLevel === 2, '北-02 新观测温度/风力取保守默认值');
  const newReason = returns.find((r) => r.pondCode === '北-02' && r.date === '2026-10-02');
  assert(newReason?.reason.includes('补录'), '新建行 reason 提示调度员补录温度/风力');

  // 闸门只改开度；gate-a-b 最后一次并入开度 80（第二行闸门行也并入）
  const gateAB = await db.gates.get('gate-a-b');
  assert(gateAB?.openingPct === 80, `闸门 gate-a-b 开度被现场值改写为 80（实际 ${gateAB?.openingPct}）`);
  assert(gateAB?.widthCm === 120 && gateAB.note.includes('主走水'), '闸门口宽/备注未被回传改动');
  const gateBC = await db.gates.get('gate-b-c');
  assert(gateBC?.openingPct === 40, '无关闸门 gate-b-c 开度不变');
  assert((await db.gates.count()) === 4, '待对认没有新建闸门（仍为 4 条）');

  // 重复行原因写明首见行号（首见为第 2 行）
  const dup = returns.find((r) => r.reason.includes('重复'));
  assert(dup?.reason.includes('第 2 行'), `重复行跳过原因引用首见行号（实际：${dup?.reason}）`);

  // ---------- 场景 2：补建闸门后重新对认 ----------
  console.log('场景 2：待对认行在串级补建后重新对认');
  assert(pending !== undefined, '存在待对认行');
  let ok = await retryFieldReturn(pending!.id);
  assert(ok === false, '补建前重新对认仍失败，继续搁置');

  const stamp = new Date().toISOString();
  await db.gates.put({
    id: 'gate-c-e',
    fromPondId: 'pond-north-03',
    toPondId: 'pond-south-05',
    openingPct: 0,
    widthCm: 100,
    state: '关闭',
    note: '后补串级',
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  });
  ok = await retryFieldReturn(pending!.id);
  assert(ok === true, '补建唯一闸门后重新对认成功');
  const gateCE = await db.gates.get('gate-c-e');
  assert(gateCE?.openingPct === 45 && gateCE.state === '半开', '对认成功后开度 45 与状态已回写');
  const resolved = await db.fieldReturns.get(pending!.id);
  assert(resolved?.status === '已并入' && resolved.gateId === 'gate-c-e' && resolved.resolvedAt !== null, '回传行转为已并入并记录对认时间');

  // ---------- 场景 3：多闸门歧义也搁置 ----------
  console.log('场景 3：同走向多条闸门时不唯一 → 搁置');
  await db.gates.put({
    id: 'gate-c-e-2',
    fromPondId: 'pond-north-03',
    toPondId: 'pond-south-05',
    openingPct: 10,
    widthCm: 80,
    state: '半开',
    note: '第二条同走向',
    createdAt: stamp,
    updatedAt: stamp,
    revision: 3,
  });
  const amb = reconcileFieldReturn('闸门,北-03,南-05,30', ponds, await db.gates.toArray(), await db.observations.toArray());
  assert(amb.pending === 1 && amb.lines[0]?.reason.includes('无法唯一对认'), '同走向 2 条闸门 → 待对认并写明不唯一');

  // ---------- 场景 4：快照导出 / 旧 v2 快照导入 ----------
  console.log('场景 4：快照含 fieldReturns；旧存档（无 fieldReturns）照常导入');
  const snapshot = await exportSnapshot();
  assert(Array.isArray(snapshot.fieldReturns) && snapshot.fieldReturns.length === 10, '导出快照包含 10 行回传');
  assert(snapshot.schemaVersion === 3, '快照结构版本为 v3');

  const oldSnapshot = {
    name: 'gbbrinepond',
    schemaVersion: 2,
    exportedAt: stamp,
    ponds: snapshot.ponds,
    gates: snapshot.gates.filter((g) => g.id !== 'gate-c-e-2'),
    observations: snapshot.observations,
    assays: snapshot.assays,
    schedules: snapshot.schedules,
  };
  await importSnapshot(oldSnapshot as never);
  assert((await db.fieldReturns.count()) === 0, 'v2 旧存档导入后回传表为空（按缺省处理，不报错）');
  assert((await db.ponds.count()) === 5 && (await db.gates.count()) === 5, '旧存档主体数据照常打开');

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  await db.close();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
