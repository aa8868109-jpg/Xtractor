const fs = require('fs');
const path = require('path');

// Try dotenv first
try {
  require('dotenv').config();
} catch (e) {
  // ignore
}

function readBaseIdFromDotenvFile() {
  try {
    const p = path.join(process.cwd(), '.env');
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf8');
    const m = content.match(/^\s*BASE_ID\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim();
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const fromEnv = process.env.BASE_ID || null;
  const fallback = (!fromEnv) ? readBaseIdFromDotenvFile() : null;
  const BASE_ID = fromEnv || fallback || null;
  res.statusCode = 200;
  res.end(JSON.stringify({ BASE_ID }));
};