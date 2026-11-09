const axios = require('axios');

const WORLD = 'nubes';
const CHECK_INTERVAL = 5 * 60 * 1000; // co 3 minuty
const TS_THRESHOLD = 10 * 60 * 1000;  // 30 minut
const ALERT_DELAY = 10 * 1000;        // 10s między alertami

const MAP_CONFIG = [
    { name: "Sala Tronowa",                              monster: "Tanroth",            mapId: "p2758" },
    { name: "Sala Zrujnowanej Świątyni",                 monster: "Barbatos Smoczy Strażnik",           mapId: "p238"  },
    { name: "Teotihuacan",                               monster: "Tezcatlipoca",       mapId: "n166"  },
    { name: "Nora Jaszczurzych Koszmarów - źródło",      monster: "Maddok Magua",       mapId: "s85"   },
    { name: "Komnata Krwawych Obrzędów",                 monster: "Przyzywacz Demonów", mapId: "p157"  },
    { name: "Źródło Wspomnień",                          monster: "Łowczyni Wspomnień", mapId: "p211"  },
    { name: "Lokum Złych Goblinów - pracownia",          monster: "Versus Zoons",       mapId: "p182"  },
    { name: "Wulkan Politraki - Piekielne Czeluście",    monster: "Piekielny Arcymag",  mapId: "p251"  },
    { name: "Bandyckie Chowisko - skarbiec",             monster: "Renegat Baulus",     mapId: "p172"  },
];

async function fetchTimers() {
    try {
        const res = await axios.get(`https://api.lootlog.pl/timers?world=${WORLD}`, {
            headers: { Cookie: process.env.LOOTLOG_COOKIE },
            timeout: 8000
        });
        return res.data || [];
    } catch (e) {
        console.error('[LOOTLOG] Błąd pobierania timerów:', e.message);
        return [];
    }
}

function formatMinutes(ms) {
    const totalMinutes = Math.floor(ms / 60000);
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function sendQueue(alerts, broadcast) {
    alerts.forEach((alert, i) => {
        setTimeout(() => {
            console.log(`[LOOTLOG] Wysyłam alert: ${alert.monster}`);
            broadcast({
                type: 'global_alert',
                data: {
                    text: alert.text,
                    sender: 'System',
                    monster: alert.monster,
                    ts: Date.now()
                }
            });
        }, i * ALERT_DELAY);
    });
}

async function check(broadcast, db, activeCells) {
    console.log('[LOOTLOG] Sprawdzam timery...');
    const timers = await fetchTimers();
    const now = Date.now();
    const alertsToSend = [];

    for (const map of MAP_CONFIG) {
        const timer = timers.find(t =>
            t.npc?.name?.toLowerCase() === map.monster.toLowerCase()
        );

        // Sprawdzamy czy potwór respuje lub nie ma wpisu
        let isRespawning = false;
        if (!timer) {
            isRespawning = true;
        } else {
            const minSpawn = new Date(timer.minSpawnTime).getTime();
            if (now >= minSpawn) isRespawning = true;
        }

        if (!isRespawning) continue;

        // Szukamy ostatniej wizyty - najpierw w activeCells (RAM)
        const id1 = `${map.mapId}_1`;
        const id2 = `${map.mapId}_2`;
        let lastVisit = 0;

        if (activeCells.has(id1) && activeCells.get(id1).ts > lastVisit) lastVisit = activeCells.get(id1).ts;
        if (activeCells.has(id2) && activeCells.get(id2).ts > lastVisit) lastVisit = activeCells.get(id2).ts;

        if (lastVisit === 0) {
            try {
                const snap = await db.ref('cells').once('value');
                const data = snap.val() || {};
                if (data[id1]?.ts > lastVisit) lastVisit = data[id1].ts;
                if (data[id2]?.ts > lastVisit) lastVisit = data[id2].ts;
            } catch (e) {
                console.error('[LOOTLOG] Błąd odczytu bazy:', e.message);
            }
        }

        const noBodyRecently = lastVisit === 0 || (now - lastVisit) > TS_THRESHOLD;

        if (noBodyRecently) {
            const sinceText = lastVisit === 0
                ? 'od (brak danych)'
                : `od ${formatMinutes(now - lastVisit)}`;

            // alertsToSend.push({
            //     monster: map.monster,
            //     text: `Sprawdź <b style="color:#e74c3c">${map.monster}</b>, nie było nikogo <b style="color:#e74c3c">${sinceText}</b>`
            // });
        }
    }

    if (alertsToSend.length > 0) {
        console.log(`[LOOTLOG] Znaleziono ${alertsToSend.length} alertów, wysyłam co 10s...`);
        sendQueue(alertsToSend, broadcast);
    } else {
        console.log('[LOOTLOG] Brak alertów.');
    }
}

module.exports = function startWatcher(broadcast, db, activeCells) {
    setTimeout(() => {
        check(broadcast, db, activeCells);
        setInterval(() => check(broadcast, db, activeCells), CHECK_INTERVAL);
    }, 60 * 1000);

    console.log('[LOOTLOG] Watcher uruchomiony, pierwsze sprawdzenie za 1 minutę.');
};