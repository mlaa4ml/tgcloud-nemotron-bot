/**
 * Обработчик входящих сообщений.
 *
 * Получает сообщение от пользователя, сохраняет его в базу данных,
 * запрашивает ответ у модели NVIDIA Nemotron 3.5 Super VL 120B
 * и отправляет ответ обратно в Telegram.
 *
 * Поддерживает:
 *  - текстовые сообщения
 *  - фото (vision-модель может viewing изображения)
 *  - команды /start, /help, /stats, /reset
 */

import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import {
  getResponse,
  getResponseFromMessagePhoto,
  getResponseWithImages
} from '../lib/nemotron.js';
import { messages, users } from '../schema.js';

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

  // --- Команды ---

  if (userText === '/start') {
    await saveMessage(userId, chatId, '/start', false);
    await sendText(
      chatId,
      '👋 Привет! Я бот на базе модели <b>NVIDIA Nemotron 3.5 Super VL 120B</b>.\n\n'
      + 'Что я умею:\n'
      + '• Отвечать на текстовые сообщения\n'
      + '• Смотреть на фото и отвечать на вопросы о них (пришлите фото с подписью)\n'
      + '• Статистику по вашим сообщениям — команда /stats\n'
      + '• Помощь — команда /help\n\n'
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
      + '/reset — сбросить статистику'
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

  // --- Обычные сообщения ---

  try {
    let answer;

    if (hasPhoto) {
      answer = await getResponseFromMessagePhoto(message, caption);
    } else if (userText) {
      answer = await getResponse(userText);
    } else {
      await sendText(chatId, 'Я пока умею обрабатывать текст и фото.');
      return;
    }

    await saveMessage(userId, chatId, userText ?? caption ?? '', hasPhoto);

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