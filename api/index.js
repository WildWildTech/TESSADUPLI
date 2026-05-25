// /api/webhook.js
export default async function handler(req, res) {
    if (req.method === 'POST') {
        const { content } = req.body;
        const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

        try {
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: CHAT_ID, text: content })
            });
            res.status(200).send('Notification sent');
        } catch (error) {
            res.status(500).send('Error');
        }
    } else {
        res.status(405).end();
    }
}
