// База данных Telegram Serverless (SQLite).
// Подробнее: https://core.telegram.org/bots/serverless#the-database
//
// Таблицы здесь используются для хранения статистики пользователей,
// их сообщений, списка разрешённых пользователей, администраторов,
// диалогов и лимитов скорости. Можете расширять по мере роста бота.

import { table, integer, text, real, sql } from 'sdk/db';

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

// Разрешённые пользователи бота (кроме администраторов).
// Доступ к боту granted только тем, кто здесь есть или является админом.
export const allowedUsers = table('allowed_users', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  tgId:      integer('tg_id').unique().notNull(),
  name:      text('name').notNull().default(''),
  username:  text('username'),
  created:   integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
}, (t) => ({
  byTgId: index('idx_allowed_users_tg_id').on(t.tgId)
}));

// Запросы на добавление в бота (ожидают одобрения администратором).
export const joinRequests = table('join_requests', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  tgId:      integer('tg_id').unique().notNull(),
  name:      text('name').notNull().default(''),
  username:  text('username'),
  created:   integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
}, (t) => ({
  byTgId: index('idx_join_requests_tg_id').on(t.tgId)
}));

// Администраторы бота. Могут одобрять/удалять пользователей и управлять списком админов.
export const admins = table('admins', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  tgId:      integer('tg_id').unique().notNull(),
  name:      text('name').notNull().default(''),
  username:  text('username'),
  created:   integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
}, (t) => ({
  byTgId: index('idx_admins_tg_id').on(t.tgId)
}));

// Диалоги пользователей. Каждый диалог — изолированная история общения.
export const dialogs = table('dialogs', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull(),
  name:      text('name').notNull().default(''),
  created:   integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
}, (t) => ({
  byUser: index('idx_dialogs_user_id').on(t.userId)
}));

// Сообщения диалогов (история общения с моделью внутри диалога).
export const dialogMessages = table('dialog_messages', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  dialogId:  integer('dialog_id').notNull(),
  role:      text('role').notNull(),   // 'user' | 'assistant' | 'system'
  content:   text('content').notNull(),
  created:   integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
}, (t) => ({
  byDialog: index('idx_dialog_messages_dialog_id').on(t.dialogId),
  byCreated: index('idx_dialog_messages_created_at').on(t.created)
}));

// Текущий (активный) диалог пользователя — для переключения между диалогами.
export const userCurrentDialog = table('user_current_dialog', {
  userId:    integer('user_id').primaryKey(),
  dialogId:  integer('dialog_id').notNull(),
  updated:   integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`)
});

// Лимит скорости: время последнего запроса к модели по пользователю.
export const userRateLimit = table('user_rate_limit', {
  userId:       integer('user_id').primaryKey(),
  lastRequest:  integer('last_request').notNull().default(0)
});

// Глобальный лимит скорости: время последнего запроса к модели от любого пользователя.
export const globalRateLimit = table('global_rate_limit', {
  id:          integer('id').primaryKey(),
  lastRequest: integer('last_request').notNull().default(0)
});