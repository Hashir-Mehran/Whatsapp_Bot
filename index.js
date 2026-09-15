require('dotenv').config();
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('WhatsApp Bot is running live!');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI; // MongoDB Connection String

if (!GEMINI_API_KEY || !MONGO_URI) {
    console.error("ERROR: GEMINI_API_KEY ya MONGO_URI missing hai!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const pausedChats = new Set();
const chatHistories = {};

// MongoDB Auth State Handler Function
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
                            if (type === 'app-state-sync-key' && value) {
                                value = value;
                            }
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
Tum Sargodha, Pakistan me ek Switch Store ke professional sales assistant ho.
Tumhara kaam WhatsApp par aane wale customers ke sawalat ka polite Roman Urdu / Urdu me jawab dena hai.
`;

async function connectToWhatsApp() {
    // MongoDB Connection
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db('whatsapp_bot');
    const collection = db.collection('auth_session');

    const { state, saveCreds } = await useMongoDBAuthState(collection);
    
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
                await sock.sendMessage(sender, { delete: m.key });
                return;
            }
            chatHistories[sender].push({ role: 'model', parts: [{ text: text }] });
            return;
        }

        chatHistories[sender].push({ role: 'user', parts: [{ text: text }] });

        if (pausedChats.has(sender)) return;

        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                systemInstruction: systemPrompt 
            });

            const historyForGemini = chatHistories[sender].slice(0, -1);
            const chat = model.startChat({ history: historyForGemini });

            const result = await chat.sendMessage(text);
            const responseText = result.response.text();

            chatHistories[sender].push({ role: 'model', parts: [{ text: responseText }] });

            if (chatHistories[sender].length > 20) {
                chatHistories[sender] = chatHistories[sender].slice(-20);
            }

            await sock.sendMessage(sender, { text: responseText });
        } catch (error) {
            console.error("Gemini API Error:", error);
        }
    });
}

connectToWhatsApp();