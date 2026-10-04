// ============================================================
// ARRAIN BROS INC. - WhatsApp AI Sales Executive Bot (v3.0 FINAL)
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

// DNS fix
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

// ============================================================
// EXPRESS SERVER (Health Check)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('✅ Arain Bros WhatsApp Bot is LIVE!'));
app.get('/ping', (req, res) => res.send('Pong! Health OK.'));

app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));

// ============================================================
// ENV VARIABLES
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

if (!GEMINI_API_KEY || !MONGO_URI) {
    console.error("❌ ERROR: GEMINI_API_KEY ya MONGO_URI missing hai!");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ============================================================
// GLOBAL STATE
// ============================================================
const pausedChats = new Set();
const allowedGroups = new Set();
const chatHistories = {};
const processedMessages = new Set();

const defaultProducts = {
    'wifi':       { name: 'Wi-Fi Touch Smart Switch (App & Voice Control)', price: 'Rs. 4,500 per piece' },
    'normal':     { name: 'Standard Electric Switch & Socket', price: 'Rs. 150 - Rs. 350 per piece' },
    'board':      { name: 'Complete Switchboard & Set', price: 'Rs. 800 - Rs. 2,500' },
    'breaker':    { name: 'Circuit Breakers & Smart Distribution Boxes', price: 'Rs. 2,000 - Rs. 4,000' },
    'breaker_sm': { name: 'Circuit Breaker (Small)', price: 'Rs. 1,000 - Rs. 2,000' },
    'usocket':    { name: 'Universal Socket (10A)', price: "Rate jaan'ne ke liye quantity bata dein." }
};

let mongoClient = null;
let isConnecting = false;
let ratesCollection = null;
let customRatesCollection = null;

// ============================================================
// MONGODB AUTH STATE
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
// HELPERS
// ============================================================
function cleanJidNumber(rawJid) {
    if (!rawJid) return '';
    let num = rawJid.split('@')[0];
    num = num.split(':')[0];
    num = num.replace(/\D/g, '');
    return num;
}

function normalizePhone(raw) {
    if (!raw) return '';
    let num = String(raw).replace(/\D/g, '');
    if (num.startsWith('0')) num = '92' + num.slice(1);
    if (num.length === 10 && num.startsWith('3')) num = '92' + num;
    return num;
}

// ============================================================
// GET DYNAMIC PRODUCTS (with custom rates)
// ============================================================
async function getDynamicProductsText(customerJid = null) {
    try {
        let products = await ratesCollection.find({}).toArray();

        if (!products || products.length === 0) {
            for (const key of Object.keys(defaultProducts)) {
                await ratesCollection.updateOne(
                    { nickname: key },
                    {
                        $set: {
                            nickname: key,
                            name: defaultProducts[key].name,
                            price: defaultProducts[key].price,
                            updatedAt: new Date()
                        },
                        $setOnInsert: { createdAt: new Date() }
                    },
                    { upsert: true }
                );
            }
            products = await ratesCollection.find({}).toArray();
        }

        let customRatesMap = {};
        if (customerJid) {
            const phoneNum = cleanJidNumber(customerJid);
            const normalizedPhone = normalizePhone(phoneNum);

            const userCustomRates = await customRatesCollection.find({
                $or: [
                    { customerId: phoneNum },
                    { customerId: normalizedPhone },
                    { customerId: customerJid },
                    { customerId: `+${normalizedPhone}` },
                    { customerId: `0${normalizedPhone.slice(2)}` }
                ]
            }).toArray();

            console.log(`🔍 Custom rate lookup for ${phoneNum}: found ${userCustomRates.length} entries`);

            userCustomRates.forEach(cr => {
                customRatesMap[cr.nickname] = cr.price;
            });
        }

        let productStr = "";
        products.forEach(p => {
            const finalPrice = customRatesMap[p.nickname] || p.price;
            const marker = customRatesMap[p.nickname] ? ' ⭐ (Special Rate)' : '';
            productStr += `- [${p.nickname}] ${p.name}: ${finalPrice}${marker}\n`;
        });
        return productStr;
    } catch (e) {
        console.error("Error getting dynamic rates:", e);
        return `- Standard Electric Switches: Rs. 150 - Rs. 350 per piece\n- Wi-Fi Touch Smart Switches: Rs. 4,500 per piece`;
    }
}

// ============================================================
// GET RECENT PRODUCTS (last N days)
// ============================================================
async function getRecentProducts(days = 30) {
    try {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const recent = await ratesCollection.find({
            $or: [
                { createdAt: { $gte: cutoff } },
                { updatedAt: { $gte: cutoff } }
            ]
        }).sort({ createdAt: -1, updatedAt: -1 }).toArray();

        if (recent.length === 0) return null;

        let out = "";
        recent.forEach(p => {
            const dateStr = p.createdAt
                ? new Date(p.createdAt).toLocaleDateString('en-PK')
                : 'Recently added';
            out += `🆕 *${p.name}* (\`${p.nickname}\`)\n   🏷️ ${p.price}\n   📅 ${dateStr}\n\n`;
        });
        return out;
    } catch (e) {
        console.error("Error fetching recent products:", e);
        return null;
    }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
function getSystemPrompt(productsListText) {
    return `
You are an experienced, sharp, and polite Sales Executive for "Arain Bros, Inc." (Electric & Smart Switch Store) based in Sargodha, Punjab, Pakistan. You handle customer chats on WhatsApp.

==================================================
1. LOCAL MARKET DEALING & BEHAVIOR RULES
==================================================
- FAST & DIRECT: Local customers prefer quick, short, to-the-point replies.
- NO REPETITIVE GREETINGS: Only say "Wa'alaikumsalam" if user greets FIRST.
- NO ROBOTIC FLUFF: Avoid formal corporate intros.
- RESPECTFUL LANGUAGE: Use "Aap", "G bilkul", "Ji haan", "Bhai", "Sir".
- CONVERSATION FLOW: Read history first. Track what customer is asking.

==================================================
2. LANGUAGE STYLE
==================================================
- TEXT MODE: Natural Roman Urdu, short lines, bullet points, bold prices.
- VOICE MODE: Clear Urdu script (اردو رسم الخط), 2-3 complete sentences.

==================================================
3. PRODUCT LIST RULES (VERY IMPORTANT!)
==================================================
- ALWAYS quote the FULL product name (not just last word).
  ✅ CORRECT: "Universal Socket (10A)"
  ❌ WRONG: "Socket" or "Universal"

- When customer asks "Koi naya product?" / "New items?" / "Kya naya hai?":
  → Politely list NEWLY ADDED products with FULL names.
  → If none new, share a couple of popular items from the full list.

- When customer asks about ANY product, use the EXACT name from the list below.
- If customer shortens (e.g. "wifi switch"), map to the full name from list.

==================================================
4. CATALOG & PRICING (FOR THIS CUSTOMER)
==================================================
Store: Sargodha, Punjab, Pakistan.
Business Hours: 10:00 AM - 9:00 PM (PKT).

${productsListText}

⭐ Products marked "Special Rate" are VIP/custom rates for THIS customer. Always quote these.

==================================================
5. DELIVERY & PAYMENT
==================================================
- Sargodha City: Same-day/Next-day COD or shop pickup.
- All Pakistan: TCS / Leopards within 2-4 days.

==================================================
6. DISCOUNT HANDLING (MOLE TOL)
==================================================
If customer asks discount:
"Bhai yeh final wholesale rates hain, quality A1 milegi. Bulk quantity pe management se best package de dein ge."

==================================================
7. ORDER CLOSING
==================================================
When user says "Order kar do" / "Pack kar do":
  1. Confirm item, quantity, total bill.
  2. Request: Naam, Poora Pata (with landmark), Mobile Number.

Human Support Transfer (bulk/VIP):
  - Text: "Main aap ka number sales manager ko pass kar raha hoon, woh direct rabta kar lein ge."
  - Voice: "میں آپ کا نمبر ہمارے سیلز مینیجر کو پاس کر رہا ہوں، وہ آپ سے ڈائریکٹ رابطہ کر لیں گے۔"
`;
}

// ============================================================
// VOICE GENERATION
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
// DETECTION HELPERS
// ============================================================
function checkForTextRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const keywords = ['text', 'likh', 'likho', 'likha', 'likhna', 'likh kar', 'likh ke', 'likh do',
        'message me', 'msg me', 'text me', 'rate list', 'ratelist', 'rates', 'list',
        'detail', 'details', 'تکست', 'لکھ', 'ریٹ', 'لسٹ'];
    return keywords.some(k => lower.includes(k));
}

function checkForVoiceRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const keywords = ['voice', 'vois', 'vn', 'voice note', 'voice me', 'voice main',
        'bol ke', 'bol kar', 'bolen', 'bolo', 'batao voice', 'audio', 'آواز', 'وائس'];
    return keywords.some(k => lower.includes(k));
}

// ============================================================
// OWNER COMMAND HANDLER (Self-Chat Me Delete Nahi)
// ============================================================
async function handleOwnerCommand(sock, m, text, sender) {
    const cleanText = text.toLowerCase().trim();

    // ✅ Detect: Owner apne "You" chat me hai?
    const isSelfChat = (() => {
        try {
            const myNumber = cleanJidNumber(sock.user?.id || '');
            const senderNumber = cleanJidNumber(sender);
            return myNumber && senderNumber && myNumber === senderNumber;
        } catch { return false; }
    })();

    // ✅ Sirf customer chats me command delete karo
    const deleteCommandMsg = async () => {
        if (isSelfChat) return;
        try { await sock.sendMessage(sender, { delete: m.key }); } catch (e) {}
    };

    // ✅ Sirf customer chats me reply auto-delete karo
    const autoDelete = async (sentMsg, delay = 5000) => {
        if (isSelfChat) return;
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
                {
                    $set: { nickname, name: fullName, price, updatedAt: new Date() },
                    $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true }
            );

            Object.keys(chatHistories).forEach(k => delete chatHistories[k]);

            const sentMsg = await sock.sendMessage(sender, {
                text: `✅ *New Product Added!*\n📦 *Key:* \`${nickname}\`\n📛 *Name:* ${fullName}\n🏷️ *Price:* ${price}`
            });
            autoDelete(sentMsg, 6000);
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `❌ *Format:* \`/addproduct nickname | Full Name | Price\`\n*Example:* \`/addproduct usocket | Universal Socket (10A) | Qty batao\``
            });
            autoDelete(sentMsg, 8000);
        }
        return true;
    }

    // -------- /newlist --------
    if (cleanText === '/newlist' || cleanText === '/newproducts') {
        await deleteCommandMsg();
        const recentText = await getRecentProducts(30);
        if (!recentText) {
            const sentMsg = await sock.sendMessage(sender, {
                text: "ℹ️ Pichle 30 din me koi naya product add nahi hua."
            });
            autoDelete(sentMsg, 6000);
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `🆕 *Recently Added Products (Last 30 Days):*\n\n${recentText}`
            });
            autoDelete(sentMsg, 25000);
        }
        return true;
    }

    // -------- /customrate --------
    if (text.startsWith('/customrate')) {
        await deleteCommandMsg();
        const parts = text.split(' ').filter(p => p.trim().length > 0);

        if (parts.length >= 4) {
            const rawCustomer = parts[1];
            const customerId = normalizePhone(rawCustomer);
            const nickname = parts[2].toLowerCase();
            const rateValue = parts.slice(3).join(' ').trim();

            if (['cancel', 'reset', 'delete'].includes(rateValue.toLowerCase())) {
                await customRatesCollection.deleteMany({
                    $or: [
                        { customerId },
                        { customerId: rawCustomer },
                        { customerId: `+${customerId}` },
                        { customerId: `0${customerId.slice(2)}` }
                    ],
                    nickname
                });

                Object.keys(chatHistories).forEach(k => {
                    if (cleanJidNumber(k) === customerId) delete chatHistories[k];
                });

                const sentMsg = await sock.sendMessage(sender, {
                    text: `✅ *Custom Rate Cancelled!*\n👤 *Customer:* \`${customerId}\`\n📦 *Product:* \`${nickname}\`\nℹ️ Ab normal rates show honge.`
                });
                autoDelete(sentMsg, 6000);
            } else {
                const formattedPrice = rateValue.toLowerCase().includes('rs') ? rateValue : `Rs. ${rateValue}`;

                await customRatesCollection.updateOne(
                    { customerId, nickname },
                    {
                        $set: { customerId, nickname, price: formattedPrice, updatedAt: new Date() },
                        $setOnInsert: { createdAt: new Date() }
                    },
                    { upsert: true }
                );

                Object.keys(chatHistories).forEach(k => {
                    if (cleanJidNumber(k) === customerId) delete chatHistories[k];
                });

                const sentMsg = await sock.sendMessage(sender, {
                    text: `✅ *Custom Rate Set!*\n👤 *Customer:* \`${customerId}\`\n📦 *Product:* \`${nickname}\`\n🏷️ *Special Rate:* ${formattedPrice}\n\nℹ️ Ab jab yeh customer poochega, yeh rate hi batayega.`
                });
                autoDelete(sentMsg, 7000);
            }
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `❌ *Format:*\n• Set: \`/customrate 923001234567 wifi 4000\`\n• Cancel: \`/customrate 923001234567 wifi cancel\``
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
                {
                    $set: { nickname, name: productName, price: priceFormatted, updatedAt: new Date() },
                    $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true }
            );

            Object.keys(chatHistories).forEach(k => delete chatHistories[k]);

            const sentMsg = await sock.sendMessage(sender, {
                text: `✅ *Rate Updated!*\n📦 \`${nickname}\`\n🏷️ ${priceFormatted}`
            });
            autoDelete(sentMsg, 5000);
        } else {
            const sentMsg = await sock.sendMessage(sender, {
                text: `❌ *Format:* \`/rate wifi 4500\``
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
                {
                    $set: { nickname, name: newName, price: currentPrice, updatedAt: new Date() },
                    $setOnInsert: { createdAt: new Date() }
                },
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

    // -------- /list --------
    if (['/list', '/rates', '/ratelist'].includes(cleanText)) {
        await deleteCommandMsg();
        const currentRatesText = await getDynamicProductsText();
        const sentMsg = await sock.sendMessage(sender, {
            text: `📋 *Current Product & Rates:*\n\n${currentRatesText}`
        });
        autoDelete(sentMsg, 20000);
        return true;
    }

    // -------- /seed --------
    if (cleanText === '/seed') {
        await deleteCommandMsg();
        for (const key of Object.keys(defaultProducts)) {
            await ratesCollection.updateOne(
                { nickname: key },
                {
                    $set: { nickname: key, name: defaultProducts[key].name, price: defaultProducts[key].price, updatedAt: new Date() },
                    $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true }
            );
        }
        Object.keys(chatHistories).forEach(k => delete chatHistories[k]);
        const sentMsg = await sock.sendMessage(sender, { text: "✅ Default products seeded/updated successfully!" });
        autoDelete(sentMsg, 5000);
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
// MAIN BOT START
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

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            const m = messages[0];
            if (!m || !m.message) return;

            const msgId = m.key.id;
            if (processedMessages.has(msgId)) return;
            processedMessages.add(msgId);
            if (processedMessages.size > 1000) processedMessages.clear();

            const sender = m.key.remoteJid;
            const isGroup = sender.endsWith('@g.us');
            const isFromMe = m.key.fromMe;
            const isAudio = !!m.message.audioMessage;
            const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();

            // GROUP HANDLING
            if (isGroup) {
                if (isFromMe) {
                    const handled = await handleGroupCommand(sock, m, text, sender);
                    if (handled) return;
                }
                if (!allowedGroups.has(sender)) return;
            }

            // OWNER COMMANDS (Personal Chat Only)
            if (isFromMe && text && !isGroup) {
                const handled = await handleOwnerCommand(sock, m, text, sender);
                if (handled) return;
                return;
            }

            if (!isGroup && pausedChats.has(sender)) return;
            if (!isAudio && !text) return;
            if (isFromMe) return;

            if (!chatHistories[sender]) chatHistories[sender] = [];

            try {
                let sendAsVoice = false;
                if (isAudio) {
                    sendAsVoice = true;
                } else {
                    const userWantsVoice = checkForVoiceRequest(text);
                    const userWantsText = checkForTextRequest(text);
                    sendAsVoice = userWantsVoice && !userWantsText;
                }

                let promptPayload;
                if (isAudio) {
                    const audioBuffer = await downloadMediaMessage(m, 'buffer', {});
                    const formatInstruction = `
[INSTRUCTION]:
1. Customer ki voice note sun kar jawab do.
2. Agar customer ne voice me "likh kar", "text me", "rate list", "list", "detail" maangi ho, toh Roman Urdu TEXT me reply do.
3. Warna normal dialogue ke liye PURE URDU SCRIPT (اردو) me 2-3 sentences me jawab do.
4. IMPORTANT: Product ka POORA naam use karo (jaise "Universal Socket (10A)", na ke sirf "Socket").
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
                        ? " [INSTRUCTION]: Jawab SIRF PURE URDU SCRIPT (اردو) me 2-3 complete sentences me do. Product ka POORA naam use karo."
                        : " [INSTRUCTION]: Jawab Roman Urdu (English alphabets) me do. Polite aur clear rakhna. Product ka POORA naam use karo (jaise 'Universal Socket (10A)', 'Wi-Fi Touch Smart Switch').";
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

                const currentRatesText = await getDynamicProductsText(sender);
                const recentProductsText = await getRecentProducts(30);

                let fullProductsText = currentRatesText;
                if (recentProductsText) {
                    fullProductsText += `\n\n🆕 RECENTLY ADDED (Last 30 Days) — mention when customer asks "kya naya hai?":\n${recentProductsText}`;
                }

                const currentSystemPrompt = getSystemPrompt(fullProductsText);

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

                if (responseText) {
                    chatHistories[sender].push({ role: 'user', parts: [{ text: isAudio ? '[Voice Note]' : text }] });
                    chatHistories[sender].push({ role: 'model', parts: [{ text: responseText }] });

                    const isUrduScript = /[\u0600-\u06FF]/.test(responseText);

                    if (isAudio && checkForTextRequest(responseText)) sendAsVoice = false;

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

startBot();