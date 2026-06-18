const { createClient } = require('@supabase/supabase-js');

const UPGRADE_URL = process.env.UPGRADE_URL || 'https://your-gumroad-link.com';

module.exports = async (req, res) => {
  // CORS headers — allow requests from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, code } = req.body || {};

  // Validate inputs
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request format.' });
  }
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Access code is required.' });
  }

  // Connect to Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Look up the access code
  const { data: record, error: dbError } = await supabase
    .from('access_codes')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .single();

  if (dbError || !record) {
    return res.status(401).json({
      error: 'Invalid access code. Double-check your code and try again.'
    });
  }

  if (!record.active) {
    return res.status(403).json({
      error: 'This access code has been deactivated. Email support@singleandoverstimulated.com for help.'
    });
  }

  // Auto-reset monthly usage if reset date has passed
  const today = new Date();
  const resetDate = new Date(record.reset_date);
  let currentUsage = record.messages_used;

  if (today >= resetDate) {
    const nextReset = new Date(today.getFullYear(), today.getMonth() + 1, 1)
      .toISOString().split('T')[0];
    await supabase
      .from('access_codes')
      .update({ messages_used: 0, reset_date: nextReset })
      .eq('code', record.code);
    currentUsage = 0;
  }

  // Check usage limit (999999 = unlimited)
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

  // Call Anthropic API
  let anthropicRes, anthropicData;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages
      })
    });
    anthropicData = await anthropicRes.json();
  } catch (e) {
    return res.status(500).json({ error: 'AI service error. Please try again in a moment.' });
  }

  if (anthropicData.error) {
    return res.status(500).json({ error: 'AI error: ' + anthropicData.error.message });
  }

  const textBlock = anthropicData.content && anthropicData.content.find(b => b.type === 'text');
  if (!textBlock || !textBlock.text) {
    return res.status(500).json({ error: 'Empty response. Please try again.' });
  }

  // Increment usage count
  await supabase
    .from('access_codes')
    .update({ messages_used: currentUsage + 1 })
    .eq('code', record.code);

  // Return response with usage info
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
};
