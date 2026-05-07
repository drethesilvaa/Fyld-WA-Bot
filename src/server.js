require('dotenv').config();
const express = require('express');
const { initBirthdayBot } = require('./services/birthdayBot');

const PORT = process.env.PORT || 3001;
const app  = express();

app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('🚀 Starting server...');

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  initBirthdayBot().catch((err) =>
    console.error('❌ Birthday Bot init error:', err.message)
  );
});
