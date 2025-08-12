const express = require('express');
const path = require('path');
const AdvancedMapSVGGenerator = require('./advanced-generator');

const app = express();
const PORT = 3445;

// Базовый middleware
app.use(express.json());

// Статические файлы (HTML интерфейс)
app.use(express.static(path.join(__dirname, '../public')));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Эндпоинт для генерации карты
app.get('/api/map', async (req, res) => {
    try {
        const { url } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL parameter is required' });
        }

        // Декодируем URL если он закодирован
        const decodedUrl = decodeURIComponent(url);
        console.log(`Generating map for: ${decodedUrl}`);
        
        const generator = new AdvancedMapSVGGenerator();
        await generator.generateMapSVG(decodedUrl);
        
        // Возвращаем созданный файл
        const svgPath = path.join(__dirname, '../result/map.svg');
        res.sendFile(svgPath);
        
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Example: http://localhost:${PORT}/api/map?url=https://map.project-osrm.org/?z=11&center=43.533367%2C39.845352&loc=43.443971%2C39.940093&loc=43.671308%2C39.620620`);
});

module.exports = app;
