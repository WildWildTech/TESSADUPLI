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

app.post('/api/init-handshake', async (req, res) => {
    const { symbol, account_id, balance } = req.body;
    try {
        const welcomeMessage = `🟢 **EA CONNECTED SUCCESSFULLY**\n` +
                               `-----------------------------------------\n` +
                               `• **Asset Pair:** ${symbol}\n` +
                               `• **Account ID:** ${account_id}\n` +
                               `• **Live Balance:** $${parseFloat(balance).toLocaleString(undefined, {minimumFractionDigits: 2})}\n` +
                               `• **Status:** Pipeline Online & Syncing Loops Active.`;
                               
        await bot.sendMessage(CHAT_ID, welcomeMessage, { parse_mode: 'Markdown' });
        return res.json({ success: true, message: "Handshake alert delivered successfully." });
    } catch (err) {
        console.error("Handshake Delivery Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/ea-sync', async (req, res) => {
    try {
        const { symbol, current_price, total_active_ea_trades } = req.body;
        
        const { data: config, error: cfgErr } = await supabase
            .from('ea_configs')
            .select('*')
            .eq('symbol', symbol)
            .single();
            
        if (cfgErr || !config) return res.status(404).json({ error: 'Pair configuration record not initialized.' });
        
        const direction = config.command_string.substring(0, 4); 
        const staticPivotSource = parseFloat(config.command_string.substring(4)); 

        let { data: state } = await supabase.from('ea_state').select('*').eq('symbol', symbol).single();
        if (!state) {
            const { data: newState } = await supabase
                .from('ea_state')
                .insert({ 
                    symbol, 
                    dynamic_pivot_high: direction === 'BULL' ? current_price : staticPivotSource, 
                    dynamic_pivot_low: direction === 'BEAR' ? current_price : staticPivotSource,
                    break_zero_stage: 0,
                    last_command_seen: config.command_string,
                    range_locked: false,
                    break_zero_placed: false,
                    tp_slashed: false
                })
                .select()
                .single();
            state = newState;
        }

        if (state.last_command_seen !== config.command_string) {
            let freshHigh = direction === 'BULL' ? current_price : staticPivotSource;
            let freshLow = direction === 'BEAR' ? current_price : staticPivotSource;
            
            if (freshHigh <= freshLow) {
                if (direction === 'BULL') freshHigh = freshLow + 10.0;
                if (direction === 'BEAR') freshLow = freshHigh - 10.0;
            }

            const { data: updatedState } = await supabase
                .from('ea_state')
                .update({ 
                    dynamic_pivot_high: freshHigh, 
                    dynamic_pivot_low: freshLow, 
                    break_zero_stage: 0,
                    last_command_seen: config.command_string,
                    range_locked: false,
                    break_zero_placed: false,
                    tp_slashed: false
                })
                .eq('symbol', symbol)
                .select()
                .single();
                
            state = updatedState;
        }

        let updatedLow = parseFloat(state.dynamic_pivot_low);
        let updatedHigh = parseFloat(state.dynamic_pivot_high);
        let currentStage = state.break_zero_stage;
        let isLocked = state.range_locked;
        let stopPlaced = state.break_zero_placed;
        let isTpSlashed = state.tp_slashed;

        if (!isLocked) {
            const { data: activeTrades } = await supabase
                .from('trade_logs')
                .select('id')
                .eq('symbol', symbol)
                .eq('status', 'OPEN')
                .limit(1);
                
            if (activeTrades && activeTrades.length > 0) {
                isLocked = true;
                await supabase.from('ea_state').update({ range_locked: true }).eq('symbol', symbol);
            }
        }

        const range = updatedHigh - updatedLow;

        // --- ONE-SHOT TOUCH LEVEL 0 PROFIT SLASHING CRITERIA MATRIX ---
        if (total_active_ea_trades === 1 && !isTpSlashed) {
            if (direction === 'BULL' && current_price >= updatedHigh) {
                isTpSlashed = true;
                await supabase.from('ea_state').update({ tp_slashed: true }).eq('symbol', symbol);
            } else if (direction === 'BEAR' && current_price <= updatedLow) {
                isTpSlashed = true;
                await supabase.from('ea_state').update({ tp_slashed: true }).eq('symbol', symbol);
            }
        }

        // Reset TP reduction state back to full targets if asset composition hits 2 or more active entries
        if (total_active_ea_trades >= 2 && isTpSlashed) {
            isTpSlashed = false;
            await supabase.from('ea_state').update({ tp_slashed: false }).eq('symbol', symbol);
        }

        // --- INVERTED FIBONACCI SCANNING MATRIX ENGINE ---
        if (direction === 'BULL') {
            updatedLow = staticPivotSource; 
            
            if (!isLocked && current_price > updatedHigh) {
                updatedHigh = current_price; 
                currentStage = 0; 
                await supabase.from('ea_state').update({ dynamic_pivot_high: updatedHigh, break_zero_stage: currentStage }).eq('symbol', symbol);
            }

            const fib382 = updatedHigh - (range * 0.382);
            const fib450 = updatedHigh - (range * 0.450);

            if (currentStage === 0 && current_price <= fib382 && current_price >= fib450) currentStage = 1;
            else if (currentStage === 1 && current_price > updatedHigh) currentStage = 2;
            else if (currentStage === 2 && current_price <= fib382 && current_price >= fib450) currentStage = 3;
        } 
        else if (direction === 'BEAR') {
            updatedHigh = staticPivotSource; 
            
            if (!isLocked && current_price < updatedLow && current_price > 0) {
                updatedLow = current_price; 
                currentStage = 0; 
                await supabase.from('ea_state').update({ dynamic_pivot_low: updatedLow, break_zero_stage: currentStage }).eq('symbol', symbol);
            }

            const fib382 = updatedLow + (range * 0.382);
            const fib450 = updatedLow + (range * 0.450);

            if (currentStage === 0 && current_price >= fib382 && current_price <= fib450) currentStage = 1;
            else if (currentStage === 1 && current_price < updatedLow) currentStage = 2;
            else if (currentStage === 2 && current_price >= fib382 && current_price <= fib450) currentStage = 3;
        }

        if (currentStage !== state.break_zero_stage) {
            await supabase.from('ea_state').update({ break_zero_stage: currentStage }).eq('symbol', symbol);
        }

        return res.json({
            config, 
            direction,
            pivot_high: updatedHigh,
            dynamic_pivot_low: updatedLow,
            break_zero_stage: currentStage,
            range_locked: isLocked,
            break_zero_placed: stopPlaced,
            tp_slashed: isTpSlashed,
            reduction_pct: parseFloat(config.single_trade_tp_reduction_pct || 50)
        });

    } catch (err) {
        console.error("Critical Runtime Routing Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/alerts', async (req, res) => {
    const { type, message, ticket_id, symbol, pnl_pct, lot_size, level_type, above_sma, entry_price, exit_price, is_manual } = req.body;
    try {
        await bot.sendMessage(CHAT_ID, `🚨 **EA TELEMETRY ALERT [${type}]**\n${message}`);

        if (type === 'PENDING_STOP_PLACED') {
            await supabase.from('ea_state').update({ break_zero_placed: true }).eq('symbol', symbol);
        }

        if (type === 'TRADE_OPEN') {
            await supabase.from('ea_state').update({ range_locked: true }).eq('symbol', symbol);

            // Added safe fallback assertion for strict boolean column type compatibility
            const isAboveSma = typeof above_sma === 'boolean' ? above_sma : (is_manual ? false : false);

            await supabase.from('trade_logs').insert({
                ticket_id,
                symbol,
                direction: message.includes('BUY') || message.includes('Buy Stop') ? 'BULL' : 'BEAR',
                entry_level_type: level_type || (is_manual ? 'MANUAL' : 'Unknown'),
                lot_size,
                entry_price: entry_price,
                entry_time: new Date().toISOString(),
                above_30min_sma: isAboveSma,
                status: 'OPEN'
            });
        }

        if (type === 'TRADE_CLOSE') {
            const exitTime = new Date();
            const { data: openTrade } = await supabase.from('trade_logs').select('entry_time').eq('ticket_id', ticket_id).single();
            
            // Fixed direct date arithmetic casting pattern
            let durationMins = openTrade ? Math.round((exitTime.getTime() - new Date(openTrade.entry_time).getTime()) / 60000) : 0;

            await supabase.from('trade_logs').update({
                exit_price: exit_price,
                exit_time: exitTime.toISOString(),
                duration_minutes: durationMins,
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

cron.schedule('0 22 * * *', async () => {
    try {
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);
        
        const { data: logs } = await supabase
            .from('trade_logs')
            .select('*')
            .gte('exit_time', startOfDay.toISOString());

        if (!logs || logs.length === 0) {
            await bot.sendMessage(CHAT_ID, `📊 **Daily Journal Report (10 PM London)**\nNo positions closed during today's sessions.`);
            return;
        }

        let totalPnl = 0, wins = 0;
        logs.forEach(log => {
            totalPnl += parseFloat(log.gross_pnl_percent || 0);
            if (log.gross_pnl_percent > 0) wins++;
        });

        const report = `📊 **Daily Journal Report (10 PM London)**\n` +
                       `----------------------------------\n` +
                       `• Total Closed Positions: ${logs.length}\n` +
                       `• Win Rate Performance: ${((wins / logs.length) * 100).toFixed(1)}%\n` +
                       `• Combined Realized Return: ${fmtPct(totalPnl)}\n` +
                       `• Operational metrics securely locked to database logs.`;

        await bot.sendMessage(CHAT_ID, report);
    } catch (err) {
        console.error("Cron Process Core Error:", err);
    }
}, { timezone: "Europe/London" });

export default app;
