/**
 * Birthday Bot for Fyld WhatsApp Group
 * Connects via Baileys, queries PostgreSQL daily at 09:00,
 * and sends birthday messages to the "Fyld" group.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const pino = require('pino');
const db = require('../models/database');

// ─── Constants ───────────────────────────────────────────────────────────────

const GROUP_NAME    = 'Fyld';
const AUTH_FOLDER   = 'auth_info_baileys';
const CRON_SCHEDULE = '0 9 * * *';          // 09:00 AM every day
const MSG_DELAY_MS  = 2000;                 // delay between messages
const EMOJIS        = ['🎈', '🎊', '🎁', '🌟', '✨', '💫'];
const TEST_MODE     = process.env.TEST_MODE === 'true';

// ─── State ────────────────────────────────────────────────────────────────────

let sock       = null;
let groupId    = null;
let cronJob    = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomEmoji = () => EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

/**
 * Convert a phone number to a WhatsApp JID.
 * Strips all non-digit characters and appends @s.whatsapp.net.
 * @param {string} phone
 * @returns {string}
 */
function phoneToJid(phone) {
  return `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
}

/**
 * Build the birthday message for a contact.
 * @param {{ first_name: string, last_name: string, phone_number: string }} person
 * @returns {{ text: string, mentions: string[] }}
 */
function buildMessage(person) {
  const emoji = randomEmoji();
  const jid = phoneToJid(person.phone_number);
  const text =
    `🎂 Happy birthday @${person.first_name} ${person.last_name}! ${emoji}\n\n` +
    `Wishing you a fantastic day filled with joy and celebrations! 🎉`;
  return { text, mentions: [jid] };
}

// ─── Core bot functions ───────────────────────────────────────────────────────

/**
 * Query the database for today's birthdays.
 * @returns {Promise<Array<{first_name: string, last_name: string}>>}
 */
async function getTodaysBirthdays() {
  const { data, error } = await db
    .from('contacts')
    .select('first_name,last_name,phone_number,date_of_birth')
    .order('first_name');

  if (error) throw new Error(error.message);

  const now = new Date();
  const todayMonth = now.getMonth() + 1; // 1-12
  const todayDay   = now.getDate();

  console.log(`📅 Today: month=${todayMonth} day=${todayDay}`);
  console.log(`📋 Raw DB rows: ${JSON.stringify(data)}`);

  return (data ?? []).filter((c) => {
    const [, m, d] = c.date_of_birth.split('-').map(Number);
    return m === todayMonth && d === todayDay;
  });
}

/**
 * Send a birthday message for one person to the group.
 * @param {{ first_name: string, last_name: string }} person
 */
async function sendBirthdayMessage(person) {
  try {
    const { text, mentions } = buildMessage(person);
    await sock.sendMessage(groupId, { text, mentions });
    console.log(`🎉 Sent birthday message for ${person.first_name} ${person.last_name}`);
  } catch (err) {
    console.error(`❌ Failed to send message for ${person.first_name} ${person.last_name}:`, err.message);
  }
}

/**
 * Check the database and send messages for every birthday today.
 */
async function checkAndSendBirthdays() {
  console.log('⏰ Checking birthdays for today...');
  try {
    const birthdays = await getTodaysBirthdays();

    if (!birthdays.length) {
      console.log('📝 No birthdays today.');
      return;
    }

    console.log(`🎂 Found ${birthdays.length} birthday(s) today!`);

    for (const person of birthdays) {
      await sendBirthdayMessage(person);
      await sleep(MSG_DELAY_MS);
    }
  } catch (err) {
    console.error('❌ Error checking birthdays:', err.message);
  }
}

/**
 * Fetch all groups, find "Fyld", store its ID, then start the cron job.
 */
async function findGroupAndStartScheduler() {
  try {
    if (TEST_MODE) {
      // Send to the bot's own chat instead of the group
      // Strip device suffix: "351912345678:5@s.whatsapp.net" → "351912345678@s.whatsapp.net"
      groupId = sock.user.id.replace(/:\d+@/, '@');
      console.log(`🧪 TEST_MODE: sending to self-chat (${groupId})`);
    } else {
      const groups = await sock.groupFetchAllParticipating();
      const found = Object.values(groups).find((g) => g.subject === GROUP_NAME);

      if (!found) {
        const names = Object.values(groups).map((g) => `"${g.subject}"`).join(', ');
        console.error(`❌ Group "${GROUP_NAME}" not found. Available groups: ${names || '(none)'}`);
        return;
      }

      groupId = found.id;
      console.log(`✅ Group "${GROUP_NAME}" found (${groupId})`);
    }

    // Stop any previous cron job before starting a new one
    if (cronJob) cronJob.stop();

    cronJob = cron.schedule(CRON_SCHEDULE, () => {
      checkAndSendBirthdays().catch((e) => console.error('❌ Cron error:', e.message));
    });

    console.log(`⏰ Birthday scheduler started (${CRON_SCHEDULE})`);

    // Run immediately on startup so we don't miss today's birthdays
    await checkAndSendBirthdays();
  } catch (err) {
    console.error('❌ Error finding group or starting scheduler:', err.message);
  }
}

// ─── Connection management ────────────────────────────────────────────────────

/**
 * Create and wire up a Baileys socket.
 * Handles QR display, connection events, and auto-reconnect.
 */
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`🔧 Using WhatsApp Web version ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Fyld Birthday Bot', 'Birthday Bot', '1.0.0'],
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('📱 Scan the QR code below with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Birthday Bot connected to WhatsApp!');
      await findGroupAndStartScheduler();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log('🚪 Logged out. Delete auth_info_baileys/ and restart to re-link.');
      } else {
        console.log(`🔄 Connection closed (code ${code}). Reconnecting...`);
        await connect();
      }
    }
  });
}

/**
 * Entry point — called from server.js on startup.
 */
async function initBirthdayBot() {
  console.log('🤖 Initialising Birthday Bot...');
  try {
    await connect();
  } catch (err) {
    console.error('❌ Failed to initialise Birthday Bot:', err.message);
  }
}

module.exports = { initBirthdayBot, checkAndSendBirthdays };
