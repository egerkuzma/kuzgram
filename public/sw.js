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
      badge: '/icons/icon-192.png',
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
