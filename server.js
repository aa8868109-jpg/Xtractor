const express = require('express');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

function getAirtableConfig(useProtection = false) {
  const apiKey = useProtection
    ? (process.env.PROTECTION_API_KEY || process.env.AIRTABLE_API_KEY)
    : process.env.AIRTABLE_API_KEY;

  const baseId = useProtection
    ? (process.env.PROTECTION_BASE_ID || process.env.AIRTABLE_BASE_ID)
    : process.env.AIRTABLE_BASE_ID;

  return { apiKey, baseId };
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/api/config', (req, res) => {
  const { apiKey, baseId } = getAirtableConfig(false);
  res.json({
    ok: true,
    ready: Boolean(apiKey && baseId)
  });
});

app.get('/api/airtable/protection', async (req, res) => {
  try {
    const { apiKey, baseId } = getAirtableConfig(true);

    if (!baseId || !apiKey) {
      return res.status(500).json({ error: 'Protection credentials are not configured' });
    }

    const response = await axios.get(
      `https://api.airtable.com/v0/${baseId}/Protection`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message, details: error.response?.data || null });
  }
});

app.all('/api/airtable/:table/:recordId?', async (req, res) => {
  try {
    const table = req.params.table;
    const recordId = req.params.recordId;
    const { apiKey, baseId } = getAirtableConfig(false);

    if (!baseId || !apiKey) {
      return res.status(500).json({ error: 'Airtable credentials are not configured' });
    }

    const url = recordId
      ? `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}/${recordId}`
      : `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;

    const response = await axios({
      method: req.method,
      url,
      params: req.query,
      data: req.body,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    return res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    return res.status(status).json({ error: error.message, details: error.response?.data || null });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
