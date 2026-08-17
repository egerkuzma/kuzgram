'use strict';

// Классический service worker, не модуль: на WebKit с модулями в SW бывают проблемы.
// Своего кеша нет вообще — оффлайн тут не нужен, а отладку кеш только ломает.

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      // На этом origin раньше жил другой прототип: вычищаем всё, что он оставил,
      // иначе его кеш продолжит подсовывать старые файлы
      var names = await caches.keys();
      await Promise.all(names.map(function (name) { return caches.delete(name); }));
      await self.clients.claim();
    })()
  );
});

// Единственное, что перехватываем — открытие приложения без сети: вместо
// динозаврика Chrome показываем свою заглушку. Ассеты и запросы к API идут
// мимо обработчика, никакого кеша по-прежнему нет.
// Заодно это условие для beforeinstallprompt: без fetch-обработчика Chrome
// не даёт показать свою кнопку установки.
var OFFLINE_PAGE = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Kuzgram</title><style>body{margin:0;height:100vh;display:flex;' +
  'align-items:center;justify-content:center;background:#0d1117;color:#8b949e;' +
  'font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
  'text-align:center;padding:24px}</style></head><body>' +
  '<p>Нет связи с сервером.<br>Появится сеть — потяни страницу вниз.</p>' +
  '</body></html>';

self.addEventListener('fetch', function (event) {
  if (event.request.mode !== 'navigate') return;

  event.respondWith(
    fetch(event.request).catch(function () {
      return new Response(OFFLINE_PAGE, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    })
  );
});

self.addEventListener('push', function (event) {
  var title = 'Kuzgram';
  var body = 'Новое сообщение';

  if (event.data) {
    try {
      var data = event.data.json();
      if (data && data.title) title = data.title;
      if (data && data.body) body = data.body;
    } catch (err) {
      body = event.data.text() || body;
    }
  }

  // Уведомление показываем всегда: за тихий пуш iOS отбирает разрешение
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/icons/icon-192.png',
      // Android рисует бейдж только по альфа-каналу: цветная иконка
      // превратилась бы в белое пятно
      badge: '/icons/badge-96.png',
      tag: 'kuzgram-chat', // один общий чат — незачем плодить стопку уведомлений
      renotify: true,
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async function () {
      var clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          await client.focus();
          return;
        }
      }
      // Открытого окна нет — запускаем приложение, а не новую вкладку Safari
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});
