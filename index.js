require('dotenv').config();
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const { MongoClient } = require('mongodb');

const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('WhatsApp Bot is running live!');
});

app.get('/ping', (req, res) => {
    res.send('Pong! Health check OK.');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

if (!GEMINI_API_KEY || !MONGO_URI) {
    console.error("ERROR: GEMINI_API_KEY ya MONGO_URI missing hai!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const pausedChats = new Set();
const chatHistories = {};


// Available models print karne ke liye
async function checkModels() {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    const data = await response.json();
    console.log("Available Models:", data.models?.map(m => m.name));
}
checkModels();
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        return collection.replaceOne(
            { _id: id },
            { _id: id, data: JSON.stringify(data, BufferJSON.replacer) },
            { upsert: true }
        );
    };

    const readData = async (id) => {
        try {
            const document = await collection.findOne({ _id: id });
            if (document) {
                return JSON.parse(document.data, BufferJSON.reviver);
            }
            return null;
        } catch {
            return null;
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : collection.deleteOne({ _id: key }));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

const systemPrompt = `
Tum Sargodha, Pakistan me ek premier Electric & Smart Switch Store ke highly professional, friendly aur expert Sales Assistant ho. 
Tumhara maqsad WhatsApp par aane wale customers ke sawalat ka jawab dena, unki zaroorat ke mutabiq products suggest karna, aur orders confirm karwana hai.

==================================================
1. LANGUAGE & TONE OF VOICE:
==================================================
- Hamesha natural, polite aur professional Roman Urdu (ya Urdu) me jawab do.
- Conversational aur welcoming style rakho (e.g., "Assalam-o-Alaikum! Switch Store me khushamdeed!").
- Short, crisp aur easy-to-read messages bhejo. Zyada lambay paragraphs se perhez karo.

==================================================
2. STORE & BUSINESS DETAILS:
==================================================
- Location: Sargodha, Punjab, Pakistan.
- Main Products:
  1. Standard/Normal Electric Switches & Sockets (Rs. 150 - Rs. 350 per piece)
  2. Wi-Fi Touch Smart Switches (Rs. 1,800 - Rs. 3,500 per piece) - App & Voice (Alexa/Google) control.
  3. Complete Switchboards & Sets (Rs. 800 - Rs. 2,500)
  4. Circuit Breakers, Distribution Boxes, & Smart Automation Modules.
- Delivery:
  * Sargodha City: Same-day / Next-day Home Delivery.
  * Across Pakistan: Courier service (TCS/Leopards) ke zariye 2-4 working days me.
- Business Hours: 10:00 AM se 9:00 PM.

==================================================
3. CONVERSATION & SALES RULES:
==================================================
1. CHAT HISTORY CHECK: Message ka jawab dene se pehle purani chat history parho. Agar customer ya Store Owner ne pehle hi koi price, discount ya deal tay kar li hai, toh wahi se baat aage barhao—dobara pehle wale sawal mat poocho.
2. NEED ASSESSMENT: Agar customer pooche ke konsa switch behtar hai, toh unse unki requirement (Normal Wiring ya Smart Home Setup) poocho.
3. PRICE FLEXIBILITY: Agar customer kisi price par bargain kare, toh polite raho. Agar Owner ne chat me koi special rate likha ho toh wahi final samjho.
4. ORDER TAKING TRIGGER:
   - Jab customer bole: "Order kar do", "Parcel bhej do", "Pack kar do", "Send kar do", ya "Final karo":
   - Step A: Pehle order kiye gaye items aur total price ki confirmation do.
   - Step B: Customer se unki Delivery Details maango:
     * Full Name (Naam)
     * Complete Delivery Address
     * Contact Phone Number
5. HUMAN HANDOVER / UNKNOWN QUERIES:
   - Agar customer koi aisi technical specification, bulk discount, ya custom board design maange jo details me nahi hai, toh exact yeh reply do:
     "Main aap ka paigham store owner ko forward kar raha hoon. Woh jald hi aap se direct rabta kar ke guide kar dein ge."

==================================================
4. STRICT RESTRICTIONS:
==================================================
- Kisi doosri city ke local shop ya competitors ki baat mat karo.
- Ghalat ya fake prices mat batao.
- Hamesha respectful raho, chahe customer rude bhi ho.
`;

async function connectToWhatsApp() {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('whatsapp_bot');
    const collection = db.collection('auth_session');

    const { state, saveCreds } = await useMongoDBAuthState(collection);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("\n==================================================");
            console.log("   APNE WHATSAPP SE NECHE DIYA GAYA QR SCAN KAREIN   ");
            console.log("==================================================\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection drop. StatusCode: ${statusCode}. Reconnecting: ${shouldReconnect}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log("Session Logged Out! Database cleared.");
                await collection.deleteMany({});
                connectToWhatsApp();
            } else if (shouldReconnect) {
                setTimeout(() => {
                    connectToWhatsApp();
                }, 3000);
            }
        } else if (connection === 'open') {
            console.log('\nSUCCESS: WhatsApp Bot Successfully Connected & Alive!\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const sender = m.key.remoteJid;
        const isFromMe = m.key.fromMe;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

        if (!text) return;

        if (!chatHistories[sender]) {
            chatHistories[sender] = [];
        }

        if (isFromMe) {
            const cleanText = text.toLowerCase();
            if (cleanText === 'off') {
                pausedChats.add(sender);
                await sock.sendMessage(sender, { delete: m.key });
                return;
            }
            if (cleanText === 'start') {
                pausedChats.delete(sender);
                chatHistories[sender] = []; // Fresh start ke liye history reset
                await sock.sendMessage(sender, { delete: m.key });
                console.log(`Chat history reset for: ${sender}`);
                return;
            }
            chatHistories[sender].push({ role: 'model', parts: [{ text: text }] });

            if (chatHistories[sender].length > 10) {
                chatHistories[sender] = chatHistories[sender].slice(-10);
            }
            return;
        }

        if (pausedChats.has(sender)) return;

        try {
            // Updated Official Model Name (gemini-1.5-flash)
            const model = genAI.getGenerativeModel({ 
                model: "gemini-3.6-flash",
                systemInstruction: systemPrompt 
            });

            const historyForGemini = chatHistories[sender].slice(-10);
            const chat = model.startChat({ history: historyForGemini });

            const result = await chat.sendMessage(text);
            const responseText = result.response.text();

            // History Update after response
            chatHistories[sender].push({ role: 'user', parts: [{ text: text }] });
            chatHistories[sender].push({ role: 'model', parts: [{ text: responseText }] });

            if (chatHistories[sender].length > 10) {
                chatHistories[sender] = chatHistories[sender].slice(-10);
            }

            await sock.sendMessage(sender, { text: responseText });
        } catch (error) {
            console.error("Gemini API Error:", error);
        }
    });
}

connectToWhatsApp();