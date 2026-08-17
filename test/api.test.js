'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kuzgram-api-')), 'test.db');
process.env.KUZGRAM_DB = DB_FILE;

const webpush = require('web-push');
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC = vapid.publicKey;
process.env.VAPID_PRIVATE = vapid.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

let pushCalls = [];
webpush.sendNotification = async (subscription) => {
  pushCalls.push(subscription.endpoint);
};

const store = require('../db');
const app = require('../server');

const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  store.db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

async function call(method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch(base() + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function join(name, prefix) {
  const code = `KUZ-${prefix}-0001`;
  store.createInvite(code);
  const res = await call('POST', '/api/join', { code, name });
  assert.strictEqual(res.status, 200);
  return res.json;
}

/* ---------- статика и заголовки ---------- */

test('index.html отдаётся', async () => {
  const res = await call('GET', '/');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Kuzgram/);
});

test('HSTS проставляется на ответах', async () => {
  const res = await call('GET', '/');
  assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
});

test('sw.js отдаётся без кеширования', async () => {
  const res = await call('GET', '/sw.js');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-cache/);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('публичный VAPID-ключ доступен без токена', async () => {
  const res = await call('GET', '/api/vapid-public-key');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.key, vapid.publicKey);
});

/* ---------- вход ---------- */

test('join: без кода', async () => {
  const res = await call('POST', '/api/join', { name: 'Никто' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'no_code');
});

test('join: неизвестный код', async () => {
  const res = await call('POST', '/api/join', { code: 'KUZ-ZZZZ-ZZZZ', name: 'Никто' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'unknown_code');
});

test('join: слишком длинное имя', async () => {
  store.createInvite('KUZ-LONG-0001');
  const res = await call('POST', '/api/join', { code: 'KUZ-LONG-0001', name: 'я'.repeat(33) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'long_name');
});

test('join: код в нижнем регистре и пробелы в имени', async () => {
  store.createInvite('KUZ-CASE-0001');
  const res = await call('POST', '/api/join', { code: ' kuz-case-0001 ', name: '  Мама   Ро  ' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.user.name, 'Мама Ро');
  assert.ok(res.json.token.length >= 32);
});

test('join: код одноразовый', async () => {
  store.createInvite('KUZ-ONCE-0001');
  await call('POST', '/api/join', { code: 'KUZ-ONCE-0001', name: 'Первый' });
  const res = await call('POST', '/api/join', { code: 'KUZ-ONCE-0001', name: 'Второй' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'code_used');
});

test('join: код на устройство не требует имени и не плодит людей', async () => {
  const owner = await join('Хозяин', 'OWNR');
  const usersBefore = store.db.prepare('SELECT COUNT(*) n FROM users').get().n;

  store.createInvite('KUZ-DEVC-0001', owner.user.id);
  const res = await call('POST', '/api/join', { code: 'KUZ-DEVC-0001' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.user.id, owner.user.id);
  assert.strictEqual(res.json.user.name, 'Хозяин');
  assert.notStrictEqual(res.json.token, owner.token, 'у второго устройства свой токен');
  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM users').get().n, usersBefore);
});

test('join: обычному коду имя обязательно', async () => {
  store.createInvite('KUZ-NONM-0001');
  const res = await call('POST', '/api/join', { code: 'KUZ-NONM-0001' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'no_name');
});

/* ---------- авторизация ---------- */

test('me: без токена и с мусорным токеном', async () => {
  const empty = await call('GET', '/api/me');
  assert.strictEqual(empty.status, 401);
  assert.strictEqual(empty.json.error, 'no_token');

  // Только ASCII: заголовок с кириллицей fetch не отправит
  const garbage = await call('GET', '/api/me', undefined, 'deadbeef');
  assert.strictEqual(garbage.status, 401);
  assert.strictEqual(garbage.json.error, 'bad_token');
});

test('me: с токеном отдаёт своего пользователя', async () => {
  const me = await join('Свой', 'SELF');
  const res = await call('GET', '/api/me', undefined, me.token);
  assert.deepStrictEqual(res.json.user, { id: me.user.id, name: 'Свой' });
});

test('last_seen_at обновляется, но не на каждый запрос', async () => {
  const me = await join('Активный', 'ACTV');
  const readSeen = () =>
    store.db.prepare('SELECT last_seen_at FROM tokens WHERE token = ?').get(me.token).last_seen_at;

  const fresh = readSeen();
  await call('GET', '/api/me', undefined, me.token);
  assert.strictEqual(readSeen(), fresh, 'частые запросы не должны писать в базу');

  store.db.prepare('UPDATE tokens SET last_seen_at = 0 WHERE token = ?').run(me.token);
  await call('GET', '/api/me', undefined, me.token);
  assert.ok(readSeen() > 0, 'протухший last_seen_at должен обновиться');
});

test('все закрытые роуты требуют токен', async () => {
  for (const [method, url] of [
    ['GET', '/api/me'],
    ['GET', '/api/messages'],
    ['POST', '/api/messages'],
    ['POST', '/api/subscribe'],
  ]) {
    const res = await call(method, url, method === 'POST' ? {} : undefined);
    assert.strictEqual(res.status, 401, `${method} ${url} пускает без токена`);
  }
});

/* ---------- сообщения ---------- */

test('сообщения: отправка, trim, чтение по after', async () => {
  const me = await join('Писатель', 'WRTR');

  const created = await call('POST', '/api/messages', { text: '  привет  ' }, me.token);
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.json.message.text, 'привет');
  assert.strictEqual(created.json.message.user_name, 'Писатель');

  const all = await call('GET', '/api/messages?after=0', undefined, me.token);
  assert.ok(all.json.messages.some((m) => m.id === created.json.message.id));
  assert.strictEqual(all.json.limit, 100);

  const after = await call('GET', `/api/messages?after=${created.json.message.id}`, undefined, me.token);
  assert.ok(!after.json.messages.some((m) => m.id === created.json.message.id));
});

test('сообщения: пустой текст и перебор длины', async () => {
  const me = await join('Молчун', 'SLNT');

  assert.strictEqual((await call('POST', '/api/messages', { text: '   ' }, me.token)).json.error, 'empty_text');
  assert.strictEqual((await call('POST', '/api/messages', {}, me.token)).json.error, 'empty_text');
  assert.strictEqual(
    (await call('POST', '/api/messages', { text: 'я'.repeat(4001) }, me.token)).json.error,
    'long_text'
  );
});

test('сообщения: мусор в after трактуется как 0', async () => {
  const me = await join('Кривой', 'BRKN');

  const bad = await call('GET', '/api/messages?after=abc', undefined, me.token);
  const zero = await call('GET', '/api/messages?after=0', undefined, me.token);
  assert.deepStrictEqual(bad.json.messages.map((m) => m.id), zero.json.messages.map((m) => m.id));

  const negative = await call('GET', '/api/messages?after=-5', undefined, me.token);
  assert.deepStrictEqual(negative.json.messages.map((m) => m.id), zero.json.messages.map((m) => m.id));
});

/* ---------- подписки и рассылка ---------- */

test('subscribe: мусор отвергается', async () => {
  const me = await join('Подписчик', 'SUBS');

  for (const body of [{}, { endpoint: 'https://push.example/x' }, { endpoint: '', keys: {} },
    { endpoint: 'https://push.example/x', keys: { p256dh: 'p' } }]) {
    const res = await call('POST', '/api/subscribe', body, me.token);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
    assert.strictEqual(res.json.error, 'bad_subscription');
  }
});

test('subscribe: сохраняет и дедуплицирует по endpoint', async () => {
  const me = await join('Двойной', 'DBLE');
  const sub = { endpoint: 'https://push.example/dup', keys: { p256dh: 'p', auth: 'a' } };

  assert.strictEqual((await call('POST', '/api/subscribe', sub, me.token)).json.ok, true);
  await call('POST', '/api/subscribe', sub, me.token);

  const rows = store.db
    .prepare('SELECT COUNT(*) n FROM subscriptions WHERE endpoint = ?')
    .get(sub.endpoint).n;
  assert.strictEqual(rows, 1);
});

test('новое сообщение рассылает пуш всем кроме автора', async () => {
  const author = await join('Отправитель', 'SNDR');
  const reader = await join('Получатель', 'RCVR');

  await call('POST', '/api/subscribe',
    { endpoint: 'https://push.example/author-dev', keys: { p256dh: 'p', auth: 'a' } }, author.token);
  await call('POST', '/api/subscribe',
    { endpoint: 'https://push.example/reader-dev', keys: { p256dh: 'p', auth: 'a' } }, reader.token);

  pushCalls = [];
  await call('POST', '/api/messages', { text: 'всем привет' }, author.token);

  // Рассылка идёт мимо ответа, даём ей завершиться
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(pushCalls.includes('https://push.example/reader-dev'));
  assert.ok(!pushCalls.includes('https://push.example/author-dev'), 'автору свой же пуш не нужен');
});
