/**
 * Обработчик входящих сообщений.
 *
 * Получает сообщение от пользователя, проверяет доступ, поддерживает
 * изолированные диалоги с возможностью переключения, rate-limit 1 сообщение
 * в секунду, и запрашивает ответ у модели NVIDIA Nemotron 3.5 Super VL 120B.
 *
 * Поддерживает:
 *  - текстовые сообщения
 *  - фото (vision-модель может viewing изображения)
 *  - команды /start, /help, /stats, /reset, /dialogs, /switch, /newdialog, /allow, /admins
 */

import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import {
  getResponse,
  getResponseFromMessagePhoto,
  getResponseWithImages,
  chatWithHistory
} from '../lib/nemotron.js';
import {
  isAdmin,
  isAllowed,
  hasJoinRequest,
  createJoinRequest,
  approveUser,
  revokeUser,
  listJoinRequests,
  addAdmin,
  removeAdmin,
  listAdmins,
  createDialog,
  listUserDialogs,
  setCurrentDialog,
  getOrCreateCurrentDialog,
  switchDialog,
  getDialogHistory,
  addDialogMessage,
  checkRateLimit,
  recordRateLimit,
} from '../lib/access.js';
import { messages, users, dialogs } from '../schema.js';

/**
 * Отправляет текстовое сообщение в Telegram.
 */
async function sendText(chatId, text) {
  await api.sendMessage({
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  });
}

/**
 * Создаёт или обновляет пользователя в БД и возвращает его ID.
 */
async function ensureUser(from) {
  const existing = await db.select().from(users).where(eq(users.tgId, from.id)).get();
  if (existing) {
    await db.update(users)
      .set({
        name: from.first_name ?? '',
        username: from.username ?? null,
        lastSeen: Math.floor(Date.now() / 1000)
      })
      .where(eq(users.tgId, from.id))
      .run();
    return existing.id;
  }

  const [row] = await db.insert(users)
    .values({
      tgId: from.id,
      name: from.first_name ?? '',
      username: from.username ?? null,
      lastSeen: Math.floor(Date.now() / 1000)
    })
    .returning()
    .run();
  return row.id;
}

/**
 * Сохраняет сообщение в БД и возвращает количество сообщений от этого пользователя.
 */
async function saveMessage(userId, chatId, text, hasPhoto) {
  await db.insert(messages)
    .values({
      userId,
      chatId,
      text: text ?? null,
      hasPhoto: hasPhoto ? 1 : 0,
      created: Math.floor(Date.now() / 1000)
    })
    .run();

  const count = await db.$count(messages, eq(messages.userId, userId));
  return count;
}

/**
 * Форматирует список диалогов пользователя для вывода.
 */
function formatDialogs(dialogs, currentDialogId) {
  if (dialogs.length === 0) {
    return 'У вас пока нет диалогов. Создайте новый командой /newdialog.';
  }

  let text = '💬 <b>Ваши диалоги:</b>\n';
  for (const d of dialogs) {
    const marker = d.id === currentDialogId ? ' ▶️' : '';
    text += `/switch ${d.id} — ${d.name}${marker}\n`;
  }
  text += '\nСоздать новый: /newdialog <имя>\n';
  text += 'Текущий диалог помечен ▶️.';
  return text;
}

export default async function (message) {
  const chatId = message.chat.id;
  const from = message.from;
  const userText = message.text;
  const caption = message.caption ?? '';
  const hasPhoto = message.photo && message.photo.length > 0;

  if (!from) {
    return;
  }

  // Регистрируем пользователя в БД
  const userId = await ensureUser(from);

  const userTgId = from.id;
  const userName = from.first_name ?? '';
  const userUsername = from.username ?? null;

  const isAdminUser = await isAdmin(userTgId);
  const allowed = await isAllowed(userTgId);

  // --- Админские команды (доступны только администраторам) ---

  if (userText === '/admins') {
    if (!isAdminUser) {
      await sendText(chatId, '❌ Эта команда доступна только администраторам.');
      return;
    }
    const adminList = await listAdmins();
    let text = '👮 <b>Администраторы:</b>\n';
    for (const a of adminList) {
      text += `• ${a.name} (tg_id: ${a.tgId})${a.username ? ` (@${a.username})` : ''}\n`;
    }
    await sendText(chatId, text);
    return;
  }

  if (userText.startsWith('/addadmin ')) {
    if (!isAdminUser) {
      await sendText(chatId, '❌ Эта команда доступна только администраторам.');
      return;
    }
    const targetTgId = parseInt(userText.slice('/addadmin '.length).trim(), 10);
    if (!targetTgId) {
      await sendText(chatId, '❌ Укажите tg_id пользователя: /addadmin <tg_id>');
      return;
    }
    // Ищем пользователя по tgId в заявках или разрешённых
    const req = await db.select().from(joinRequests).where(eq(joinRequests.tgId, targetTgId)).get();
    const allowedUser = await db.select().from(allowedUsers).where(eq(allowedUsers.tgId, targetTgId)).get();
    const target = req || allowedUser;
    if (!target) {
      await sendText(chatId, '❌ Пользователь не найден среди заявок или разрешённых.');
      return;
    }
    const added = await addAdmin(targetTgId, target.name, target.username ?? null);
    if (added) {
      await sendText(chatId, `✅ Пользователь ${target.name} (tg_id: ${targetTgId}) добавлен в администраторы.`);
    } else {
      await sendText(chatId, '❌ Пользователь уже является администратором.');
    }
    return;
  }

  if (userText.startsWith('/removeadmin ')) {
    if (!isAdminUser) {
      await sendText(chatId, '❌ Эта команда доступна только администраторам.');
      return;
    }
    const targetTgId = parseInt(userText.slice('/removeadmin '.length).trim(), 10);
    if (!targetTgId) {
      await sendText(chatId, '❌ Укажите tg_id пользователя: /removeadmin <tg_id>');
      return;
    }
    if (targetTgId === userTgId) {
      await sendText(chatId, '❌ Нельзя удалить себя из администраторов.');
      return;
    }
    await removeAdmin(targetTgId);
    await sendText(chatId, `✅ Пользователь (tg_id: ${targetTgId}) удалён из администраторов.`);
    return;
  }

  if (userText.startsWith('/allow ')) {
    if (!isAdminUser) {
      await sendText(chatId, '❌ Эта команда доступна только администраторам.');
      return;
    }
    const targetTgId = parseInt(userText.slice('/allow '.length).trim(), 10);
    if (!targetTgId) {
      await sendText(chatId, '❌ Укажите tg_id пользователя: /allow <tg_id>');
      return;
    }
    const approved = await approveUser(targetTgId);
    if (approved) {
      await sendText(chatId, `✅ Пользователь (tg_id: ${targetTgId}) добавлен в разрешённые.`);
    } else {
      await sendText(chatId, '❌ У этого пользователя нет активной заявки на вступление.');
    }
    return;
  }

  if (userText.startsWith('/revoke ')) {
    if (!isAdminUser) {
      await sendText(chatId, '❌ Эта команда доступна только администраторам.');
      return;
    }
    const targetTgId = parseInt(userText.slice('/revoke '.length).trim(), 10);
    if (!targetTgId) {
      await sendText(chatId, '❌ Укажите tg_id пользователя: /revoke <tg_id>');
      return;
    }
    await revokeUser(targetTgId);
    await sendText(chatId, `✅ Доступ отозван у пользователя (tg_id: ${targetTgId}).`);
    return;
  }

  if (userText === '/requests') {
    if (!isAdminUser) {
      await sendText(chatId, '❌ Эта команда доступна только администраторам.');
      return;
    }
    const requests = await listJoinRequests();
    if (requests.length === 0) {
      await sendText(chatId, '📭 Нет заявок на вступление.');
      return;
    }
    let text = '📥 <b>Заявки на вступление:</b>\n';
    for (const r of requests) {
      text += `• ${r.name} (tg_id: ${r.tgId})${r.username ? ` (@${r.username})` : ''}\n`;
    }
    text += '\nОдобрить: /allow <tg_id>';
    await sendText(chatId, text);
    return;
  }

  // --- Проверка доступа для обычных пользователей ---

  if (!allowed && !isAdminUser) {
    // Пользователь не разрешён и не админ — предлагаем оставить заявку
    const hasReq = await hasJoinRequest(userTgId);
    if (userText === '/start') {
      await saveMessage(userId, chatId, '/start', false);
      await sendText(
        chatId,
        '👋 Привет! Этот бот доступен только по приглашению.\n\n'
        + 'Чтобы получить доступ, отправьте заявку администратору:\n'
        + '/request — оставить заявку на вступление\n\n'
        + 'Администратор рассмотрит вашу заявку и добавит вас в список разрешённых пользователей.'
      );
      return;
    }

    if (userText === '/request') {
      await saveMessage(userId, chatId, '/request', false);
      const created = await createJoinRequest(userTgId, userName, userUsername);
      if (created) {
        await sendText(chatId, '✅ Ваша заявка отправлена администратору. Ожидайте одобрения.');
      } else {
        await sendText(chatId, '⏳ Ваша заявка уже отправлена и ожидает рассмотрения.');
      }
      return;
    }

    // Любое другое сообщение от неразрешённого пользователя
    await sendText(
      chatId,
      '❌ У вас нет доступа к этому боту.\n'
      + 'Отправьте /start чтобы узнать подробности, или /request чтобы подать заявку на вступление.'
    );
    return;
  }

  // --- Команды для разрешённых пользователей и админов ---

  if (userText === '/start') {
    await saveMessage(userId, chatId, '/start', false);
    const currentDialogId = await getOrCreateCurrentDialog(userId, userTgId, userName);
    await sendText(
      chatId,
      '👋 Привет! Я бот на базе модели <b>NVIDIA Nemotron 3.5 Super VL 120B</b>.\n\n'
      + 'Что я умею:\n'
      + '• Отвечать на текстовые сообщения\n'
      + '• Смотреть на фото и отвечать на вопросы о них (пришлите фото с подписью)\n'
      + '• Вести изолированные диалоги — переключайтесь между ними командами ниже\n'
      + '• Статистику по вашим сообщениям — команда /stats\n'
      + '• Помощь — команда /help\n\n'
      + 'Диалоги:\n'
      + '/dialogs — список ваших диалогов\n'
      + '/newdialog <имя> — создать новый диалог\n'
      + '/switch <id> — переключиться на диалог\n\n'
      + 'Напишите что-нибудь, и я отвечу с помощью нейросети.'
    );
    return;
  }

  if (userText === '/help') {
    await saveMessage(userId, chatId, '/help', false);
    await sendText(
      chatId,
      '📋 <b>Справка</b>\n\n'
      + 'Просто отправьте мне любое текстовое сообщение — я отвечу, '
      + 'используя модель NVIDIA Nemotron 3.5 Super VL.\n\n'
      + 'Вы также можете прислать фото с текстом-подписью — я посмотрю на изображение '
      + 'и отвечу о нём.\n\n'
      + 'Команды:\n'
      + '/start — приветствие\n'
      + '/help — эта справка\n'
      + '/stats — статистика ваших сообщений\n'
      + '/reset — сбросить статистику\n'
      + '/dialogs — список ваших диалогов\n'
      + '/newdialog <имя> — создать новый диалог\n'
      + '/switch <id> — переключиться на диалог\n\n'
      + 'Ограничение: не чаще одного сообщения в секунду.'
    );
    return;
  }

  if (userText === '/stats') {
    await saveMessage(userId, chatId, '/stats', false);
    const count = await db.$count(messages, eq(messages.userId, userId));
    await sendText(
      chatId,
      `📊 Статистика: вы отправили <b>${count}</b> сообщений(я).`
    );
    return;
  }

  if (userText === '/reset') {
    await db.delete(messages).where(eq(messages.userId, userId)).run();
    await sendText(chatId, '✅ Статистика сброшена.');
    return;
  }

  if (userText === '/dialogs') {
    const currentDialogId = await db.select().from(userCurrentDialog)
      .where(eq(userCurrentDialog.userId, userId)).get();
    const userDialogs = await listUserDialogs(userId);
    const currentId = currentDialogId ? currentDialogId.dialogId : null;
    await sendText(chatId, formatDialogs(userDialogs, currentId));
    return;
  }

  if (userText.startsWith('/newdialog')) {
    const name = userText.slice('/newdialog'.length).trim() || `Диалог ${Date.now()}`;
    const dialogId = await createDialog(userId, name);
    await setCurrentDialog(userId, dialogId);
    await saveMessage(userId, chatId, userText, false);
    await sendText(chatId, `✅ Создан новый диалог «${name}» и установлен как текущий.`);
    return;
  }

  if (userText.startsWith('/switch ')) {
    const dialogId = parseInt(userText.slice('/switch '.length).trim(), 10);
    if (!dialogId) {
      await sendText(chatId, '❌ Укажите ID диалога: /switch <id>');
      return;
    }
    const ok = await switchDialog(userId, dialogId);
    if (!ok) {
      await sendText(chatId, '❌ Диалог с таким ID не найден среди ваших.');
      return;
    }
    const dialog = await db.select().from(dialogs).where(eq(dialogs.id, dialogId)).get();
    await sendText(chatId, `✅ Переключено на диалог «${dialog ? dialog.name : dialogId}».`);
    return;
  }

  // --- Обычные сообщения (текст / фото) ---

  // Rate limit: не чаще одного сообщения в секунду
  const rateLimit = await checkRateLimit(userId);
  if (!rateLimit.allowed) {
    await sendText(
      chatId,
      `⏳ Пожалуйста, подождите ${Math.ceil(rateLimit.waitMs / 1000)} сек. перед следующим сообщением.`
    );
    return;
  }

  // Получаем или создаём текущий диалог
  const currentDialogId = await getOrCreateCurrentDialog(userId, userTgId, userName);

  try {
    let answer;
    const userMessageText = userText ?? caption ?? '';

    // Сохраняем сообщение пользователя в историю диалога
    await addDialogMessage(currentDialogId, 'user', userMessageText);

    // Получаем историю диалога для контекста модели
    const history = await getDialogHistory(currentDialogId, 20);

    if (hasPhoto) {
      answer = await getResponseFromMessagePhoto(message, caption);
    } else if (userText) {
      // Строим сообщения для модели с учётом истории диалога
      const messagesForModel = history.map((m) => ({ role: m.role, content: m.content }));
      messagesForModel.push({ role: 'user', content: userText });
      answer = await chatWithHistory(messagesForModel);
    } else {
      await sendText(chatId, 'Я пока умею обрабатывать текст и фото.');
      return;
    }

    // Сохраняем ответ модели в историю диалога
    await addDialogMessage(currentDialogId, 'assistant', answer);

    await saveMessage(userId, chatId, userMessageText, hasPhoto);

    // Записываем время запроса к модели (rate limit)
    await recordRateLimit(userId);

    // Telegram ограничивает длину сообщения — разбиваем, если нужно
    const MAX_LENGTH = 4000;
    if (answer.length <= MAX_LENGTH) {
      await sendText(chatId, answer);
    } else {
      for (let i = 0; i < answer.length; i += MAX_LENGTH) {
        await sendText(chatId, answer.slice(i, i + MAX_LENGTH));
      }
    }
  } catch (err) {
    console.error('Ошибка при обработке сообщения:', err);

    await sendText(
      chatId,
      'Извините, произошла ошибка при обработке вашего сообщения. '
      + 'Попробуйте ещё раз позже.'
    );
  }
}
