module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body || {};
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const cleanCode = (code || '').trim().toUpperCase();

  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(cleanCode)}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const records = await lookupRes.json();

    if (!records || records.length === 0) {
      return res.status(401).json({ error: 'Code not found: ' + cleanCode });
    }

    const record = records[0];
    return res.status(200).json({
      text: 'Supabase connected! Found code: ' + record.code + ' | Tier: ' + record.tier + ' | Used: ' + record.messages_used + '/' + record.messages_limit,
      usage: { used: record.messages_used, limit: record.messages_limit, unlimited: false, tier: record.tier }
    });

  } catch (e) {
    return res.status(500).json({ error: 'Supabase error: ' + e.message });
  }
};
