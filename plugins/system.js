const { cmd } = require('../lib/handler');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ⚡ Startup එකේදීම Image එක RAM එකට Load කර තබා ගැනීම (Zero Disk I/O Delay)
let cachedLogo = null;
const possiblePaths = [
    path.join(__dirname, '../Logo.png'),
    path.join(__dirname, '../logo.png'),
    path.join(__dirname, '../assets/Logo.png'),
    path.join(__dirname, '../assets/logo.png'),
    path.join(__dirname, '../Logo.jpg'),
    path.join(__dirname, '../logo.jpg')
];

for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
        try {
            cachedLogo = fs.readFileSync(p);
            console.log(`[SYSTEM CMD] Logo loaded into memory from: ${path.basename(p)}`);
            break;
        } catch (e) {}
    }
}

// Uptime calculation helper
function formatUptime(seconds) {
    seconds = Number(seconds);
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d > 0 ? d + 'd ' : ''}${h > 0 ? h + 'h ' : ''}${m > 0 ? m + 'm ' : ''}${s}s`;
}

cmd({
    pattern: 'system',
    alias: ['status', 'botinfo', 'info'],
    desc: 'Check server and bot system specifications',
    category: 'general',
    react: '📟'
}, async (sock, m) => {
    // RAM Metrics
    const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
    const freeMem = (os.freemem() / 1024 / 1024).toFixed(0);
    const usedMem = (totalMem - freeMem).toFixed(0);
    const heapUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

    // CPU Metrics
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown CPU';
    const cpuCores = cpus.length;

    // System Metrics
    const botUptime = formatUptime(process.uptime());
    const osUptime = formatUptime(os.uptime());
    const platform = `${os.platform()} (${os.arch()})`;
    const nodeVersion = process.version;

    const systemText = `*❬❬ DARK DINU SYSTEM STATUS ⚙️ ❭❭*

▸ *Bot Uptime:* \`${botUptime}\`
▸ *Host Uptime:* \`${osUptime}\`
▸ *Platform:* \`${platform}\`
▸ *Node.js:* \`${nodeVersion}\`

*❬❬ MEMORY & PERFORMANCE ❭❭*
▸ *RAM Usage:* \`${usedMem}MB / ${totalMem}MB\`
▸ *Heap Allocated:* \`${heapUsed}MB\`
▸ *CPU Model:* \`${cpuModel}\`
▸ *CPU Cores:* \`${cpuCores} Core(s)\`

> *◉ ᴅᴇᴠ ʜᴇꜱʜᴀɴ ᴏꜰᴄ ◉*`;

    // RAM එකේ ඇති Image Buffer එකෙන් ක්ෂණිකව යැවීම
    if (cachedLogo) {
        await sock.sendMessage(m.jid, {
            image: cachedLogo,
            caption: systemText
        }, { quoted: m });
    } else {
        await sock.sendMessage(m.jid, { text: systemText }, { quoted: m });
    }
});
