module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const messages = body.messages;
    const code = body.code;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Step 1 failed: messages missing or not array. Body was: ' + JSON.stringify(body).slice(0, 200) });
    }
    if (!code) {
      return res.status(400).json({ error: 'Step 2 failed: code missing.' });
    }

    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
    const UPGRADE_URL = process.env.UPGRADE_URL || 'https://your-gumroad-link.com';
    const cleanCode = code.trim().toUpperCase();

    if (!SUPABASE_URL) return res.status(500).json({ error: 'Step 3 failed: SUPABASE_URL not set.' });
    if (!SUPABASE_KEY) return res.status(500).json({ error: 'Step 4 failed: SUPABASE_SERVICE_KEY not set.' });
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'Step 5 failed: ANTHROPIC_API_KEY not set.' });

    // Supabase lookup
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

    if (!Array.isArray(records)) {
      return res.status(500).json({ error: 'Step 6 failed: Supabase returned non-array: ' + JSON.stringify(records) });
    }
    if (records.length === 0) {
      return res.status(401).json({ error: 'Step 7 failed: Code not found: ' + cleanCode });
    }

    const record = records[0];
    if (!record.active) {
      return res.status(403).json({ error: 'Code deactivated.' });
    }

    // Reset monthly usage if needed
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

    // Check limit
    const isUnlimited = record.messages_limit >= 999999;
    if (!isUnlimited && currentUsage >= record.messages_limit) {
      const resetFormatted = new Date(record.reset_date)
        .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      return res.status(429).json({
        error: 'limit_reached',
        messages_used: currentUsage,
        messages_limit: record.messages_limit,
        reset_date: resetFormatted,
        upgrade_url: UPGRADE_URL
      });
    }

    // Call Anthropic
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages
      })
    });
    const anthropicData = await anthropicRes.json();

    if (anthropicData.error) {
      return res.status(500).json({ error: 'Anthropic error: ' + anthropicData.error.message });
    }

    const textBlock = anthropicData.content && anthropicData.content.find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      return res.status(500).json({ error: 'Empty Anthropic response. Raw: ' + JSON.stringify(anthropicData).slice(0, 300) });
    }

    // Update usage
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
        body: JSON.stringify({ messages_used: currentUsage + 1 })
      }
    );

    return res.status(200).json({
      text: textBlock.text,
      usage: {
        used: currentUsage + 1,
        limit: record.messages_limit,
        unlimited: isUnlimited,
        tier: record.tier,
        reset_date: record.reset_date
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: 'Uncaught error: ' + e.message,
      stack: e.stack ? e.stack.slice(0, 500) : 'no stack'
    });
  }
};
