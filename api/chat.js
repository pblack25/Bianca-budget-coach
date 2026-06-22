module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, code } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request format.' });
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Access code is required.' });
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const UPGRADE_URL = process.env.UPGRADE_URL || 'https://your-gumroad-link.com';
  const cleanCode = code.trim().toUpperCase();

  // Look up the access code
  let records;
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
    records = await lookupRes.json();
  } catch (e) {
    return res.status(500).json({ error: 'Database connection error: ' + e.message });
  }

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(401).json({ error: 'Code not found. Double-check your code and try again.' });
  }

  const record = records[0];

  if (!record.active) {
    return res.status(403).json({ error: 'This access code has been deactivated. Please contact support.' });
  }

  // Auto-reset monthly usage if reset date has passed
  const today = new Date();
  const resetDate = new Date(record.reset_date);
  let currentUsage = record.messages_used;

  if (today >= resetDate) {
    const nextReset = new Date(today.getFullYear(), today.getMonth() + 1, 1)
      .toISOString().split('T')[0];
    await fetch(
      `${SUPABASE_URL}/rest/v1/access_codes?code=eq.${encodeURIComponent(cleanCode)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ messages_used: 0, reset_date: nextReset })
      }
    );
    currentUsage = 0;
  }

  // Check usage limit
  const isUnlimited = record.messages_limit >= 999999;
  if (!isUnlimited && currentUsage >= record.messages_limit) {
    const resetFormatted = new Date(record.reset_date)
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    return res.status(429).json({
      error: 'limit_reached',
      messages_used: currentUsage,
      messages_limit: record.messages_limit,
      reset_date: resetFormatted,
