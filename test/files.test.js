'use strict';

// Вложения: приём, лимиты, ссылки на скачивание, отдача опасных типов.
// Посторонний не должен ни скачать файл, ни подсунуть его так,
// чтобы браузер исполнил его как страницу.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kuzgram-files-'));
process.env.KUZGRAM_DB = path.join(TMP, 'test.db');
process.env.FILE_MAX_MB = '0.1'; // ~100 КБ, чтобы проверять лимит без гигабайтов

const webpush = require('web-push');
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC = vapid.publicKey;
process.env.VAPID_PRIVATE = vapid.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

let pushed = [];
webpush.sendNotification = async (subscription, payload) => {
  pushed.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
};

const store = require('../db');
const files = require('../files');
const app = require('../server');

const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  store.db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let inviteSeq = 0;

function member(name) {
  const code = `KUZ-FILE-${String(++inviteSeq).padStart(4, '0')}`;
  store.createInvite(code);
  const user = store.redeemInvite(code, name).user;
  const token = `files-token-${inviteSeq}`;
  store.createToken(token, user.id);
  return { user, token };
}

async function upload(token, body, options) {
  const opts = options || {};
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (opts.name !== undefined) headers['X-File-Name'] = opts.rawName ? opts.name : encodeURIComponent(opts.name);
  if (opts.type !== undefined) headers['X-File-Type'] = opts.type;

  const init = { method: 'POST', headers, body };
  if (body && typeof body.getReader === 'function') init.duplex = 'half';

  const res = await fetch(base() + '/api/files', init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }
  return { status: res.status, json };
}

async function download(url, headers) {
  const res = await fetch(base() + url, { headers: headers || {} });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

const onDisk = () => fs.readdirSync(files.FILES_DIR);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const countMessages = () => store.db.prepare('SELECT COUNT(*) n FROM messages').get().n;

const owner = member('Отправитель');
const reader = member('Получатель');

/* ---------- приём ---------- */

test('без токена файл не принимается и на диск не попадает', async () => {
  const before = onDisk().length;
  const res = await upload(null, Buffer.from('чужой файл'), { name: 'virus.apk' });

  assert.strictEqual(res.status, 401);
  await settle();
  assert.strictEqual(onDisk().length, before);
});

test('файл ложится на диск под случайным именем и с правами 600', async () => {
  const bytes = Buffer.from('PK\u0003\u0004 это как будто apk');
  const res = await upload(owner.token, bytes, {
    name: 'Приложение.apk',
    type: 'application/vnd.android.package-archive',
  });

  assert.strictEqual(res.status, 200);
  const { file, text, user_name: author } = res.json.message;

  assert.strictEqual(text, '');
  assert.strictEqual(author, 'Отправитель');
  assert.strictEqual(file.name, 'Приложение.apk');
  assert.strictEqual(file.mime, 'application/vnd.android.package-archive');
  assert.strictEqual(file.size, bytes.length);
  assert.match(file.id, /^[a-f0-9]{32}$/);

  const stored = files.pathFor(file.id);
  assert.deepStrictEqual(fs.readFileSync(stored), bytes);
  assert.strictEqual(fs.statSync(stored).mode & 0o777, 0o600);
  assert.ok(!onDisk().some((n) => n.includes('Приложение')), 'исходное имя не должно попадать на диск');
});

test('пустой файл отвергается без следов', async () => {
  const before = { disk: onDisk().length, messages: countMessages() };
  const res = await upload(owner.token, Buffer.alloc(0), { name: 'empty.txt' });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'empty_file');
  await settle();
  assert.strictEqual(onDisk().length, before.disk);
  assert.strictEqual(countMessages(), before.messages);
});

test('файл больше лимита отбивается сразу по Content-Length', async () => {
  const before = { disk: onDisk().length, messages: countMessages() };
  const res = await upload(owner.token, Buffer.alloc(files.FILE_MAX_BYTES + 1, 1), { name: 'big.bin' });

  assert.strictEqual(res.status, 413);
  assert.strictEqual(res.json.error, 'file_too_large');
  assert.strictEqual(res.json.limit, files.FILE_MAX_BYTES);
  await settle();
  assert.strictEqual(onDisk().length, before.disk);
  assert.strictEqual(countMessages(), before.messages);
});

test('потоковая загрузка без Content-Length тоже упирается в лимит', async () => {
  const before = { disk: onDisk().length, messages: countMessages() };
  const chunk = Buffer.alloc(32 * 1024, 7);
  let sent = 0;

  const body = new ReadableStream({
    pull(controller) {
      if (sent > files.FILE_MAX_BYTES * 2) return controller.close();
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });

  // Сервер может оборвать соединение раньше, чем клиент дочитает ответ, —
  // это тоже честный отказ. Главное — ничего не осталось
  try {
    const res = await upload(owner.token, body, { name: 'stream.bin' });
    assert.strictEqual(res.status, 413);
  } catch (err) {
    assert.ok(err, 'обрыв соединения допустим');
  }

  await settle();
  assert.ok(!onDisk().some((n) => n.endsWith('.part')), 'недокачанный .part должен удаляться');
  assert.strictEqual(onDisk().length, before.disk);
  assert.strictEqual(countMessages(), before.messages);
});

test('имя файла чистится от путей, управляющих символов и bidi-разворотов', async () => {
  const cases = [
    ['../../etc/passwd', (n) => !n.includes('/') && n.endsWith('passwd')],
    ['..\\..\\boot.ini', (n) => !n.includes('\\')],
    ['setup\u202etxt.exe', (n) => !n.includes('\u202e') && n === 'setuptxt.exe'],
    ['bad\u0000name\u0007.txt', (n) => n === 'badname.txt'],
    ['..', (n) => n === 'file'],
    ['', (n) => n === 'file'],
    ['x'.repeat(300) + '.apk', (n) => n.length <= 180 && n.endsWith('.apk')],
  ];

  for (const [raw, ok] of cases) {
    const res = await upload(owner.token, Buffer.from('x'), { name: raw });
    assert.strictEqual(res.status, 200, JSON.stringify(raw));
    assert.ok(ok(res.json.message.file.name), `${JSON.stringify(raw)} → ${JSON.stringify(res.json.message.file.name)}`);
  }

  const broken = await upload(owner.token, Buffer.from('x'), { name: '%E0%A4%A', rawName: true });
  assert.strictEqual(broken.json.message.file.name, 'file', 'битое кодирование не должно ронять сервер');
});

test('тип берётся от браузера, а если его нет — по расширению', async () => {
  const cases = [
    [{ name: 'app.apk', type: '' }, 'application/vnd.android.package-archive'],
    [{ name: 'doc.pdf' }, 'application/pdf'],
    [{ name: 'photo.jpg', type: 'image/jpeg' }, 'image/jpeg'],
    [{ name: 'x.bin', type: 'not a type; charset=<script>' }, 'application/octet-stream'],
    [{ name: 'noext', type: '' }, 'application/octet-stream'],
  ];

  for (const [opts, mime] of cases) {
    const res = await upload(owner.token, Buffer.from('x'), opts);
    assert.strictEqual(res.json.message.file.mime, mime, JSON.stringify(opts));
  }
});

test('сообщение и вложение создаются только вместе', () => {
  const first = store.addFileMessage(owner.user.id, {
    id: 'a'.repeat(32), name: 'один.txt', mime: 'text/plain', size: 1,
  });
  assert.strictEqual(first.file.id, 'a'.repeat(32));

  const before = countMessages();
  assert.throws(() =>
    store.addFileMessage(owner.user.id, { id: 'a'.repeat(32), name: 'дубль.txt', mime: 'text/plain', size: 1 })
  );
  assert.strictEqual(countMessages(), before, 'сообщение без вложения остаться не должно');
});

test('новый файл рассылает пуш остальным: 📎 для файла, 📷 для картинки', async () => {
  store.saveSubscription(reader.user.id, 'https://push.example/reader', { p256dh: 'p', auth: 'a' });
  store.saveSubscription(owner.user.id, 'https://push.example/owner', { p256dh: 'p', auth: 'a' });

  pushed = [];
  await upload(owner.token, Buffer.from('apk'), { name: 'game.apk' });
  await upload(owner.token, Buffer.from('png'), { name: 'cat.png', type: 'image/png' });
  await settle();

  const bodies = pushed.filter((p) => p.endpoint.endsWith('/reader')).map((p) => p.payload.body);
  assert.ok(bodies.includes('📎 game.apk'), JSON.stringify(bodies));
  assert.ok(bodies.includes('📷 cat.png'), JSON.stringify(bodies));
  assert.ok(!pushed.some((p) => p.endpoint.endsWith('/owner')), 'автору свой файл не пушим');
});

/* ---------- ссылки ---------- */

async function uploaded(name, type, bytes) {
  const res = await upload(owner.token, bytes || Buffer.from('содержимое ' + name), { name, type });
  assert.strictEqual(res.status, 200);
  return res.json.message.file;
}

test('лента отдаёт вложение вместе с рабочей ссылкой', async () => {
  const file = await uploaded('в-ленте.zip', 'application/zip');

  const res = await fetch(base() + '/api/messages?after=0', {
    headers: { Authorization: 'Bearer ' + reader.token },
  });
  const { messages } = await res.json();
  const found = messages.find((m) => m.file && m.file.id === file.id);

  assert.ok(found, 'сообщение с файлом должно быть в ленте');
  assert.match(found.file.url, /^\/files\/[a-f0-9]{32}\?exp=\d+&sig=/);
  assert.strictEqual(found.file.expires_in, files.LINK_TTL);
  assert.strictEqual((await download(found.file.url)).status, 200);
});

test('скачивание по ссылке отдаёт файл целиком и с правильными заголовками', async () => {
  const bytes = Buffer.from('настоящий apk, честно');
  const file = await uploaded('Игра для внука.apk', 'application/vnd.android.package-archive', bytes);
  const res = await download(file.url);

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, bytes);
  assert.strictEqual(res.headers.get('content-type'), 'application/vnd.android.package-archive');

  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /^attachment;/);
  assert.match(disposition, /filename\*=UTF-8''%D0%98%D0%B3%D1%80%D0%B0/, 'кириллическое имя должно доехать');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
});

test('докачка: Range отдаёт кусок файла', async () => {
  const file = await uploaded('range.bin', 'application/octet-stream', Buffer.from('0123456789'));
  const res = await download(file.url, { Range: 'bytes=2-5' });

  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.body.toString(), '2345');
});

test('растровая картинка показывается прямо, а с dl=1 — скачивается', async () => {
  const file = await uploaded('кот.png', 'image/png');

  const inline = await download(file.url);
  assert.strictEqual(inline.headers.get('content-type'), 'image/png');
  assert.match(inline.headers.get('content-disposition'), /^inline;/);

  const forced = await download(file.url + '&dl=1');
  assert.match(forced.headers.get('content-disposition'), /^attachment;/);
});

test('SVG, HTML и скрипты никогда не отдаются как документ', async () => {
  const cases = [
    ['evil.svg', 'image/svg+xml', '<svg onload="alert(1)"/>'],
    ['evil.html', 'text/html', '<script>alert(1)</script>'],
    ['evil.js', 'application/javascript', 'alert(1)'],
    ['evil.xml', 'application/xhtml+xml', '<html/>'],
  ];

  for (const [name, type, content] of cases) {
    const file = await uploaded(name, type, Buffer.from(content));
    const res = await download(file.url);

    assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(res.headers.get('content-disposition'), /^attachment;/, name);
    assert.match(res.headers.get('content-security-policy'), /sandbox/, name);
  }
});

test('без подписи, с чужой, подделанной или протухшей подписью — 403', async () => {
  const a = await uploaded('a.txt', 'text/plain');
  const b = await uploaded('b.txt', 'text/plain');

  const [, aQuery] = a.url.split('?');
  const aSig = new URLSearchParams(aQuery).get('sig');
  const aExp = new URLSearchParams(aQuery).get('exp');

  const past = Math.floor(Date.now() / 1000) - 10;
  const attempts = [
    `/files/${a.id}`,
    `/files/${a.id}?exp=${aExp}`,
    `/files/${a.id}?sig=${aSig}`,
    `/files/${b.id}?exp=${aExp}&sig=${aSig}`,                                   // подпись от другого файла
    `/files/${a.id}?exp=${Number(aExp) + 3600}&sig=${aSig}`,                    // продлил срок сам
    `/files/${a.id}?exp=${aExp}&sig=${aSig.slice(0, -1)}${aSig.endsWith('A') ? 'B' : 'A'}`,
    `/files/${a.id}?exp=${past}&sig=${files.sign(a.id, String(past))}`,         // честная, но протухшая
    `/files/${a.id}?exp=${aExp}&sig=${aSig}&sig=${aSig}`,                       // массив вместо строки
  ];

  for (const url of attempts) {
    const res = await download(url);
    assert.strictEqual(res.status, 403, url);
    assert.ok(!res.body.toString().includes('содержимое'), `${url} слил содержимое`);
  }
});

test('кривой id и несуществующий файл', async () => {
  const exp = String(Math.floor(Date.now() / 1000) + 600);
  const ghost = 'f'.repeat(32);

  assert.strictEqual((await download(`/files/../../.env?exp=${exp}&sig=x`)).status, 404);
  assert.strictEqual((await download(`/files/not-an-id?exp=${exp}&sig=${files.sign('not-an-id', exp)}`)).status, 403);
  assert.strictEqual((await download(`/files/${ghost}?exp=${exp}&sig=${files.sign(ghost, exp)}`)).status, 404);
});

test('новую ссылку выдаёт только участник чата', async () => {
  const file = await uploaded('link.txt', 'text/plain');

  const anonymous = await fetch(base() + `/api/files/${file.id}/link`);
  assert.strictEqual(anonymous.status, 401);

  const res = await fetch(base() + `/api/files/${file.id}/link`, {
    headers: { Authorization: 'Bearer ' + reader.token },
  });
  const link = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await download(link.url)).status, 200);

  const missing = await fetch(base() + `/api/files/${'0'.repeat(32)}/link`, {
    headers: { Authorization: 'Bearer ' + reader.token },
  });
  assert.strictEqual(missing.status, 404);

  const garbage = await fetch(base() + '/api/files/..%2f..%2fetc/link', {
    headers: { Authorization: 'Bearer ' + reader.token },
  });
  assert.strictEqual(garbage.status, 404);
});

test('каталог с файлами не виден через статику', async () => {
  const file = await uploaded('hidden.txt', 'text/plain');

  for (const url of [`/data/files/${file.id}`, `/files/`, `/${file.id}`, `/files`]) {
    const res = await download(url);
    assert.ok(res.status === 404 || res.status === 403, `${url} → ${res.status}`);
    assert.ok(!res.body.toString().includes('содержимое'), `${url} слил содержимое`);
  }
});

test('клиент узнаёт лимит при входе', async () => {
  const res = await fetch(base() + '/api/me', { headers: { Authorization: 'Bearer ' + owner.token } });
  const data = await res.json();
  assert.strictEqual(data.limits.file_max_bytes, files.FILE_MAX_BYTES);
});
