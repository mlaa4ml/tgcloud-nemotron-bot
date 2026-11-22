# Проект Telegram Serverless бота

- Toute логика бота находится в `tgcloud/`.
- Обработчики обновлений — в `tgcloud/handlers/`, общий код — в `tgcloud/lib/`.
- Схема базы данных — в `tgcloud/schema.js`.
- Импортируйте SDK так: `import { api, db, fetch } from 'sdk'`.
- Импортируйте свои модули по относительному пути с расширением `.js`.
- Модель NVIDIA Nemotron вызывается через `lib/nemotron.js`.
- Ключ API модели хранится в `.tgcloud/env` (переменная `NVIDIA_API_KEY`).
- Деплой: `npx tgcloud push`, миграции БД: `npx tgcloud migrate`.
- Тест без деплоя: `npx tgcloud run handlers/message '{...}'`.