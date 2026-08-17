'use strict';

// Проверки доступа: посторонний не должен ни прочитать переписку,
// ни зарегистрироваться, ни подобрать код перебором.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kuzgram-sec-')), 'test.db');
process.env.KUZGRAM_DB = DB_FILE;
process.env.JOIN_MAX_FAILS = '5';
process.env.JOIN_WINDOW_MS = '60000';

const webpush = require('web-push');
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC = vapid.publicKey;
process.env.VAPID_PRIVATE = vapid.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
webpush.sendNotification = async () => {};

const store = require('../db');
const app = require('../server');

const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  store.db.close();
  fs.rmSync(path.dirname(DB_FILE), { recursive: true, force: true });
});

async function call(method, url, body, headers) {
  const res = await fetch(base() + url, {
    method,
    headers: Object.assign(body === undefined ? {} : { 'Content-Type': 'application/json' }, headers),
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

function bearer(token) {
  return { Authorization: 'Bearer ' + token };
}

// Свой человек с перепиской — то, что чужой не должен увидеть
const insider = (() => {
  store.createInvite('KUZ-SEED-0001');
  const user = store.redeemInvite('KUZ-SEED-0001', 'Свой').user;
  store.createToken('insider-token', user.id);
  store.addMessage(user.id, 'секретное семейное сообщение');
  return { user, token: 'insider-token' };
})();

/* ---------- чтение без токена ---------- */

test('переписку нельзя достать ни одним из закрытых роутов без токена', async () => {
  const attempts = [
    ['GET', '/api/messages'],
    ['GET', '/api/messages?after=0'],
    ['GET', '/api/me'],
    ['POST', '/api/messages'],
    ['POST', '/api/subscribe'],
  ];

  for (const [method, url] of attempts) {
    const res = await call(method, url, method === 'POST' ? { text: 'x' } : undefined);
    assert.strictEqual(res.status, 401, `${method} ${url}`);
    assert.ok(!res.text.includes('секретное'), `${method} ${url} слил текст сообщения`);
  }
});

test('кривые заголовки авторизации не проходят', async () => {
  const headers = [
    { Authorization: 'insider-token' },              // без схемы
    { Authorization: 'Basic insider-token' },        // чужая схема
    { Authorization: 'Bearer' },                     // без значения
    { Authorization: 'Bearer ' },                    // пустое значение
    { Authorization: 'Bearer wrong-token' },
    { Authorization: 'Bearer insider-token extra' }, // мусор после токена
  ];

  for (const h of headers) {
    const res = await call('GET', '/api/messages', undefined, h);
    assert.strictEqual(res.status, 401, JSON.stringify(h));
  }

  // Регистр схемы значения не имеет — это допустимо по RFC
  const ok = await call('GET', '/api/messages', undefined, { Authorization: 'bearer insider-token' });
  assert.strictEqual(ok.status, 200);
});

test('токен из удалённой строки перестаёт работать сразу', async () => {
  store.createInvite('KUZ-SEED-0002');
  const victim = store.redeemInvite('KUZ-SEED-0002', 'Отзываемый').user;
  store.createToken('revoked-token', victim.id);

  assert.strictEqual((await call('GET', '/api/me', undefined, bearer('revoked-token'))).status, 200);

  store.db.prepare('DELETE FROM tokens WHERE token = ?').run('revoked-token');

  const after = await call('GET', '/api/messages', undefined, bearer('revoked-token'));
  assert.strictEqual(after.status, 401);
  assert.ok(!after.text.includes('секретное'));
});

test('статика не отдаёт ни .env, ни исходники сервера', async () => {
  const paths = [
    '/.env', '/db.js', '/server.js', '/push.js', '/auth.js', '/kuzgram.db', '/package.json',
    '/../.env', '/%2e%2e/.env', '/public/../.env', '/bin/invite.js', '/test/db.test.js',
  ];

  for (const p of paths) {
    const res = await call('GET', p);
    assert.ok(res.status === 404 || res.status === 400, `${p} → ${res.status}`);
    assert.ok(!res.text.includes('VAPID_PRIVATE'), `${p} слил ключи`);
  }
});

/* ---------- регистрация ---------- */

test('без кода зарегистрироваться нельзя', async () => {
  const before = store.db.prepare('SELECT COUNT(*) n FROM users').get().n;

  for (const body of [{}, { name: 'Чужой' }, { code: '', name: 'Чужой' },
    { code: null, name: 'Чужой' }, { code: 'KUZ-FAKE-CODE', name: 'Чужой' }]) {
    const res = await call('POST', '/api/join', body);
    assert.ok(res.status >= 400, JSON.stringify(body));
    assert.strictEqual(res.json.token, undefined, 'токен выдавать нельзя');
  }

  assert.strictEqual(store.db.prepare('SELECT COUNT(*) n FROM users').get().n, before);
});

test('нельзя подсунуть свой user_id или чужое имя вместо кода', async () => {
  const res = await call('POST', '/api/join', {
    code: 'KUZ-FAKE-CODE',
    name: 'Свой',
    user_id: insider.user.id,
    token: 'insider-token',
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.token, undefined);
});

test('истёкший код не принимается и не гасится', async () => {
  store.createInvite('KUZ-DEAD-0001', null, Date.now() - 1000);

  const res = await call('POST', '/api/join', { code: 'KUZ-DEAD-0001', name: 'Опоздавший' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'code_expired');
  assert.strictEqual(store.getInvite('KUZ-DEAD-0001').used_by, null);
});

test('код без срока (expires_at = NULL) продолжает работать', async () => {
  store.createInvite('KUZ-FRVR-0001', null, null);
  const res = await call('POST', '/api/join', { code: 'KUZ-FRVR-0001', name: 'Бессрочный' });
  assert.strictEqual(res.status, 200);
});

test('код нельзя использовать дважды даже параллельными запросами', async () => {
  store.createInvite('KUZ-RACE-0001');

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      call('POST', '/api/join', { code: 'KUZ-RACE-0001', name: 'Гонщик ' + i })
    )
  );

  const winners = results.filter((r) => r.status === 200);
  assert.strictEqual(winners.length, 1, 'код должен сработать ровно один раз');
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) n FROM users WHERE name LIKE 'Гонщик%'").get().n,
    1,
    'лишних пользователей заводить нельзя'
  );
});

test('код на устройство не даёт стать кем-то другим', async () => {
  store.createInvite('KUZ-DEVX-0001', insider.user.id);

  const res = await call('POST', '/api/join', {
    code: 'KUZ-DEVX-0001',
    name: 'Хочу быть кем-то ещё',
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.user.id, insider.user.id);
  assert.strictEqual(res.json.user.name, 'Свой', 'имя из тела запроса игнорируется');
});

test('перебор кодов упирается в блокировку', async () => {
  const limit = Number(process.env.JOIN_MAX_FAILS);
  let locked = null;

  // Часть промахов могли набрать предыдущие тесты, поэтому стучимся,
  // пока не упрёмся, но не дольше разумного
  for (let i = 0; i < limit * 3 && !locked; i++) {
    const res = await call('POST', '/api/join', { code: `KUZ-BRUT-${1000 + i}`, name: 'Перебор' });
    if (res.status === 429) locked = res;
    else assert.strictEqual(res.json.error, 'unknown_code');
  }

  assert.ok(locked, 'перебор должен упереться в блокировку');
  assert.strictEqual(locked.json.error, 'too_many_attempts');

  // Блокировка глухая: даже настоящий код в этот момент не пройдёт
  store.createInvite('KUZ-REAL-0001');
  const legit = await call('POST', '/api/join', { code: 'KUZ-REAL-0001', name: 'Честный' });
  assert.strictEqual(legit.status, 429);
  assert.strictEqual(store.getInvite('KUZ-REAL-0001').used_by, null, 'код не должен сгореть');
});

/* ---------- заголовки ---------- */

test('заголовки безопасности на месте', async () => {
  const res = await call('GET', '/');

  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
});

test('кросс-доменного доступа нет: CORS-заголовки не выдаются', async () => {
  const res = await call('GET', '/api/messages', undefined,
    Object.assign({ Origin: 'https://evil.example' }, bearer(insider.token)));

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null,
    'без этого заголовка браузер не отдаст ответ чужой странице');
});
