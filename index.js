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
You are an experienced, sharp, and polite Sales Executive for "Arain Bros, Inc." (Electric & Smart Switch Store) based in Sargodha, Punjab, Pakistan. You are handling customer chats on WhatsApp.

==================================================
1. LOCAL MARKET DEALING & BEHAVIOR RULES (PAKISTANI STYLE)
==================================================
- FAST & DIRECT: Local customers prefer quick, short, and to-the-point replies. Don't waste time in high-level corporate introductions.
- NO REPETITIVE GREETINGS: Never repeat "Salam" or "Khair khamdam" in every message. Only say "Wa'alaikumsalam" if the user sends a greeting FIRST in their current message.
- NO ROBOTIC FLUFF: Avoid formal lines like "Arain Bros, Inc. mein aap ka khair khamdam hai" or "Main aap ki poori rehnumai ke liye hazir hoon". Speak like an actual shop salesman/manager on WhatsApp.
- RESPECTFUL LANGUAGE: Always address the customer with respect using "Aap" and polite words like "G bilkul", "Ji haan", "Bhai", or "Sir" where appropriate.
- CONVERSATION FLOW: Always read the chat history first. Keep track of what product the customer is asking about.

==================================================
2. LANGUAGE & COMMUNICATION STYLE
==================================================
- TEXT MODE: 
  - Natural Roman Urdu (Pakistani WhatsApp typing style).
  - Short lines, simple bullet points, bold prices. Easy to read on mobile.
- VOICE MODE: 
  - Clear Urdu script (اردو رسم الخط) for TTS output.

==================================================
3. CATALOG, PRICING & LOCAL BUSINESS DETAILS
==================================================
Store Location: Sargodha, Punjab, Pakistan.
Business Hours: 10:00 AM to 9:00 PM (PKT).

Current Product & Rate List:
${productsListText}

Delivery & Payment Terms (Pakistani Market Standards):
- Sargodha City: Same-day / Next-day Cash on Delivery (COD) or direct shop pickup.
- All Pakistan (Other Cities): Delivery via TCS / Leopards / Courier within 2 to 4 days.
- Advance / COD Policy: Standard delivery options available. Mention total estimate clearly.

==================================================
4. HANDLING DISCOUNTS & BARGAINING (MOLE TOL)
==================================================
- If customer asks for discount ("Kuch kam karo", "Discount milega?", "Final price kia hai?"):
  - Polite answer: "Bhai yeh humari sub se reasonable aur final wholesale rates hain, quality A1 milegi. Agar aap bulk/zyada quantity lein ge toh hum management se baat karke best package de dein ge."

==================================================
5. ORDER CLOSING & ESCALATION PROTOCOL
==================================================
- When user shows interest in buying ("Order kar do", "Pack kar do", "Bhej do", "Final karo"):
  1. Confirm item, quantity, and total bill.
  2. Request details for delivery:
     - Name (Naam)
     - Full Address with landmark (Poora Pata - House/Street/Area/City)
     - Mobile Number (Contact)
- Human Support Transfer: For special bulk orders, electric blueprints/fitting consultations, or owner deals:
  - Text: "Main aap ka number hamare sales manager ko pass kar raha hoon, woh aap se direct WhatsApp/Call par rabta kar lein ge."
  - Voice: "میں آپ کا نمبر ہمارے سیلز مینیجر کو پاس کر رہا ہوں، وہ آپ سے ڈائریکٹ رابطہ کر لیں گے۔"
`;
}

async function generateNaturalAudio(text, outputPath) {
    const tts = new EdgeTTS({
        voice: 'ur-PK-AsadNeural',
        lang: 'ur-PK',
        outputFormat: 'ogg-24khz-16bit-mono-opus'
    });
    await tts.ttsPromise(text, outputPath);
    return outputPath;
}

function checkForTextRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const textKeywords = [
        'text', 'likh', 'likho', 'likha', 'likhna', 'likh kar', 'likh ke', 'likh do',
        'message me', 'msg me', 'text me', 'rate list', 'ratelist', 'rates', 'list',
        'detail', 'details', 'تکست', 'لکھ', 'ریٹ', 'لسٹ'
    ];
    return textKeywords.some(keyword => lower.includes(keyword));
}

function checkForVoiceRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const voiceKeywords = ['voice', 'vois', 'vn', 'voice note', 'voice me', 'voice main', 'bol ke', 'bol kar', 'bolen', 'bolo', 'batao voice', 'audio', 'آواز', 'وائس'];
    return voiceKeywords.some(keyword => lower.includes(keyword));
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
                console.log("    APNE WHATSAPP SE NECHE DIYA GAYA QR SCAN KAREIN   ");
                console.log("==================================================\n");
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection drop. StatusCode: ${statusCode}. Reconnecting: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("Session Logged Out! Database cleared.");
                    await collection.deleteMany({});
                    setTimeout(() => startBot(), 3000);
                } else if (shouldReconnect) {
                    setTimeout(() => startBot(), 3000);
                }
            } else if (connection === 'open') {
                isConnecting = false;
                console.log('\nSUCCESS: WhatsApp Bot Successfully Connected & Alive!\n');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            const m = messages[0];
            if (!m || !m.message) return;

            const msgId = m.key.id;
            if (processedMessages.has(msgId)) return;
            processedMessages.add(msgId);

            if (processedMessages.size > 1000) {
                processedMessages.clear();
            }

            const sender = m.key.remoteJid;
            const isFromMe = m.key.fromMe;
            const isAudio = !!m.message.audioMessage;
            const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

            // OWNER COMMANDS HANDLING
            if (isFromMe && text) {
                const cleanText = text.toLowerCase();

                // Bot Control Commands
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

                // Rate Change Command
                // Rate Change Command
if (text.startsWith('/ratechange')) {
    try {
        await sock.sendMessage(sender, { delete: m.key });
    } catch (err) {
        console.error("Could not delete command message:", err);
    }

    const parts = text.split(' ');
    if (parts.length >= 3) {
        const nickname = parts[1].toLowerCase();
        const newPrice = parts.slice(2).join(' ');

        let productName = defaultProducts[nickname]?.name || nickname;

        const existingDoc = await ratesCollection.findOne({ nickname });
        if (existingDoc && existingDoc.name) {
            productName = existingDoc.name;
        }

        const priceFormatted = newPrice.toLowerCase().includes('rs') ? newPrice : `Rs. ${newPrice}`;

        await ratesCollection.updateOne(
            { nickname: nickname },
            { $set: { nickname: nickname, name: productName, price: priceFormatted } },
            { upsert: true }
        );

        // 🟢 FIX: Rate change hotay hi saari purani memory clear kar dein
        Object.keys(chatHistories).forEach(key => delete chatHistories[key]);

        const sentMsg = await sock.sendMessage(sender, {
            text: `✅ *Rate Updated Successfully!*\n\n📦 *Product:* ${productName}\n🏷️ *New Rate:* ${priceFormatted}`
        });

        setTimeout(async () => {
            try {
                await sock.sendMessage(sender, { delete: sentMsg.key });
            } catch (err) {
                console.error("Could not auto-delete rate status message:", err);
            }
        }, 5000);

    } else {
        const sentMsg = await sock.sendMessage(sender, {
            text: `❌ *Invalid Format!*\nUse: \`/ratechange wifi-switch 2000\`\nAvailable Nicknames:\n- \`wifi-switch\`\n- \`normal-switch\`\n- \`board\`\n- \`breaker\``
        });

        setTimeout(async () => {
            try {
                await sock.sendMessage(sender, { delete: sentMsg.key });
            } catch (err) {
                console.error("Could not auto-delete error status message:", err);
            }
        }, 5000);
    }
    return;
}

                if (cleanText === '/ratelist') {
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) { }
                    const currentRatesText = await getDynamicProductsText();
                    await sock.sendMessage(sender, { text: `📋 *Current Product Rates List:*\n\n${currentRatesText}` });
                    return;
                }

                return;
            }

            if (pausedChats.has(sender)) return;
            if (!isAudio && !text) return;

            if (!chatHistories[sender]) chatHistories[sender] = [];

            try {
                let sendAsVoice = false;

                if (isAudio) {
                    sendAsVoice = true;
                } else {
                    const userWantsVoice = checkForVoiceRequest(text);
                    const userWantsText = checkForTextRequest(text);
                    if (userWantsVoice && !userWantsText) {
                        sendAsVoice = true;
                    } else {
                        sendAsVoice = false;
                    }
                }

                let promptPayload;

                if (isAudio) {
                    const audioBuffer = await downloadMediaMessage(m, 'buffer', {});
                    const formatInstruction = `
[INSTRUCTION]: 
1. Direct customer voice note listen karein.
2. AGAR customer ne voice me "likh kar", "text me", "rate list", "list", "detail" maangi ho, toh answer Roman Urdu text mein dein.
3. AGAR normal dialogue ho, toh answer Pure Urdu Script (اردو) mein complete sentences mein dein.
`;
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
                        ? " [INSTRUCTION]: Jawab Sirf Pure Urdu Script (اردو) me complete 2-3 sentences me do."
                        : " [INSTRUCTION]: Jawab Roman Urdu (English Alphabets) me do. Clear aur polite sentence structure maintain rakho.";
                    promptPayload = text + formatInstruction;
                }

                if (chatHistories[sender].length > 10) {
                    chatHistories[sender] = chatHistories[sender].slice(-10);
                }

                while (chatHistories[sender].length > 0 && chatHistories[sender][0].role !== 'user') {
                    chatHistories[sender].shift();
                }

                const modelsToTry = [
                    "gemini-3.5-flash-lite",
                    "gemini-3.5-flash",
                    "gemini-3.1-flash-lite",
                    "gemini-2.5-flash",
                    "gemini-flash-lite-latest",
                    "gemini-flash-latest"
                ];

                let responseText = null;

                const currentRatesText = await getDynamicProductsText();
                const currentSystemPrompt = getSystemPrompt(currentRatesText);

                for (const modelName of modelsToTry) {
                    try {
                        const model = genAI.getGenerativeModel({
                            model: modelName,
                            systemInstruction: currentSystemPrompt,
                            generationConfig: {
                                maxOutputTokens: 500,
                            }
                        });

                        const chat = model.startChat({
                            history: chatHistories[sender]
                        });

                        const result = await chat.sendMessage(promptPayload);
                        responseText = result.response.text().trim();
                        break;
                    } catch (apiErr) {
                        console.warn(`Model ${modelName} fallback triggered: ${apiErr.message}`);
                        if (modelName === modelsToTry[modelsToTry.length - 1]) {
                            throw apiErr;
                        }
                    }
                }

                if (responseText) {
                    chatHistories[sender].push({ role: 'user', parts: [{ text: isAudio ? '[Voice Note Input]' : text }] });
                    chatHistories[sender].push({ role: 'model', parts: [{ text: responseText }] });

                    const isUrduScript = /[\u0600-\u06FF]/.test(responseText);

                    if (isAudio && checkForTextRequest(responseText)) {
                        sendAsVoice = false;
                    }

                    if (sendAsVoice && isUrduScript) {
                        const audioPath = path.join(__dirname, `reply_${Date.now()}.mp3`);
                        try {
                            await generateNaturalAudio(responseText, audioPath);
                            const audioBuffer = fs.readFileSync(audioPath);

                            // FIXED MIME TYPE & PTT ATTRIBUTES FOR WHATSAPP VOICE NOTES
                            await sock.sendMessage(sender, {
                                audio: audioBuffer,
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true
                            }, { quoted: m });

                        } catch (audioErr) {
                            console.error("Voice Generation Error, falling back to text:", audioErr);
                            await sock.sendMessage(sender, { text: responseText }, { quoted: m });
                        } finally {
                            if (fs.existsSync(audioPath)) {
                                fs.unlinkSync(audioPath);
                            }
                        }
                    } else {
                        await sock.sendMessage(sender, { text: responseText }, { quoted: m });
                    }
                }

            } catch (error) {
                console.error("Fast Response Error:", error);
            }
        });

    } catch (err) {
        isConnecting = false;
        console.error("Startup Error:", err);
        setTimeout(() => startBot(), 5000);
    }
}

startBot();
