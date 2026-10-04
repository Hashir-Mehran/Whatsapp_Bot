// ============================================================
// ARRAIN BROS INC. - WhatsApp AI Sales Executive Bot
// ============================================================

require('dotenv').config();

const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const { MongoClient } = require('mongodb');
const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');
const path = require('path');

// DNS fix (network issues ke liye)
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

// ============================================================
// EXPRESS SERVER (Health Check - Render/Railway ke liye)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('✅ Arain Bros WhatsApp Bot is LIVE!'));
app.get('/ping', (req, res) => res.send('Pong! Health OK.'));

app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));

// ============================================================
// ENV VARIABLES CHECK
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

if (!GEMINI_API_KEY || !MONGO_URI) {
    console.error("❌ ERROR: GEMINI_API_KEY ya MONGO_URI missing hai!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ============================================================
// GLOBAL STATE VARIABLES
// ============================================================
const pausedChats = new Set();        // Bot off kiye gaye chats
const allowedGroups = new Set();      // Active groups
const chatHistories = {};             // Customer memory
const processedMessages = new Set();  // Duplicate prevention

const defaultProducts = {
    'normal':  { name: 'Standard / Normal Electric Switch & Socket', price: 'Rs. 150 - Rs. 350 per piece' },
    'wifi':    { name: 'Wi-Fi Touch Smart Switch (App & Voice Control)', price: 'Rs. 1,800 - Rs. 3,500 per piece' },
    'board':   { name: 'Complete Switchboard & Set', price: 'Rs. 800 - Rs. 2,500' },
    'breaker': { name: 'Circuit Breakers & Smart Distribution Boxes', price: 'Rs. 500 - Rs. 1,800' }
};

let mongoClient = null;
let isConnecting = false;
let ratesCollection = null;
let customRatesCollection = null;

// ============================================================
// MONGODB AUTH STATE (Baileys Session Persistence)
// ============================================================
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne(
        { _id: id },
        { _id: id, data: JSON.stringify(data, BufferJSON.replacer) },
        { upsert: true }
    );

    const readData = async (id) => {
        try {
            const doc = await collection.findOne({ _id: id });
            if (doc) return JSON.parse(doc.data, BufferJSON.reviver);
            return null;
        } catch { return null; }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        data[id] = await readData(`${type}-${id}`);
                    }));
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

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function cleanJidNumber(rawJid) {
    if (!rawJid) return '';
    return rawJid.split('@')[0].split(':')[0].trim();
}

// Fetch dynamic rates (General + Customer-specific)
async function getDynamicProductsText(customerJid = null) {
    try {
        let products = await ratesCollection.find({}).toArray();
        
        // Agar DB khali hai toh defaults insert karo
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

        // Customer-specific custom rates
        let customRatesMap = {};
        if (customerJid) {
            const phoneNum = cleanJidNumber(customerJid);
            const userCustomRates = await customRatesCollection.find({
                $or: [{ customerId: phoneNum }, { customerId: customerJid }]
            }).toArray();

            userCustomRates.forEach(cr => {
                customRatesMap[cr.nickname] = cr.price;
            });
        }

        let productStr = "";
        products.forEach(p => {
            const finalPrice = customRatesMap[p.nickname] || p.price;
            productStr += `- [${p.nickname}] ${p.name}: ${finalPrice}\n`;
        });
        return productStr;
    } catch (e) {
        console.error("Error getting dynamic rates:", e);
        return `- Standard Electric Switches: Rs. 150 - Rs. 350 per piece\n- Wi-Fi Touch Smart Switches: Rs. 1,800 - Rs. 3,500 per piece`;
    }
}

// ============================================================
// AI SYSTEM PROMPT (Sales Executive Personality)
// ============================================================
function getSystemPrompt(productsListText) {
    return `
You are an experienced, sharp, and polite Sales Executive for "Arain Bros, Inc." (Electric & Smart Switch Store) based in Sargodha, Punjab, Pakistan. You handle customer chats on WhatsApp.

==================================================
1. LOCAL MARKET DEALING & BEHAVIOR RULES (PAKISTANI STYLE)
==================================================
- FAST & DIRECT: Local customers prefer quick, short, to-the-point replies.
- NO REPETITIVE GREETINGS: Never repeat "Salam" in every message. Only say "Wa'alaikumsalam" if user sends greeting FIRST.
- NO ROBOTIC FLUFF: Avoid formal lines like "Arain Bros, Inc. mein aap ka khair khamdam hai".
- RESPECTFUL LANGUAGE: Always use "Aap", "G bilkul", "Ji haan", "Bhai", "Sir".
- CONVERSATION FLOW: Read chat history first. Track what customer is asking about.

==================================================
2. LANGUAGE & COMMUNICATION STYLE
==================================================
- TEXT MODE: Natural Roman Urdu (Pakistani WhatsApp typing). Short lines, bullet points, bold prices.
- VOICE MODE: Clear Urdu script (اردو رسم الخط) for TTS output. 2-3 complete sentences.

==================================================
3. CATALOG, PRICING & BUSINESS DETAILS
==================================================
Store Location: Sargodha, Punjab, Pakistan.
Business Hours: 10:00 AM to 9:00 PM (PKT).

Current Product & Rate List for this customer:
${productsListText}

Delivery & Payment:
- Sargodha City: Same-day/Next-day Cash on Delivery (COD) or shop pickup.
- All Pakistan: TCS / Leopards / Courier within 2-4 days.
- Advance/COD Policy: Mention total estimate clearly.

==================================================
4. HANDLING DISCOUNTS & BARGAINING (MOLE TOL)
==================================================
- If customer asks for discount ("Kuch kam karo", "Discount milega?", "Final price?"):
  - Polite answer: "Bhai yeh humari sub se reasonable aur final wholesale rates hain, quality A1 milegi. Agar aap bulk quantity lein ge toh management se baat karke best package de dein ge."

==================================================
5. ORDER CLOSING & ESCALATION
==================================================
- When user shows buying interest ("Order kar do", "Pack kar do", "Bhej do"):
  1. Confirm item, quantity, total bill.
  2. Request: Name (Naam), Full Address with landmark, Mobile Number.
- Human Support Transfer: For bulk orders or special deals:
  - Text: "Main aap ka number hamare sales manager ko pass kar raha hoon, woh aap se direct WhatsApp/Call par rabta kar lein ge."
  - Voice: "میں آپ کا نمبر ہمارے سیلز مینیجر کو پاس کر رہا ہوں، وہ آپ سے ڈائریکٹ رابطہ کر لیں گے۔"
`;
}

// ============================================================
// VOICE NOTE GENERATION (Urdu TTS)
// ============================================================
async function generateNaturalAudio(text, outputPath) {
    const tts = new EdgeTTS({
        voice: 'ur-PK-AsadNeural',
        lang: 'ur-PK',
        outputFormat: 'ogg-24khz-16bit-mono-opus'
    });
    await tts.ttsPromise(text, outputPath);
    return outputPath;
}

// ============================================================
// REQUEST DETECTION HELPERS
// ============================================================
function checkForTextRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const keywords = [
        'text', 'likh', 'likho', 'likha', 'likhna', 'likh kar', 'likh ke', 'likh do',
        'message me', 'msg me', 'text me', 'rate list', 'ratelist', 'rates', 'list',
        'detail', 'details', 'تکست', 'لکھ', 'ریٹ', 'لسٹ'
    ];
    return keywords.some(k => lower.includes(k));
}

function checkForVoiceRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const keywords = [
        'voice', 'vois', 'vn', 'voice note', 'voice me', 'voice main',
        'bol ke', 'bol kar', 'bolen', 'bolo', 'batao voice', 'audio',
        'آواز', 'وائس'
    ];
    return keywords.some(k => lower.includes(k));
}

// ============================================================
// COMMAND HANDLER (Owner Commands)
// ============================================================
async function handleOwnerCommand(sock, m, text, sender) {
    const cleanText = text.toLowerCase().trim();

    // Delete owner command silently
    const deleteCommandMsg = async () => {
        try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) {}
    };

    // Auto-delete bot reply after N seconds
    const autoDelete = async (sentMsg, delay = 5000) => {
        setTimeout(async () => {
            try { await sock.sendMessage(sender, { delete: sentMsg.key }); } catch (err) {}
        }, delay);
    };

    // -------- ON / OFF --------
    if (cleanText === 'off' || cleanText === 'stop') {
        pausedChats.add(sender);
        await deleteCommandMsg();
        return true;
    }
    if (cleanText === 'on' || cleanText === 'start') {
        pausedChats.delete(sender);
        chatHistories[sender] = [];
        await deleteCommandMsg();
        return true;
    }

    // -------- /addproduct --------
    if (text.startsWith('/addproduct')) {
        await deleteCommandMsg();
        const rawContent = text.replace('/addproduct', '').trim();
        const parts = rawContent.split('|').map(p => p.trim());

        if (parts.length >= 3) {
            const nickname = parts[0].toLowerCase();
            const fullName = parts[1];
            const price = parts[2].toLowerCase().includes('rs') ? parts[2] : `Rs. ${parts[2]}`;

            await ratesCollection.updateOne(
                { nickname },
                { $set: { nickname, name: fullName, price } },
                { upsert: true }
            );

            Object.keys(chatHistories).forEach(k => delete chatHistories[k]);

            const sentMsg = await sock.sendMessage(sender, {
                text: `✅ *New Product Added!*\n📦 *Key:* \`${nickname}\`\n📛 *Name:* ${fullName}\n🏷️ *Price:* ${price}`
            });
            autoDelete(sentMsg, 6000);
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `❌ *Format:* \`/addproduct nickname | Full Name | Price\`\n*Example:* \`/addproduct socket | 13A Multi Socket | 450\``
            });
            autoDelete(sentMsg, 8000);
        }
        return true;
    }

    // -------- /customrate --------
    if (text.startsWith('/customrate')) {
        await deleteCommandMsg();
        const parts = text.split(' ').filter(p => p.trim().length > 0);

        if (parts.length >= 4) {
            const customerId = cleanJidNumber(parts[1]);
            const nickname = parts[2].toLowerCase();
            const rateValue = parts.slice(3).join(' ').trim();

            if (['cancel', 'reset', 'delete'].includes(rateValue.toLowerCase())) {
                await customRatesCollection.deleteOne({ customerId, nickname });
                delete chatHistories[`${customerId}@s.whatsapp.net`];

                const sentMsg = await sock.sendMessage(sender, {
                    text: `✅ *Custom Rate Cancelled!*\n👤 *Customer:* \`${customerId}\`\n📦 *Product:* \`${nickname}\`\nℹ️ Ab normal rates show honge.`
                });
                autoDelete(sentMsg, 6000);
            } else {
                const formattedPrice = rateValue.toLowerCase().includes('rs') ? rateValue : `Rs. ${rateValue}`;
                await customRatesCollection.updateOne(
                    { customerId, nickname },
                    { $set: { customerId, nickname, price: formattedPrice, updatedAt: new Date() } },
                    { upsert: true }
                );
                delete chatHistories[`${customerId}@s.whatsapp.net`];

                const sentMsg = await sock.sendMessage(sender, {
                    text: `✅ *Custom Rate Set!*\n👤 *Customer:* \`${customerId}\`\n📦 *Product:* \`${nickname}\`\n🏷️ *Special Rate:* ${formattedPrice}`
                });
                autoDelete(sentMsg, 6000);
            }
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `❌ *Format:*\n• Set: \`/customrate 923001234567 wifi 1500\`\n• Cancel: \`/customrate 923001234567 wifi cancel\``
            });
            autoDelete(sentMsg, 8000);
        }
        return true;
    }

    // -------- /customlist --------
    if (cleanText === '/customlist') {
        await deleteCommandMsg();
        const list = await customRatesCollection.find({}).toArray();
        let outStr = list.length === 0
            ? "ℹ️ Koi custom rate active nahi hai."
            : "📊 *Active Custom Rates:*\n\n";
        list.forEach(c => {
            outStr += `👤 ${c.customerId} | 📦 \`${c.nickname}\` ➔ 🏷️ ${c.price}\n`;
        });
        const sentMsg = await sock.sendMessage(sender, { text: outStr });
        autoDelete(sentMsg, 15000);
        return true;
    }

    // -------- /rate --------
    if (text.startsWith('/rate')) {
        await deleteCommandMsg();
        const parts = text.split(' ');
        if (parts.length >= 3) {
            const nickname = parts[1].toLowerCase();
            const newPrice = parts.slice(2).join(' ');

            let productName = defaultProducts[nickname]?.name || nickname;
            const existingDoc = await ratesCollection.findOne({ nickname });
            if (existingDoc?.name) productName = existingDoc.name;

            const priceFormatted = newPrice.toLowerCase().includes('rs') ? newPrice : `Rs. ${newPrice}`;

            await ratesCollection.updateOne(
                { nickname },
                { $set: { nickname, name: productName, price: priceFormatted } },
                { upsert: true }
            );

            Object.keys(chatHistories).forEach(k => delete chatHistories[k]);

            const sentMsg = await sock.sendMessage(sender, {
                text: `✅ *Rate Updated!*\n📦 \`${nickname}\`\n🏷️ ${priceFormatted}`
            });
            autoDelete(sentMsg, 5000);
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `❌ *Format:* \`/rate wifi 2000\``
            });
            autoDelete(sentMsg, 5000);
        }
        return true;
    }

    // -------- /rename --------
    if (text.startsWith('/rename')) {
        await deleteCommandMsg();
        const parts = text.split(' ');
        if (parts.length >= 3) {
            const nickname = parts[1].toLowerCase();
            const newName = parts.slice(2).join(' ');

            const existingDoc = await ratesCollection.findOne({ nickname });
            const currentPrice = existingDoc?.price || defaultProducts[nickname]?.price || 'Rs. 0';

            await ratesCollection.updateOne(
                { nickname },
                { $set: { nickname, name: newName, price: currentPrice } },
                { upsert: true }
            );

            Object.keys(chatHistories).forEach(k => delete chatHistories[k]);

            const sentMsg = await sock.sendMessage(sender, {
                text: `✅ *Name Updated!*\n📦 \`${nickname}\`\n🏷️️ ${newName}`
            });
            autoDelete(sentMsg, 5000);
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `❌ *Format:* \`/rename wifi Smart Touch Board\``
            });
            autoDelete(sentMsg, 5000);
        }
        return true;
    }

    // -------- /list or /rates --------
    if (['/list', '/rates', '/ratelist'].includes(cleanText)) {
        await deleteCommandMsg();
        const currentRatesText = await getDynamicProductsText();
        const sentMsg = await sock.sendMessage(sender, {
            text: `📋 *Current Product & Rates:*\n\n${currentRatesText}`
        });
        autoDelete(sentMsg, 20000);
        return true;
    }

    return false;
}

// ============================================================
// GROUP COMMAND HANDLER
// ============================================================
async function handleGroupCommand(sock, m, text, sender) {
    const cleanText = text.toLowerCase().trim();

    if (cleanText === 'gon' || cleanText === 'groupchaton') {
        allowedGroups.add(sender);
        try {
            await sock.sendMessage(sender, {
                delete: { remoteJid: sender, fromMe: true, id: m.key.id, participant: m.key.participant }
            });
        } catch (e) { console.error("Group cmd delete error:", e); }
        return true;
    }

    if (['goff', 'groupchatoff', 'off', 'stop'].includes(cleanText)) {
        allowedGroups.delete(sender);
        try {
            await sock.sendMessage(sender, {
                delete: { remoteJid: sender, fromMe: true, id: m.key.id, participant: m.key.participant }
            });
        } catch (e) { console.error("Group cmd delete error:", e); }
        return true;
    }

    return false;
}

// ============================================================
// MAIN BOT START FUNCTION
// ============================================================
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
        customRatesCollection = db.collection('customer_custom_rates');

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

        // -------- Connection Update --------
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log("\n==================================================");
                console.log("    SCAN THIS QR CODE WITH YOUR WHATSAPP");
                console.log("==================================================\n");
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                isConnecting = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("⚠️ Logged out! Clearing DB session...");
                    await collection.deleteMany({});
                    setTimeout(() => startBot(), 3000);
                } else if (shouldReconnect) {
                    setTimeout(() => startBot(), 3000);
                }
            } else if (connection === 'open') {
                isConnecting = false;
                console.log('\n✅ WhatsApp Bot Connected Successfully!\n');
            }
        });

        // -------- Message Upsert Handler --------
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            const m = messages[0];
            if (!m || !m.message) return;

            // Duplicate check
            const msgId = m.key.id;
            if (processedMessages.has(msgId)) return;
            processedMessages.add(msgId);
            if (processedMessages.size > 1000) processedMessages.clear();

            const sender = m.key.remoteJid;
            const isGroup = sender.endsWith('@g.us');
            const isFromMe = m.key.fromMe;
            const isAudio = !!m.message.audioMessage;
            const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

            // ==========================================
            // GROUP HANDLING
            // ==========================================
            if (isGroup) {
                if (isFromMe) {
                    const handled = await handleGroupCommand(sock, m, text, sender);
                    if (handled) return;
                }
                if (!allowedGroups.has(sender)) return;
            }

            // ==========================================
            // OWNER COMMANDS (Personal Chat Only)
            // ==========================================
            if (isFromMe && text && !isGroup) {
                const handled = await handleOwnerCommand(sock, m, text, sender);
                if (handled) return;
                return;
            }

            // Skip if paused, empty, or self
            if (!isGroup && pausedChats.has(sender)) return;
            if (!isAudio && !text) return;
            if (isFromMe) return;

            // Initialize history
            if (!chatHistories[sender]) chatHistories[sender] = [];

            try {
                // ==========================================
                // MODE DECISION: Voice or Text
                // ==========================================
                let sendAsVoice = false;

                if (isAudio) {
                    sendAsVoice = true;
                } else {
                    const userWantsVoice = checkForVoiceRequest(text);
                    const userWantsText = checkForTextRequest(text);
                    sendAsVoice = userWantsVoice && !userWantsText;
                }

                // ==========================================
                // BUILD PROMPT PAYLOAD
                // ==========================================
                let promptPayload;

                if (isAudio) {
                    const audioBuffer = await downloadMediaMessage(m, 'buffer', {});
                    const formatInstruction = `
[INSTRUCTION]:
1. Customer ki voice note sun kar jawab do.
2. Agar customer ne voice me "likh kar", "text me", "rate list", "list", "detail" maangi ho, toh Roman Urdu TEXT me reply do.
3. Warna normal dialogue ke liye PURE URDU SCRIPT (اردو) me 2-3 sentences me jawab do.
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
                        ? " [INSTRUCTION]: Jawab SIRF PURE URDU SCRIPT (اردو) me 2-3 complete sentences me do."
                        : " [INSTRUCTION]: Jawab Roman Urdu (English alphabets) me do. Polite aur clear rakhna.";
                    promptPayload = text + formatInstruction;
                }

                // ==========================================
                // MEMORY MANAGEMENT (Last 10 messages)
                // ==========================================
                if (chatHistories[sender].length > 10) {
                    chatHistories[sender] = chatHistories[sender].slice(-10);
                }
                while (chatHistories[sender].length > 0 && chatHistories[sender][0].role !== 'user') {
                    chatHistories[sender].shift();
                }

                // ==========================================
                // AI MODEL FALLBACK LIST
                // ==========================================
                const modelsToTry = [
                   "gemini-3.5-flash-lite",
                    "gemini-3.5-flash",
                    "gemini-3.1-flash-lite",
                    "gemini-2.5-flash",
                    "gemini-flash-lite-latest",
                    "gemini-flash-latest"

                ];

                let responseText = null;
                const currentRatesText = await getDynamicProductsText(sender);
                const currentSystemPrompt = getSystemPrompt(currentRatesText);

                // ==========================================
                // GEMINI API CALL WITH FALLBACK
                // ==========================================
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
                        console.log(`✅ AI responded using: ${modelName}`);
                        break;
                    } catch (apiErr) {
                        console.warn(`⚠️ Model ${modelName} failed: ${apiErr.message}`);
                        if (modelName === modelsToTry[modelsToTry.length - 1]) throw apiErr;
                    }
                }

                // ==========================================
                // SEND RESPONSE
                // ==========================================
                if (responseText) {
                    // Save to memory
                    chatHistories[sender].push({ role: 'user', parts: [{ text: isAudio ? '[Voice Note]' : text }] });
                    chatHistories[sender].push({ role: 'model', parts: [{ text: responseText }] });

                    // Check if response is Urdu script
                    const isUrduScript = /[\u0600-\u06FF]/.test(responseText);

                    // If AI wrote a text-request answer in Roman Urdu, send as text
                    if (isAudio && checkForTextRequest(responseText)) sendAsVoice = false;

                    // SEND VOICE NOTE
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

                            console.log(`🎙️ Voice note sent to ${sender}`);
                        } catch (audioErr) {
                            console.error("Voice generation failed, sending text:", audioErr);
                            await sock.sendMessage(sender, { text: responseText }, { quoted: m });
                        } finally {
                            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                        }
                    } else {
                        // SEND TEXT
                        await sock.sendMessage(sender, { text: responseText }, { quoted: m });
                    }
                }

            } catch (error) {
                console.error("❌ Message handling error:", error);
            }
        });

    } catch (err) {
        isConnecting = false;
        console.error("❌ Startup Error:", err);
        setTimeout(() => startBot(), 5000);
    }
}

// ============================================================
// START THE BOT
// ============================================================
startBot();