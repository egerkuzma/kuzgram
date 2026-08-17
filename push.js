'use strict';

const webpush = require('web-push');
const store = require('./db');

const TTL = 12 * 60 * 60; // сутки спустя сообщение уже неинтересно

const configured = Boolean(
  process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE && process.env.VAPID_SUBJECT
);

if (configured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC,
    process.env.VAPID_PRIVATE
  );
} else {
  console.error('[push] VAPID не настроен, рассылки не будет');
}

// Рассылка всем подписчикам кроме автора. Ошибки наружу не пробрасываем:
// отправка сообщения не должна падать из-за мёртвой подписки
async function broadcast(exceptUserId, payload) {
  if (!configured) return { sent: 0, removed: 0 };

  const subs = store.subscriptionsExcept(exceptUserId);
  if (subs.length === 0) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          { TTL: TTL, urgency: 'high' }
        );
        sent += 1;
      } catch (err) {
        // 404/410 — подписка мертва: PWA удалили или переустановили
        if (err.statusCode === 404 || err.statusCode === 410) {
          store.deleteSubscription(sub.endpoint);
          removed += 1;
          console.log(`[push] ${err.statusCode}, подписка удалена: ${sub.endpoint.slice(0, 50)}…`);
        } else {
          console.error(`[push] ошибка ${err.statusCode || '?'}: ${err.message}`);
        }
      }
    })
  );

  console.log(`[push] отправлено ${sent}, удалено ${removed}`);
  return { sent, removed };
}

module.exports = { broadcast, configured };
