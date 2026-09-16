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

// Default Products & Nicknames Mapping
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

// Dynamic Products List fetch karne ke liye function
async function getDynamicProductsText() {
    try {
        let products = await ratesCollection.find({}).toArray();
        if (!products || products.length === 0) {
            // Seed default values in DB
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
Tum Sargodha, Pakistan me ek premier Electric & Smart Switch Store ke highly professional, friendly aur natural Sales Assistant ho. 
Tumhara tone bilkul insano jaisa, relaxed aur madadgar hona chahiye. Kabhi adhoori baat ya robot jaisi ajeeb phrasing mat use karo.

==================================================
1. LANGUAGE & RESPONSE INSTRUCTIONS:
==================================================
- Jab tumhein bola jaye ke TEXT mode me jawab do: HAMESHA Aasaan Roman Urdu (English Alphabets) me jawab do. Clear, polite aur naturally likho.
- Jab tumhein bola jaye ke VOICE mode me jawab do: HAMESHA Pure Urdu Script (اردو رسم الخط) me mukammal aur ba-maani sentence likho taake audio natural sunayi de.
- Baat hamesha poori karo, kabhi adhoora sentence mat chhorna.

==================================================
2. STORE & LATEST PRODUCT RATES:
==================================================
Location: Sargodha, Punjab, Pakistan.
Current Product Rates:
${productsListText}

Delivery Details:
* Sargodha City: Same-day / Next-day Home Delivery.
* Across Pakistan: Courier service (TCS/Leopards) ke zariye 2-4 working days me.
Business Hours: 10:00 AM se 9:00 PM.

==================================================
3. CONVERSATION & SALES RULES:
==================================================
1. CHAT HISTORY CHECK: Message ka jawab dene se pehle purani chat history parho.
2. PRODUCT NAMES: Customers ko HAMESHA full aur proper product name batao, nickname kabhi mat use karo.
3. AGAR CUSTOMER TEXT / LIKH KAR / RATE LIST MAANGE: Toh poori details aur rate list clear formats mein text mein provide karo.
4. ORDER TAKING TRIGGER:
   - Jab customer bole: "Order kar do", "Parcel bhej do", "Pack kar do", "Send kar do", ya "Final karo":
   - Step A: Pehle order kiye gaye items aur total price ki confirmation do.
   - Step B: Customer se unki Delivery Details maango (Full Name, Address, Contact).
5. HUMAN HANDOVER:
   - Agar technical specification ya bulk demand ho jo pata na ho, toh bolo:
     Text Mode: "Main aap ka paigham store owner ko forward kar raha hoon. Woh jald hi aap se direct rabta kar ke guide kar dein ge."
     Voice Mode: "میں آپ کا پیغام اسٹور کے مالک کو فارورڈ کر رہا ہوں۔ وہ جلد ہی آپ سے براہ راست رابطہ کر کے گائیڈ کر دیں گے۔"
`;
}

// Male Urdu Voice Generator
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
                console.log("   APNE WHATSAPP SE NECHE DIYA GAYA QR SCAN KAREIN   ");
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

            // OWNER COMMANDS HANDLING (Only works from logged-in WhatsApp)
            if (isFromMe && text) {
                const cleanText = text.toLowerCase();

                // Bot Control Commands
                if (cleanText === 'off') {
                    pausedChats.add(sender);
                    await sock.sendMessage(sender, { delete: m.key });
                    return;
                }
                if (cleanText === 'start') {
                    pausedChats.delete(sender);
                    chatHistories[sender] = [];
                    await sock.sendMessage(sender, { delete: m.key });
                    return;
                }

                // Dynamic Rate Update Command: /ratechange [nickname] [new price]
                if (text.startsWith('/ratechange')) {
                    const parts = text.split(' ');
                    if (parts.length >= 3) {
                        const nickname = parts[1].toLowerCase();
                        const newPrice = parts.slice(2).join(' ');

                        let productName = defaultProducts[nickname]?.name || nickname;

                        // Check if exists in DB to retain existing full name
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

                        await sock.sendMessage(sender, { 
                            text: `✅ *Rate Updated Successfully!*\n\n📦 *Product:* ${productName}\n🏷️ *New Rate:* ${priceFormatted}` 
                        });
                    } else {
                        await sock.sendMessage(sender, { 
                            text: `❌ *Invalid Format!*\nUse: \`/ratechange wifi-switch 2000\`\nAvailable Nicknames:\n- \`wifi-switch\`\n- \`normal-switch\`\n- \`board\`\n- \`breaker\`` 
                        });
                    }
                    return;
                }

                // Show Current Rates List to Owner
                if (cleanText === '/ratelist') {
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
1. Pehle customer ke is Voice Note ko achhi tarah suno.
2. AGAR customer ne voice me "likh kar", "text me", "rate list", "list", "detail" wagaira maangi hai, toh JAWAB SIRF ROMAN URDU TEXT MEIN DO (Urdu script me mat dena).
3. AGAR customer ne normal baat ki hai aur text nahi maanga, toh JAWAB PURE URDU SCRIPT (اردو) MEIN MUKAMMAL JUMLON MEIN DO.
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
                        ? " [INSTRUCTION]: Jawab Sirf Urdu Script (اردو) me mukammal aur ba-maani 2-3 jumlo me do." 
                        : " [INSTRUCTION]: Jawab Roman Urdu (English Alphabets) me do. Clear aur mukammal baatein batao.";
                    promptPayload = text + formatInstruction;
                }

                while (chatHistories[sender].length > 0 && chatHistories[sender][0].role !== 'user') {
                    chatHistories[sender].shift();
                }

                const modelsToTry = [
                    "gemini-2.5-flash",
                    "gemini-2.5-flash-lite",
                    "gemini-1.5-flash"
                ];

                let responseText = null;

                // Fetch latest dynamic rates from MongoDB for prompt
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
                        console.warn(`Model ${modelName} failed/quota exceeded. Trying next... Error: ${apiErr.message}`);
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
                                mimetype: 'audio/ogg; codecs=opus',
                                ptt: true
                            }, { quoted: m });

                        } catch (audioErr) {
                            console.error("Voice Generation Error, sending text fallback:", audioErr);
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



