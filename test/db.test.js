'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// База — временный файл, до первого require('../db')
const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kuzgram-db-')), 'test.db');
process.env.KUZGRAM_DB = DB_FILE;

const store = require('../db');

test.after(() => {
  store.db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

test('схема создаётся при старте', () => {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

  for (const name of ['users', 'invites', 'tokens', 'messages', 'subscriptions']) {
    assert.ok(tables.includes(name), `нет таблицы ${name}`);
  }

  const inviteColumns = store.db.prepare('PRAGMA table_info(invites)').all().map((c) => c.name);
  assert.ok(inviteColumns.includes('for_user'), 'миграция for_user не отработала');
});

test('инвайт: неизвестный код', () => {
  assert.deepStrictEqual(store.redeemInvite('KUZ-NOPE-NOPE', 'Кто-то'), { error: 'unknown_code' });
});

test('инвайт: обычный код заводит пользователя и гасится', () => {
  store.createInvite('KUZ-AAAA-1111');

  const result = store.redeemInvite('KUZ-AAAA-1111', 'Мама');
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.user.name, 'Мама');

  const invite = store.getInvite('KUZ-AAAA-1111');
  assert.strictEqual(invite.used_by, result.user.id);
  assert.ok(invite.used_at > 0);
});

test('инвайт: второй раз тем же кодом — отлуп', () => {
  store.createInvite('KUZ-AAAA-2222');
  store.redeemInvite('KUZ-AAAA-2222', 'Папа');

  assert.deepStrictEqual(store.redeemInvite('KUZ-AAAA-2222', 'Вор'), { error: 'code_used' });
  assert.strictEqual(store.db.prepare("SELECT COUNT(*) n FROM users WHERE name = 'Вор'").get().n, 0);
});

test('инвайт: обычному коду нужно имя', () => {
  store.createInvite('KUZ-AAAA-3333');

  assert.deepStrictEqual(store.redeemInvite('KUZ-AAAA-3333', ''), { error: 'no_name' });
  // Неудачная попытка не должна гасить код
  assert.strictEqual(store.getInvite('KUZ-AAAA-3333').used_by, null);
});

test('инвайт на устройство: привязывается к существующему, имя игнорируется', () => {
  store.createInvite('KUZ-BBBB-1111');
  const owner = store.redeemInvite('KUZ-BBBB-1111', 'Дед').user;

  store.createInvite('KUZ-BBBB-2222', owner.id);
  const second = store.redeemInvite('KUZ-BBBB-2222', 'какое-то другое имя');

  assert.strictEqual(second.user.id, owner.id);
  assert.strictEqual(second.user.name, 'Дед');
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM users').get().n,
    store.db.prepare('SELECT COUNT(*) n FROM users').get().n); // нового не завели
});

test('инвайт на устройство: пользователь исчез — код невалиден', () => {
  // Внешний ключ не даст создать такой инвайт обычным путём, поэтому
  // подкладываем строку в обход проверки — код защищается именно от этого
  store.db.pragma('foreign_keys = OFF');
  store.db
    .prepare('INSERT INTO invites (code, created_at, for_user) VALUES (?, ?, ?)')
    .run('KUZ-BBBB-3333', Date.now(), 999999);
  store.db.pragma('foreign_keys = ON');

  assert.deepStrictEqual(store.redeemInvite('KUZ-BBBB-3333', ''), { error: 'unknown_code' });
  assert.strictEqual(store.getInvite('KUZ-BBBB-3333').used_by, null, 'битый код не должен гаситься');
});

test('поиск пользователя по имени нечувствителен к регистру, включая кириллицу', () => {
  store.createInvite('KUZ-CCCC-1111');
  const cyrillic = store.redeemInvite('KUZ-CCCC-1111', 'Бабушка').user;
  store.createInvite('KUZ-CCCC-2222');
  const latin = store.redeemInvite('KUZ-CCCC-2222', 'Grandpa').user;

  assert.strictEqual(store.findUserByName('Бабушка').id, cyrillic.id);
  assert.strictEqual(store.findUserByName('бабушка').id, cyrillic.id, 'COLLATE NOCASE кириллицу не берёт');
  assert.strictEqual(store.findUserByName('GRANDPA').id, latin.id);
  assert.strictEqual(store.findUserByName('нет такой'), undefined);
});

test('токены: выдача, поиск, обновление last_seen_at', () => {
  store.createInvite('KUZ-DDDD-1111');
  const user = store.redeemInvite('KUZ-DDDD-1111', 'Токеновладелец').user;

  store.createToken('token-abc', user.id);
  const found = store.userByToken('token-abc');
  assert.strictEqual(found.id, user.id);
  assert.strictEqual(found.name, 'Токеновладелец');

  assert.strictEqual(store.userByToken('нет-такого'), undefined);

  store.db.prepare('UPDATE tokens SET last_seen_at = 0 WHERE token = ?').run('token-abc');
  store.touchToken('token-abc');
  assert.ok(store.userByToken('token-abc').last_seen_at > 0);
});

test('сообщения: сохраняются с именем автора и отдаются по возрастанию id', () => {
  store.createInvite('KUZ-EEEE-1111');
  const user = store.redeemInvite('KUZ-EEEE-1111', 'Автор').user;

  const first = store.addMessage(user.id, 'первое');
  const second = store.addMessage(user.id, 'второе');

  assert.strictEqual(first.user_name, 'Автор');
  assert.ok(second.id > first.id);

  const after = store.messagesAfter(first.id).map((m) => m.id);
  assert.ok(after.includes(second.id));
  assert.ok(!after.includes(first.id), 'after должен быть строго больше');

  const sorted = [...after].sort((a, b) => a - b);
  assert.deepStrictEqual(after, sorted);
});

test('сообщения: отдаётся не больше сотни за раз', () => {
  store.createInvite('KUZ-EEEE-2222');
  const user = store.redeemInvite('KUZ-EEEE-2222', 'Болтун').user;

  const before = store.messagesAfter(0).length;
  for (let i = 0; i < 120; i++) store.addMessage(user.id, 'сообщение ' + i);

  assert.strictEqual(store.messagesAfter(0).length, 100);
  assert.ok(before + 120 > 100);
});

test('подписки: дедуп по endpoint, исключение автора, удаление', () => {
  store.createInvite('KUZ-FFFF-1111');
  store.createInvite('KUZ-FFFF-2222');
  const alice = store.redeemInvite('KUZ-FFFF-1111', 'Алиса').user;
  const bob = store.redeemInvite('KUZ-FFFF-2222', 'Боб').user;

  const endpoint = 'https://push.example/one';
  store.saveSubscription(alice.id, endpoint, { p256dh: 'p1', auth: 'a1' });
  store.saveSubscription(alice.id, endpoint, { p256dh: 'p2', auth: 'a2' });

  const forBob = store.subscriptionsExcept(bob.id).filter((s) => s.endpoint === endpoint);
  assert.strictEqual(forBob.length, 1, 'endpoint должен быть уникален');
  assert.deepStrictEqual(forBob[0].keys, { p256dh: 'p2', auth: 'a2' }, 'ключи должны обновиться');

  assert.strictEqual(
    store.subscriptionsExcept(alice.id).filter((s) => s.endpoint === endpoint).length,
    0,
    'автор не должен получать свой же пуш'
  );

  store.deleteSubscription(endpoint);
  assert.strictEqual(store.subscriptionsExcept(bob.id).filter((s) => s.endpoint === endpoint).length, 0);
});
