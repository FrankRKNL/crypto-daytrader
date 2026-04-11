/**
 * Single-shot live signal test
 * Run: node test-live.mjs
 */

import { getSignalDashboard, getFundingScan } from './src/indicators/microstructure.js';

console.log('=== LIVE SIGNAL TEST ===\n');

const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];

for (const sym of symbols) {
    const dash = await getSignalDashboard(sym);
    
    console.log(`\n${sym}:`);
    console.log(`  Price:    ${dash.funding?.markPrice || 'N/A'}`);
    console.log(`  Funding:  ${dash.funding?.fundingBps?.toFixed(2) || 'N/A'} bps (${dash.funding?.fundingRate > 0 ? '+' : ''}${((dash.funding?.fundingRate || 0) * 100).toFixed(4)}%)`);
    console.log(`  OI:       ${dash.oi?.openInterest ? parseFloat(dash.oi.openInterest).toFixed(0) : 'N/A'} contracts`);
    console.log(`  L/S:      ${dash.longshort?.currentLongPct?.toFixed(1) || '?'}% long / ${dash.longshort?.currentShortPct?.toFixed(1) || '?'}% short`);
    console.log(`  OB Imb:   ${dash.orderbook?.imbalance?.toFixed(4) || 'N/A'}`);
    console.log(`  Flow Imb: ${dash.tradeflow?.volumeImbalance?.toFixed(4) || 'N/A'}`);
    
    if (dash.funding?.fundingBps > 10) console.log(`  >>> SHORT SQUEEZE SIGNAL (funding > +10bps)`);
    if (dash.funding?.fundingBps < -10) console.log(`  >>> LONG SQUEEZE SIGNAL (funding < -10bps)`);
}

console.log('\n=== EXTREME FUNDING SCAN ===\n');
const scan = await getFundingScan();
console.log('Top positive (longs pay):');
scan.topPositive.forEach(f => console.log(`  ${f.symbol}: ${f.fundingBps.toFixed(2)} bps`));
console.log('Top negative (shorts pay):');
scan.topNegative.forEach(f => console.log(`  ${f.symbol}: ${f.fundingBps.toFixed(2)} bps`));

console.log('\nDone.');