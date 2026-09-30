'use strict';

const $ = (sel) => document.querySelector(sel);
let state = { version: null, artworks: [], slots: [] };
let draft = [];          // 未开始时段草稿
let draftSeq = 0;        // 草稿行本地序号
let editingArtworkId = null;
let finishingSlotId = null;

// ---------- 工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function minutes(s, e) {
  if (!s || !e) return null;
  const ms = new Date(s).getTime(), me = new Date(e).getTime();
  if (Number.isNaN(ms) || Number.isNaN(me)) return null;
  return Math.round((me - ms) / 60000);
}
function statusBadge(s) {
  if (s.status === 'running') return '<span class="badge badge-running">进行中·冻结</span>';
  if (s.status === 'finished') return '<span class="badge badge-finished">已结束</span>';
  if (s.blocked) return '<span class="badge badge-blocked">不可启动</span>';
  return '<span class="badge badge-scheduled">未开始</span>';
}
let toastTimer = null;
function toast(kind, text) {
  const el = $('#toast');
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ---------- 数据加载 ----------
async function loadState(resetDraft = true) {
  state = await api('/api/state');
  $('#versionTag').textContent = `v${state.version}`;
  if (resetDraft) draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
function serverRowToDraft(s) {
  return {
    cid: `s${s.id}`,
    savedId: s.id,
    hall: s.hall,
    start: s.plannedStart,
    end: s.plannedEnd,
    lux: s.plannedLux,
    artworkIds: s.artworks.map((a) => a.id),
    blocked: s.blocked,
    blockedReason: s.blockedReason,
  };
}
function newDraftRow() {
  return { cid: `d${++draftSeq}`, hall: '', start: '', end: '', lux: 50, artworkIds: [] };
}

// ---------- 渲染：作品 ----------
function renderArtworks() {
  const tb = $('#artworkTable tbody');
  if (!state.artworks.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">还没有作品，点击「录入作品」开始</td></tr>';
    return;
  }
  tb.innerHTML = state.artworks.map((a) => `
    <tr>
      <td class="art-name">${esc(a.name)}</td>
      <td class="num">${fmt(a.limit)}</td>
      <td class="num">${fmt(a.existing)}</td>
      <td class="num">${fmt(a.used)}</td>
      <td class="num">${fmt(a.reserved)}<span class="reserved-detail">${fmt(a.reservedRunning)} / ${fmt(a.reservedScheduled)}</span></td>
      <td class="num">${fmt(a.committed)}</td>
      <td class="num ${a.over ? 'neg' : 'pos'}">${a.over ? '−' + fmt(Math.abs(a.balance)) : fmt(a.balance)}</td>
      <td class="note-text">${esc(a.note)}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="edit-art" data-id="${a.id}">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="del-art" data-id="${a.id}">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ---------- 渲染：冻结时段（进行中/已结束） ----------
function segmentsHtml(segments) {
  if (!segments || !segments.length) return '<div class="hint">无分段明细</div>';
  const total = segments.reduce((a, g) => a + (g.exposure || 0), 0);
  return `
    <table class="seg-table">
      <thead><tr>
        <th>段</th><th>开始</th><th>结束</th><th class="num">照度(lux)</th>
        <th class="num">分钟</th><th class="num">曝光(lux·min)</th>
      </tr></thead>
      <tbody>
        ${segments.map((g, gi) => `
          <tr>
            <td>${(g.index ?? gi) + 1}</td>
            <td class="mono">${esc(g.start)}</td>
            <td class="mono">${esc(g.end)}</td>
            <td class="num">${fmt(g.lux)}</td>
            <td class="num">${fmt(g.minutes)}</td>
            <td class="num">${fmt(g.exposure)}</td>
          </tr>`).join('')}
        <tr><td colspan="5" class="num" style="text-align:right;color:var(--muted)">合计</td>
          <td class="num" style="font-weight:700">${fmt(Math.round(total * 1000) / 1000)}</td></tr>
      </tbody>
    </table>`;
}

function correctionsHtml(slot) {
  const list = slot.corrections || [];
  if (!list.length) return '';
  return `
    <h4>更正记录（${list.length}）</h4>
    ${list.map((c) => `
      <div class="corr-item">
        <div class="corr-head">
          <span class="corr-reason">理由：${esc(c.reason)}</span>
          <span>${esc((c.createdAt || '').replace('T', ' ').slice(0, 19))}</span>
        </div>
        <div class="corr-diff">
          曝光 <span class="before">${fmt(c.beforeExposure)}</span>
          → <span class="after">${fmt(c.afterExposure)}</span> lux·min
          （${esc(c.beforeStart)} ~ ${esc(c.beforeEnd)}
          → ${esc(c.afterStart)} ~ ${esc(c.afterEnd)}）
        </div>
        <details><summary style="cursor:pointer;color:var(--muted)">查看更正前后分段</summary>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">
            <div style="flex:1;min-width:240px"><strong style="color:var(--danger)">更正前</strong>${segmentsHtml(c.beforeSegments)}</div>
            <div style="flex:1;min-width:240px"><strong style="color:var(--primary)">更正后</strong>${segmentsHtml(c.afterSegments)}</div>
          </div>
        </details>
      </div>`).join('')}`;
}

function renderFrozen() {
  const tb = $('#frozenTable tbody');
  const rows = state.slots
    .filter((s) => s.status === 'running' || s.status === 'finished')
    .sort((a, b) => a.seq - b.seq);
  if (!rows.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="11">暂无进行中或已结束时段</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((s) => {
    const corrCount = (s.corrections || []).length;
    const luxCell = s.actualLux === null
      ? (s.actualSegments ? `<span class="badge badge-scheduled">多段×${s.actualSegments.length}</span>` : '—')
      : fmt(s.actualLux);
    return `
    <tr>
      <td>${s.seq}</td>
      <td>${esc(s.hall)}</td>
      <td>${statusBadge(s)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${esc(s.plannedStart)}<br>～ ${esc(s.plannedEnd)}
      </td>
      <td class="num">${fmt(s.plannedLux)}</td>
      <td class="num">${fmt(s.plannedExposure)}</td>
      <td class="mono" style="font-family:var(--mono);font-size:12.5px;white-space:nowrap">
        ${s.actualStart ? `${esc(s.actualStart)}<br>～ ${esc(s.actualEnd)}` : '—（冻结中）'}
      </td>
      <td class="num">${luxCell}</td>
      <td class="num">${s.actualExposure === null ? '—' : fmt(s.actualExposure)}</td>
      <td><div class="art-chips">${s.artworks.map((a) => `<span class="chip">${esc(a.name)}</span>`).join('')}</div></td>
      <td>
        ${s.status === 'running'
          ? `<button class="btn btn-sm btn-primary" data-act="finish" data-id="${s.id}">结束补记</button>`
          : `<button class="btn btn-sm" data-act="correct" data-id="${s.id}">分段更正</button>
             <button class="seg-toggle" data-act="toggle-detail" data-id="${s.id}">
               分段${s.actualSegments ? `×${s.actualSegments.length}` : ''}${corrCount ? ` / 更正×${corrCount}` : ''}
             </button>`}
      </td>
    </tr>
    <tr class="detail-row hidden" id="detail_${s.id}">
      <td colspan="11"><div class="detail-box">
        <h4>实际照度分段</h4>
        ${segmentsHtml(s.actualSegments)}
        ${correctionsHtml(s)}
      </div></td>
    </tr>`;
  }).join('');
}

// ---------- 渲染：未开始草稿 ----------
function renderDraft() {
  const tb = $('#scheduleTable tbody');
  if (!draft.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">没有未开始时段，点击「新增时段」，或从下方整批保存</td></tr>';
    return;
  }
  const artOptions = (selected) => state.artworks
    .map((a) => `<option value="${a.id}" ${selected.includes(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('');

  tb.innerHTML = draft.map((r) => {
    const mins = minutes(r.start, r.end);
    const expo = mins !== null && mins >= 0 && Number(r.lux) >= 0 ? Math.round(mins * Number(r.lux)) : null;
    const gaps = (r.blockedReason && r.blockedReason.gaps) || [];
    const gapHtml = gaps.length ? `
      <tr class="blocked-tag-row">
        <td colspan="8" class="blocked-cell">
          <strong>⛔ 预算不足，禁止启动。</strong> 调整排期后重新核算。
          <ul class="gap-list">
            ${gaps.map((g) => `<li>作品「${esc(g.artworkName)}」：当前可用余额 ${fmt(g.has)}，本时段需要 ${fmt(g.need)}，缺口 <strong>${fmt(g.gap)}</strong> lux·min</li>`).join('')}
          </ul>
        </td>
      </tr>` : '';
    return `
      <tr data-cid="${esc(r.cid)}">
        <td><input type="text" value="${esc(r.hall)}" data-f="hall" placeholder="如：一号厅" style="width:110px" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.start)}" data-f="start" /></td>
        <td><input type="datetime-local" class="mono" value="${esc(r.end)}" data-f="end" /></td>
        <td><input type="number" min="0" step="1" value="${esc(r.lux)}" data-f="lux" /></td>
        <td class="num">${mins === null ? '–' : mins < 0 ? '✗' : mins}</td>
        <td class="cell-expo ${r.blocked ? 'neg' : ''}">${expo === null || expo < 0 ? '–' : fmt(expo)}</td>
        <td><select multiple size="3" data-f="artworkIds">${artOptions(r.artworkIds)}</select></td>
        <td>
          <div class="row-actions">
            ${r.savedId ? `<button class="btn btn-sm btn-primary" data-act="start" data-id="${r.savedId}">▶ 启动</button>` : ''}
            <button class="btn btn-sm btn-danger" data-act="del-draft">删除</button>
          </div>
        </td>
      </tr>
      ${gapHtml}
    `;
  }).join('');
}

function renderAll() {
  renderArtworks();
  renderFrozen();
  renderDraft();
}

// ---------- 草稿交互 ----------
function syncRowFromDom(tr) {
  const cid = tr.dataset.cid;
  const row = draft.find((r) => r.cid === cid);
  if (!row) return;
  tr.querySelectorAll('[data-f]').forEach((el) => {
    const f = el.dataset.f;
    if (f === 'artworkIds') {
      row.artworkIds = Array.from(el.selectedOptions).map((o) => Number(o.value));
    } else if (f === 'lux') {
      row.lux = el.value;
    } else {
      row[f] = el.value;
    }
  });
  // 草稿一旦被改动，清除服务端的核算标记，保存后以服务端结果为准
  row.blocked = false;
  row.blockedReason = null;
  row.savedId = undefined;
}

$('#addSlotBtn').addEventListener('click', () => {
  if (!state.artworks.length) return toast('warn', '请先录入至少一件作品');
  draft.push(newDraftRow());
  renderDraft();
});
$('#resetDraftBtn').addEventListener('click', () => {
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderDraft();
});

$('#scheduleTable').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-cid]');
  if (tr) { syncRowFromDom(tr); renderDraft(); }
});
$('#scheduleTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = e.target.closest('tr[data-cid]');
  if (btn.dataset.act === 'del-draft' && tr) {
    syncRowFromDom(tr);
    draft = draft.filter((r) => r.cid !== tr.dataset.cid);
    renderDraft();
  }
  if (btn.dataset.act === 'start') {
    syncRowFromDom(tr);
    await startSlot(Number(btn.dataset.id));
  }
});

// ---------- 整批保存 ----------
function formatBatchError(payload) {
  const lines = [];
  (payload.errors || []).forEach((x) => lines.push(`• ${x.message}`));
  (payload.conflicts || []).forEach((c) => {
    lines.push(`• 作品「${c.artworkName}」时段重叠：\n    ${c.slotA.label}\n    ${c.slotB.label}`);
  });
  (payload.budgetExceeded || []).forEach((b) => {
    lines.push(`• 作品「${b.artworkName}」预算超限：已用 ${fmt(b.used)} + 预占 = ${fmt(b.projected)}，上限 ${fmt(b.limit)}，超出 ${fmt(b.overflow)} lux·min`);
  });
  return lines.join('\n') || '整批校验失败';
}

$('#saveScheduleBtn').addEventListener('click', async () => {
  // 先把 DOM 中未触发 change 的输入同步进来
  document.querySelectorAll('#scheduleTable tbody tr[data-cid]').forEach(syncRowFromDom);
  try {
    const body = {
      version: state.version,
      slots: draft.map((r) => ({
        cid: r.cid, hall: r.hall, start: r.start, end: r.end,
        lux: r.lux === '' ? null : Number(r.lux),
        artworkIds: r.artworkIds,
      })),
    };
    const next = await api('/api/schedule', { method: 'POST', body });
    applyNewState(next);
    const blocked = next.slots.filter((s) => s.blocked);
    if (blocked.length) {
      const detail = blocked.map((s) => {
        const gaps = (s.blockedReason.gaps || []).map((g) =>
          `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
        return `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gaps}`;
      }).join('\n');
      toast('warn', `整批已保存并重新核算，以下时段按开始顺序不可启动：\n${detail}`);
    } else {
      toast('success', '整批校验通过，排期已保存');
    }
  } catch (err) {
    await handleMutationError(err);
  }
});

async function startSlot(id) {
  try {
    const next = await api(`/api/slots/${id}/start`, { method: 'POST' });
    applyNewState(next);
    toast('success', '时段已启动：原排期冻结，预占保留');
  } catch (err) {
    if (err.status === 422 && err.payload && err.payload.blockedReason) {
      const gaps = (err.payload.blockedReason.gaps || []).map((g) =>
        `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('\n');
      toast('error', `禁止启动：预算不足\n${gaps}\n请调整排期后重新核算`);
    } else {
      toast('error', err.message);
    }
  }
}

// ---------- 结束补记 / 分段更正 ----------
let finishMode = 'single';      // 'single' | 'multi'
let fnSegRows = [];
let correctingSlotId = null;
let corSegRows = [];

function tsMin(str) {
  if (!str) return null;
  const t = new Date(str).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 60000);
}

// 分段客户端校验（服务端仍为最终依据）。expected: {start,end} 或 null（按分段自身跨度）
function segCoverage(rows, expected) {
  const errs = [];
  if (!rows.length) return ['至少需要 1 个分段'];
  const p = [];
  rows.forEach((g, i) => {
    const s = tsMin(g.start), e = tsMin(g.end), lux = Number(g.lux);
    if (s === null) errs.push(`第 ${i + 1} 段开始时间无效`);
    if (e === null) errs.push(`第 ${i + 1} 段结束时间无效`);
    if (s !== null && e !== null && e <= s) errs.push(`第 ${i + 1} 段结束必须晚于开始`);
    if (!(lux >= 0)) errs.push(`第 ${i + 1} 段照度必须为非负数值`);
    if (s !== null && e !== null && e > s && lux >= 0) p.push({ i, s, e });
  });
  if (errs.length) return errs;
  p.sort((a, b) => a.s - b.s || a.e - b.e);
  if (expected) {
    const es = tsMin(expected.start), ee = tsMin(expected.end);
    if (p[0].s !== es) errs.push('首段开始必须等于实际开始时间');
    if (p[p.length - 1].e !== ee) errs.push('末段结束必须等于实际结束时间');
  }
  for (let k = 1; k < p.length; k++) {
    if (p[k].s < p[k - 1].e) errs.push(`第 ${p[k - 1].i + 1}、${p[k].i + 1} 段重叠，分段须首尾衔接`);
    else if (p[k].s > p[k - 1].e) errs.push(`第 ${p[k - 1].i + 1}、${p[k].i + 1} 段之间有缺口，分段须首尾衔接`);
  }
  return errs;
}

function segRowsTotal(rows) {
  let total = 0;
  for (const g of rows) {
    const m = minutes(g.start, g.end);
    const lux = Number(g.lux);
    if (m === null || m <= 0 || !(lux >= 0)) return null;
    total += m * lux;
  }
  return Math.round(total);
}

function renderSegRows(containerId, rows) {
  $('#' + containerId).innerHTML = rows.map((g, i) => `
    <div class="seg-row">
      <span class="seg-idx">${i + 1}</span>
      <input type="datetime-local" data-f="start" value="${esc(g.start)}" />
      <input type="datetime-local" data-f="end" value="${esc(g.end)}" />
      <input type="number" min="0" step="1" data-f="lux" value="${esc(g.lux)}" />
      <button type="button" class="seg-del" data-act="seg-del" title="删除此段">✕</button>
    </div>`).join('');
}
function readSegRows(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} .seg-row`)).map((row) => ({
    start: row.querySelector('[data-f="start"]').value,
    end: row.querySelector('[data-f="end"]').value,
    lux: row.querySelector('[data-f="lux"]').value,
  }));
}
function segPayload(rows) {
  return rows.map((g) => ({ start: g.start, end: g.end, lux: Number(g.lux) }));
}

function setFinishMode(mode) {
  finishMode = mode;
  $('#fn_tab_single').classList.toggle('active', mode === 'single');
  $('#fn_tab_multi').classList.toggle('active', mode === 'multi');
  $('#fn_single_pane').classList.toggle('hidden', mode !== 'single');
  $('#fn_multi_pane').classList.toggle('hidden', mode !== 'multi');
  if (mode === 'multi') updateFinishMultiPreview();
  else updateFinishPreview();
}

$('#frozenTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const slot = state.slots.find((s) => s.id === id);

  if (btn.dataset.act === 'toggle-detail') {
    $('#detail_' + id).classList.toggle('hidden');
    return;
  }
  if (btn.dataset.act === 'finish') {
    finishingSlotId = id;
    $('#fn_start').value = slot.plannedStart;
    $('#fn_end').value = slot.plannedEnd;
    $('#fn_lux').value = slot.plannedLux;
    fnSegRows = [{ start: slot.plannedStart, end: slot.plannedEnd, lux: String(slot.plannedLux) }];
    renderSegRows('fn_seg_rows', fnSegRows);
    $('#fn_error').classList.add('hidden');
    setFinishMode('single');
    $('#finishModal').classList.remove('hidden');
  }
  if (btn.dataset.act === 'correct') {
    openCorrectModal(slot);
  }
});

function updateFinishPreview() {
  const mins = minutes($('#fn_start').value, $('#fn_end').value);
  const lux = Number($('#fn_lux').value);
  const el = $('#fn_preview');
  if (mins !== null && mins > 0 && lux >= 0) el.textContent = fmt(Math.round(mins * lux));
  else el.textContent = '–';
}
function updateFinishMultiPreview() {
  const rows = readSegRows('fn_seg_rows');
  const errs = segCoverage(rows, null);
  $('#fn_multi_err').textContent = errs.length ? `⚠ ${errs[0]}` : '';
  const total = errs.length ? null : segRowsTotal(rows);
  $('#fn_multi_preview').textContent = total === null ? '–' : fmt(total);
}
['fn_start', 'fn_end', 'fn_lux'].forEach((id) => $('#' + id).addEventListener('input', updateFinishPreview));
$('#fn_tab_single').addEventListener('click', () => setFinishMode('single'));
$('#fn_tab_multi').addEventListener('click', () => setFinishMode('multi'));
$('#fn_seg_rows').addEventListener('input', updateFinishMultiPreview);
$('#fn_seg_rows').addEventListener('click', (e) => {
  const del = e.target.closest('[data-act="seg-del"]');
  if (!del) return;
  const rows = readSegRows('fn_seg_rows');
  const idx = Array.from(document.querySelectorAll('#fn_seg_rows .seg-row')).indexOf(del.closest('.seg-row'));
  rows.splice(idx, 1);
  fnSegRows = rows;
  renderSegRows('fn_seg_rows', fnSegRows);
  updateFinishMultiPreview();
});
$('#fn_seg_add').addEventListener('click', () => {
  fnSegRows = readSegRows('fn_seg_rows');
  // 默认接上一段结束：新段用上一段结束作为开始
  const last = fnSegRows[fnSegRows.length - 1];
  fnSegRows.push({ start: last ? last.end : '', end: '', lux: '0' });
  renderSegRows('fn_seg_rows', fnSegRows);
  updateFinishMultiPreview();
});

function reportSettled(next, verb) {
  if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
    const detail = next.blockedAfterFinish.map((s) => {
      const gaps = (s.blockedReason.gaps || []).map((g) =>
        `「${g.artworkName}」缺口 ${fmt(g.gap)}（可用 ${fmt(g.has)} / 需 ${fmt(g.need)}）`).join('；');
      return `#${s.seq} ${s.hall} ${s.plannedStart}~${s.plannedEnd}：${gaps}`;
    }).join('\n');
    toast('warn', `${verb}，实际曝光 ${fmt(next.justFinishedExposure)} lux·min 已替换预占。\n超量导致以下后续时段预算不足、不可开始：\n${detail}\n请调整排期后重新核算`);
  } else {
    toast('success', `${verb}，实际曝光 ${fmt(next.justFinishedExposure)} lux·min 已替换预占`);
  }
}

$('#fn_save').addEventListener('click', async () => {
  try {
    let next;
    if (finishMode === 'single') {
      next = await api(`/api/slots/${finishingSlotId}/finish`, {
        method: 'POST',
        body: {
          actualStart: $('#fn_start').value,
          actualEnd: $('#fn_end').value,
          actualLux: Number($('#fn_lux').value),
        },
      });
    } else {
      const rows = readSegRows('fn_seg_rows');
      const errs = segCoverage(rows, null);
      if (errs.length) {
        $('#fn_error').textContent = errs.join('\n');
        $('#fn_error').classList.remove('hidden');
        return;
      }
      next = await api(`/api/slots/${finishingSlotId}/settle`, {
        method: 'POST',
        body: { version: state.version, segments: segPayload(rows) },
      });
    }
    $('#finishModal').classList.add('hidden');
    applyNewState(next);
    reportSettled(next, finishMode === 'single' ? '已结束并补记' : '多段照度已结算');
  } catch (err) {
    if (err.status === 409) {
      $('#finishModal').classList.add('hidden');
      return handleMutationError(err);
    }
    const detail = err.payload && err.payload.errors ? err.payload.errors.join('\n') : err.message;
    $('#fn_error').textContent = detail;
    $('#fn_error').classList.remove('hidden');
  }
});

// ---------- 已结束时段分段更正 ----------
function openCorrectModal(slot) {
  correctingSlotId = slot.id;
  const segs = slot.actualSegments && slot.actualSegments.length
    ? slot.actualSegments
    : [{ start: slot.actualStart, end: slot.actualEnd, lux: slot.actualLux ?? 0 }];
  corSegRows = segs.map((g) => ({ start: g.start, end: g.end, lux: String(g.lux) }));
  $('#cor_meta').innerHTML = `
    时段 <strong>#${slot.seq} ${esc(slot.hall)}</strong>
    原实际区间 <strong>${esc(slot.actualStart)} ~ ${esc(slot.actualEnd)}</strong><br>
    更正前曝光合计 <strong>${fmt(slot.actualExposure)}</strong> lux·min，已有更正记录 ${(slot.corrections || []).length} 条`;
  $('#cor_override').checked = false;
  $('#cor_actual_start').value = slot.actualStart;
  $('#cor_actual_end').value = slot.actualEnd;
  $('#cor_range').classList.add('hidden');
  $('#cor_reason').value = '';
  $('#cor_error').classList.add('hidden');
  renderSegRows('cor_seg_rows', corSegRows);
  updateCorrectPreview();
  $('#correctModal').classList.remove('hidden');
}
function correctExpected(slot) {
  if ($('#cor_override').checked) {
    return { start: $('#cor_actual_start').value, end: $('#cor_actual_end').value };
  }
  return { start: slot.actualStart, end: slot.actualEnd };
}
function updateCorrectPreview() {
  const slot = state.slots.find((s) => s.id === correctingSlotId);
  if (!slot) return;
  const rows = readSegRows('cor_seg_rows');
  const errs = segCoverage(rows, correctExpected(slot));
  $('#cor_seg_err').textContent = errs.length ? `⚠ ${errs[0]}` : '';
  const total = errs.length ? null : segRowsTotal(rows);
  $('#cor_preview').textContent = total === null ? '–' : fmt(total);
}
$('#cor_override').addEventListener('change', () => {
  $('#cor_range').classList.toggle('hidden', !$('#cor_override').checked);
  updateCorrectPreview();
});
['cor_actual_start', 'cor_actual_end'].forEach((id) => $('#' + id).addEventListener('input', updateCorrectPreview));
$('#cor_seg_rows').addEventListener('input', updateCorrectPreview);
$('#cor_seg_rows').addEventListener('click', (e) => {
  const del = e.target.closest('[data-act="seg-del"]');
  if (!del) return;
  const rows = readSegRows('cor_seg_rows');
  const idx = Array.from(document.querySelectorAll('#cor_seg_rows .seg-row')).indexOf(del.closest('.seg-row'));
  rows.splice(idx, 1);
  corSegRows = rows;
  renderSegRows('cor_seg_rows', corSegRows);
  updateCorrectPreview();
});
$('#cor_seg_add').addEventListener('click', () => {
  corSegRows = readSegRows('cor_seg_rows');
  const last = corSegRows[corSegRows.length - 1];
  corSegRows.push({ start: last ? last.end : '', end: '', lux: '0' });
  renderSegRows('cor_seg_rows', corSegRows);
  updateCorrectPreview();
});
$('#cor_save').addEventListener('click', async () => {
  const slot = state.slots.find((s) => s.id === correctingSlotId);
  const reason = $('#cor_reason').value.trim();
  if (!reason) {
    $('#cor_error').textContent = '请填写更正理由';
    $('#cor_error').classList.remove('hidden');
    return;
  }
  const rows = readSegRows('cor_seg_rows');
  const expected = correctExpected(slot);
  const errs = segCoverage(rows, expected);
  if (errs.length) {
    $('#cor_error').textContent = errs.join('\n');
    $('#cor_error').classList.remove('hidden');
    return;
  }
  const body = { version: state.version, reason, segments: segPayload(rows) };
  if ($('#cor_override').checked) {
    body.actualStart = $('#cor_actual_start').value;
    body.actualEnd = $('#cor_actual_end').value;
  }
  try {
    const next = await api(`/api/slots/${correctingSlotId}/correct`, { method: 'POST', body });
    $('#correctModal').classList.add('hidden');
    applyNewState(next);
    // 更正可能解除缺口，展开该行便于看到记录
    $('#detail_' + correctingSlotId)?.classList.remove('hidden');
    const diff = `曝光 ${fmt(next.beforeExposure)} → ${fmt(next.afterExposure)} lux·min`;
    if (next.blockedAfterFinish && next.blockedAfterFinish.length) {
      reportSettled(next, `已更正（${diff}）`);
    } else {
      toast('success', `分段更正已生效（${diff}），作品已用量与后续时段核算已重算`);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#correctModal').classList.add('hidden');
      return handleMutationError(err);
    }
    const detail = err.payload && err.payload.errors ? err.payload.errors.join('\n') : err.message;
    $('#cor_error').textContent = detail;
    $('#cor_error').classList.remove('hidden');
  }
});

// ---------- 作品弹窗 ----------
function openArtworkModal(a) {
  editingArtworkId = a ? a.id : null;
  $('#artworkModalTitle').textContent = a ? '编辑作品' : '录入作品';
  $('#aw_name').value = a ? a.name : '';
  $('#aw_limit').value = a ? a.limit : '';
  $('#aw_existing').value = a ? a.existing : '';
  $('#aw_note').value = a ? a.note : '';
  $('#aw_error').classList.add('hidden');
  $('#artworkModal').classList.remove('hidden');
}
$('#addArtworkBtn').addEventListener('click', () => openArtworkModal(null));

$('#artworkTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.act === 'edit-art') {
    openArtworkModal(state.artworks.find((a) => a.id === id));
  }
  if (btn.dataset.act === 'del-art') {
    const a = state.artworks.find((x) => x.id === id);
    if (!confirm(`确定删除作品「${a.name}」吗？`)) return;
    try {
      const next = await api(`/api/artworks/${id}`, { method: 'DELETE', body: { version: state.version } });
      applyNewState(next);
      toast('success', '作品已删除');
    } catch (err) { await handleMutationError(err); }
  }
});

$('#aw_save').addEventListener('click', async () => {
  const payload = {
    version: state.version,
    name: $('#aw_name').value,
    limit: Number($('#aw_limit').value),
    existing: Number($('#aw_existing').value),
    note: $('#aw_note').value,
  };
  try {
    const next = editingArtworkId
      ? await api(`/api/artworks/${editingArtworkId}`, { method: 'PUT', body: payload })
      : await api('/api/artworks', { method: 'POST', body: payload });
    applyNewState(next);
    $('#artworkModal').classList.add('hidden');
    toast('success', editingArtworkId ? '作品已更新' : '作品已录入');
  } catch (err) {
    if (err.status === 409) { $('#artworkModal').classList.add('hidden'); }
    await handleMutationError(err);
  }
});

// ---------- 通用 ----------
function applyNewState(next) {
  state = next;
  $('#versionTag').textContent = `v${state.version}`;
  draft = state.slots.filter((s) => s.status === 'scheduled').map(serverRowToDraft);
  renderAll();
}
async function handleMutationError(err) {
  if (err.status === 409 && err.payload && err.payload.state) {
    applyNewState(err.payload.state);
    toast('error', `${err.message}\n本地草稿已被服务端最新预算替换，请重新调整后再提交`);
    return;
  }
  if (err.status === 422 && err.payload) toast('error', formatBatchError(err.payload));
  else toast('error', err.message);
}

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('.modal-mask').classList.add('hidden')));
document.querySelectorAll('.modal-mask').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

$('#refreshBtn').addEventListener('click', () => loadState(true).then(() => toast('success', '已刷新为最新预算')));

loadState().catch((err) => toast('error', `初始化加载失败：${err.message}`));
