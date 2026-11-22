/**
 * Клиент для нейросетевой модели NVIDIA Nemotron 3.5 Super VL 120B.
 *
 * Документация API: https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b/apireference
 *
 * Вызывается из обработчиков сообщений. Ключ API берётся из переменной
 * окружения NVIDIA_API_KEY (задаётся в .tgcloud/env или через системные
 * переменные окружения при деплое).
 *
 * Поддерживает как текстовые сообщения, так и сообщения с фото (vision).
 * Фото из Telegram скачиваются через api.getFileContent и передаются в
 * модель в формате base64 data-URL.
 */

import { fetch } from 'sdk/fetch';
import { api } from 'sdk';

const BASE_URL = process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';
const MODEL = process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const API_KEY = process.env.NVIDIA_API_KEY;

/**
 * Проверяет, что ключ API задан.
 */
function requireApiKey() {
  if (!API_KEY) {
    throw new Error(
      'NVIDIA_API_KEY не задан. Укажите ключ в .tgcloud/env (переменная NVIDIA_API_KEY).'
    );
  }
}

/**
 * Превращает массив байт в base64-строку.
 */
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Скачивает файл по file_id из Telegram и возвращает data-URL
 * (data:image/jpeg;base64,...) для передачи в модель.
 *
 * @param {string} fileId - file_id фото из Telegram
 * @returns {Promise<string>} data-URL изображения
 */
async function downloadFileAsDataUrl(fileId) {
  const { file } = await api.getFile(fileId);
  const bytes = await api.getFileContent(file_id_or_path(file));
  const mime = file.file_path ? mimeFromPath(file.file_path) : 'image/jpeg';
  const base64 = bytesToBase64(bytes);
  return `data:${mime};base64,${base64}`;
}

/**
 * Вспомогательная обёртка: api.getFileContent принимает file_id (строку),
 * а не объект File. Оставляем для ясности.
 */
function file_id_or_path(file) {
  return typeof file === 'string' ? file : file.file_id;
}

/**
 * Определяет MIME-тип по расширению файла.
 */
function mimeFromPath(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return 'image/jpeg';
  }
}

/**
 * Строит массив content для сообщения пользователя: текст + изображения.
 *
 * @param {string} text - текст сообщения
 * @param {string[]} imageUrls - массив data-URL изображений
 * @returns {Array} массив блоков content в формате OpenAI/NVIDIA API
 */
function buildUserContent(text, imageUrls = []) {
  const parts = [];
  if (text && text.trim()) {
    parts.push({ type: 'text', text });
  }
  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  // Если только картинка без текста — добавляем пустой текст
  if (parts.length === 0) {
    parts.push({ type: 'text', text: '' });
  }
  return parts;
}

/**
 * Отправляет запрос модели и возвращает её ответ.
 *
 * @param {Array} messages - массив сообщений в формате API
 * @returns {Promise<string>} текст ответа модели
 */
async function chat(messages) {
  requireApiKey();

  const url = `${BASE_URL}/chat/completions`;

  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 2048,
    stream: false
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json'
    },
    body
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NVIDIA API ошибка ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('NVIDIA API вернул некорректный ответ');
  }

  return data.choices[0].message.content;
}

/**
 * Отправляет текст модели и возвращает её ответ.
 *
 * @param {string} userMessage - текст сообщения от пользователя в Telegram
 * @returns {Promise<string>} - ответ модели
 */
export async function getResponse(userMessage) {
  return chat([
    {
      role: 'system',
      content: 'Вы — полезный ассистент в Телеграм-боте. Отвечайте по-русски, кратко и по существу.'
    },
    {
      role: 'user',
      content: userMessage
    }
  ]);
}

/**
 * Отправляет текст и изображения модели и возвращает её ответ.
 *
 * @param {string} text - текст подписи к фото (может быть пустым)
 * @param {string[]} imageUrls - массив data-URL изображений
 * @returns {Promise<string>} - ответ модели
 */
export async function getResponseWithImages(text, imageUrls = []) {
  return chat([
    {
      role: 'system',
      content: 'Вы — полезный ассистент в Телеграм-боте. Вы умеете видеть изображения и отвечать на вопросы о них. Отвечайте по-русски, кратко и по существу.'
    },
    {
      role: 'user',
      content: buildUserContent(text, imageUrls)
    }
  ]);
}

/**
 * Скачивает все фото из сообщения Telegram и возвращает ответ модели.
 * Берёт фото наибольшего размера (последний элемент массива photo).
 *
 * @param {object} message - объект Message из Telegram
 * @param {string} caption - подпись к фото
 * @returns {Promise<string>} - ответ модели
 */
export async function getResponseFromMessagePhoto(message, caption = '') {
  const photos = message.photo;
  if (!photos || photos.length === 0) {
    throw new Error('В сообщении нет фото');
  }

  // Берем фото наибольшего размера
  const largestPhoto = photos[photos.length - 1];
  const imageUrl = await downloadFileAsDataUrl(largestPhoto.file_id);

  return getResponseWithImages(caption, [imageUrl]);
}

export { BASE_URL, MODEL, buildUserContent, downloadFileAsDataUrl };