const AdvancedMapSVGGenerator = require('./advanced-generator');

// Основная функция
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('📝 Использование: node src/index.js <URL_Maps>');
        console.log('📝 Пример Google: node src/index.js "https://maps.app.goo.gl/6rwcTyUHgDZdRAnW9"');
        console.log('📝 Пример OSRM: node src/index.js "https://map.project-osrm.org/?z=11&center=43.533367%2C39.845352&loc=43.443971%2C39.940093&loc=43.671308%2C39.620620&hl=en&alt=0&srv=0"');
        console.log('📝 Для PowerShell используйте одинарные кавычки вместо двойных');
        
        // Используем OSRM для демонстрации
        const demoUrl = 'https://map.project-osrm.org/?z=11&center=43.533367%2C39.845352&loc=43.443971%2C39.940093&loc=43.671308%2C39.620620&hl=en&alt=0&srv=0';
        
        console.log('\n🚀 Запускаем с демо OSRM URL...');
        const generator = new AdvancedMapSVGGenerator();
        await generator.generateMapSVG(demoUrl);
        return;
    }
    
    const googleMapsUrl = args[0];
    
    try {
        const generator = new AdvancedMapSVGGenerator();
        await generator.generateMapSVG(googleMapsUrl);
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        process.exit(1);
    }
}

// Запускаем скрипт
if (require.main === module) {
    main();
}
