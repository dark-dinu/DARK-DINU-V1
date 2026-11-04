// Default settings for every NEW session. Each user can change them with the .setting panel.
module.exports = {
    prefix: '.',
    antiDelete: true,       // 1
    antiViewOnce: true,     // 2
    sendTo: 'inbox',        // 3  inbox | chat
    mode: 'public',         // 4  public | private | group | inbox
    antiCall: false,        // 5
    statusSeen: true,       // 6
    statusReact: false,     // 7
    presence: 'off',        // 8  off | typing | recording
    antiSend: 'off',        // 9  off | all | mine | others
    statusEmoji: '💖',      // 10
    online: 'default',      // 11 on | offline | default
    statusSave: true        // 12
};
