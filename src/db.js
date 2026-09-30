'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lightbudget.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 全局版本：任何对作品 / 排期 / 时段生命周期的变更都会使其 +1。
-- 并发调整必须携带当前版本，过期则拒绝（409）。
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1
);

-- 作品：展期曝光上限（lux·min）与既有累计量
CREATE TABLE IF NOT EXISTS artworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  limit_amount REAL NOT NULL CHECK (limit_amount >= 0),
  existing_amount REAL NOT NULL CHECK (existing_amount >= 0),
  note TEXT NOT NULL DEFAULT ''
);

-- 展厅时段
-- status: scheduled 未开始 / running 进行中(冻结原排期) / finished 已结束(以实际值结算)
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hall TEXT NOT NULL,
  seq INTEGER NOT NULL,                 -- 编号（按开始时间排序的顺序号）
  status TEXT NOT NULL DEFAULT 'scheduled',
  -- 排期（计划）值：开始后冻结
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  planned_lux REAL NOT NULL CHECK (planned_lux >= 0),
  -- 结束时补记的实际值（actual_lux 仅在单一照度结算时有值；多段结算见 slot_segments）
  actual_start TEXT,
  actual_end TEXT,
  actual_lux REAL,
  actual_exposure REAL,
  -- 核算结果：该时段按当前预算是否可启动
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT NOT NULL DEFAULT '{}'
);

-- 实际照度分段：实际照度随时间变化时，按段记录起止与照度，曝光 = Σ(段分钟 × 段照度)
-- 同一时段的分段须首尾衔接、无重叠并完整覆盖 slots.actual_start ~ actual_end。
CREATE TABLE IF NOT EXISTS slot_segments (
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  seg_index INTEGER NOT NULL,              -- 段序号（按开始时间升序，0 起）
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  lux REAL NOT NULL CHECK (lux >= 0),
  exposure REAL NOT NULL CHECK (exposure >= 0),
  PRIMARY KEY (slot_id, seg_index)
);

-- 已结束时段的完整分段更正记录（审计流水）：新总量替换旧总量，不重复累计
CREATE TABLE IF NOT EXISTS slot_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_start TEXT NOT NULL,
  before_end TEXT NOT NULL,
  before_exposure REAL NOT NULL,
  after_start TEXT NOT NULL,
  after_end TEXT NOT NULL,
  after_exposure REAL NOT NULL,
  before_segments TEXT NOT NULL DEFAULT '[]',  -- 更正前分段 JSON 快照
  after_segments TEXT NOT NULL DEFAULT '[]'    -- 更正后分段 JSON 快照
);
CREATE INDEX IF NOT EXISTS idx_slot_corrections_slot ON slot_corrections(slot_id, id);

-- 时段 <-> 作品（一个时段可同时展出多件作品，同照度下分别计入各作品）
CREATE TABLE IF NOT EXISTS slot_artworks (
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  PRIMARY KEY (slot_id, artwork_id)
);
`;

function backfillSegments(db) {
  // 旧库兼容：已结束但没有分段记录的时段（历史单一照度结算 / 演示数据），补一段等值分段。
  const rows = db.prepare(`
    SELECT s.id, s.actual_start, s.actual_end, s.actual_lux, s.actual_exposure
    FROM slots s
    LEFT JOIN slot_segments g ON g.slot_id = s.id
    WHERE s.status = 'finished' AND g.slot_id IS NULL
    GROUP BY s.id
  `).all();
  if (!rows.length) return;
  const ins = db.prepare(`
    INSERT INTO slot_segments (slot_id, seg_index, start_time, end_time, lux, exposure)
    VALUES (?, 0, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.actual_start || !r.actual_end) continue;
      ins.run(r.id, r.actual_start, r.actual_end, r.actual_lux ?? 0, r.actual_exposure ?? 0);
    }
  });
  tx.immediate();
}

function openDb() {
  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  backfillSegments(db);
  return db;
}

function resetDb() {
  if (DB_PATH !== ':memory:' && fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH);
    for (const suffix of ['-wal', '-shm']) {
      const f = DB_PATH + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }
  const db = openDb();
  db.close();
  return DB_PATH;
}

module.exports = { openDb, resetDb, DB_PATH };
