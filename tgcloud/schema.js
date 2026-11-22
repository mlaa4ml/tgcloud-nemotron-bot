// База данных Telegram Serverless (SQLite).
// Подробнее: https://core.telegram.org/bots/serverless#the-database
//
// Таблицы здесь используются для хранения статистики пользователей
// и их сообщений. Можете расширять по мере роста бота.

import { table, integer, text, sql } from 'sdk/db';

export const users = table('users', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  tgId:      integer('tg_id').unique().notNull(),
  name:      text('name').notNull().default(''),
  username:  text('username'),
  lastSeen:  integer('last_seen').default(0)
}, (t) => ({
  byTgId: index('idx_users_tg_id').on(t.tgId)
}));

export const messages = table('messages', {
  id:       integer('id').primaryKey({ autoIncrement: true }),
  userId:   integer('user_id').notNull(),
  chatId:   integer('chat_id').notNull(),
  text:     text('text'),
  hasPhoto: integer('has_photo').default(0),
  created:  integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
}, (t) => ({
  byUser:   index('idx_messages_user_id').on(t.userId),
  byChat:   index('idx_messages_chat_id').on(t.chatId),
  byCreated: index('idx_messages_created_at').on(t.created)
}));