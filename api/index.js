import express from 'express';
import { createClient } from '@supabase/supabase-js';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const fmtPct = (val) => `${val > 0 ? '+' : ''}${parseFloat(val).toFixed(2)}%`;

app.get('/', (req, res) => {
    return res.status(200).json({ status: "online", system: "MT5 Enterprise Gateway Serverless Core" });
});

// Handshake: Used by EA on startup to verify connection and log account status
app.post('/api/init-handshake', async (req, res) => {
    const { symbol, account_id, balance } = req.body;
    try {
        const welcomeMessage = `🟢 **EA CONNECTED SUCCESSFULLY**\n` +
                               `-----------------------------------------\n` +
                               `• **Asset Pair:** ${symbol}\n` +
                               `• **Account ID:** ${account_id}\n` +
                               `• **Live Balance:** ${parseFloat(balance).toLocaleString(undefined, {minimumFractionDigits: 2})}\n` +
                               `• **Status:** Local Logic Active.`;
                               
        await bot.sendMessage(CHAT_ID, welcomeMessage, { parse_mode: 'Markdown' });
        return res.json({ success: true, message: "Handshake alert delivered." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Sync: Used by EA to fetch current settings (Pivot levels, etc.) from DB.
// Removed all logic/calculations. Purely fetches current config.
app.post('/api/ea-sync', async (req, res) => {
    try {
        const { symbol } = req.body;
        const { data: config, error } = await supabase
            .from('ea_configs')
            .select('*')
            .eq('symbol', symbol)
            .single();
            
        if (error || !config) return res.status(404).json({ error: 'Config not found' });
        
        return res.json({ config });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Alerts: The primary event-driven endpoint for logging trades.
app.post('/api/alerts', async (req, res) => {
    const { type, message, ticket_id, symbol, pnl_pct, lot_size, entry_price, exit_price } = req.body;
    try {
        // Send notification for every significant trade event
        await bot.sendMessage(CHAT_ID, `🚨 **EA TELEMETRY [${type}]**\n${message}`);

        if (type === 'TRADE_OPEN') {
            await supabase.from('trade_logs').insert({
                ticket_id,
                symbol,
                lot_size,
                entry_price: entry_price,
                entry_time: new Date().toISOString(),
                status: 'OPEN'
            });
        }

        if (type === 'TRADE_CLOSE') {
            await supabase.from('trade_logs').update({
                exit_price: exit_price,
                exit_time: new Date().toISOString(),
                gross_pnl_percent: pnl_pct,
                status: 'CLOSED'
            }).eq('ticket_id', ticket_id);
        }
        
        return res.json({ success: true });
    } catch (err) {
        console.error("Alert Logging Exception:", err);
        return res.status(500).json({ error: err.message });
    }
});

// Cron: Daily journal remains unchanged
cron.schedule('0 22 * * *', async () => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);
        
        const { data: logs } = await supabase
            .from('trade_logs')
            .select('*')
            .gte('exit_time', startOfDay.toISOString());

        if (!logs || logs.length === 0) {
            await bot.sendMessage(CHAT_ID, `📊 **Daily Journal (10 PM London)**\nNo positions closed today.`);
            return;
        }

        let totalPnl = 0, wins = 0;
        logs.forEach(log => {
            totalPnl += parseFloat(log.gross_pnl_percent || 0);
            if (log.gross_pnl_percent > 0) wins++;
        });

        const report = `📊 **Daily Journal Report (10 PM London)**\n` +
                       `----------------------------------\n` +
                       `• Total Closed: ${logs.length}\n` +
                       `• Win Rate: ${((wins / logs.length) * 100).toFixed(1)}%\n` +
                       `• Realized Return: ${fmtPct(totalPnl)}`;

        await bot.sendMessage(CHAT_ID, report);
    } catch (err) {
        console.error("Cron Error:", err);
    }
}, { timezone: "Europe/London" });

export default app;
