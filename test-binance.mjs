import { getKlines, getPremiumIndex, getLongShortRatio, getAggTrades, getDepth, getOpenInterest, get24hrTicker } from './src/data/binance.js';

console.log('=== BINANCE DATA TEST ===\n');

try {
    console.log('1. Klines (1m BTC)');
    const klines = await getKlines('BTCUSDT', '1m', 3);
    klines.forEach(k => console.log(`  ${new Date(k.openTime).toISOString()} O:${k.open.toFixed(2)} H:${k.high.toFixed(2)} L:${k.low.toFixed(2)} C:${k.close.toFixed(2)}`));

    console.log('\n2. Premium Index (funding rate)');
    const pi = await getPremiumIndex('BTCUSDT');
    console.log(`  Funding: ${(parseFloat(pi.lastFundingRate) * 100).toFixed(4)}% | Mark: ${pi.markPrice} | Index: ${pi.indexPrice}`);

    console.log('\n3. Long/Short Ratio');
    const ls = await getLongShortRatio('BTCUSDT', '1h', 3);
    ls.forEach(l => console.log(`  ${new Date(l.timestamp).toISOString()} | Long: ${l.longAccount} | Short: ${l.shortAccount} | Ratio: ${l.longShortRatio}`));

    console.log('\n4. Open Interest');
    const oi = await getOpenInterest('BTCUSDT');
    console.log(`  OI: ${parseFloat(oi.openInterest).toFixed(0)} contracts`);

    console.log('\n5. Order Book (top 5)');
    const depth = await getDepth('BTCUSDT', 5);
    console.log('  Bids:', depth.bids.map(b => `${b[0]}:${b[1]}`).join(' | '));
    console.log('  Asks:', depth.asks.map(a => `${a[0]}:${a[1]}`).join(' | '));

    console.log('\n6. Recent AggTrades');
    const trades = await getAggTrades('BTCUSDT', 5);
    trades.forEach(t => console.log(`  ${new Date(t.timestamp).toISOString()} | P:${t.price} Q:${t.quantity} ${t.isBuyerMaker ? 'SELL' : 'BUY'}`));

    console.log('\n=== ALL OK ===');
} catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
}