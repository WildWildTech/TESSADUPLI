// api/webhook.js
export default async function handler(req, res) {
    // Debugging: Log the method so you can see it in Vercel Logs
    console.log("Received request method:", req.method);

    if (req.method !== 'POST') {
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    try {
        const { content } = req.body;
        // Verify these are in your Vercel Environment Variables
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chat_id = process.env.TELEGRAM_CHAT_ID;

        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chat_id, text: content })
        });
        
        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
