require('dotenv').config();
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const { MongoClient } = require('mongodb');
const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');
const path = require('path');

const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('WhatsApp Bot is running live!'));
app.get('/ping', (req, res) => res.send('Pong! Health check OK.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

if (!GEMINI_API_KEY || !MONGO_URI) {
    console.error("ERROR: GEMINI_API_KEY ya MONGO_URI missing hai!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const pausedChats = new Set();
const chatHistories = {};
const processedMessages = new Set();

const defaultProducts = {
    'normal-switch': { name: 'Standard / Normal Electric Switch & Socket', price: 'Rs. 150 - Rs. 350 per piece' },
    'wifi-switch': { name: 'Wi-Fi Touch Smart Switch (App & Voice Control)', price: 'Rs. 1,800 - Rs. 3,500 per piece' },
    'board': { name: 'Complete Switchboard & Set', price: 'Rs. 800 - Rs. 2,500' },
    'breaker': { name: 'Circuit Breakers & Smart Distribution Boxes', price: 'Rs. 500 - Rs. 1,800' }
};

let mongoClient = null;
let isConnecting = false;
let ratesCollection = null;

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
            return document ? JSON.parse(document.data, BufferJSON.reviver) : null;
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

async function getDynamicProductsText() {
    try {
        let products = await ratesCollection.find({}).toArray();
        if (!products || products.length === 0) {
            for (const key of Object.keys(defaultProducts)) {
                await ratesCollection.updateOne(
                    { nickname: key },
                    { $set: { nickname: key, name: defaultProducts[key].name, price: defaultProducts[key].price } },
                    { upsert: true }
                );
            }
            products = await ratesCollection.find({}).toArray();
        }

        let productStr = "";
        products.forEach(p => {
            productStr += `- ${p.name}: ${p.price}\n`;
        });
        return productStr;
    } catch (e) {
        console.error("Error getting dynamic rates:", e);
        return `- Standard Electric Switches: Rs. 150 - Rs. 350 per piece\n- Wi-Fi Touch Smart Switches: Rs. 1,800 - Rs. 3,500 per piece`;
    }
}

function getSystemPrompt(productsListText) {
    return `
You are the official Customer Service & Sales Executive for "Arain Bros, Inc." (Electric & Smart Switch Store) operating out of Sargodha, Punjab, Pakistan.

==================================================
1. CORE IDENTITY & BRAND PERSONALITY
==================================================
- Store Name: Arain Bros, Inc.
- Tone & Demeanor: Highly professional, warm, polite, respectful, and customer-centric.
- Language Standard: Always use "Aap", never "Tum".

==================================================
2. GREETINGS & IDENTITY HANDLING
==================================================
- Greetings: "Wa'alaikumsalam! Arain Bros, Inc. mein khush aamdeed! Main aap ki kis tarah madad kar sakta hoon?"
- Identity: "Main Arain Bros, Inc. ka official Virtual Assistant hoon."

==================================================
3. CRITICAL OUTPUT FORMATTING RULES
==================================================
- IF INSTRUCTED FOR TEXT MODE:
  - Respond ONLY in Roman Urdu (English alphabet).
- IF INSTRUCTED FOR VOICE MODE:
  - Respond STRICTLY in Pure Urdu Script (اردو رسم الخط). Do NOT use English letters or Roman Urdu in Voice mode, so Text-To-Speech engine can read it properly.

==================================================
4. PRODUCT CATALOG & LATEST RATES
==================================================
Store Location: Sargodha, Punjab, Pakistan.
Business Hours: 10:00 AM to 9:00 PM (PKT).

Current Store Products & Pricing Catalogue:
${productsListText}

Delivery & Logistics Policy:
* Sargodha Local Delivery: Same-day or next-day direct home delivery.
* Nationwide Pakistan Shipping: Express Courier Service (TCS / Leopards) delivered in 2 to 4 working days.
`;
}

async function generateNaturalAudio(text, outputPath) {
    const tts = new EdgeTTS({
        voice: 'ur-PK-AsadNeural',
        lang: 'ur-PK',
        outputFormat: 'ogg-24khz-16bit-mono-opus',
        timeout: 30000
    });
    await tts.ttsPromise(text, outputPath);
    return outputPath;
}

function checkForVoiceRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const voiceKeywords = ['voice', 'vois', 'vn', 'v voice', 'voice note', 'voice me', 'voice main', 'bol ke', 'bol kar', 'bolen', 'bolo', 'batao voice', 'audio', 'آواز', 'وائس', 'suna', 'sunao', 'bhej voice'];
    return voiceKeywords.some(keyword => lower.includes(keyword));
}

function checkForTextRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const textKeywords = ['text', 'likh', 'likho', 'likha', 'likhna', 'likh kar', 'likh ke', 'likh do', 'message me', 'msg me', 'text me', ' rate list', 'ratelist', ' detail', 'details', 'تکست', 'لکھ'];
    return textKeywords.some(keyword => lower.includes(keyword));
}

async function startBot() {
    if (isConnecting) return;
    isConnecting = true;

    try {
        if (!mongoClient) {
            mongoClient = new MongoClient(MONGO_URI);
            await mongoClient.connect();
        }

        const db = mongoClient.db('whatsapp_bot');
        const collection = db.collection('auth_session');
        ratesCollection = db.collection('product_rates');

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
                console.log("    APNE WHATSAPP SE QR SCAN KAREIN   ");
                console.log("==================================================\n");
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (statusCode === DisconnectReason.loggedOut) {
                    await collection.deleteMany({});
                    setTimeout(() => startBot(), 3000);
                } else if (shouldReconnect) {
                    setTimeout(() => startBot(), 3000);
                }
            } else if (connection === 'open') {
                isConnecting = false;
                console.log('\nSUCCESS: WhatsApp Bot Connected!\n');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            const m = messages[0];
            if (!m || !m.message) return;

            const msgId = m.key.id;
            if (processedMessages.has(msgId)) return;
            processedMessages.add(msgId);

            if (processedMessages.size > 1000) processedMessages.clear();

            const sender = m.key.remoteJid;
            const isFromMe = m.key.fromMe;
            const isAudio = !!m.message.audioMessage;
            const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

            // OWNER COMMANDS
            if (isFromMe && text) {
                const cleanText = text.toLowerCase();

                if (cleanText === 'off') {
                    pausedChats.add(sender);
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) { }
                    return;
                }
                if (cleanText === 'start') {
                    pausedChats.delete(sender);
                    chatHistories[sender] = [];
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) { }
                    return;
                }

                if (text.startsWith('/ratechange')) {
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) { }
                    const parts = text.split(' ');
                    if (parts.length >= 3) {
                        const nickname = parts[1].toLowerCase();
                        const newPrice = parts.slice(2).join(' ');
                        let productName = defaultProducts[nickname]?.name || nickname;

                        const existingDoc = await ratesCollection.findOne({ nickname });
                        if (existingDoc && existingDoc.name) productName = existingDoc.name;

                        const priceFormatted = newPrice.toLowerCase().includes('rs') ? newPrice : `Rs. ${newPrice}`;

                        await ratesCollection.updateOne(
                            { nickname: nickname },
                            { $set: { nickname: nickname, name: productName, price: priceFormatted } },
                            { upsert: true }
                        );

                        const sentMsg = await sock.sendMessage(sender, {
                            text: `✅ *Rate Updated!*\n📦 *Product:* ${productName}\n🏷️ *New Rate:* ${priceFormatted}`
                        });

                        setTimeout(async () => {
                            try { await sock.sendMessage(sender, { delete: sentMsg.key }); } catch (e) { }
                        }, 5000);
                    }
                    return;
                }

                if (cleanText === '/ratelist') {
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) { }
                    const currentRatesText = await getDynamicProductsText();
                    await sock.sendMessage(sender, { text: `📋 *Current Product Rates:*\n\n${currentRatesText}` });
                    return;
                }
                return;
            }

            if (pausedChats.has(sender)) return;
            if (!isAudio && !text) return;

            if (!chatHistories[sender]) chatHistories[sender] = [];

            let audioPath = null;
            try {
                // DECIDE IF RESPONSE SHOULD BE VOICE NOTE
                const wantsVoice = isAudio || checkForVoiceRequest(text);
                const wantsText = checkForTextRequest(text);
                
                // If user asked for voice, override and send voice unless explicitly asked for text list
                const sendAsVoice = wantsVoice && !wantsText;

                let promptPayload;

                if (isAudio) {
                    const audioBuffer = await downloadMediaMessage(m, 'buffer', {});
                    const formatInstruction = sendAsVoice
                        ? " [CRITICAL INSTRUCTION]: Customer ne Voice Note bheja hai. Jawab STRICTLY Pure Urdu Script (اردو) me do taakay voice generate ho sake."
                        : " [INSTRUCTION]: Customer ne text mangha hai. Jawab Roman Urdu (English Alphabets) me do.";

                    promptPayload = [
                        {
                            inlineData: {
                                mimeType: m.message.audioMessage.mimetype || 'audio/ogg; codecs=opus',
                                data: audioBuffer.toString('base64')
                            }
                        },
                        formatInstruction
                    ];
                } else {
                    const formatInstruction = sendAsVoice
                        ? " [CRITICAL INSTRUCTION]: Customer ko Voice Note sunana hai. Isliye jawab STRICTLY Pure Urdu Script (اردو) mein 2-3 aasan sentences mein do. English alphabet ya Roman Urdu bilkul mat likhna."
                        : " [INSTRUCTION]: Jawab Roman Urdu (English Alphabets) me do. Clear aur polite sentences use karo.";
                    
                    promptPayload = text + formatInstruction;
                }

                if (chatHistories[sender].length > 10) {
                    chatHistories[sender] = chatHistories[sender].slice(-10);
                }

                while (chatHistories[sender].length > 0 && chatHistories[sender][0].role !== 'user') {
                    chatHistories[sender].shift();
                }

                const modelsToTry = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
                let responseText = null;
                const currentRatesText = await getDynamicProductsText();
                const currentSystemPrompt = getSystemPrompt(currentRatesText);

                for (const modelName of modelsToTry) {
                    try {
                        const model = genAI.getGenerativeModel({
                            model: modelName,
                            systemInstruction: currentSystemPrompt,
                            generationConfig: { maxOutputTokens: 500 }
                        });

                        const chat = model.startChat({ history: chatHistories[sender] });
                        const result = await chat.sendMessage(promptPayload);
                        responseText = result.response.text().trim();
                        break;
                    } catch (apiErr) {
                        console.warn(`Fallback triggered from ${modelName}`);
                    }
                }

                if (responseText) {
                    chatHistories[sender].push({
                        role: 'user',
                        parts: [{ text: isAudio ? '[Voice Note Input]' : text }]
                    });

                    chatHistories[sender].push({
                        role: 'model',
                        parts: [{ text: responseText }]
                    });

                    if (sendAsVoice) {
                        // Clean markdown or special symbols from Urdu text for TTS engine
                        const cleanUrduText = responseText.replace(/[*_~`]/g, '');
                        audioPath = path.join(__dirname, `reply_${Date.now()}.ogg`);
                        
                        try {
                            await generateNaturalAudio(cleanUrduText, audioPath);
                            const audioBuffer = fs.readFileSync(audioPath);

                            await sock.sendMessage(sender, {
                                audio: audioBuffer,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true // Sends as WhatsApp Voice Note
                            }, { quoted: m });

                        } catch (audioErr) {
                            console.error("Audio generation error, fallback to text:", audioErr);
                            await sock.sendMessage(sender, { text: responseText }, { quoted: m });
                        }
                    } else {
                        await sock.sendMessage(sender, { text: responseText }, { quoted: m });
                    }
                }

            } catch (error) {
                console.error("Error processing message:", error);
            } finally {
                if (audioPath && fs.existsSync(audioPath)) {
                    try { fs.unlinkSync(audioPath); } catch (e) { }
                }
            }
        });

    } catch (err) {
        isConnecting = false;
        console.error("Startup Error:", err);
        setTimeout(() => startBot(), 5000);
    }
}

startBot();
