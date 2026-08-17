'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Путь к базе переопределяется через KUZGRAM_DB — тесты гоняют на временном файле
const DB_PATH = process.env.KUZGRAM_DB || path.join(__dirname, 'kuzgram.db');
const db = new Database(DB_PATH);

// В базе лежит вся переписка и все токены — читать её посторонним ни к чему
try {
  fs.chmodSync(DB_PATH, 0o600);
} catch (err) {
  console.error('Не смог ужать права на базу:', err.message);
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invites (
    code       TEXT    PRIMARY KEY,
    used_by    INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    used_at    INTEGER
  );

  CREATE TABLE IF NOT EXISTS tokens (
    token        TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    endpoint   TEXT    NOT NULL UNIQUE,
    keys_json  TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
`);

// Код с проставленным for_user не заводит нового человека, а привязывает
// ещё одно устройство к существующему: PWA с домашнего экрана на iOS —
// отдельное хранилище, сессия из Safari туда не переезжает
const inviteColumns = db.prepare('PRAGMA table_info(invites)').all().map((c) => c.name);
if (!inviteColumns.includes('for_user')) {
  db.exec('ALTER TABLE invites ADD COLUMN for_user INTEGER REFERENCES users(id)');
}
// Код с истёкшим сроком не примут: невостребованное приглашение не должно
// лежать годами и ждать, пока его подберут
if (!inviteColumns.includes('expires_at')) {
  db.exec('ALTER TABLE invites ADD COLUMN expires_at INTEGER');
}

const q = {
  insertUser: db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)'),
  getUser: db.prepare('SELECT id, name, created_at FROM users WHERE id = ?'),

  getInvite: db.prepare(
    'SELECT code, used_by, created_at, used_at, for_user, expires_at FROM invites WHERE code = ?'
  ),
  insertInvite: db.prepare(
    'INSERT INTO invites (code, created_at, for_user, expires_at) VALUES (?, ?, ?, ?)'
  ),
  findUserByName: db.prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE'),
  allUsers: db.prepare('SELECT id, name FROM users'),
  markInviteUsed: db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL'),

  insertToken: db.prepare('INSERT INTO tokens (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)'),
  getTokenUser: db.prepare(`
    SELECT u.id AS id, u.name AS name, t.last_seen_at AS last_seen_at
    FROM tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token = ?
  `),
  touchToken: db.prepare('UPDATE tokens SET last_seen_at = ? WHERE token = ?'),

  insertMessage: db.prepare('INSERT INTO messages (user_id, text, created_at) VALUES (?, ?, ?)'),
  getMessage: db.prepare(`
    SELECT m.id, m.user_id, m.text, m.created_at, u.name AS user_name
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.id = ?
  `),
  messagesAfter: db.prepare(`
    SELECT m.id, m.user_id, m.text, m.created_at, u.name AS user_name
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.id > ?
    ORDER BY m.id ASC
    LIMIT 100
  `),

  upsertSubscription: db.prepare(`
    INSERT INTO subscriptions (user_id, endpoint, keys_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json
  `),
  deleteSubscription: db.prepare('DELETE FROM subscriptions WHERE endpoint = ?'),
  subscriptionsExcept: db.prepare('SELECT endpoint, keys_json FROM subscriptions WHERE user_id != ?'),
  countSubscriptions: db.prepare('SELECT COUNT(*) AS n FROM subscriptions'),
};

const now = () => Date.now();

// Инвайт одноразовый: пометка used и создание юзера — одной транзакцией,
// иначе два одновременных входа по одному коду создадут двух пользователей
const redeemInvite = db.transaction((code, name) => {
  const invite = q.getInvite.get(code);
  if (!invite) return { error: 'unknown_code' };
  if (invite.used_by !== null) return { error: 'code_used' };

  const ts = now();
  if (invite.expires_at && ts > invite.expires_at) return { error: 'code_expired' };
  let userId;

  if (invite.for_user) {
    // Код на второе устройство: нового человека не заводим
    userId = invite.for_user;
    if (!q.getUser.get(userId)) return { error: 'unknown_code' };
  } else {
    if (!name) return { error: 'no_name' };
    userId = Number(q.insertUser.run(name, ts).lastInsertRowid);
  }

  const marked = q.markInviteUsed.run(userId, ts, code);
  if (marked.changes !== 1) throw new Error('invite race');

  return { user: q.getUser.get(userId) };
});

module.exports = {
  db,
  now,
  redeemInvite,

  createInvite: (code, forUserId, expiresAt) =>
    q.insertInvite.run(code, now(), forUserId || null, expiresAt || null),
  getInvite: (code) => q.getInvite.get(code),
  getUser: (id) => q.getUser.get(id),
  // COLLATE NOCASE в SQLite складывает только латиницу, а имена тут кириллические:
  // «ноут» по такому запросу не найдётся, если в базе «Ноут». Досравниваем в JS
  findUserByName: (name) => {
    const exact = q.findUserByName.get(name);
    if (exact) return exact;
    const needle = String(name).toLowerCase();
    return q.allUsers.all().find((u) => u.name.toLowerCase() === needle);
  },

  createToken: (token, userId) => q.insertToken.run(token, userId, now(), now()),
  userByToken: (token) => q.getTokenUser.get(token),
  touchToken: (token) => q.touchToken.run(now(), token),

  addMessage: (userId, text) => {
    const info = q.insertMessage.run(userId, text, now());
    return q.getMessage.get(Number(info.lastInsertRowid));
  },
  messagesAfter: (afterId) => q.messagesAfter.all(afterId),

  saveSubscription: (userId, endpoint, keys) =>
    q.upsertSubscription.run(userId, endpoint, JSON.stringify(keys), now()),
  deleteSubscription: (endpoint) => q.deleteSubscription.run(endpoint),
  subscriptionsExcept: (userId) =>
    q.subscriptionsExcept.all(userId).map((row) => ({
      endpoint: row.endpoint,
      keys: JSON.parse(row.keys_json),
    })),
  countSubscriptions: () => q.countSubscriptions.get().n,
};
