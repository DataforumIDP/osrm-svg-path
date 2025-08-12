const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const polyline = require('@mapbox/polyline');
const axios = require('axios');
require('dotenv').config();

const MIN_ROUTE_POINTS = 30; // если меньше — считаем маршрут неполным и добираем через OSRM

class AdvancedMapSVGGenerator {
    constructor() {
        this.resultDir = path.join(__dirname, '..', 'result');
        this.ensureResultDir();
    }

    ensureResultDir() {
        if (!fs.existsSync(this.resultDir)) {
            fs.mkdirSync(this.resultDir, { recursive: true });
        }
    }

    /**
     * Получает реальные точки маршрута из Google/Yandex Maps через браузер
     * @param {string} mapsUrl - URL от карт (Google или Yandex)
     * @returns {Promise<Array>} - массив координат маршрута
     */
    async extractRouteFromBrowser(mapsUrl) {
        console.log('🌐 Запускаем браузер для извлечения маршрута...');
        const browser = await puppeteer.launch({ 
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-blink-features=AutomationControlled',
                '--disable-features=VizDisplayCompositor'
            ] 
        });
        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                'DNT': '1',
                'Upgrade-Insecure-Requests': '1'
            });
            try { await page.emulateTimezone('Europe/Moscow'); } catch {}

            // Коллектор ответов на уровне Puppeteer (ловит всё, включая кросс-домены и service worker)
            const respCaptured = [];
            page.on('response', async (resp) => {
                try {
                    const url = resp.url();
                    const ct = resp.headers()['content-type'] || '';
                    
                    // Расширенные фильтры для Яндекс API
                    const isYandexUrl = /yandex\.|maps\.yandex|api-maps/i.test(url);
                    
                    // Дополнительные фильтры для API маршрутизации
                    const hasRoutePattern = /\/route|\/api\/|\/maps\/|\/geosrv|\/directions|\/api_|\/search|\/suggest|\/geocode|router|masstransit|navigation|matrix|batch|rpc/i.test(url);
                    
                    const shouldCapture = isYandexUrl || 
                        /json|text|x-www-form-urlencoded|javascript|protobuf|application\/x-protobuf/.test(ct) ||
                        hasRoutePattern;
                    
                    if (!shouldCapture) return;
                    
                    let body = '';
                    try { body = await resp.text(); } catch { /* ignore */ }
                    if (!body) return;
                    respCaptured.push({ url, ct, body });
                } catch {}
            });

            // Инжектируем скрипт для перехвата fetch/XHR до загрузки страницы + минимальный антибот
            await page.evaluateOnNewDocument(() => {
                try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
                try { Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU','ru','en-US','en'] }); } catch {}
                try { Object.defineProperty(navigator, 'language', { get: () => 'ru-RU' }); } catch {}
                try { Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }); } catch {}

                window.__gmCaptured = [];
                const origFetch = window.fetch;
                if (origFetch) {
                    window.fetch = async (...args) => {
                        const res = await origFetch(...args);
                        try {
                            const clone = res.clone();
                            const text = await clone.text();
                            window.__gmCaptured.push({ url: res.url, ct: res.headers.get('content-type') || '', body: text });
                        } catch {}
                        return res;
                    };
                }
                const origOpen = XMLHttpRequest.prototype.open;
                const origSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.open = function(method, url) { this.__gmUrl = url; return origOpen.apply(this, arguments); };
                XMLHttpRequest.prototype.send = function(body) {
                    this.addEventListener('load', function() {
                        try {
                          const ct = this.getResponseHeader('content-type') || '';
                          window.__gmCaptured.push({ url: this.__gmUrl || '', ct, body: this.responseText });
                        } catch {}
                    });
                    return origSend.apply(this, arguments);
                };
            });

            // Определяем провайдера карт
            let isYandex = false;
            try { const u = new URL(mapsUrl); isYandex = /yandex\./i.test(u.hostname); } catch {}

            const finalUrlToLoad = await this.resolveFinalMapsUrl(mapsUrl);
            const roughWps = isYandex ? this.extractWaypointsFromYandexUrl(finalUrlToLoad) : await this.extractWaypointsFromUrl(finalUrlToLoad);
            const expectedStart = roughWps[0] || null;
            const expectedEnd = roughWps[roughWps.length - 1] || null;

            console.log(`📄 Загружаем страницу ${isYandex ? 'Yandex Maps' : 'Google Maps'}:`, finalUrlToLoad);
            if (expectedStart && expectedEnd) {
                console.log(`🎯 Ожидаемый маршрут: от [${expectedStart.lat}, ${expectedStart.lng}] до [${expectedEnd.lat}, ${expectedEnd.lng}]`);
            }
            
            await page.goto(finalUrlToLoad, { waitUntil: 'networkidle2', timeout: 45000 });
            
            // Для Яндекс карт - дожидаемся загрузки и делаем дополнительные действия
            if (isYandex) {
                console.log('🗺️ Ждем полной загрузки Яндекс.Карт...');
                await new Promise(r => setTimeout(r, 10000));
                
                try {
                    // Кликаем по карте для активации
                    await page.click('canvas, [class*="map"], .map-container', { timeout: 5000 });
                    console.log('👆 Кликнули по карте');
                } catch {}
                
                try {
                    // Пытаемся найти и кликнуть кнопку "Построить маршрут" если она есть
                    await page.click('[data-name="route"], .route-button, [title*="маршрут"], [aria-label*="маршрут"]', { timeout: 3000 });
                    console.log('🛣️ Нажали кнопку маршрута');
                } catch {}
                
                // Попробуем нажать Enter для активации
                try {
                    await page.keyboard.press('Enter');
                    await new Promise(r => setTimeout(r, 2000));
                } catch {}
                
                // Попробуем кликнуть по координатам из URL 
                try {
                    if (waypoints && waypoints.length >= 2) {
                        // Приблизительные координаты клика для активации маршрута
                        await page.mouse.click(500, 350);
                        await new Promise(r => setTimeout(r, 1000));
                        await page.mouse.click(600, 450);
                        console.log('🎯 Кликнули по точкам маршрута');
                    }
                } catch {}
                
                // Дополнительное ожидание загрузки маршрута
                await new Promise(r => setTimeout(r, 8000));
            }
            
            // Небольшая дерганина карты, чтобы триггернуть релоад данных
            try {
                await page.mouse.move(400, 300);
                await page.mouse.wheel({ deltaY: -200 });
                await page.mouse.wheel({ deltaY: 200 });
                await page.mouse.move(500, 400);
            } catch {}
            await new Promise(r => setTimeout(r, 3000));

            console.log('🔍 Анализируем перехваченные сетевые запросы...');
            let routeData = null;

            try {
                const evalCaptured = await page.evaluate(() => window.__gmCaptured || []);
                const captured = [...evalCaptured, ...respCaptured];
                console.log(`🔍 Найдено ${captured.length} перехваченных ответов (fetch/xhr + puppeteer).`);

                // Сохраняем все ответы для отладки
                const logPath = path.join(this.resultDir, 'network_log.json');
                try {
                    const logData = captured.map((r, i) => ({ id: i, url: r.url, contentType: r.ct, body: r.body }));
                    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf8');
                    console.log(`📝 Все ${captured.length} перехваченных ответов сохранены в: ${logPath}`);
                } catch (e) {
                    console.warn(`⚠️ Не удалось сохранить лог файл: ${e.message}`);
                }

                // Ищем маршрут в перехваченных данных
                for (const [i, req] of captured.entries()) {
                    if (!req.body) continue;
                    const shortUrl = (req.url || '').slice(0, 120);
                    console.log(`\n--- Проверяем ответ #${i} (url: ${shortUrl}...) ---`);

                    // Удаляем XSSI префикс
                    let body = req.body.replace(/^\)\]\}'\n?/, '');

                    // 1) Попытка распарсить целиком
                    let parsedWhole = null;
                    try { parsedWhole = JSON.parse(body); } catch {}
                    if (parsedWhole) {
                        const route = isYandex
                            ? this.parseRouteFromYandexResponse(parsedWhole, { expectedStart, expectedEnd })
                            : this.parseRouteFromApiResponse(parsedWhole, { expectedStart, expectedEnd });
                        if (route && route.length > 2) {
                            console.log(`✅ Найден маршрут в ответе #${i} (JSON целиком): ${route.length} точек`);
                            routeData = route; break;
                        }
                    }

                    // 2) batchexecute: многострочный JSON
                    try {
                        const lines = body.split('\n');
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) continue;
                            let parsed = null;
                            try { parsed = JSON.parse(trimmed); } catch { continue; }
                            const route = isYandex
                                ? this.parseRouteFromYandexResponse(parsed, { expectedStart, expectedEnd })
                                : this.parseRouteFromApiResponse(parsed, { expectedStart, expectedEnd });
                            if (route && route.length > 2) {
                                console.log(`✅ Найден маршрут в строке ответа #${i}: ${route.length} точек`);
                                routeData = route; break;
                            }
                        }
                        if (routeData) break;
                    } catch {}

                    // 3) Фолбэк: ищем все похожие на полилинию токены прямо в тексте (актуально для Google)
                    if (!isYandex) {
                        try {
                            const tokenRe = /[A-Za-z0-9_\-.~]{60,}/g;
                            const seen = new Set();
                            let m;
                            while ((m = tokenRe.exec(body)) !== null) {
                                const token = m[0];
                                if (seen.has(token)) continue; seen.add(token);
                                try {
                                    const decoded = polyline.decode(token);
                                    if (decoded && decoded.length > 2) {
                                        const pts = decoded.map(([lat, lng]) => ({ lat, lng }));
                                        console.log(`✅ Найден маршрут по токену в ответе #${i}: ${pts.length} точек`);
                                        routeData = pts; break;
                                    }
                                } catch { /* not a polyline */ }
                            }
                        } catch {}
                    }

                    if (routeData) break;
                    console.log(`- Маршрут в ответе #${i} не найден.`);
                }
            } catch (err) {
                console.log('❌ Ошибка при обработке перехваченных запросов:', err.message);
            }

            // Для Google — пробуем открыть Directions v1 URL (ui) как второй шанс
            if (!isYandex && (!routeData || routeData.length < 3)) {
                console.log('🔁 Маршрут не найден. Пробуем открыть Directions v1 URL (ui)…');
                try {
                    // извлечь точки из исходного URL
                    let waypoints = await this.extractWaypointsFromUrl(finalUrlToLoad);
                    // если не нашли, попробуем через страницу
                    if (waypoints.length < 2) {
                        try {
                            const info = await this.extractRouteInfoFromPage(page);
                            waypoints = info.waypoints || waypoints;
                        } catch {}
                    }
                    const travelMode = this.parseTravelModeFromUrl(finalUrlToLoad);
                    const v1 = this.buildDirectionsV1Url(waypoints, travelMode);
                    if (v1) {
                        console.log('➡️ Открываем:', v1);
                        await page.goto(v1, { waitUntil: 'networkidle2', timeout: 45000 });
                        try {
                            await page.mouse.move(400, 300);
                            await page.mouse.wheel({ deltaY: -200 });
                            await page.mouse.wheel({ deltaY: 200 });
                        } catch {}
                        await new Promise(r => setTimeout(r, 7000));

                        // объединяем новые ответы
                        const evalCaptured2 = await page.evaluate(() => window.__gmCaptured || []);
                        const captured2 = [...evalCaptured2];
                        for (const [i, req] of captured2.entries()) {
                            if (!req.body) continue;
                            let body = req.body.replace(/^\)\]\}'\n?/, '');
                            let parsedWhole = null; try { parsedWhole = JSON.parse(body); } catch {}
                            if (parsedWhole) {
                                const route = this.parseRouteFromApiResponse(parsedWhole, { expectedStart, expectedEnd });
                                if (route && route.length > 2) { routeData = route; break; }
                            }
                            try {
                                const lines = body.split('\n');
                                for (const line of lines) {
                                    const trimmed = line.trim();
                                    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) continue;
                                    let parsed = null; try { parsed = JSON.parse(trimmed); } catch { continue; }
                                    const route = this.parseRouteFromApiResponse(parsed, { expectedStart, expectedEnd });
                                    if (route && route.length > 2) { routeData = route; break; }
                                }
                                if (routeData) break;
                            } catch {}
                            // regex fallback
                            try {
                                const tokenRe = /[A-Za-z0-9_\-.~]{60,}/g; let m; const seen = new Set();
                                while ((m = tokenRe.exec(body)) !== null) {
                                    const token = m[0]; if (seen.has(token)) continue; seen.add(token);
                                    try {
                                        const decoded = polyline.decode(token);
                                        if (decoded && decoded.length > 2) {
                                            routeData = decoded.map(([lat, lng]) => ({ lat, lng }));
                                            break;
                                        }
                                    } catch {}
                                }
                                if (routeData) break;
                            } catch {}
                        }
                    } else {
                        console.log('⚠️ Не удалось построить Directions v1 URL — недостаточно данных.');
                    }
                } catch (e) {
                    console.log('⚠️ Ошибка при попытке Directions v1:', e.message);
                }
            }

            return routeData;
        } catch (e) {
            console.error('❌ Ошибка при работе с браузером:', e.message);
            throw e;
        } finally {
            try { await browser.close(); } catch {}
        }
    }

    /**
     * Пытается извлечь маршрут из внутреннего состояния страницы (inline state)
     */
    async extractRouteFromInlineState(page) {
        try {
            const candidates = await page.evaluate(() => {
                const polylineCandidates = new Set();

                function collectCandidates(node) {
                    if (!node) return;
                    if (typeof node === 'string') {
                        // кандидаты на закодированные полилинии
                        if (/^[A-Za-z0-9_.\-]+$/.test(node) && node.length > 50) {
                            polylineCandidates.add(node);
                        }
                        return;
                    }
                    if (Array.isArray(node)) {
                        for (const v of node) collectCandidates(v);
                        return;
                    }
                    if (typeof node === 'object') {
                        for (const k in node) collectCandidates(node[k]);
                    }
                }

                // 1) Пробуем известные глобальные стейты
                try { collectCandidates(window.APP_INITIALIZATION_STATE); } catch {}
                try { collectCandidates(window.APP_STATE); } catch {}
                try { collectCandidates(window.WIZ_GLOBAL_STATE); } catch {}
                try { collectCandidates(window._pageData); } catch {}

                // 2) Парсим инлайновые скрипты
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const s of scripts) {
                    const t = s.textContent || '';
                    if (t.includes('APP_INITIALIZATION_STATE')) {
                        try {
                            const m = t.match(/APP_INITIALIZATION_STATE\s*=\s*(\[.*?\]);/s);
                            if (m && m[1]) {
                                const arr = (0, eval)(m[1]); // выполнить в контексте страницы
                                collectCandidates(arr);
                            }
                        } catch {}
                    }
                }

                return Array.from(polylineCandidates).slice(0, 50);
            });

            if (!candidates || candidates.length === 0) return null;
            // Передаем кандидатов назад и парсим уже в ноде
            const best = this.parseRouteFromCandidateStrings(candidates);
            return best && best.length ? best : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Парсит список строк-кандидатов и возвращает лучший маршрут (наибольшее число точек)
     */
    parseRouteFromCandidateStrings(candidates) {
        const routes = [];
        for (const c of candidates) {
            try {
                const decoded = require('@mapbox/polyline').decode(c);
                if (decoded && decoded.length > 2) {
                    routes.push(decoded.map(([lat, lng]) => ({ lat, lng })));
                }
            } catch {}
        }
        if (routes.length === 0) return null;
        // выбираем самый длинный маршрут
        return routes.sort((a, b) => b.length - a.length)[0];
    }

    /**
     * Извлекает маршрут из network requests
     */
    async extractRouteFromNetworkRequests(page) {
        return new Promise(async (resolve) => {
            let best = null;
            const candidates = new Set();

            function tryDecode(str) {
                try {
                    const pts = polyline.decode(str);
                    if (pts && pts.length > 2) return pts.map(([lat, lng]) => ({ lat, lng }));
                } catch {}
                return null;
            }

            function scanAny(obj) {
                if (!obj) return;
                if (typeof obj === 'string') {
                    if (/^[A-Za-z0-9_\-]{50,}$/.test(obj)) candidates.add(obj);
                    return;
                }
                if (Array.isArray(obj)) { for (const v of obj) scanAny(v); return; }
                if (typeof obj === 'object') { for (const k in obj) scanAny(obj[k]); }
            }

            page.on('response', async (resp) => {
                try {
                    const url = resp.url();
                    const ct = resp.headers()['content-type'] || '';
                    if (!(/batchexecute|\/rpcs|directions|route|maps\/api/.test(url))) return;
                    if (!(ct.includes('json') || ct.includes('text/plain'))) return;

                    let body = null;
                    try { body = await resp.text(); } catch {}
                    if (!body) return;
                    body = body.replace(/^\)\]\}'\n?/, ''); // XSSI

                    // Пытаемся распарсить как JSON, либо как вложенные JSON внутри строк
                    let parsed = null;
                    try { parsed = JSON.parse(body); } catch {}
                    if (!parsed && body.includes('\n')) {
                        for (const line of body.split('\n')) {
                            let p = null; try { p = JSON.parse(line); } catch {}
                            if (p) scanAny(p);
                        }
                    } else if (parsed) {
                        scanAny(parsed);
                    }
                } catch {}
            });

            // Ждём до 8 секунд и завершаем
            setTimeout(() => {
                for (const s of candidates) {
                    const pts = tryDecode(s);
                    if (pts && (!best || pts.length > best.length)) best = pts;
                }
                resolve(best);
            }, 8000);
        });
    }

    /**
     * Парсит данные маршрута из ответа API, ища полилинии в характерных структурах.
     */
    parseRouteFromApiResponse(data, opts = {}) {
        const { expectedStart = null, expectedEnd = null } = opts;
        const encodedSet = new Set();
        const candidates = [];

        const tryAddEncoded = (s) => {
            if (!s || typeof s !== 'string') return;
            if (encodedSet.has(s)) return;
            // quick skip very short strings
            if (s.length < 16) return;
            try {
                const dec = polyline.decode(s);
                if (dec && dec.length > 2) {
                    encodedSet.add(s);
                    const pts = dec.map(([lat, lng]) => ({ lat, lng }));
                    candidates.push({ encoded: s, points: pts });
                }
            } catch { /* not a polyline */ }
        };

        const findRecursive = (obj) => {
            if (obj == null) return;
            if (typeof obj === 'string') {
                const trimmed = obj.trim();
                // If string looks like JSON, parse and recurse
                if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length > 2) {
                    try { const inner = JSON.parse(trimmed); findRecursive(inner); } catch { /* ignore */ }
                }
                // Try as encoded polyline
                tryAddEncoded(obj);
                return;
            }
            if (Array.isArray(obj)) {
                // Some patterns: first element is encoded polyline, or inner JSON string as element
                if (typeof obj[0] === 'string') {
                    const t0 = obj[0].trim();
                    if (t0.startsWith('[') || t0.startsWith('{')) { try { findRecursive(JSON.parse(t0)); } catch {} }
                    tryAddEncoded(obj[0]);
                }
                for (const v of obj) findRecursive(v);
                return;
            }
            if (typeof obj === 'object') {
                // Look for common polyline fields
                if (obj.encodedPolyline && typeof obj.encodedPolyline === 'string') tryAddEncoded(obj.encodedPolyline);
                if (obj.points && typeof obj.points === 'string') tryAddEncoded(obj.points);
                if (obj.polyline && typeof obj.polyline === 'string') tryAddEncoded(obj.polyline);
                if (obj.polyline && typeof obj.polyline === 'object') {
                    if (typeof obj.polyline.encodedPolyline === 'string') tryAddEncoded(obj.polyline.encodedPolyline);
                    if (typeof obj.polyline.points === 'string') tryAddEncoded(obj.polyline.points);
                }
                for (const k in obj) findRecursive(obj[k]);
                return;
            }
        };

        findRecursive(data);

        if (candidates.length === 0) return null;

        const costAndPts = (pts) => {
            if (!expectedStart || !expectedEnd) return { dirCost: Infinity, revCost: Infinity, pts: pts.length };
            const first = pts[0];
            const last = pts[pts.length - 1];
            const dirCost = this.haversine(first, expectedStart) + this.haversine(last, expectedEnd);
            const revCost = this.haversine(first, expectedEnd) + this.haversine(last, expectedStart);
            return { dirCost, revCost, pts: pts.length };
        };

        let best = null;
        let bestScore = null;

        for (const c of candidates) {
            const s = costAndPts(c.points);
            if (!best) { best = c; bestScore = s; continue; }
            // Prefer lower min cost, tie-break by number of points
            const bestMin = Math.min(bestScore.dirCost, bestScore.revCost);
            const curMin = Math.min(s.dirCost, s.revCost);
            if (curMin < bestMin || (curMin === bestMin && s.pts > bestScore.pts)) {
                best = c; bestScore = s;
            }
        }

        if (!best) {
            best = candidates.sort((a, b) => b.points.length - a.points.length)[0];
            return best ? best.points : null;
        }

        // Re-orient if reversed matches endpoints better
        if (expectedStart && expectedEnd) {
            if (bestScore.revCost < bestScore.dirCost) {
                best.points.reverse();
            }
        }
        return best.points;
    }

    /**
     * Создает маршрут из URL
     */
    async extractRouteFromUrl(url) {
        const found = [];
        const pushIfValid = (lat, lng) => {
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            // авто‑swap, если подозрительно
            if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
                [lat, lng] = [lng, lat];
            }
            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) found.push({ lat, lng });
        };

        try {
            const u = new URL(url);
            const fullText = decodeURIComponent(u.href);

            // 1) Токены вида !NdVAL (2d=lng, 3d=lat, 4d=lng, 1d=lat)
            const tokens = [];
            const reTok = /!([1234])d(-?\d+\.?\d*)/g;
            let m;
            while ((m = reTok.exec(fullText)) !== null) tokens.push({ t: parseInt(m[1], 10), v: parseFloat(m[2]) });
            let latCand = null, lngCand = null;
            for (const tk of tokens) {
                if (tk.t === 3 || tk.t === 1) latCand = tk.v; // lat
                if (tk.t === 2 || tk.t === 4) lngCand = tk.v; // lng
                if (latCand != null && lngCand != null) {
                    pushIfValid(latCand, lngCand);
                    latCand = null; lngCand = null;
                }
            }

            // 2) Паттерн @lat,lng
            const reAt = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/g;
            while ((m = reAt.exec(fullText)) !== null) pushIfValid(parseFloat(m[1]), parseFloat(m[2]));

            // 3) Координаты в path /dir/ ... и параметрах
            if (u.pathname.includes('/maps/dir/')) {
                const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean);
                for (const part of parts) {
                    const rePair = /(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/g; let mm;
                    while ((mm = rePair.exec(part)) !== null) pushIfValid(parseFloat(mm[1]), parseFloat(mm[2]));
                }
            }
            for (const [k, v] of u.searchParams.entries()) {
                const dec = decodeURIComponent(v);
                const rePair = /(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/g; let mm;
                while ((mm = rePair.exec(dec)) !== null) pushIfValid(parseFloat(mm[1]), parseFloat(mm[2]));
            }
        } catch {}

        // Дедупликация
        const unique = [];
        for (const c of found) {
            if (!unique.find(u => Math.abs(u.lat - c.lat) < 1e-5 && Math.abs(u.lng - c.lng) < 1e-5)) unique.push(c);
        }
        return unique;
    }

    /**
     * Извлекает только точки маршрута (waypoints) из URL Google Maps.
     * Исключает координаты из @center.
     */
    async extractWaypointsFromUrl(url) {
        const wp = [];
        const push = (lat, lng) => {
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                // дедупликация по порядку
                const last = wp[wp.length - 1];
                if (!last || Math.hypot(last.lat - lat, last.lng - lng) > 1e-5) wp.push({ lat, lng });
            }
        };
        try {
            const u = new URL(url);
            const full = decodeURIComponent(u.href);
            // !Nd токены
            const toks = []; let m;
            const reTok = /!([1234])d(-?\d+\.?\d*)/g;
            while ((m = reTok.exec(full)) !== null) toks.push({ t: +m[1], v: parseFloat(m[2]) });
            let lat = null, lng = null;
            for (const tk of toks) {
                if (tk.t === 1 || tk.t === 3) lat = tk.v; // lat
                if (tk.t === 2 || tk.t === 4) lng = tk.v; // lng
                if (lat != null && lng != null) { push(lat, lng); lat = lng = null; }
            }
            // /dir/ сегменты
            if (u.pathname.includes('/maps/dir/')) {
                const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean);
                for (const p of parts) {
                    let mm; const rx = /(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/g;
                    while ((mm = rx.exec(p)) !== null) push(parseFloat(mm[1]), parseFloat(mm[2]));
                }
            }
            // параметры запроса, кроме @
            for (const [k, v] of u.searchParams.entries()) {
                const dec = decodeURIComponent(v);
                let mm; const rx = /(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/g;
                while ((mm = rx.exec(dec)) !== null) push(parseFloat(mm[1]), parseFloat(mm[2]));
            }
        } catch {}
        return wp;
    }

    /**
     * Создает реалистичный маршрут между двумя точками
     */
    createRealisticRoute(startCoords, endCoords) {
        console.log(`🎯 Создаем маршрут от [${startCoords.lat.toFixed(6)}, ${startCoords.lng.toFixed(6)}] до [${endCoords.lat.toFixed(6)}, ${endCoords.lng.toFixed(6)}]`);
        
        const route = [];
        const steps = 50;
        
        const latDiff = endCoords.lat - startCoords.lat;
        const lngDiff = endCoords.lng - startCoords.lng;
        const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
        
        console.log(`📏 Расстояние между точками: ${distance.toFixed(6)} градусов`);
        
        // Создаем более выраженную кривизну
        const routeHash = Math.abs((startCoords.lat + startCoords.lng + endCoords.lat + endCoords.lng) * 1000) % 1000;
        const curvatureBase = Math.max(0.3, (routeHash % 100) / 100); // Минимум 30% кривизны
        const curveDirection = (routeHash % 2) === 0 ? 1 : -1;
        
        console.log(`📐 Параметры кривой: curvature=${curvatureBase.toFixed(3)}, direction=${curveDirection}`);
        
        // Создаем несколько контрольных точек для более сложной кривой
        const controlPoints = [];
        const numControlPoints = 3;
        
        for (let i = 0; i <= numControlPoints; i++) {
            const t = i / numControlPoints;
            let lat = startCoords.lat + latDiff * t;
            let lng = startCoords.lng + lngDiff * t;
            
            // Добавляем большие отклонения для создания интересной кривой
            if (i > 0 && i < numControlPoints) {
                const perpLat = -lngDiff / distance;
                const perpLng = latDiff / distance;
                
                // Создаем S-образную кривую
                const curveFactor = Math.sin(t * Math.PI * 2) * curvatureBase * distance * 0.3;
                const waveFactor = Math.sin(t * Math.PI * 6) * curvatureBase * distance * 0.1;
                
                lat += (curveFactor + waveFactor) * perpLat * curveDirection;
                lng += (curveFactor + waveFactor) * perpLng * curveDirection;
                
                // Добавляем случайные отклонения для реалистичности
                const randomFactor = (routeHash * (i + 1)) % 1000 / 1000 - 0.5;
                lat += randomFactor * distance * 0.1;
                lng += randomFactor * distance * 0.1;
            }
            
            controlPoints.push({ lat, lng });
        }
        
        // Создаем плавную кривую через контрольные точки используя интерполяцию Безье
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const point = this.bezierInterpolation(controlPoints, t);
            route.push(point);
        }
        
        console.log(`✅ Создан маршрут с ${route.length} точками`);
        return route;
    }

    /**
     * Интерполяция Безье для создания плавной кривой через контрольные точки
     */
    bezierInterpolation(controlPoints, t) {
        if (controlPoints.length === 1) {
            return controlPoints[0];
        }
        
        const newPoints = [];
        for (let i = 0; i < controlPoints.length - 1; i++) {
            const p1 = controlPoints[i];
            const p2 = controlPoints[i + 1];
            
            newPoints.push({
                lat: p1.lat + (p2.lat - p1.lat) * t,
                lng: p1.lng + (p2.lng - p1.lng) * t
            });
        }
        
        return this.bezierInterpolation(newPoints, t);
    }

    /**
     * Конвертирует координаты в SVG координаты (Web Mercator + uniform scale)
     */
    convertToSVGCoordinates(route, width = 800, height = 600) {
        const R = 6378137; // радиус сферы для Web Mercator
        const clampLat = (lat) => Math.max(Math.min(lat, 85.05112878), -85.05112878);
        const toMercator = (coord) => {
            // coord может быть как [lat, lng], так и {lat, lng}
            const lat = Array.isArray(coord) ? coord[0] : coord.lat;
            const lng = Array.isArray(coord) ? coord[1] : coord.lng;
            
            const φ = clampLat(lat) * Math.PI / 180;
            const λ = lng * Math.PI / 180;
            const x = R * λ;
            const y = R * Math.log(Math.tan(Math.PI / 4 + φ / 2));
            return { x, y };
        };

        // Проецируем все точки в метры (Mercator)
        const mpts = route.map(toMercator);
        const xs = mpts.map(p => p.x);
        const ys = mpts.map(p => p.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);

        const padding = 50;
        const innerW = Math.max(1, width - 2 * padding);
        const innerH = Math.max(1, height - 2 * padding);
        const rangeX = Math.max(1e-6, maxX - minX);
        const rangeY = Math.max(1e-6, maxY - minY);

        // Равномерное масштабирование без искажений
        const scale = Math.min(innerW / rangeX, innerH / rangeY);
        const offsetX = padding + (innerW - scale * rangeX) / 2;
        const offsetY = padding + (innerH - scale * rangeY) / 2;

        const svgPoints = mpts.map(p => {
            const x = offsetX + (p.x - minX) * scale;
            const y = offsetY + (maxY - p.y) * scale; // инвертируем Y для SVG
            return { x: x.toFixed(2), y: y.toFixed(2) };
        });

        return { points: svgPoints, bounds: { minX, maxX, minY, maxY }, width, height };
    }

    /**
     * Генерирует SVG, строго проходящий через все точки маршрута (без сглаживания)
     */
    generateSVG(svgData, route) {
        const { points, width, height } = svgData;
        if (!points || points.length < 2) {
            throw new Error('Нет точек для создания SVG');
        }

        console.log(`🎨 Генерируем SVG из ${points.length} точек (режим: polyline)`);

        // Точный полилинейный путь: M x0 y0 L x1 y1 L x2 y2 ...
        let pathData = `M ${points[0].x} ${points[0].y}`;
        for (let i = 1; i < points.length; i++) {
            pathData += ` L ${points[i].x} ${points[i].y}`;
        }

        console.log(`📝 Создан SVG path длиной ${pathData.length} символов`);

        // Маркеры всех точек для наглядности соответствия количества точек
        let circlesData = '';
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            const isStart = i === 0;
            const isEnd = i === points.length - 1;
            const radius = isStart || isEnd ? 3 : 1.5;
            const color = isStart ? '#4CAF50' : (isEnd ? '#F44336' : '#FFC107');
            circlesData += `    <circle cx="${point.x}" cy="${point.y}" r="${radius}" fill="${color}" opacity="0.9"/>\n`;
        }

        const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">\n    <!-- Маршрут (точный полилинейный путь) -->\n    <path d="${pathData}"\n          fill="none"\n          stroke="#2196F3"\n          stroke-width="3"\n          stroke-linecap="round"\n          stroke-linejoin="round"/>\n    <!-- Узловые точки маршрута -->\n${circlesData}</svg>`;

        return svg;
    }

    /**
     * Создает хеш строки
     */
    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    /**
     * Пытается получить маршрут через публичный OSRM demo сервер
     */
    async fetchRouteViaOSRM(start, end) {
        try {
            const base = 'https://router.project-osrm.org/route/v1/driving';
            const url = `${base}/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=polyline`;
            const { data } = await axios.get(url, { timeout: 10000 });
            if (data && data.routes && data.routes[0] && data.routes[0].geometry) {
                // OSRM polyline хранит точки как [lon, lat]
                const pts = polyline.decode(data.routes[0].geometry).map(([lon, lat]) => ({ lat, lng: lon }));
                if (pts.length > 2) return pts;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Получить маршрут у OSRM с учётом промежуточных точек (waypoints)
     */
    async fetchRouteViaOSRMWaypoints(coords) {
        try {
            if (!Array.isArray(coords) || coords.length < 2) return null;
            const base = 'https://router.project-osrm.org/route/v1/driving';
            const parts = coords.map(c => `${c.lng},${c.lat}`).join(';');
            const url = `${base}/${parts}?overview=full&geometries=polyline&steps=false&alternatives=false&continue_straight=true`;
            const { data } = await axios.get(url, { timeout: 15000 });
            if (data && data.routes && data.routes[0] && data.routes[0].geometry) {
                // OSRM polyline хранит точки как [lon, lat]
                const pts = polyline.decode(data.routes[0].geometry).map(([lon, lat]) => ({ lat, lng: lon }));
                return pts && pts.length > 2 ? pts : null;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Разворачивает короткие ссылки (maps.app.goo.gl / goo.gl/maps) до финального URL
     */
    async resolveFinalMapsUrl(url) {
        try {
            const u = new URL(url);
            // Не "прозваниваем" Яндекс заранее, чтобы не словить showcaptcha
            if (/yandex\./i.test(u.hostname)) {
                return url;
            }
            // Для коротких/редиректных ссылок Google — безопасно разворачиваем
            const resp = await axios.get(url, { timeout: 12000, maxRedirects: 5, validateStatus: () => true });
            const finalUrl = (resp && resp.request && resp.request.res && resp.request.res.responseUrl) ? resp.request.res.responseUrl : null;
            if (finalUrl && finalUrl.includes('google.com/maps')) return finalUrl;
            return url;
        } catch {
            return url;
        }
    }

    /**
     * Извлекает информацию о маршруте со страницы Google Maps
     */
    async extractRouteInfoFromPage(page) {
        try {
            return await page.evaluate(() => {
                const routeInfo = {
                    waypoints: [],
                    travelMode: 'driving'
                };

                // Ищем waypoints в URL или данных страницы
                const url = window.location.href;
                
                // Парсим URL для извлечения координат
                const matches = url.match(/!1d([\d.-]+)!2d([\d.-]+)/g);
                if (matches && matches.length >= 2) {
                    for (const match of matches) {
                        const coords = match.match(/!1d([\d.-]+)!2d([\d.-]+)/);
                        if (coords) {
                            routeInfo.waypoints.push({
                                lat: parseFloat(coords[2]),
                                lng: parseFloat(coords[1])
                            });
                        }
                    }
                }

                // Альтернативный парсинг из URL
                if (routeInfo.waypoints.length < 2) {
                    const dirMatch = url.match(/\/dir\/([^/]+)\/([^/]+)/);
                    if (dirMatch) {
                        // Попытка извлечь координаты из названий мест
                        const from = dirMatch[1];
                        const to = dirMatch[2];
                        
                        // Если это координаты
                        const fromCoords = from.match(/([\d.-]+),([\d.-]+)/);
                        const toCoords = to.match(/([\d.-]+),([\d.-]+)/);
                        
                        if (fromCoords) {
                            routeInfo.waypoints.push({
                                lat: parseFloat(fromCoords[1]),
                                lng: parseFloat(fromCoords[2])
                            });
                        }
                        if (toCoords) {
                            routeInfo.waypoints.push({
                                lat: parseFloat(toCoords[1]),
                                lng: parseFloat(toCoords[2])
                            });
                        }
                    }
                }

                // Определяем режим передвижения
                if (url.includes('!3e2')) routeInfo.travelMode = 'driving';
                else if (url.includes('!3e1')) routeInfo.travelMode = 'walking';
                else if (url.includes('!3e3')) routeInfo.travelMode = 'transit';
                else if (url.includes('!3e0')) routeInfo.travelMode = 'bicycling';

                return routeInfo;
            });
        } catch (error) {
            console.warn('❌ Ошибка при извлечении информации о маршруте:', error.message);
            return { waypoints: [], travelMode: 'driving' };
        }
    }

    /**
     * Получает детальный маршрут через Google Routes API (новый)
     */
    async getRouteFromGoogleAPI(waypoints, travelMode = 'driving') {
        try {
            if (waypoints.length < 2) return null;

            const apiKey = process.env.GOOGLE_MAPS_API_KEY;
            if (!apiKey) {
                console.log('⚠️  Google Maps API ключ не найден в .env файле');
                return null;
            }

            const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';

            const travelModeMap = {
                driving: 'DRIVE',
                walking: 'WALK',
                bicycling: 'BICYCLE',
                transit: 'TRANSIT'
            };

            const requestBody = {
                origin: { location: { latLng: { latitude: waypoints[0].lat, longitude: waypoints[0].lng } } },
                destination: { location: { latLng: { latitude: waypoints[waypoints.length - 1].lat, longitude: waypoints[waypoints.length - 1].lng } } },
                travelMode: travelModeMap[travelMode] || 'DRIVE',
                polylineEncoding: 'ENCODED_POLYLINE',
            };

            if (waypoints.length > 2) {
                requestBody.intermediates = waypoints.slice(1, -1).map(w => ({
                    location: { latLng: { latitude: w.lat, longitude: w.lng } }
                }));
            }

            console.log('🌐 Запрос к Google Routes API (v2)...');
            const response = await axios.post(url, requestBody, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': apiKey,
                    'X-Goog-FieldMask': 'routes.polyline'
                },
                timeout: 15000
            });

            if (response.data && response.data.routes && response.data.routes.length > 0) {
                const route = response.data.routes[0];
                if (route.polyline && route.polyline.encodedPolyline) {
                    const decoded = polyline.decode(route.polyline.encodedPolyline);
                    const points = decoded.map(p => ({ lat: p[0], lng: p[1] }));
                    
                    console.log(`✅ Google Routes API: получено ${points.length} точек`);
                    return points.length > 2 ? points : null;
                }
            }
            
            if (response.data && response.data.error) {
                console.log(`❌ Google Routes API ошибка: ${response.data.error.message}`);
            } else {
                console.log('❌ Google Routes API не вернул маршрут.');
            }
            
            return null;
        } catch (error) {
            if (error.response && error.response.data && error.response.data.error) {
                 console.log(`❌ Google Routes API недоступен: ${error.response.data.error.message}`);
            } else {
                console.log('❌ Google Routes API недоступен:', error.message);
            }
            return null;
        }
    }

    /**
     * Получает маршрут через OpenRouteService API (бесплатный fallback)
     */
    async getRouteFromOpenRouteService(waypoints, travelMode = 'driving') {
        try {
            if (waypoints.length < 2) return null;

            const apiKey = process.env.OPENROUTESERVICE_API_KEY;
            if (!apiKey) {
                console.log('⚠️  OpenRouteService API ключ не найден в .env файле');
                return null;
            }

            const profile = travelMode === 'walking' ? 'foot-walking' : 
                          travelMode === 'bicycling' ? 'cycling-regular' : 'driving-car';

            const coordinates = waypoints.map(w => [w.lng, w.lat]);
            
            const url = `https://api.openrouteservice.org/v2/directions/${profile}`;
            const requestData = {
                coordinates: coordinates,
                format: 'json',
                geometry_format: 'polyline'
            };

            console.log('🌐 Запрос к OpenRouteService API...');
            const response = await axios.post(url, requestData, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': apiKey
                },
                timeout: 15000
            });

            if (response.data && response.data.routes && response.data.routes.length > 0) {
                const route = response.data.routes[0];
                if (route.geometry) {
                    const decoded = polyline.decode(route.geometry);
                    const points = decoded.map(p => ({ lat: p[0], lng: p[1] }));
                    console.log(`✅ OpenRouteService: получено ${points.length} точек`);
                    return points.length > 10 ? points : null;
                }
            }

            return null;
        } catch (error) {
            if (error.response && error.response.data) {
                console.log('❌ OpenRouteService API ошибка:', error.response.data);
            } else {
                console.log('❌ OpenRouteService API недоступен:', error.message);
            }
            return null;
        }
    }

    /**
     * Основная функция генерации SVG
     */
    async generateMapSVG(mapsUrl) {
        try {
            console.log('🗺️  Начинаем генерацию SVG карты...');
            
            // Проверяем тип URL и обрабатываем соответственно
            if (mapsUrl.includes('project-osrm.org')) {
                console.log('🚗 Используем OSRM API...');
                const waypoints = this.extractWaypointsFromOSRMUrl(mapsUrl);
                const route = await this.getRouteFromOSRM(waypoints, 'driving');
                
                if (!route || route.length < 2) {
                    throw new Error('Не удалось получить маршрут от OSRM');
                }
                
                // Генерируем SVG
                const svgData = this.convertToSVGCoordinates(route);
                const svgContent = this.generateSVG(svgData, route);
                
                // Сохраняем SVG
                const outputPath = path.join(this.resultDir, 'map.svg');
                fs.writeFileSync(outputPath, svgContent, 'utf8');
                console.log(`✅ SVG карта успешно сохранена: ${outputPath}`);
                console.log(`📁 Размер файла: ${(svgContent.length / 1024).toFixed(2)} KB`);
                console.log('✅ SVG карта успешно сгенерирована!');
                return svgContent;
            }
            
            // Для других карт используем существующую логику
            const resolvedUrl = await this.resolveFinalMapsUrl(mapsUrl);
            console.log('📍 Финальный URL:', resolvedUrl);

            let route = null;
            const isYandex = /yandex\./i.test(resolvedUrl);
            const apiKey = process.env.GOOGLE_MAPS_API_KEY;

            // Сначала всегда пытаемся получить маршрут бесплатным методом через Puppeteer
            console.log('🌐 Используем метод перехвата данных из браузера...');
            route = await this.extractRouteFromBrowser(resolvedUrl);

            if (isYandex) {
                // Для Яндекс Карт — используем только перехват. Без OSRM/ORS/Google API фолбэков.
                if (!route || route.length < 2) {
                    console.log('\n🚨 Маршрут Яндекс не найден!');
                    throw new Error('Не удалось получить данные маршрута из Яндекс Карт.');
                }
            } else {
                // Google flow: Если бесплатный метод не сработал, и есть API ключ, пробуем платный метод
                if ((!route || route.length < 10) && apiKey) {
                    console.log('⚠️ Перехват не дал результата. Пробуем Google Routes API...');
                    let waypoints = await this.extractWaypointsFromUrl(resolvedUrl);
                    let travelMode = 'driving';

                    if (waypoints.length < 2) {
                        console.log('🌐 URL не содержит точек, запускаем браузер для анализа страницы...');
                        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                        try {
                            const page = await browser.newPage();
                            await page.goto(resolvedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                            const routeInfo = await this.extractRouteInfoFromPage(page);
                            waypoints = routeInfo.waypoints;
                            travelMode = routeInfo.travelMode;
                        } finally {
                            await browser.close();
                        }
                    }

                    if (waypoints.length >= 2) {
                        route = await this.getRouteFromGoogleAPI(waypoints, travelMode);
                    }
                }
                
                // Финальный fallback через OpenRouteService, если он настроен (только для Google URL)
                if (!route || route.length < 10) {
                    console.log('⚠️ Предыдущие методы не дали результата. Пробуем OpenRouteService API...');
                    const orsApiKey = process.env.OPENROUTESERVICE_API_KEY;
                    if (orsApiKey) {
                        let waypoints = await this.extractWaypointsFromUrl(resolvedUrl);
                        if (waypoints.length >= 2) {
                            route = await this.getRouteFromOpenRouteService(waypoints);
                        }
                    } else {
                        console.log('⚠️ Ключ для OpenRouteService API не найден.');
                    }
                }
            }

            if (!route || route.length < 2) {
                console.log('\n🚨 Маршрут не найден ни одним из доступных методов!');
                console.log('💡 Для повышения надежности можно настроить API ключи в файле .env');
                throw new Error('Не удалось получить данные маршрута.');
            }

            console.log(`✅ Получен итоговый маршрут с ${route.length} точками`);
            console.log(`   От: ${route[0].lat.toFixed(6)}, ${route[0].lng.toFixed(6)}`);
            console.log(`   До: ${route[route.length - 1].lat.toFixed(6)}, ${route[route.length - 1].lng.toFixed(6)}`);

            console.log('📐 Конвертируем координаты (Web Mercator)...');
            const svgData = this.convertToSVGCoordinates(route);

            console.log('🎨 Генерируем SVG полилинию...');
            const svgContent = this.generateSVG(svgData, route);

            const outputPath = path.join(this.resultDir, 'map.svg');
            fs.writeFileSync(outputPath, svgContent, 'utf8');
            console.log(`✅ SVG карта успешно сохранена: ${outputPath}`);
            console.log(`📁 Размер файла: ${(svgContent.length / 1024).toFixed(2)} KB`);

        } catch (error) {
            console.error('❌ Ошибка при генерации SVG карты:', error.message);
            throw error;
        }
    }

    /**
     * Создает маршрут для Google Maps Directions v1 URL
     */
    buildDirectionsV1Url(waypoints, travelMode = 'driving', opts = {}) {
        if (!Array.isArray(waypoints) || waypoints.length < 2) return null;
        const origin = `${waypoints[0].lat},${waypoints[0].lng}`;
        const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;
        const wps = waypoints.slice(1, -1).map(w => `${w.lat},${w.lng}`).join('|');
        const params = new URLSearchParams();
        params.set('api', '1');
        params.set('origin', origin);
        params.set('destination', destination);
        if (wps) params.set('waypoints', wps);
        params.set('travelmode', (travelMode || 'driving'));
        if (opts.hl) params.set('hl', opts.hl);
        return `https://www.google.com/maps/dir/?${params.toString()}`;
    }

    /**
     * Парсит режим передвижения из URL Google Maps
     */
    parseTravelModeFromUrl(url) {
        try {
            const u = decodeURIComponent(String(url || ''));
            if (u.includes('!3e2')) return 'driving';
            if (u.includes('!3e1')) return 'walking';
            if (u.includes('!3e3')) return 'transit';
            if (u.includes('!3e0')) return 'bicycling';
            const sp = new URL(url);
            const tm = sp.searchParams.get('travelmode');
            if (tm && ['driving','walking','bicycling','transit'].includes(tm)) return tm;
        } catch {}
        return 'driving';
    }

    // Haversine distance in meters
    haversine(a, b) {
        if (!a || !b) return Number.POSITIVE_INFINITY;
        const R = 6371000;
        const toRad = (x) => x * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLon = toRad(b.lng - a.lng);
        const lat1 = toRad(a.lat);
        const lat2 = toRad(b.lat);
        const sinDLat = Math.sin(dLat / 2);
        const sinDLon = Math.sin(dLon / 2);
        const c = 2 * Math.asin(Math.sqrt(sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon));
        return R * c;
    }

    /**
     * Извлекает только точки маршрута (waypoints) из URL Яндекс Карт.
     * Исключает координаты из @center.
     */
    extractWaypointsFromOSRMUrl(url) {
        const waypoints = [];
        
        // OSRM URL имеет формат: ?loc=lat,lon&loc=lat,lon
        // Поддерживаем как закодированные (%2C), так и обычные запятые
        const matches = url.matchAll(/[?&]loc=([0-9.-]+)(?:%2C|,)([0-9.-]+)/g);
        
        for (const match of matches) {
            const lat = parseFloat(match[1]);
            const lon = parseFloat(match[2]);
            if (!isNaN(lat) && !isNaN(lon)) {
                waypoints.push([lat, lon]);
            }
        }
        
        console.log(`🎯 Извлечено ${waypoints.length} точек из OSRM URL`);
        return waypoints;
    }

    async getRouteFromOSRM(waypoints, profile = 'driving') {
        if (!waypoints || waypoints.length < 2) {
            throw new Error('Недостаточно точек для построения маршрута');
        }

        // Формируем URL для OSRM API
        const coordinates = waypoints.map(wp => `${wp[1]},${wp[0]}`).join(';');
        const osrmUrl = `https://router.project-osrm.org/route/v1/${profile}/${coordinates}?overview=full&geometries=geojson`;
        
        console.log(`📡 Запрос к OSRM API: ${osrmUrl}`);
        
        try {
            const response = await axios.get(osrmUrl);
            
            if (response.data.code !== 'Ok') {
                throw new Error(`OSRM API ошибка: ${response.data.message || response.data.code}`);
            }
            
            const route = response.data.routes[0];
            if (!route || !route.geometry || !route.geometry.coordinates) {
                throw new Error('OSRM не вернул геометрию маршрута');
            }
            
            // OSRM возвращает координаты в формате [lon, lat], нам нужно [lat, lon]
            const routePoints = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);
            
            console.log(`✅ Получен маршрут от OSRM: ${routePoints.length} точек`);
            console.log(`📏 Расстояние: ${(route.distance / 1000).toFixed(1)} км`);
            console.log(`⏱️ Время: ${Math.round(route.duration / 60)} мин`);
            
            return routePoints;
            
        } catch (error) {
            if (error.response) {
                console.error(`❌ OSRM API ошибка: ${error.response.status} - ${error.response.statusText}`);
                if (error.response.data && error.response.data.message) {
                    console.error(`💬 Сообщение: ${error.response.data.message}`);
                }
            } else {
                console.error(`❌ Ошибка запроса к OSRM: ${error.message}`);
            }
            throw error;
        }
    }

    extractWaypointsFromYandexUrl(url) {
        try {
            const u = new URL(url);
            const rtext = u.searchParams.get('rtext');
            if (!rtext) return [];
            // rtext like: lat,lon~lat,lon~...
            return rtext.split('~')
                .map(p => p.trim())
                .map(p => p.split(',').map(Number))
                .filter(a => a.length === 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]))
                .map(([lat, lon]) => ({ lat, lng: lon }))
                .filter(p => p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180);
        } catch { return []; }
    }

    parseRouteFromYandexResponse(data, opts = {}) {
        const { expectedStart = null, expectedEnd = null } = opts;
        const candidates = [];

        const pushCandidate = (coords) => {
            if (!Array.isArray(coords) || coords.length < 2) return;
            const pts = coords
                .filter(a => Array.isArray(a) && a.length >= 2 && isFinite(a[0]) && isFinite(a[1]))
                .map(([lon, lat]) => ({ lat, lng: lon }))
                .filter(p => p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180);
            if (pts.length > 2) candidates.push(pts);
        };

        const scan = (obj) => {
            if (obj == null) return;
            if (typeof obj === 'string') {
                const t = obj.trim();
                if ((t.startsWith('{') || t.startsWith('[')) && t.length > 2) {
                    try { scan(JSON.parse(t)); } catch {}
                }
                // Проверяем на похожие на координаты строки в Яндексе
                if (/^\d+\.\d+,\d+\.\d+/.test(t)) {
                    try {
                        const coords = t.split(/[,;\s]+/).map(Number);
                        for (let i = 0; i < coords.length - 1; i += 2) {
                            if (isFinite(coords[i]) && isFinite(coords[i + 1])) {
                                // Яндекс часто использует lat,lng порядок
                                const lat = coords[i], lng = coords[i + 1];
                                if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                                    candidates.push([{ lat, lng }]);
                                }
                            }
                        }
                    } catch {}
                }
                return;
            }
            if (Array.isArray(obj)) {
                // Detect array of [lon,lat] pairs
                let looksLikeLine = obj.length >= 2 && obj.every(el => Array.isArray(el) && el.length >= 2 && isFinite(el[0]) && isFinite(el[1]));
                if (looksLikeLine) {
                    pushCandidate(obj);
                } else {
                    for (const v of obj) scan(v);
                }
                return;
            }
            if (typeof obj === 'object') {
                // Common GeoJSON-like
                if (obj.type === 'LineString' && Array.isArray(obj.coordinates)) pushCandidate(obj.coordinates);
                if (obj.type === 'MultiLineString' && Array.isArray(obj.coordinates)) {
                    for (const line of obj.coordinates) pushCandidate(line);
                }
                if (obj.geometry) scan(obj.geometry);
                if (Array.isArray(obj.features)) for (const f of obj.features) scan(f);
                if (Array.isArray(obj.segments)) for (const s of obj.segments) scan(s);
                if (Array.isArray(obj.paths)) for (const p of obj.paths) scan(p);
                if (Array.isArray(obj.route)) scan(obj.route);
                if (Array.isArray(obj.polyline)) scan(obj.polyline);
                if (Array.isArray(obj.coordinates)) scan(obj.coordinates);
                // Яндекс-специфичные поля
                if (Array.isArray(obj.points)) scan(obj.points);
                if (Array.isArray(obj.legs)) for (const leg of obj.legs) scan(leg);
                if (Array.isArray(obj.steps)) for (const step of obj.steps) scan(step);
                if (obj.encoded_polyline && typeof obj.encoded_polyline === 'string') {
                    // Иногда Яндекс использует encoded polyline как Google
                    try {
                        const decoded = require('@mapbox/polyline').decode(obj.encoded_polyline);
                        if (decoded && decoded.length > 2) {
                            pushCandidate(decoded.map(([lat, lng]) => [lng, lat])); // swap to [lon,lat]
                        }
                    } catch {}
                }
                for (const k in obj) scan(obj[k]);
                return;
            }
        };

        scan(data);
        if (candidates.length === 0) return null;

        const choose = () => {
            if (!expectedStart || !expectedEnd) {
                return candidates.sort((a, b) => b.length - a.length)[0];
            }
            let best = null;
            let bestCost = Infinity;
            for (const pts of candidates) {
                const a = pts[0];
                const b = pts[pts.length - 1];
                const dir = this.haversine(a, expectedStart) + this.haversine(b, expectedEnd);
                const rev = this.haversine(a, expectedEnd) + this.haversine(b, expectedStart);
                const cost = Math.min(dir, rev) - Math.min(pts.length, 999)/1000; // легкий бонус за длину
                if (cost < bestCost) { best = { pts, dir, rev }; bestCost = cost; }
            }
            if (!best) return candidates[0];
            const out = best.pts.slice();
            if (best.rev < best.dir) out.reverse();
            return out;
        };

        return choose();
    }
}

module.exports = AdvancedMapSVGGenerator;
