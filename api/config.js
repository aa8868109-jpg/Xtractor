module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    ready: Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID)
  });
};
