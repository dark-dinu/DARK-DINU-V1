// Auto-reject incoming calls
const { on } = require('../lib/handler');

on({ on: 'call' }, async (sock, call, S) => {
    if (!S.cfg.get('antiCall')) return;
    if (!call || call.status !== 'offer') return;
    try { await sock.rejectCall(call.id, call.from); } catch (e) { return; }

    const last = S.callNotified.get(call.from) || 0;
    if (Date.now() - last > 10 * 60 * 1000) {
        S.callNotified.set(call.from, Date.now());
        await sock.sendMessage(call.from, {
            text: '📵 *Auto Call Reject*\n\nමම දැන් call ගන්න බෑ. Message එකක් දාන්න.\n\n' + S.config.FOOTER
        }).catch(() => {});
    }
});
