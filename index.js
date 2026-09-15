require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;


// Render health check route
app.get('/', (req, res) => {
  res.send('WhatsApp Bot is running live!');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// 1. Environment variable se API Key load karna
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("ERROR: GEMINI_API_KEY .env file mein mojood nahi hai!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Specific chats ko pause rakhne ke liye Set
const pausedChats = new Set();

// Har customer ki Chat History store karne ke liye Object
const chatHistories = {};

// 2. Business Details & Updated System Prompt
const systemPrompt = `
Tum Sargodha, Pakistan me ek Switch Store ke professional sales assistant ho.
Tumhara kaam WhatsApp par aane wale customers ke sawalat ka polite Roman Urdu / Urdu me jawab dena hai.

Business Details:
- Store Location: Sargodha, Punjab, Pakistan.
- Products: Electric Switches, Touch Smart Switches, Sockets, Circuit Breakers, Switchboards.
- Delivery: Sargodha me home delivery aur pooray Pakistan me courier service available hai.
- Prices: 
  * Normal Switches: Rs. 150 - Rs. 350 per piece
  * Touch/Smart Wi-Fi Switches: Rs. 1,800 - Rs. 3,500 per piece (Note: Owner rates update kar sakta hai chat me)
  * Switchboards (Complete Set): Rs. 800 - Rs. 2,500
- Business Hours: 10:00 AM se 9:00 PM.

Rules:
1. Hamesha Urdu ya Roman Urdu me polite aur helpful reply do.
2. Chat history ko achi tarah parho. Agar customer ya owner ne pehle hi kisi item, price, ya deal ki baat kar li hai, to dobara pehle wala menu ya sawal mat poocho.
3. Agar customer kahe 'parcel kar do', 'order pack kar do', ya 'send kar do', to pehle se tay shuda item ki confirmation karo aur customer se unka Naama (Name), Address, aur Phone Number maango.
4. Agar koi aisi cheez pooche jo details me nahi hai, to kaho: "Main aap ka paigham owner ko forward kar raha hoon, woh jald aap se rabta kar lein ge."
`;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

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

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const sender = m.key.remoteJid;
        const isFromMe = m.key.fromMe; 
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

        if (!text) return;

        // Ensure history array exists for this user
        if (!chatHistories[sender]) {
            chatHistories[sender] = [];
        }

        // ==========================================
        // 1. OWNER COMMANDS & OWNER MESSAGES
        // ==========================================
        if (isFromMe) {
            const cleanText = text.toLowerCase();

            // Command: "off"
            if (cleanText === 'off') {
                pausedChats.add(sender);
                await sock.sendMessage(sender, { delete: m.key });
                console.log(`[BOT PAUSED] AI status for ${sender} is now OFF`);
                return;
            }

            // Command: "start"
            if (cleanText === 'start') {
                pausedChats.delete(sender);
                await sock.sendMessage(sender, { delete: m.key });
                console.log(`[BOT ACTIVE] AI status for ${sender} is now ACTIVE`);
                return;
            }

            // Jab aap khud (Owner) koi normal message bhejte hain (jaise: "Bhi wifi wla 2000 ka ha")
            // Toh hum isko history mein AI ke role (model) ke tor par save kar lete hain taakay AI ko yaad rahe
            chatHistories[sender].push({
                role: 'model',
                parts: [{ text: text }]
            });
            return;
        }

        // Customer ka message history mein 'user' ke tor par save karein
        chatHistories[sender].push({
            role: 'user',
            parts: [{ text: text }]
        });

        // ==========================================
        // 2. PAUSE CHECK
        // ==========================================
        if (pausedChats.has(sender)) {
            console.log(`[IGNORED] AI is PAUSED for customer (${sender})`);
            return;
        }

        // ==========================================
        // 3. AI REPLY GENERATION WITH HISTORY
        // ==========================================
        console.log(`Customer Message (${sender}): ${text}`);

        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                systemInstruction: systemPrompt 
            });

            // Purani history ke saath Chat Session start karein
            // Aakhri message ko chor kar baki sab history mein pass hongay
            const historyForGemini = chatHistories[sender].slice(0, -1);

            const chat = model.startChat({
                history: historyForGemini
            });

            // Current message bhejen
            const result = await chat.sendMessage(text);
            const responseText = result.response.text();

            // AI ka reply bhi history mein save karein
            chatHistories[sender].push({
                role: 'model',
                parts: [{ text: responseText }]
            });

            // Limit history to last 20 messages to avoid memory limits
            if (chatHistories[sender].length > 20) {
                chatHistories[sender] = chatHistories[sender].slice(-20);
            }

            await sock.sendMessage(sender, { text: responseText });
            console.log(`Bot Reply: ${responseText}`);

        } catch (error) {
            console.error("Gemini API Error:", error);
        }
    });
}

connectToWhatsApp();