require('dotenv').config();
const groupManager = require('./group-manager');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '5kb' }));

const PORT = process.env.PORT || 3000;
const GUILD_ID = process.env.GUILD_ID;
const ROLE_ID = process.env.ROLE_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const discordQueue = [];
let isProcessingQueue = false;
const inFlightRequests = new Map();
const MAX_QUEUE_SIZE = 30;

const firebaseConfig = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
};

admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

// activeCells trackuje tylko lastSeen - żeby wiedzieć kiedy usunąć val
// val i ts zawsze w bazie - źródło prawdy
const activeCells = new Map();     // cellId -> { lastSeen, ts }
const failedAttempts = new Map();
const bannedIPs = new Map();
const discordCache = new Map();
const ipLastQuery = new Map();
const ipConnCount = new Map();

const isValidId = (id) => /^[a-zA-Z0-9_-]{1,25}$/.test(id);
const MAX_CONN_PER_IP = 5;
const IP_QUERY_COOLDOWN = 2000;
const BAN_DURATION = 30 * 60 * 1000;
const BAN_THRESHOLD = 5;
const DB_WRITE_INTERVAL = 45 * 1000;
const loggedUsers = new Set();
const VALID_TOKEN = process.env.SECRET_TOKEN || "zaq1";

app.get('/au', (req, res) => {
    const token = req.query.token;

    if (!token || token !== VALID_TOKEN) {
        return res.status(403).json({ error: 'Brak dostępu.' });
    }

    fs.readFile('au.js', 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Błąd pliku.' });
        
        res.setHeader('Content-Type', 'application/javascript');
        res.send(data);
    });
});

app.post('/api/log', (req, res) => {
    const nick = req.body.nick;
    if (!nick) return res.status(400).send('Brak nicku');

    if (!loggedUsers.has(nick)) {
        loggedUsers.add(nick);
        console.log(`NOWY_NICK: ${nick}`); 
    }

    res.send('OK');
});

// Przywraca activeCells z bazy po restarcie
// lastSeen jest cofane o elapsed żeby cleanup poprawnie ocenił czy usunąć
async function restoreActiveCells() {
    try {
        console.log("⏳ Pobieranie danych z Firebase...");
        const snap = await db.ref('cells').once('value');
        const data = snap.val() || {};
        const now = Date.now();
        for (const [id, cell] of Object.entries(data)) {
            if (cell.val && cell.val !== "") {
                const elapsed = now - cell.ts;
                activeCells.set(id, {
                    lastSeen: now - elapsed,
                    ts: cell.ts,
                    lastDbWrite: now
                });
            }
        }
        console.log(`✅ Przywrócono ${activeCells.size} komórek.`);
    } catch (e) {
        console.error('Błąd przywracania danych:', e);
    }
}

async function getDiscordData(accessToken, ip) {
    const cached = discordCache.get(accessToken);
    if (cached && Date.now() - cached.time < 180 * 60 * 1000) return cached.data;

    if (inFlightRequests.has(accessToken)) {
        return inFlightRequests.get(accessToken);
    }

    const lastQuery = ipLastQuery.get(ip) || 0;
    if (Date.now() - lastQuery < IP_QUERY_COOLDOWN) {
        return { hasRole: false, status: 'rate_limited_locally' };
    }
    ipLastQuery.set(ip, Date.now());

    if (discordQueue.length >= MAX_QUEUE_SIZE) {
        console.warn("[QUEUE] Kolejka pełna - odrzucanie zapytania.");
        return { hasRole: false, status: 'queue_full' };
    }

    const promise = new Promise((resolve) => {
        discordQueue.push({ accessToken, resolve });
        processDiscordQueue();
    });

    inFlightRequests.set(accessToken, promise);
    try {
        return await promise;
    } finally {
        inFlightRequests.delete(accessToken);
    }
}

async function processDiscordQueue() {
    if (isProcessingQueue || discordQueue.length === 0) return;
    isProcessingQueue = true;

    while (discordQueue.length > 0) {
        const { accessToken, resolve } = discordQueue.shift();

        try {
            console.log("Strzał do Discord ..");
            const userRes = await axios.get('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 4000
            });
            const userData = userRes.data;

            const res = await axios.get(`https://discord.com/api/guilds/${GUILD_ID}/members/${userData.id}`, {
                headers: { Authorization: `Bot ${BOT_TOKEN}` },
                timeout: 4000
            });

            const result = {
                hasRole: res.data.roles.includes(ROLE_ID),
                username: userData.username,
                id: userData.id
            };
            
            discordCache.set(accessToken, { data: result, time: Date.now() });
            resolve(result);
        } catch (e) {
            if (e.response?.status === 429) {
                console.error("[DISCORD 429] Global Rate Limit osiągnięty!");
                resolve({ hasRole: false, username: "Unknown", status: 'rate_limited_global' });
            } else {
                console.error("[DISCORD ERROR]", e.response?.data || e.message);
                resolve({ hasRole: false, username: "Unknown", status: 'invalid_token' });
            }
        }

        await new Promise(r => setTimeout(r, 333));
    }

    isProcessingQueue = false;
}

function broadcast(data, excludeWs = null) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client !== excludeWs) {
            client.send(msg);
        }
    });
}

async function handleIncomingMessage(ws, message) {
    let parsed;
    try { parsed = JSON.parse(message); } catch { return; }

    const { type, id, val, nick, data } = parsed;
    if (id && !isValidId(id.replace(/_/g, ''))) return;

    const now = Date.now();

    if (type === 'update_cell') {
        if (!id || typeof val !== 'string') return;
        const safeVal = val.slice(0, 32);

        activeCells.set(id, { lastSeen: now, ts: now, lastDbWrite: now });
        await db.ref(`cells/${id}`).update({ val: safeVal, ts: now }).catch(() => {});

        const pkg = { type: 'cell_updated', id, val: safeVal, ts: now };
        broadcast(pkg);
        ws.send(JSON.stringify(pkg));

    } else if (type === 'heartbeat') {
        if (!id) return;
        const safeNick = nick ? String(nick).slice(0, 32) : "";
        let cell = activeCells.get(id);

        if (cell) {
            cell.lastSeen = now;
            cell.ts = now;

            // Zapis do bazy co 45s - żeby ts przeżyło restart
            if (now - (cell.lastDbWrite || 0) > DB_WRITE_INTERVAL) {
                cell.lastDbWrite = now;
                db.ref(`cells/${id}`).update({ val: safeNick, ts: now }).catch(() => {});
            }
        } else {
            // Nie ma w RAM - gracz reconnectował po restarcie
            cell = { lastSeen: now, ts: now, lastDbWrite: now };
            activeCells.set(id, cell);
            db.ref(`cells/${id}`).update({ val: safeNick, ts: now }).catch(() => {});
        }

        // Broadcast do wszystkich - gracz stoi, ts = now, timer = 00:00
        broadcast({ type: 'cell_updated', id, val: safeNick, ts: now });

    } else if (type === 'send_alert') {
        if (!data || typeof data.text !== 'string') return;
        broadcast({ type: 'global_alert', data: { ...data, text: data.text.slice(0, 300) } });
    }
}

const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    maxPayload: 5120,
    verifyClient: (info, callback) => {
        const ip = info.req.headers['x-forwarded-for']?.split(',')[0] || info.req.socket.remoteAddress;
        const origin = info.origin || info.req.headers.origin;

        if (bannedIPs.has(ip) && Date.now() < bannedIPs.get(ip)) {
            console.warn(`[BAN] Zablokowane połączenie z IP: ${ip}`);
            return callback(false, 403, 'Banned');
        } else {
            bannedIPs.delete(ip);
        }

        if ((ipConnCount.get(ip) || 0) >= MAX_CONN_PER_IP) {
            console.warn(`[LIMIT] Za dużo połączeń z IP: ${ip}`);
            return callback(false, 429, 'Too Many Connections');
        }

        if (!origin || (!origin.includes('margonem.pl') && !origin.includes('margonem.vercel.app') && !origin.includes('localhost'))) {
            console.log('Unauthorized Origi: ' + origin);
            return callback(false, 401, 'Unauthorized Origin');
        }

        callback(true);
    }
});

wss.on('connection', async (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const token = urlParams.get('token');

    ipConnCount.set(ip, (ipConnCount.get(ip) || 0) + 1);
    ws.isAuthenticated = false;

    ws.on('close', () => {
        const count = ipConnCount.get(ip) || 1;
        if (count <= 1) ipConnCount.delete(ip);
        else ipConnCount.set(ip, count - 1);
    });

    if (!token || token === 'null' || token === 'undefined') {
        return ws.terminate();
    }

    try {
        const auth = await getDiscordData(token, ip);

        if (!auth || !auth.hasRole) {
            if (auth?.status === 'rate_limited_locally') {
                return ws.terminate();
            }

            const attempts = (failedAttempts.get(ip) || 0) + 1;
            failedAttempts.set(ip, attempts);
            console.warn(`[BLOKADA] ${auth?.username || 'Unknown'} (IP: ${ip}) - Brak roli. Próba ${attempts}/${BAN_THRESHOLD}`);

            if (attempts >= BAN_THRESHOLD) {
                bannedIPs.set(ip, Date.now() + BAN_DURATION);
                console.warn(`[BAN] IP: ${ip} zbanowany na 30 minut`);
            }

            ws.send(JSON.stringify({ type: 'auth_error' }));
            return ws.terminate();
        }

        failedAttempts.delete(ip);
        ws.isAuthenticated = true;
        ws.username = auth.username;
        console.log(`[AUTH] Akceptacja: ${auth.username} (${ip})`);

        // init_data zawsze z bazy - źródło prawdy, zawiera ts nawet dla pustych slotów
        const snapshot = await db.ref('cells').once('value');
        ws.send(JSON.stringify({ type: 'init_data', data: snapshot.val() || {} }));
        groupManager.sendActiveGroupsToClient(ws);
        ws.on('message', (msg) => handleIncomingMessage(ws, msg));

    } catch (err) {
        console.error("Błąd handshaka:", err);
        ws.terminate();
    }
});

// Cleanup: po 3 minutach bezczynności usuwa val ale zostawia ts w bazie
// Dzięki temu timer odlicza dalej od ostatniej wizyty
setInterval(async () => {
    const now = Date.now();
    const threshold = 3 * 60 * 1000;
    const updates = {};
    const toDelete = [];
    
    activeCells.forEach((data, cellId) => {
        if (now - data.lastSeen > threshold) {
            updates[`cells/${cellId}/val`] = "";
    
            toDelete.push({ cellId, ts: data.ts }); // Zachowujemy oryginalny ts z RAM
        }
    });



    if (toDelete.length > 0) {

        await db.ref().update(updates).catch(() => {});
        
        toDelete.forEach(({ cellId, ts }) => {
            
            broadcast({ type: 'cell_updated', id: cellId, val: "", ts }); // Wysyłamy pierwotny czas
            
            activeCells.delete(cellId);
        });
    
    }

}, 5000); 



// Co godzinę czyści stare cache
setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of discordCache) {
        if (now - entry.time > 180 * 60 * 1000) discordCache.delete(token);
    }
    for (const [ip, time] of ipLastQuery) {
        if (now - time > 60 * 60 * 1000) ipLastQuery.delete(ip);
    }
    for (const [ip, time] of bannedIPs) {
        if (now > time) bannedIPs.delete(ip);
    }
}, 60 * 60 * 1000);

require('./lootlog-watcher')(broadcast, db, activeCells);

groupManager(wss, broadcast);

restoreActiveCells().then(() => {
    server.listen(PORT, () => console.log(`🚀 Server LIVE on port ${PORT}`));
});