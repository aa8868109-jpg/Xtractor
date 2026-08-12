// Minimal local dev server that mounts the serverless handlers in /api
const express = require('express');
const path = require('path');
require('dotenv').config();

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
