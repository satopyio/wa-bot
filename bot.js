const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QR = require('qrcode-terminal');
const fs = require('fs');

const SESSION_DIR = './auth_info';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Chrome', 'Linux', '98.0'],
        syncFullHistory: false,
        connectTimeoutMs: 60000
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        // TUNJUK QR DENGAN 3 CARA BERBEZA
        if (qr) {
            console.log('\n========== [1] SCAN QR INI ==========');
            QR.generate(qr, { small: true });
            
            console.log('\n========== [2] ATAU SCAN DARI LINK INI ==========');
            console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
            
            console.log('\n========== [3] ATAU COPY STRING INI ==========');
            console.log(qr.substring(0, 50) + '... (panjang)');
            console.log('Guna: https://www.qrcode-monkey.com/');
            console.log('===============================================\n');
        }
        
        if (connection === 'open') {
            console.log('\n✅ BOT BERJAYA DISAMBUNG!');
            console.log('📱 Hantar apa-apa mesej ke nombor bot\n');
        }
        
        if (connection === 'close') {
            console.log('❌ Sambungan putus. Cuba reconnect dalam 5 saat...');
            setTimeout(() => startBot(), 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (msg) => {
        try {
            const m = msg.messages[0];
            if (!m.message || m.key.fromMe) return;
            
            const sender = m.key.remoteJid;
            console.log(`📨 Mesej dari: ${sender}`);
            
            // Hantar balasan
            await sock.sendMessage(sender, { text: '🤖 Bot online! Saya terima mesej awak.' });
            console.log('✅ Balasan hantar');
            
        } catch (err) {
            console.log('Ralat:', err);
        }
    });
}

startBot();
