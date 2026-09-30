'use strict';
// 端到端规则验证（使用临时内存数据库逻辑通过 HTTP 接口验证）
const BASE = process.env.BASE || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({})).then((j) => j || {});
  return { status: res.status, json };
}
const getState = async () => (await call('GET', '/api/state')).json;

(async () => {
  console.log('# 1. 整批校验：负值 / 无效时序');
  let r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'a', hall: 'X', start: '2026-10-05T10:00', end: '2026-10-05T09:00', lux: 100, artworkIds: [3] },
    { cid: 'b', hall: 'Y', start: '2026-10-06T10:00', end: '2026-10-06T11:00', lux: -5, artworkIds: [3] },
    { cid: 'c', hall: 'Z', start: '2026-02-30T10:00', end: '2026-10-06T11:00', lux: 5, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.errors.length === 3, `拒绝三种无效输入（得到 ${r.status}, ${r.json.errors?.length} 条）`);
  let st = await getState();
  ok(st.version === 1, '被拒绝后版本不变、数据不变');

  console.log('# 2. 同作品时段重叠（新-新 / 新-冻结）');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'p1', hall: '二号厅', start: '2026-10-10T10:00', end: '2026-10-10T12:00', lux: 100, artworkIds: [3] },
    { cid: 'p2', hall: '三号厅', start: '2026-10-10T11:00', end: '2026-10-10T13:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.length === 1, '新时段互相重叠被拒绝');
  ok(r.json.conflicts[0].artworkId === 3 && r.json.conflicts[0].slotA.cid === 'p1', '冲突指出作品与两个时段');

  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'f1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [1] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '与进行中冻结时段重叠被拒绝');
  // 不同作品同一时间允许
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'ok1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '不同作品同展厅时间重叠允许（仅按作品约束）');

  console.log('# 3. 预算超限整批拒绝');
  st = await getState(); // version 现在 2
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'big', hall: '四号厅', start: '2026-11-01T08:00', end: '2026-11-01T20:00', lux: 500, artworkIds: [2] },
  ]});
  ok(r.status === 422 && r.json.budgetExceeded?.[0]?.artworkId === 2,
     `超量拒绝并指出作品与超出值（overflow=${r.json.budgetExceeded?.[0]?.overflow}）`);
  st = await getState();
  ok(st.version === 2, '超量拒绝后版本不变');

  console.log('# 4. 过期版本并发拒绝');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'v', hall: '五号厅', start: '2026-12-01T10:00', end: '2026-12-01T11:00', lux: 10, artworkIds: [3] },
  ]});
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === 2,
     `过期版本返回 409 与最新预算（state v${r.json.state?.version}）`);

  console.log('# 5. 合法整批保存 + 版本递增 + 重新编号');
  r = await call('POST', '/api/schedule', { version: 2, slots: [
    { cid: 'x', hall: '二号厅', start: '2026-10-20T10:00', end: '2026-10-20T12:00', lux: 120, artworkIds: [1, 2] },
    { cid: 'y', hall: '三号厅', start: '2026-10-19T09:00', end: '2026-10-19T10:00', lux: 80, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.version === 3, `整批保存成功，版本→${r.json.version}`);
  const sched = r.json.slots.filter((s) => s.status === 'scheduled').sort((a, b) => a.seq - b.seq);
  ok(sched.length === 2 && sched[0].hall === '三号厅' && sched[0].seq === 3 && sched[1].seq === 4,
     '按开始时间重新编号（冻结时段在前）');
  ok(sched.every((s) => !s.blocked), '预算充足：无不可启动时段');

  console.log('# 6. 启动进行中时段不允许 / 启动未开始时段');
  const target = sched[0]; // 三号厅 W3
  r = await call('POST', `/api/slots/2/start`);
  ok(r.status === 422 && r.json.error?.code === 'NOT_STARTABLE', '已在进行中的时段不能再次启动');
  r = await call('POST', `/api/slots/${target.id}/start`);
  ok(r.status === 200, '未开始时段可启动');
  st = r.json;
  const running3 = st.slots.find((s) => s.id === target.id);
  ok(running3.status === 'running', '状态变为进行中');
  ok(st.version === 4, '启动后版本 +1');
  // 启动后再保存排期：该时段必须从可编辑集合消失，且仍不可被重叠
  r = await call('POST', '/api/schedule', { version: 4, slots: [
    { cid: 'ov', hall: '三号厅', start: '2026-10-19T09:30', end: '2026-10-19T10:30', lux: 50, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '启动后冻结：新排期与其重叠被拒');
  // 空批次合法
  r = await call('POST', '/api/schedule', { version: 4, slots: [] });
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').length === 0, '空批次合法（清空未开始排期）');

  console.log('# 7. 结束补记：无效时序拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T10:00', actualEnd: '2026-10-19T09:00', actualLux: 100,
  });
  ok(r.status === 422, '实际结束早于开始被拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T09:00', actualEnd: '2026-10-19T10:00', actualLux: -1,
  });
  ok(r.status === 422, '负照度被拒绝');

  console.log('# 8. 超量结算 → 后续时段按顺序标为不可启动并禁止启动');
  // 先重建排期：W1、W2 在进行中时段(2号 240min*200)之后
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'w1s', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T12:00', lux: 180, artworkIds: [1] }, // 21600
    { cid: 'w2s', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T13:00', lux: 150, artworkIds: [2, 3] }, // 27000
    { cid: 'w3s', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] }, // 19800
  ]});
  ok(r.status === 200, '恢复三条未开始时段');
  const beforeFinish = r.json;
  const w1Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-01'));
  const w2Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-02'));
  ok(!w1Slot.blocked && !w2Slot.blocked, '结算前均可启动');

  // 结束 slot 2（W1+W2），实际 300 lux × 240 = 72000，远超冻结预占 48000
  r = await call('POST', '/api/slots/2/finish', {
    actualStart: '2026-09-30T09:00', actualEnd: '2026-09-30T13:00', actualLux: 300,
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 72000, `实际曝光 ${r.json.justFinishedExposure} 替换预占`);
  // W1: 12000+22400+72000 = 106400, 余 13600 < 21600 → 缺口 8000
  // W2: 20000+72000 = 92000, 余 8000 < 27000 → 缺口 19000
  const blockedIds = r.json.blockedAfterFinish.map((s) => s.id);
  ok(blockedIds.length === 2 && blockedIds[0] === w1Slot.id,
     `按开始顺序标出不可开始时段：#${r.json.blockedAfterFinish.map((s) => s.seq).join(', #')}`);
  const g1 = w1Slot ? r.json.blockedAfterFinish.find((s) => s.id === w1Slot.id).blockedReason.gaps[0] : null;
  ok(g1 && g1.artworkId === 1 && g1.gap === 8000 && g1.has === 13600 && g1.need === 21600,
     `W1 缺口数据正确（has=${g1?.has}, need=${g1?.need}, gap=${g1?.gap}）`);

  // 尝试启动被拦截时段
  r = await call('POST', `/api/slots/${w1Slot.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED' && r.json.blockedReason.gaps[0].gap === 8000,
     '预算不足时段禁止启动并返回缺口');

  // W3 时段（10-03）：由于 w2s 联展 W3 但被跳过（不占预算），W3 独立时段应仍可启动
  const w3Only = r.json ? null : null;
  st = await getState();
  const w3slot = st.slots.find((s) => s.plannedStart.startsWith('2026-10-03'));
  ok(!w3slot.blocked, '被拦截时段不占预算，后续预算充足的时段仍标记可启动（贪婪核算）');

  console.log('# 9. 调整排期后重新核算，缺口消除');
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    // W1 缩短到 60 分钟 × 180 = 10800 <= 13600
    { cid: 'w1f', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T11:00', lux: 180, artworkIds: [1] },
    // W2 降到 50 lux × 60 = 3000 <= 8000，同时联展 W3
    { cid: 'w2f', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T11:00', lux: 50, artworkIds: [2, 3] },
    { cid: 'w3f', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').every((s) => !s.blocked),
     '调整后重新核算：所有时段均可启动');
  st = r.json;
  const w1Final = st.slots.find((s) => s.plannedStart.startsWith('2026-10-01'));
  r = await call('POST', `/api/slots/${w1Final.id}/start`);
  ok(r.status === 200, '调整后时段可以启动');

  console.log('# 10. 作品校验：既有>上限拒绝；重复名拒绝；被引用时删除拒绝');
  st = await getState(); // #9 的启动操作又递增过版本，重新取最新版本
  r = await call('POST', '/api/artworks', { version: st.version, name: '测试品', limit: 100, existing: 200 });
  ok(r.status === 422, '既有累计超过上限拒绝');
  r = await call('POST', '/api/artworks', { version: st.version, name: '《山水轴》纸本水墨', limit: 100, existing: 0 });
  ok(r.status === 422, '作品名重复拒绝');
  r = await call('DELETE', '/api/artworks/1', { version: st.version });
  ok(r.status === 409 && r.json.error?.code === 'IN_USE', '被时段引用的作品不可删除');

  console.log('# 11. 合法作品增删改');
  r = await call('POST', '/api/artworks', { version: st.version, name: '新增测试品', limit: 5000, existing: 100, note: 'hi' });
  ok(r.status === 200, '新作品录入成功');
  const newId = r.json.artworks.at(-1).id;
  r = await call('PUT', `/api/artworks/${newId}`, { version: r.json.version, name: '新增测试品改', limit: 6000, existing: 200, note: 'x' });
  ok(r.status === 200 && r.json.artworks.at(-1).limit === 6000, '作品更新成功');
  r = await call('DELETE', `/api/artworks/${newId}`, { version: r.json.version });
  ok(r.status === 200 && !r.json.artworks.some((a) => a.id === newId), '未被引用的作品可删除');

  console.log('# 12. 多段照度结算 / 更正（进行中→结束→更正）');
  // 干净基线：清空排期后录入两件作品、一个进行中时段
  st = await getState();
  const before = st.version;
  // 用一个全新作品构造独立场景，避免影响前文数据
  r = await call('POST', '/api/artworks', { version: st.version, name: '多段测试品', limit: 100000, existing: 0 });
  ok(r.status === 200, '录入多段测试作品');
  st = r.json;
  const artId = st.artworks.at(-1).id;
  let ver = st.version;

  r = await call('POST', '/api/schedule', { version: ver, slots: [
    { cid: 'ms1', hall: '多段厅', start: '2026-11-10T09:00', end: '2026-11-10T13:00', lux: 200, artworkIds: [artId] },
  ]});
  ok(r.status === 200, '排入一个未开始时段');
  ver = r.json.version;
  const slotId = r.json.slots.find((s) => s.hall === '多段厅').id;
  r = await call('POST', `/api/slots/${slotId}/start`);
  ok(r.status === 200, '启动该时段');
  ver = r.json.version;

  // 12a. 无 version → 409
  r = await call('POST', `/api/slots/${slotId}/settle`, { segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T13:00', lux: 200 },
  ]});
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE', '多段结算缺版本号返回 409 与最新预算');

  // 12b. 分段有缺口 → 422，整批拒绝、版本不变
  r = await call('POST', `/api/slots/${slotId}/settle`, { version: ver, segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 200 },
    { start: '2026-11-10T10:30', end: '2026-11-10T13:00', lux: 300 },
  ]});
  ok(r.status === 422 && r.json.error?.code === 'SEGMENTS_INVALID' && r.json.errors.length >= 1,
     `分段有缺口被整批拒绝（${r.json.errors?.[0]}）`);
  st = await getState();
  ok(st.version === ver && st.slots.find((s) => s.id === slotId).status === 'running',
     '被拒绝后时段仍为进行中、版本不变');

  // 12c. 重叠 + 负照度 + 空数组
  r = await call('POST', `/api/slots/${slotId}/settle`, { version: ver, segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 200 },
    { start: '2026-11-10T10:00', end: '2026-11-10T13:00', lux: 300 },
  ]});
  ok(r.status === 422 && r.json.errors.some((m) => m.includes('重叠')), '分段重叠被拒绝');
  r = await call('POST', `/api/slots/${slotId}/settle`, { version: ver, segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T13:00', lux: -5 },
  ]});
  ok(r.status === 422, '负照度段被拒绝');
  r = await call('POST', `/api/slots/${slotId}/settle`, { version: ver, segments: [] });
  ok(r.status === 422, '空分段被拒绝');

  // 12d. 显式 actualStart/actualEnd：分段未覆盖到实际结束 → 422
  r = await call('POST', `/api/slots/${slotId}/settle`, {
    version: ver,
    actualStart: '2026-11-10T08:30',
    actualEnd: '2026-11-10T12:30',
    segments: [
      { start: '2026-11-10T08:30', end: '2026-11-10T10:30', lux: 200 },
      { start: '2026-11-10T10:30', end: '2026-11-10T13:00', lux: 300 },
    ],
  });
  ok(r.status === 422 && r.json.errors.some((m) => m.includes('实际结束')), '分段未覆盖到显式实际结束被拒绝');

  // 12e. 乱序提交两段，服务端排序后按 Σ 结算：60*200 + 180*300 = 66000
  r = await call('POST', `/api/slots/${slotId}/settle`, {
    version: ver,
    actualStart: '2026-11-10T08:30',
    actualEnd: '2026-11-10T12:30',
    segments: [
      { start: '2026-11-10T09:30', end: '2026-11-10T12:30', lux: 300 },
      { start: '2026-11-10T08:30', end: '2026-11-10T09:30', lux: 200 },
    ],
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 66000,
     `乱序多段结算 Σ=66000（得到 ${r.json.justFinishedExposure}）`);
  ver = r.json.version;
  let settled = r.json.slots.find((s) => s.id === slotId);
  ok(settled.status === 'finished' && settled.actualLux === null && settled.actualStart === '2026-11-10T08:30'
     && settled.actualSegments.length === 2 && settled.actualSegments[0].start === '2026-11-10T08:30',
     '结算后为已结束、actualLux 为 null（多段）、分段按时间升序返回');
  let art = r.json.artworks.find((a) => a.id === artId);
  ok(art.used === 66000, `作品已用量按新总量计入（used=${art.used}）`);

  // 12f. 对已结束时段再 settle → 422
  r = await call('POST', `/api/slots/${slotId}/settle`, { version: ver, segments: [
    { start: '2026-11-10T08:30', end: '2026-11-10T12:30', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.error?.code === 'NOT_RUNNING', '已结束时段不能再 settle');

  // 12g. 更正：无理由拒绝 / 版本过期拒绝
  r = await call('POST', `/api/slots/${slotId}/correct`, { version: ver, segments: [
    { start: '2026-11-10T08:30', end: '2026-11-10T12:30', lux: 100 },
  ]});
  ok(r.status === 422, '更正缺理由被拒绝');
  r = await call('POST', `/api/slots/${slotId}/correct`, {
    version: ver - 1, reason: 'x', segments: [
      { start: '2026-11-10T08:30', end: '2026-11-10T12:30', lux: 100 },
    ],
  });
  ok(r.status === 409 && r.json.state.version === ver, '更正过期版本返回 409 与最新预算');

  // 12h. 合法更正：两段 120*100 + 120*150 = 30000，区间沿用原值
  r = await call('POST', `/api/slots/${slotId}/correct`, {
    version: ver,
    reason: '测光表复核：上午 100 lux，午后 150 lux',
    segments: [
      { start: '2026-11-10T08:30', end: '2026-11-10T10:30', lux: 100 },
      { start: '2026-11-10T10:30', end: '2026-11-10T12:30', lux: 150 },
    ],
  });
  ok(r.status === 200 && r.json.beforeExposure === 66000 && r.json.afterExposure === 30000,
     `更正成功：${r.json.beforeExposure} → ${r.json.afterExposure}`);
  ver = r.json.version;
  settled = r.json.slots.find((s) => s.id === slotId);
  art = r.json.artworks.find((a) => a.id === artId);
  ok(art.used === 30000, '更正后作品已用量按新总量替换，不重复累计');
  ok(settled.actualExposure === 30000 && settled.corrections.length === 1
     && settled.corrections[0].beforeExposure === 66000 && settled.corrections[0].afterExposure === 30000
     && settled.corrections[0].beforeSegments.length === 2 && settled.corrections[0].afterSegments.length === 2,
     '时段记录更正流水（前后曝光、前后分段快照）');

  // 12i. 再次更正：覆盖实际区间，单段（actualLux 恢复为数值）
  r = await call('POST', `/api/slots/${slotId}/correct`, {
    version: ver,
    reason: '补录：实际提前撤展，09:30 结束，全程 120 lux',
    actualStart: '2026-11-10T08:30',
    actualEnd: '2026-11-10T09:30',
    segments: [
      { start: '2026-11-10T08:30', end: '2026-11-10T09:30', lux: 120 },
    ],
  });
  ok(r.status === 200 && r.json.afterExposure === 7200, `覆盖区间更正成功（after=${r.json.afterExposure}）`);
  ver = r.json.version;
  settled = r.json.slots.find((s) => s.id === slotId);
  art = r.json.artworks.find((a) => a.id === artId);
  ok(settled.actualStart === '2026-11-10T08:30' && settled.actualEnd === '2026-11-10T09:30'
     && settled.actualLux === 120 && settled.actualExposure === 7200 && art.used === 7200,
     '单段更正后 actualLux 有值、作品已用量随之替换');
  ok(settled.corrections.length === 2, '累计两条更正记录');

  // 12j. 更正失败不改版本、不改结算
  r = await call('POST', `/api/slots/${slotId}/correct`, {
    version: ver, reason: '坏数据', segments: [
      { start: '2026-11-10T08:30', end: '2026-11-10T09:00', lux: 120 },
      { start: '2026-11-10T09:10', end: '2026-11-10T09:30', lux: 120 },
    ],
  });
  ok(r.status === 422, '不衔接的更正分段被拒绝');
  st = await getState();
  ok(st.version === ver && st.slots.find((s) => s.id === slotId).actualExposure === 7200,
     '更正被拒绝后版本与结算均不变');

  // 12k. 旧单一照度 finish 仍可用，且同样生成单段明细
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'legacy', hall: '旧接口厅', start: '2026-12-01T09:00', end: '2026-12-01T10:00', lux: 50, artworkIds: [artId] },
  ]});
  ok(r.status === 200, '为旧接口测试排入时段');
  const legacyId = r.json.slots.find((s) => s.hall === '旧接口厅').id;
  r = await call('POST', `/api/slots/${legacyId}/start`);
  ok(r.status === 200, '旧接口时段启动');
  r = await call('POST', `/api/slots/${legacyId}/finish`, {
    actualStart: '2026-12-01T09:00', actualEnd: '2026-12-01T10:00', actualLux: 55,
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 3300 && r.json.blockedAfterFinish !== undefined,
     `旧 POST /finish 语义保持可用（exposure=${r.json.justFinishedExposure}）`);
  settled = r.json.slots.find((s) => s.id === legacyId);
  ok(settled.actualLux === 55 && settled.actualSegments.length === 1 && settled.actualSegments[0].exposure === 3300,
     '旧接口结算同样落一条分段明细');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
