'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kuzgram-push-')), 'test.db');
process.env.KUZGRAM_DB = DB_FILE;

// Ключи настоящие, но сеть не трогаем: sendNotification подменён ниже
const webpush = require('web-push');
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC = vapid.publicKey;
process.env.VAPID_PRIVATE = vapid.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

let calls = [];
let responder = () => {};

webpush.sendNotification = async (subscription, payload, options) => {
  calls.push({ subscription, payload, options });
  return responder(subscription);
};

const store = require('../db');
const push = require('../push');

function fail(statusCode) {
  const err = new Error('push failed');
  err.statusCode = statusCode;
  throw err;
}

function makeUser(name, code) {
  store.createInvite(code);
  return store.redeemInvite(code, name).user;
}

test.after(() => {
  store.db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

test.beforeEach(() => {
  calls = [];
  responder = () => {};
  store.db.exec('DELETE FROM subscriptions'); // подписки не должны течь между тестами
});

test('без подписок рассылка ничего не делает', async () => {
  const author = makeUser('Один', 'KUZ-PUSH-0000');

  assert.deepStrictEqual(await push.broadcast(author.id, { title: 'т', body: 'б' }), {
    sent: 0,
    removed: 0,
  });
  assert.strictEqual(calls.length, 0);
});

test('рассылка уходит всем кроме автора, с TTL и urgency', async () => {
  const author = makeUser('Автор', 'KUZ-PUSH-1111');
  const reader = makeUser('Читатель', 'KUZ-PUSH-2222');

  store.saveSubscription(author.id, 'https://push.example/author', { p256dh: 'p', auth: 'a' });
  store.saveSubscription(reader.id, 'https://push.example/reader', { p256dh: 'p', auth: 'a' });

  const result = await push.broadcast(author.id, { title: 'Автор', body: 'привет', id: 7 });

  assert.deepStrictEqual(result, { sent: 1, removed: 0 });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].subscription.endpoint, 'https://push.example/reader');
  assert.deepStrictEqual(calls[0].subscription.keys, { p256dh: 'p', auth: 'a' });
  assert.deepStrictEqual(JSON.parse(calls[0].payload), { title: 'Автор', body: 'привет', id: 7 });
  assert.strictEqual(calls[0].options.urgency, 'high');
  assert.ok(calls[0].options.TTL > 0);
});

test('410 — подписка удаляется', async () => {
  const author = makeUser('А', 'KUZ-PUSH-3333');
  const reader = makeUser('Б', 'KUZ-PUSH-4444');
  const endpoint = 'https://push.example/gone';
  store.saveSubscription(reader.id, endpoint, { p256dh: 'p', auth: 'a' });

  responder = () => fail(410);
  const result = await push.broadcast(author.id, { title: 'т', body: 'б' });

  assert.deepStrictEqual(result, { sent: 0, removed: 1 });
  assert.strictEqual(store.subscriptionsExcept(author.id).filter((s) => s.endpoint === endpoint).length, 0);
});

test('404 — подписка тоже удаляется', async () => {
  const author = makeUser('В', 'KUZ-PUSH-5555');
  const reader = makeUser('Г', 'KUZ-PUSH-6666');
  const endpoint = 'https://push.example/missing';
  store.saveSubscription(reader.id, endpoint, { p256dh: 'p', auth: 'a' });

  responder = () => fail(404);
  await push.broadcast(author.id, { title: 'т', body: 'б' });

  assert.strictEqual(store.subscriptionsExcept(author.id).filter((s) => s.endpoint === endpoint).length, 0);
});

test('прочие ошибки подписку не трогают', async () => {
  const author = makeUser('Д', 'KUZ-PUSH-7777');
  const reader = makeUser('Е', 'KUZ-PUSH-8888');
  const endpoint = 'https://push.example/flaky';
  store.saveSubscription(reader.id, endpoint, { p256dh: 'p', auth: 'a' });

  responder = () => fail(500);
  const result = await push.broadcast(author.id, { title: 'т', body: 'б' });

  assert.deepStrictEqual(result, { sent: 0, removed: 0 });
  assert.strictEqual(
    store.subscriptionsExcept(author.id).filter((s) => s.endpoint === endpoint).length,
    1,
    'временная ошибка не повод выбрасывать подписку'
  );
});

test('одна мёртвая подписка не мешает остальным', async () => {
  const author = makeUser('Ж', 'KUZ-PUSH-9999');
  const alive = makeUser('З', 'KUZ-PUSH-AAAA');
  const dead = makeUser('И', 'KUZ-PUSH-BBBB');

  store.saveSubscription(alive.id, 'https://push.example/alive', { p256dh: 'p', auth: 'a' });
  store.saveSubscription(dead.id, 'https://push.example/dead', { p256dh: 'p', auth: 'a' });

  responder = (sub) => {
    if (sub.endpoint.endsWith('/dead')) fail(410);
  };

  const result = await push.broadcast(author.id, { title: 'т', body: 'б' });
  assert.deepStrictEqual(result, { sent: 1, removed: 1 });
});
