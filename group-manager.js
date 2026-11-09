const GROUP_MAX = 10;
const GROUP_TIMEOUT = 20 * 60 * 1000; // 20 minut

const activeGroups = new Map();

function broadcastGroupUpdate(broadcast, monster) {
    const group = activeGroups.get(monster);
    if (!group) {
        broadcast({ type: 'group_update', monster, active: false });
        return;
    }
    broadcast({
        type: 'group_update',
        monster,
        active: true,
        count: group.members.size,
        max: GROUP_MAX,
        organizer: group.organizer
    });
}

function sendMembersToAll(wss, monster) {
    const group = activeGroups.get(monster);
    if (!group) return;
    const membersList = Array.from(group.members);

    wss.clients.forEach(client => {
        if (client.readyState !== 1 || !client.isAuthenticated) return;
        client.send(JSON.stringify({
            type: 'group_members',
            monster,
            members: membersList,
            isOrganizer: client === group.organizerWs
        }));
    });
}

function closeGroup(monster, broadcast, wss, reason = 'closed') {
    const group = activeGroups.get(monster);
    if (!group) return;
    clearTimeout(group.timer);
    activeGroups.delete(monster);
    console.log(`[GROUP] Zbiórka na ${monster} zamknięta (${reason})`);
    broadcastGroupUpdate(broadcast, monster);
}

function handleGroupMessage(ws, parsed, broadcast, wss) {
    const { type, monster } = parsed;
    if (!monster || typeof monster !== 'string' || monster.length > 50) return;

    const username = parsed.nick ? String(parsed.nick).slice(0, 32) : ws.username;

    if (type === 'group_create') {
        if (activeGroups.has(monster)) {
            ws.send(JSON.stringify({ type: 'group_error', monster, reason: 'already_exists' }));
            return;
        }

        const members = new Set();
        members.add(username); // Organizator automatycznie dołącza

        const timer = setTimeout(() => {
            closeGroup(monster, broadcast, wss, 'timeout');
        }, GROUP_TIMEOUT);

        activeGroups.set(monster, {
            organizer: username,
            organizerWs: ws, // zapamiętujemy socket organizatora
            members,
            timer,
            createdAt: Date.now()
        });

        console.log(`[GROUP] ${username} otworzył zbiórkę na ${monster}`);

        broadcastGroupUpdate(broadcast, monster);
        sendMembersToAll(wss, monster);

        // broadcast({
        //     type: 'global_alert',
        //     data: {
        //         text: `<b style="color:white">${username}</b> zbiera grupę na <b style="color:#e74c3c">${monster}</b>! Kliknij "Idę!" przy ikonie tytana.`,
        //         sender: 'System',
        //         monster,
        //         ts: Date.now()
        //     }
        // });

    } else if (type === 'group_join') {
        const group = activeGroups.get(monster);
        if (!group) {
            ws.send(JSON.stringify({ type: 'group_error', monster, reason: 'not_found' }));
            return;
        }

        if (group.members.has(username)) {
            // Gracz już jest - wycofuje się (ale nie organizator)
            if (username === group.organizer) return;
            group.members.delete(username);
            console.log(`[GROUP] ${username} wycofał się ze zbiórki na ${monster}`);
        } else {
            if (group.members.size >= GROUP_MAX) {
                ws.send(JSON.stringify({ type: 'group_error', monster, reason: 'full' }));
                return;
            }
            group.members.add(username);
            console.log(`[GROUP] ${username} dołączył do zbiórki na ${monster}`);
        }

        broadcastGroupUpdate(broadcast, monster);
        sendMembersToAll(wss, monster);

    } else if (type === 'group_close') {
        const group = activeGroups.get(monster);
        if (!group) return;
        if (group.organizer !== username) return;
        closeGroup(monster, broadcast, wss, 'manual');

    } else if (type === 'group_start') {
        const group = activeGroups.get(monster);
        if (!group) return;
        if (group.organizer !== username) return;

        broadcast({
            type: 'global_alert',
            data: {
                text: `<b style="color:#2ecc71">WCHODZIMY na ${monster}!</b> Grupa: <b>${Array.from(group.members).join(', ')}</b>`,
                sender: username,
                monster,
                ts: Date.now()
            }
        });

        closeGroup(monster, broadcast, wss, 'started');
    }
}

module.exports = function startGroupManager(wss, broadcast) {
    wss.on('connection', (ws) => {
        ws.on('message', (message) => {
            if (!ws.isAuthenticated) return;
            let parsed;
            try { parsed = JSON.parse(message); } catch { return; }

            const groupTypes = ['group_create', 'group_join', 'group_close', 'group_start'];
            if (groupTypes.includes(parsed.type)) {
                handleGroupMessage(ws, parsed, broadcast, wss);
            }
        });

        ws.on('close', () => {
            // Usuń gracza ze zbiórek gdy się rozłączy
            for (const [monster, group] of activeGroups) {
                if (group.members.has(ws.username)) {
                    group.members.delete(ws.username);
                    broadcastGroupUpdate(broadcast, monster);
                    sendMembersToAll(wss, monster);
                }
                // Jeśli organizator się rozłączył - zamknij zbiórkę
                if (group.organizerWs === ws) {
                    closeGroup(monster, broadcast, wss, 'organizer_left');
                }
            }
        });
    });

    console.log('[GROUP] Group manager uruchomiony.');
};

module.exports.sendActiveGroupsToClient = function(ws) {
    for (const [monster, group] of activeGroups) {
        ws.send(JSON.stringify({
            type: 'group_update',
            monster,
            active: true,
            count: group.members.size,
            max: GROUP_MAX,
            organizer: group.organizer
        }));
        // Wyślij też members żeby wiedział czy jest w grupie
        ws.send(JSON.stringify({
            type: 'group_members',
            monster,
            members: Array.from(group.members),
            isOrganizer: false // nowy klient nie jest organizatorem
        }));
    }
};