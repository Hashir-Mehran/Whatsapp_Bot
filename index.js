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
const processedMessages = new Set(); // Duplicate messages block karne ke liye

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

const systemPrompt = `
Tum Sargodha, Pakistan me ek premier Electric & Smart Switch Store ke highly professional, friendly aur expert Sales Assistant ho. 
Tumhara maqsad WhatsApp par aane wale customers ke sawalat ka jawab dena, unki zaroorat ke mutabiq products suggest karna, aur orders confirm karwana hai.

==================================================
1. LANGUAGE & TONE RULES:
==================================================
- AGAR RESPONSE TEXT FORM MEIN HO: To HAMESHA Aasaan Roman Urdu (English Alphabets) me jawab do. (e.g., "Assalam-o-Alaikum! Hamari shop par khushamdeed.").
- AGAR RESPONSE VOICE NOTE FORM MEIN HO: To HAMESHA Pure Urdu Script (اردو رسم الخط) me jawab do taake TTS voice clear aaye. (e.g., "السلام علیکم! ہمارے اسٹور میں خوش آمدید").
- Boht mukhtasar (Short & Concise) jawab do. 1 se 3 jumlon se ziada lamba jawab mat do.

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
1. CHAT HISTORY CHECK: Message ka jawab dene se pehle purani chat history parho.
2. NEED ASSESSMENT: Agar customer pooche ke konsa switch behtar hai, toh unse unki requirement (Normal Wiring ya Smart Home Setup) poocho.
3. PRICE FLEXIBILITY: Price par bargain karein toh polite raho.
4. ORDER TAKING TRIGGER:
   - Jab customer bole: "Order kar do", "Parcel bhej do", "Pack kar do", "Send kar do", ya "Final karo":
   - Step A: Pehle order kiye gaye items aur total price ki confirmation do.
   - Step B: Customer se unki Delivery Details maango (Full Name, Address, Contact).
5. HUMAN HANDOVER:
   - Agar technical specification ya bulk demand ho jo pata na ho, toh bolo:
     Text Mode: "Main aap ka paigham store owner ko forward kar raha hoon. Woh jald hi aap se direct rabta kar ke guide kar dein ge."
     Voice Mode: "میں آپ کا پیغام اسٹور کے مالک کو فارورڈ کر رہا ہوں۔ وہ جلد ہی آپ سے براہ راست رابطہ کر کے گائیڈ کر دیں گے۔"

==================================================
4. STRICT RESTRICTIONS:
==================================================
- Extra baatein mat karo, faaltu lamba text mat likho.
`;

let mongoClient = null;
let isConnecting = false;

// Clear Pakistani Urdu Voice Generator
async function generateNaturalAudio(text, outputPath) {
    const tts = new EdgeTTS({
        voice: 'ur-PK-UzmaNeural', // Clean Natural Pakistani Urdu Voice
        lang: 'ur-PK',
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
    });
    await tts.ttsPromise(text, outputPath);
    return outputPath;
}

// User ki demand check karne ke keywords
function checkForVoiceRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const voiceKeywords = ['voice', 'vois', 'vn', 'voice note', 'voice me', 'voice main', 'bol ke', 'bol kar', 'bolen', 'bolo', 'batao voice', 'audio', 'آواز', 'وائس'];
    return voiceKeywords.some(keyword => lower.includes(keyword));
}

function checkForTextRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const textKeywords = ['text', 'likh kar', 'likh ke', 'message me', 'msg me', 'text me', 'likho', 'likh do', 'تکست', 'لکھ'];
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

            if (isFromMe && text) {
                const cleanText = text.toLowerCase();
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
                return;
            }

            if (pausedChats.has(sender)) return;
            if (!isAudio && !text) return;

            if (!chatHistories[sender]) chatHistories[sender] = [];

            try {
                // Determine whether output should be voice or text first
                const userWantsText = checkForTextRequest(text);
                const userWantsVoice = checkForVoiceRequest(text);

                let sendAsVoice = false;
                if (userWantsText) {
                    sendAsVoice = false;
                } else if (userWantsVoice) {
                    sendAsVoice = true;
                } else {
                    sendAsVoice = isAudio;
                }

                let promptPayload;

                if (isAudio) {
                    const audioBuffer = await downloadMediaMessage(m, 'buffer', {});
                    const formatInstruction = sendAsVoice 
                        ? "Is audio ko suno. Jawab Sirf 3 se 4 jumlo me exact URDU SCRIPT (اردو) me do." 
                        : "Is audio ko suno. Jawab Sirf 3 se 4 jumlo me ROMAN URDU (English Alphabets) me do.";

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
                        ? " Jawab Sirf 1 se 2 jumlo me exact URDU SCRIPT (اردو) me do." 
                        : " Jawab Sirf 1 se 2 jumlo me ROMAN URDU (English Alphabets) me do.";
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

                for (const modelName of modelsToTry) {
                    try {
                        const model = genAI.getGenerativeModel({ 
                            model: modelName,
                            systemInstruction: systemPrompt,
                            generationConfig: {
                                maxOutputTokens: 250,
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

                    if (sendAsVoice) {
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