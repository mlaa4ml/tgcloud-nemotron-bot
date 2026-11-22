/**
 * Управление доступом к боту: разрешённые пользователи, администраторы,
 * запросы на вступление и диалоги.
 *
 * Импортируйте SDK так: `import { api, db } from 'sdk'`.
 * Импортируйте свои модули по относительному пути с расширением `.js`.
 */

import { eq, and } from 'sdk/db';
import {
  users,
  allowedUsers,
  joinRequests,
  admins,
  dialogs,
  dialogMessages,
  userCurrentDialog,
  userRateLimit,
  globalRateLimit,
} from '../schema.js';

/**
 * Минимальный интервал между запросами к модели (в мс).
 * 1 сообщение в секунду.
 */
export const MODEL_RATE_LIMIT_MS = 1000;

const INITIAL_ADMIN_TG_ID = process.env.INITIAL_ADMIN_TG_ID ? parseInt(process.env.INITIAL_ADMIN_TG_ID, 10) : null;

/**
 * Проверяет, является ли пользователь администратором.
 */
export async function isAdmin(tgId) {
  // По переменной окружения INITIAL_ADMIN_TG_ID (первый администратор при деплое)
  if (INITIAL_ADMIN_TG_ID && tgId === INITIAL_ADMIN_TG_ID) {
    return true;
  }
  const row = await db.select().from(admins).where(eq(admins.tgId, tgId)).get();
  return !!row;
}

/**
 * Проверяет, разрешён ли пользователю доступ к боту
 * (разрешённый пользователь или администратор).
 */
export async function isAllowed(tgId) {
  if (await isAdmin(tgId)) {
    return true;
  }
  const row = await db.select().from(allowedUsers).where(eq(allowedUsers.tgId, tgId)).get();
  return !!row;
}

/**
 * Проверяет, есть ли у пользователя активный запрос на вступление.
 */
export async function hasJoinRequest(tgId) {
  const row = await db.select().from(joinRequests).where(eq(joinRequests.tgId, tgId)).get();
  return !!row;
}

/**
 * Создаёт запрос на вступление (если ещё не существует).
 * Возвращает true, если запрос создан, false — если уже был.
 */
export async function createJoinRequest(tgId, name, username) {
  if (await hasJoinRequest(tgId)) {
    return false;
  }
  await db.insert(joinRequests)
    .values({ tgId, name: name ?? '', username: username ?? null })
    .run();
  return true;
}

/**
 * Добавляет пользователя в список разрешённых и удаляет его запрос на вступление.
 * Возвращает true, если пользователь был добавлен.
 */
export async function approveUser(tgId) {
  const req = await db.select().from(joinRequests).where(eq(joinRequests.tgId, tgId)).get();
  if (!req) {
    return false;
  }

  await db.insert(allowedUsers)
    .values({ tgId, name: req.name, username: req.username })
    .run();

  await db.delete(joinRequests).where(eq(joinRequests.tgId, tgId)).run();
  return true;
}

/**
 * Удаляет пользователя из списка разрешённых.
 */
export async function revokeUser(tgId) {
  await db.delete(allowedUsers).where(eq(allowedUsers.tgId, tgId)).run();
  await db.delete(joinRequests).where(eq(joinRequests.tgId, tgId)).run();
}

/**
 * Возвращает список всех заявок на вступление.
 */
export async function listJoinRequests() {
  return await db.select().from(joinRequests).all();
}

/**
 * Добавляет администратора (нельзя сделать админа самого себя через эту функцию,
 * вызывающий должен передать целевой tgId).
 */
export async function addAdmin(tgId, name, username) {
  const existing = await db.select().from(admins).where(eq(admins.tgId, tgId)).get();
  if (existing) {
    return false;
  }
  await db.insert(admins).values({ tgId, name: name ?? '', username: username ?? null }).run();
  return true;
}

/**
 * Удаляет администратора.
 */
export async function removeAdmin(tgId) {
  await db.delete(admins).where(eq(admins.tgId, tgId)).run();
}

/**
 * Возвращает список администраторов.
 */
export async function listAdmins() {
  return await db.select().from(admins).all();
}

/**
 * Создаёт новый диалог для пользователя.
 * Возвращает ID созданного диалога.
 */
export async function createDialog(userId, name) {
  const [row] = await db.insert(dialogs)
    .values({ userId, name: name ?? 'Диалог' })
    .returning()
    .run();
  return row.id;
}

/**
 * Возвращает все диалоги пользователя.
 */
export async function listUserDialogs(userId) {
  return await db.select().from(dialogs).where(eq(dialogs.userId, userId)).all();
}

/**
 * Устанавливает текущий диалог пользователя. Если диалога нет — создаёт новый.
 * Возвращает ID текущего диалога.
 */
export async function setCurrentDialog(userId, dialogId) {
  const existing = await db.select().from(userCurrentDialog).where(eq(userCurrentDialog.userId, userId)).get();
  if (existing) {
    await db.update(userCurrentDialog)
      .set({ dialogId, updated: Math.floor(Date.now() / 1000) })
      .where(eq(userCurrentDialog.userId, userId))
      .run();
  } else {
    await db.insert(userCurrentDialog)
      .values({ userId, dialogId, updated: Math.floor(Date.now() / 1000) })
      .run();
  }
  return dialogId;
}

/**
 * Возвращает ID текущего диалога пользователя. Если нет — создаёт новый диалог.
 */
export async function getOrCreateCurrentDialog(userId, userTgId, userName) {
  const current = await db.select().from(userCurrentDialog).where(eq(userCurrentDialog.userId, userId)).get();
  if (current) {
    return current.dialogId;
  }
  const dialogId = await createDialog(userId, `Диалог с ${userName ?? 'пользователем'}`);
  await setCurrentDialog(userId, dialogId);
  return dialogId;
}

/**
 * Переключает пользователя на другой свой диалог по ID.
 * Возвращает true, если переключение выполнено.
 */
export async function switchDialog(userId, dialogId) {
  const dialog = await db.select().from(dialogs)
    .where(and(eq(dialogs.id, dialogId), eq(dialogs.userId, userId))).get();
  if (!dialog) {
    return false;
  }
  await setCurrentDialog(userId, dialogId);
  return true;
}

/**
 * Возвращает историю сообщений диалога (от старых к новым).
 * Каждый элемент: { role, content }.
 */
export async function getDialogHistory(dialogId, limit = 20) {
  const rows = await db.select().from(dialogMessages)
    .where(eq(dialogMessages.dialogId, dialogId))
    .orderBy(dialogMessages.created)
    .limit(limit)
    .all();
  return rows.map((row) => ({ role: row.role, content: row.content }));
}

/**
 * Добавляет сообщение в историю диалога.
 */
export async function addDialogMessage(dialogId, role, content) {
  await db.insert(dialogMessages)
    .values({ dialogId, role, content: content ?? '', created: Math.floor(Date.now() / 1000) })
    .run();
}

/**
 * Проверяет лимит скорости (1 сообщение в секунду на пользователя и глобально).
 * Возвращает { allowed, waitMs }. Если allowed = false, waitMs — время ожидания.
 */
export async function checkRateLimit(userId) {
  const now = Math.floor(Date.now() / 1000) * 1000;

  const userLimit = await db.select().from(userRateLimit).where(eq(userRateLimit.userId, userId)).get();
  const globalLimit = await db.select().from(globalRateLimit).limit(1).all();

  let userWaitMs = 0;
  if (userLimit) {
    const elapsed = now - userLimit.lastRequest;
    if (elapsed < MODEL_RATE_LIMIT_MS) {
      userWaitMs = MODEL_RATE_LIMIT_MS - elapsed;
    }
  }

  let globalWaitMs = 0;
  if (globalLimit && globalLimit[0]) {
    const elapsed = now - globalLimit[0].lastRequest;
    if (elapsed < MODEL_RATE_LIMIT_MS) {
      globalWaitMs = MODEL_RATE_LIMIT_MS - elapsed;
    }
  }

  const waitMs = Math.max(userWaitMs, globalWaitMs);
  return { allowed: waitMs === 0, waitMs };
}

/**
 * Записывает время последнего запроса к модели (пользователь + глобально).
 */
export async function recordRateLimit(userId) {
  const now = Math.floor(Date.now() / 1000) * 1000;

  await db.upsert(userRateLimit)
    .values({ userId, lastRequest: now })
    .run();

  const rows = await db.select().from(globalRateLimit).limit(1).all();
  if (rows.length === 0) {
    await db.insert(globalRateLimit).values({ lastRequest: now }).run();
  } else {
    await db.update(globalRateLimit)
      .set({ lastRequest: now })
      .where(eq(globalRateLimit.id, rows[0].id))
      .run();
  }
}
