# OSRM SVG Map Generator

🗺️ Бесплатный генератор векторных SVG карт из маршрутов OSRM (Open Source Routing Machine)

## 🚀 Демо

Посмотреть запущенный вариант: **[https://map.dtf.su](https://map.dtf.su)**

## 📋 Описание

Этот проект позволяет создавать высококачественные векторные SVG карты из маршрутов, построенных с помощью OSRM. Идеально подходит для:

- 📄 Печати маршрутов
- 🎨 Дизайн-проектов
- 📊 Презентаций
- 🖼️ Создания иллюстраций

## ✨ Возможности

- ✅ Создание векторных SVG карт высокого качества
- ✅ Поддержка маршрутов любой сложности
- ✅ Масштабируемая векторная графика для печати
- ✅ Бесплатное использование без ограничений
- ✅ Интеграция с OpenStreetMap данными
- ✅ Простой веб-интерфейс
- ✅ REST API для интеграции

## 🛠️ Технологии

- **Backend**: Node.js + Express
- **Frontend**: HTML5 + CSS3 + JavaScript
- **Routing**: OSRM API
- **Maps**: OpenStreetMap
- **Graphics**: SVG с Web Mercator проекцией

## 🏃‍♂️ Быстрый старт

### Установка

```bash
# Клонируем репозиторий
git clone https://github.com/DataforumIDP/osrm-svg-path.git
cd osrm-svg-path

# Устанавливаем зависимости
yarn install

# Запускаем сервер
yarn start
```

Приложение будет доступно по адресу: `http://localhost:3445`

### Использование

1. Откройте [OSRM Demo](https://map.project-osrm.org/)
2. Постройте маршрут между двумя точками
3. Скопируйте URL из адресной строки
4. Вставьте URL в форму на [map.dtf.su](https://map.dtf.su)
5. Нажмите "Сгенерировать SVG карту"
6. Скачайте готовый SVG файл

## 🔌 API

### GET /api/map

Генерирует SVG карту из URL маршрута OSRM

**Параметры:**
- `url` (обязательный) - URL маршрута от OSRM

**Пример запроса:**
```bash
curl "http://localhost:3445/api/map?url=https://map.project-osrm.org/?z=10&center=55.751244%2C37.618423&loc=55.751244%2C37.618423&loc=55.755814%2C37.617448&hl=en&alt=0&srv=0"
```

**Ответ:**
- Content-Type: `image/svg+xml`
- SVG файл с картой маршрута

## 📂 Структура проекта

```
osrm-svg-path/
├── src/
│   ├── advanced-generator.js  # Основная логика генерации SVG
│   ├── server.js             # Express сервер
│   └── index.js              # CLI точка входа
├── public/
│   └── index.html            # Веб-интерфейс
├── result/                   # Результаты генерации
├── package.json
└── README.md
```

## 🧩 Как это работает

1. **Парсинг URL**: Извлекаются координаты точек маршрута из OSRM URL
2. **Запрос к OSRM API**: Получение детального маршрута с геометрией
3. **Декодирование полилинии**: Конвертация закодированной геометрии в координаты
4. **Проекция координат**: Преобразование GPS координат в SVG координаты (Web Mercator)
5. **Генерация SVG**: Создание векторного изображения с маршрутом

## 🎯 Поддерживаемые форматы URL

Поддерживаются URL от OSRM в следующем формате:
```
https://map.project-osrm.org/?z=10&center=55.751244%2C37.618423&loc=55.751244%2C37.618423&loc=55.755814%2C37.617448&hl=en&alt=0&srv=0
```

## 🤝 Вклад в проект

Мы приветствуем ваш вклад в развитие проекта! 

1. Форкните репозиторий
2. Создайте ветку для вашей функции (`git checkout -b feature/amazing-feature`)
3. Зафиксируйте изменения (`git commit -m 'Add amazing feature'`)
4. Отправьте в ветку (`git push origin feature/amazing-feature`)
5. Откройте Pull Request

## 📄 Лицензия

Этот проект распространяется под лицензией MIT. См. файл `LICENSE` для подробностей.

## 🙏 Благодарности

- [OSRM Project](http://project-osrm.org/) - за отличный routing engine
- [OpenStreetMap](https://www.openstreetmap.org/) - за географические данные
- [Mapbox](https://github.com/mapbox/polyline) - за библиотеку декодирования полилиний

## 📞 Поддержка

Если у вас есть вопросы или предложения:

- 📧 Создайте [Issue](https://github.com/DataforumIDP/osrm-svg-path/issues)
- 🌐 Посетите демо: [https://map.dtf.su](https://map.dtf.su)

---

