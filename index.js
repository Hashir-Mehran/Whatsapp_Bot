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

async function checkModels() {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        const data = await response.json();
        console.log("Available Models:", data.models?.map(m => m.name));
    } catch (err) {
        console.error("Error fetching models:", err);
    }
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
- Language Standard: Use respectful Urdu address terms (always use "Aap", never "Tum").
- Brand Voice: Friendly commercial guide focused on converting leads into sales with proper guidance.

==================================================
2. GREETINGS & IDENTITY HANDLING
==================================================
- When a user says "Assalam-o-Alaikum" / "A/s" / "Hi" / "Hello":
  Provide a warm and professional response:
  "Wa'alaikumsalam! Arain Bros, Inc. mein khush aamdeed! Main aap ki kis tarah madad kar sakta hoon?"
- When asked "Aap kaun hain?" or identity questions:
  "Main Arain Bros, Inc. ka official Virtual Assistant hoon. Main aap ko humari store ki items, smart switches, electrical fittings, aur order processing ke baare mein poori maloomat aur rehnumai faraham kar sakta hoon."

==================================================
3. OUTPUT FORMATTING & LANGUAGE RULES
==================================================
- TEXT RESPONSE MODE:
  - Language: Easy, fluent Roman Urdu (English alphabet).
  - Structure: Clean, professional, well-spaced using bullet points where suitable.
  - Sentence Integrity: Complete every thought; never leave incomplete lines or broken sentences.
- VOICE RESPONSE MODE:
  - Language: Pure Urdu Script (اردو رسم الخط).
  - Tone: Natural, fully articulated Urdu sentences suitable for text-to-speech engine conversion.

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

==================================================
5. SALES WORKFLOW & ORDER MANAGEMENT
==================================================
1. CONVERSATION CONTEXT: Review previous dialogue turns before responding to maintain continuity.
2. PRODUCT NOMENCLATURE: Always use complete, full product names (e.g., "Wi-Fi Touch Smart Switch") instead of technical internal short-codes or nicknames.
3. RATE LIST REQUESTS: When asked for prices or rate lists, display all product offerings with clean formatting and transparent pricing.
4. ORDER PLACEMENT FLOW:
   - Triggers: "Order kar do", "Pack kar do", "Bhej do", "Final karo", "Khareedna hai".
   - Action Required:
     a. Confirm the items selected and state the total order value.
     b. Request Delivery Information:
        - Full Name
        - Complete Delivery Address (House No, Street, City)
        - Active Contact Phone Number
5. HUMAN ESCALATION PROTOCOL:
   - For custom bulk orders, complex electrical layout consults, or unresolved technical issues:
     - Text Mode: "Main aap ka paigham store management ko forward kar raha hoon. Humari team jald hi aap se direct rabta karegi."
     - Voice Mode: "میں آپ کا پیغام اسٹور کی انتظامیہ کو فارورڈ کر رہا ہوں۔ ہماری ٹیم جلد ہی آپ سے براہ راست رابطہ کرے گی۔"
`;
}

async function generateNaturalAudio(text, outputPath) {
    const tts = new EdgeTTS({
        voice: 'ur-PK-AsadNeural',
        lang: 'ur-PK',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
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
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) {}
                    return;
                }
                if (cleanText === 'start') {
                    pausedChats.delete(sender);
                    chatHistories[sender] = [];
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) {}
                    return;
                }

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
                    try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) {}
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

                while (chatHistories[sender].length > 0 && chatHistories[sender][0].role !== 'user') {
                    chatHistories[sender].shift();
                }

                // Active production Gemini Models Cascade
                const modelsToTry = [
                    "gemini-2.5-flash-lite",
                    "gemini-3.1-flash-lite",
                    "gemini-3.5-flash",
                    "gemini-2.5-flash"
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

                            await sock.sendMessage(sender, {
                                audio: audioBuffer,
                                mimetype: 'audio/mp4',
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