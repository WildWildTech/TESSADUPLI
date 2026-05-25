// /api/webhook.js
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { content } = req.body;
    const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: content
            })
        });

        if (!response.ok) throw new Error('Telegram API failed');
        res.status(200).json({ status: 'success' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
