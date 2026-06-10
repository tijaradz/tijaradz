const axios = require('axios');
const cheerio = require('cheerio');

const URLS_TO_MONITOR = [
  { name: 'Wailshop', url: process.env.WAILSHOP_URL },
  { name: 'Imgvo', url: process.env.IMGVO_URL },
];

const ALERT_CONFIG = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  enableTelegram: !!process.env.TELEGRAM_BOT_TOKEN,
  enableDiscord: !!process.env.DISCORD_WEBHOOK_URL,
};

async function analyzeUrl(urlConfig) {
  const { name, url } = urlConfig;
  if (!url) return { pageName: name, status: 'SKIPPED', timestamp: new Date().toISOString() };

  try {
    const response = await axios.get(url, { timeout: 5000, headers: { 'User-Agent': 'SEOBot/1.0' } });
    const $ = cheerio.load(response.data);
    const jsonLdScripts = $('script[type="application/ld+json"]');
    const hasJsonLd = jsonLdScripts.length > 0;
    const metaTags = {
      description: $('meta[name="description"]').attr('content') ? '✓' : '✗',
      robots: $('meta[name="robots"]').attr('content') ? '✓' : '✗',
      viewport: $('meta[name="viewport"]').attr('content') ? '✓' : '✗',
    };
    const hasCanonical = !!$('link[rel="canonical"]').attr('href');
    let score = 100;
    if (response.status !== 200) score -= 50;
    if (!hasJsonLd) score -= 20;
    const missingMetas = Object.values(metaTags).filter((v) => v === '✗').length;
    score -= missingMetas * 5;
    if (!hasCanonical) score -= 10;

    return {
      pageName: name,
      url,
      status: 'SUCCESS',
      statusCode: response.status,
      healthScore: Math.max(0, score),
      jsonLd: hasJsonLd,
      timestamp: new Date().toISOString(),
      critical: score < 70,
    };
  } catch (error) {
    return {
      pageName: name,
      url,
      status: 'ERROR',
      error: error.message,
      statusCode: error.response?.status || 'FAILED',
      timestamp: new Date().toISOString(),
      critical: true,
    };
  }
}

async function sendTelegramAlert(report) {
  if (!ALERT_CONFIG.enableTelegram) return;
  const critical = report.filter((r) => r.critical);
  if (critical.length === 0) return;

  let message = '🚨 SEO Alert\n\n';
  critical.forEach((issue) => {
    message += `${issue.pageName}\nStatus: ${issue.statusCode}\n\n`;
  });

  try {
    await axios.post(`https://api.telegram.org/bot${ALERT_CONFIG.telegramBotToken}/sendMessage`, {
      chat_id: ALERT_CONFIG.telegramChatId,
      text: message,
    }, { timeout: 3000 });
    console.log('✓ Telegram sent');
  } catch (error) {
    console.error('✗ Telegram failed:', error.message);
  }
}

async function sendDiscordAlert(report) {
  if (!ALERT_CONFIG.enableDiscord) return;
  const critical = report.filter((r) => r.critical);
  if (critical.length === 0) return;

  const embeds = critical.map((issue) => ({
    title: `🚨 ${issue.pageName}`,
    color: 0xff0000,
    fields: [
      { name: 'Status', value: String(issue.statusCode), inline: true },
      { name: 'Error', value: issue.error || 'Low score', inline: false },
    ],
  }));

  try {
    await axios.post(ALERT_CONFIG.discordWebhookUrl, { content: '🚨 SEO Alert', embeds }, { timeout: 3000 });
    console.log('✓ Discord sent');
  } catch (error) {
    console.error('✗ Discord failed:', error.message);
  }
}

exports.handler = async (event) => {
  console.log('🤖 SEO Bot started');
  if (event.source !== 'aws.events') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid' }) };
  }

  try {
    const results = await Promise.allSettled(URLS_TO_MONITOR.map(analyzeUrl));
    const analysisResults = results.map((r) => r.status === 'fulfilled' ? r.value : { status: 'ERROR', critical: true });

    console.log('✅ Report Generated');
    analysisResults.forEach((r) => {
      console.log(`[${r.pageName}] ${r.status} - ${r.statusCode}`);
    });

    const critical = analysisResults.filter((r) => r.critical).length;
    if (critical > 0) {
      await Promise.all([sendTelegramAlert(analysisResults), sendDiscordAlert(analysisResults)]);
    } else {
      console.log('✓ All healthy');
    }

    return { statusCode: 200, body: JSON.stringify({ message: 'Check completed', count: analysisResults.length }) };
  } catch (error) {
    console.error('🚨 Error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed' }) };
  }
};
