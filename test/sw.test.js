'use strict';

// Service worker исполняется в отдельном контексте с подставными self, fetch
// и clients. Браузер тут не нужен, а проверить надо: воркер вмешивается
// в навигацию, и ошибка в нём сломала бы вход в приложение всем.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

function loadWorker(options) {
  const opts = options || {};
  const listeners = {};
  const shown = [];
  const opened = [];
  const focused = [];
  const deletedCaches = [];

  const self = {
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    skipWaiting() {},
    registration: {
      showNotification(title, params) {
        shown.push({ title, params });
        return Promise.resolve();
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => opts.windows || [],
      openWindow: async (url) => { opened.push(url); },
    },
  };

  const sandbox = {
    self,
    Response,
    URL,
    console,
    fetch: opts.fetch || (async () => new Response('ok')),
    caches: {
      keys: async () => opts.caches || [],
      delete: async (name) => { deletedCaches.push(name); return true; },
    },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(SOURCE, sandbox);

  async function dispatch(type, event) {
    for (const fn of listeners[type] || []) await fn(event);
    if (event && event._waits) await Promise.all(event._waits);
    return event;
  }

  return { listeners, dispatch, shown, opened, focused, deletedCaches };
}

function makeEvent(extra) {
  const event = Object.assign({ _waits: [] }, extra);
  event.waitUntil = (p) => { event._waits.push(p); };
  event.respondWith = (p) => { event.responded = p; };
  return event;
}

test('воркер вешает все нужные обработчики', () => {
  const w = loadWorker();
  for (const type of ['install', 'activate', 'fetch', 'push', 'notificationclick']) {
    assert.ok(w.listeners[type], `нет обработчика ${type}`);
  }
});

test('activate вычищает кеши, оставшиеся от прошлых версий', async () => {
  const w = loadWorker({ caches: ['old-v1', 'старый-прототип'] });
  await w.dispatch('activate', makeEvent());
  assert.deepStrictEqual(w.deletedCaches, ['old-v1', 'старый-прототип']);
});

/* ---------- перехват навигации ---------- */

test('навигация при живой сети отдаётся как есть', async () => {
  const w = loadWorker({ fetch: async () => new Response('<html>боевая страница</html>', { status: 200 }) });

  const event = makeEvent({ request: { mode: 'navigate', url: 'https://chat.example.com/' } });
  await w.dispatch('fetch', event);

  const res = await event.responded;
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /боевая страница/);
});

test('навигация без сети показывает заглушку, а не ошибку браузера', async () => {
  const w = loadWorker({ fetch: async () => { throw new Error('offline'); } });

  const event = makeEvent({ request: { mode: 'navigate', url: 'https://chat.example.com/' } });
  await w.dispatch('fetch', event);

  const res = await event.responded;
  assert.strictEqual(res.status, 503);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Нет связи/);
});

test('всё, кроме навигации, воркер не трогает', async () => {
  let calls = 0;
  const w = loadWorker({ fetch: async () => { calls++; return new Response('{}'); } });

  for (const mode of ['cors', 'no-cors', 'same-origin']) {
    const event = makeEvent({ request: { mode, url: 'https://chat.example.com/api/messages' } });
    await w.dispatch('fetch', event);
    assert.strictEqual(event.responded, undefined, `${mode} не должен перехватываться`);
  }
  assert.strictEqual(calls, 0, 'воркер не должен сам ходить в сеть за API');
});

/* ---------- уведомления ---------- */

test('push показывает имя автора и текст', async () => {
  const w = loadWorker();
  const event = makeEvent({
    data: { json: () => ({ title: 'Папа', body: 'Купите молока' }) },
  });

  await w.dispatch('push', event);

  assert.strictEqual(w.shown.length, 1);
  assert.strictEqual(w.shown[0].title, 'Папа');
  assert.strictEqual(w.shown[0].params.body, 'Купите молока');
  assert.strictEqual(w.shown[0].params.badge, '/icons/badge-96.png', 'бейдж должен быть монохромным');
});

test('битый payload не превращает пуш в тихий', async () => {
  const w = loadWorker();
  const event = makeEvent({
    data: {
      json() { throw new Error('не JSON'); },
      text: () => 'просто текст',
    },
  });

  await w.dispatch('push', event);

  assert.strictEqual(w.shown.length, 1, 'за тихий пуш iOS отбирает разрешение');
  assert.strictEqual(w.shown[0].params.body, 'просто текст');
});

test('пуш совсем без данных всё равно виден', async () => {
  const w = loadWorker();
  await w.dispatch('push', makeEvent({ data: null }));

  assert.strictEqual(w.shown.length, 1);
  assert.strictEqual(w.shown[0].title, 'Kuzgram');
});

/* ---------- клик по уведомлению ---------- */

test('клик фокусирует уже открытое окно, а не плодит новые', async () => {
  let focusedCount = 0;
  const w = loadWorker({
    windows: [{ url: 'https://chat.example.com/', focus: async () => { focusedCount++; } }],
  });

  let closed = false;
  await w.dispatch('notificationclick', makeEvent({
    notification: { close: () => { closed = true; }, data: { url: '/' } },
  }));

  assert.ok(closed, 'уведомление должно закрываться');
  assert.strictEqual(focusedCount, 1);
  assert.deepStrictEqual(w.opened, [], 'новое окно открывать не надо');
});

test('если окна нет — открывается приложение', async () => {
  const w = loadWorker({ windows: [] });

  await w.dispatch('notificationclick', makeEvent({
    notification: { close: () => {}, data: { url: '/' } },
  }));

  assert.deepStrictEqual(w.opened, ['/']);
});
