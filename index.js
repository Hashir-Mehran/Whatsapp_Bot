require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 1. Environment variable se API Key load karna
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("ERROR: GEMINI_API_KEY .env file mein mojood nahi hai!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Specific chats ko pause rakhne ke liye Set
const pausedChats = new Set();

// 2. Business Details & System Prompt
const systemPrompt = `
Tum Sargodha, Pakistan me ek Switch Store ke professional sales assistant ho.
Tumhara kaam WhatsApp par aane wale customers ke sawalat ka polite Roman Urdu / Urdu me jawab dena hai.

Business Details:
- Store Location: Sargodha, Punjab, Pakistan.
- Products: Electric Switches, Touch Smart Switches, Sockets, Circuit Breakers, Switchboards.
- Delivery: Sargodha me home delivery aur pooray Pakistan me courier service available hai.
- Prices: 
  * Normal Switches: Rs. 150 - Rs. 350 per piece
  * Touch/Smart Wi-Fi Switches: Rs. 1,800 - Rs. 3,500 per piece
  * Switchboards (Complete Set): Rs. 800 - Rs. 2,500
- Business Hours: 10:00 AM se 9:00 PM.

Rules:
1. Hamesha Urdu ya Roman Urdu me polite aur helpful reply do.
2. Customer jo bhi switch ke mutaliq pooche (price, quality, location, delivery), use business details ke mutabiq jawab do.
3. Agar koi aisi cheez pooche jo details me nahi hai, to kaho: "Main aap ka paigham owner ko forward kar raha hoon, woh jald aap se rabta kar lein ge."
`;

async function connectToWhatsApp() {
    // Fresh session handling
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // QR Code display & connection state listener
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("\n==================================================");
            console.log("   APNE WHATSAPP SE NECHE DIYA GAYA QR SCAN KAREIN   ");
            console.log("==================================================\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Connection close ho gaya. Reconnecting...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('\nSUCCESS: WhatsApp Bot Successfully Connected!\n');
        }
    });

    // Customer message receiving & reply handling
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const sender = m.key.remoteJid;
        const isFromMe = m.key.fromMe; // True agar message aap ne (Owner ne) bheja hai
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

        if (!text) return;

        // ==========================================
        // 1. OWNER COMMANDS (Silent Delete Commands)
        // ==========================================
        if (isFromMe) {
            const cleanText = text.toLowerCase();

            // Command: "off" -> Current chat me AI pause ho jayega
            if (cleanText === 'off') {
                pausedChats.add(sender);
                // Command message ko client ke dekhne se pehle delete kar do
                await sock.sendMessage(sender, { delete: m.key });
                console.log(`[BOT PAUSED] AI status for ${sender} is now OFF`);
                return;
            }

            // Command: "start" -> Current chat me AI dobara active ho jayega
            if (cleanText === 'start') {
                pausedChats.delete(sender);
                // Command message ko delete kar do
                await sock.sendMessage(sender, { delete: m.key });
                console.log(`[BOT ACTIVE] AI status for ${sender} is now ACTIVE`);
                return;
            }

            // Client ko owner ke aam messages par AI reply trigger nahi hone dena
            return;
        }

        // ==========================================
        // 2. PAUSE CHECK (Client chat validation)
        // ==========================================
        // Agar aap ne is client ke liye bot off kiya hua hai toh AI reply nahi karega
        if (pausedChats.has(sender)) {
            console.log(`[IGNORED] AI is PAUSED for customer (${sender})`);
            return;
        }

        // ==========================================
        // 3. AI REPLY GENERATION
        // ==========================================
        console.log(`Customer Message (${sender}): ${text}`);

        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                systemInstruction: systemPrompt 
            });
            
            const result = await model.generateContent(text);
            const responseText = result.response.text();

            await sock.sendMessage(sender, { text: responseText });
            console.log(`Bot Reply: ${responseText}`);

        } catch (error) {
            console.error("Gemini API Error:", error);
        }
    });
}

connectToWhatsApp();