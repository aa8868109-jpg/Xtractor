// Minimal local dev server that mounts the serverless handlers in /api
const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenvResult = require('dotenv').config();
if (dotenvResult.error) {
  console.warn('Could not load .env file:', dotenvResult.error);
} else {
  console.log('Loaded .env values');
  try {
    console.log('dotenv parsed keys:', Object.keys(dotenvResult.parsed || {}).join(', '));
  } catch (e) {}
}

// Quick diagnostic: check .env file and BASE_ID line
try {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const m = content.match(/^\s*BASE_ID\s*=\s*(.+)\s*$/m);
    console.log('.env BASE_ID line:', m ? m[1].trim() : '<not found>');
  } else {
    console.log('.env file not found at', envPath);
  }
} catch (e) {
  console.warn('Error reading .env for diagnostics', e && e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON and urlencoded bodies for API requests
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from project root
app.use(express.static(path.join(__dirname)));

// Simple CORS for local dev
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Mount the serverless protection handler for local dev
try {
  const protectionHandler = require('./api/protection');
  app.get('/api/protection', (req, res) => protectionHandler(req, res));
} catch (err) {
  console.warn('Could not mount ./api/protection handler:', err.message || err);
}

// Mount config handler for local dev
try {
  const configHandler = require('./api/config');
  app.get('/api/config', (req, res) => configHandler(req, res));
} catch (err) {
  console.warn('Could not mount ./api/config handler:', err.message || err);
}

// Mount airtable proxy handler for local dev
try {
  const airtableHandler = require('./api/airtable');
  app.all('/api/airtable/*', (req, res) => airtableHandler(req, res));
} catch (err) {
  console.warn('Could not mount ./api/airtable handler:', err.message || err);
}

// Fallback health
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Local dev server running on http://localhost:${PORT}`));
console.log('process.env.BASE_ID =', process.env.BASE_ID || null);
