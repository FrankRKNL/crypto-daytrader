/**
 * DEEP ANALYSIS: Crypto Trading Research
 */

import { readFileSync } from 'fs';
const data = JSON.parse(readFileSync('./results/comprehensive-research.json', 'utf8'));

const familyMap = {
  'A': 'Trend Following',
  'B': 'Mean Reversion',
  'C': 'Volatility',
  'D': 'Long Only',
  'E': 'Short Conditional',
  'F': 'Risk Management',
};

// Flatten: each entry in data array already has the results
const allResults = [];
data.forEach(assetResult => {
  assetResult.results.forEach(periodResult => {
    allResults.push({
      symbol: assetResult.symbol,
      period: periodResult.period,
      market: periodResult.market,
      ...periodResult,
    });
  });
});

// ===== TABLE 1: BY FAMILY =====
console.log('\n' + '='.repeat(90));
console.log(' TABLE 1: PERFORMANCE BY STRATEGY FAMILY');
console.log('='.repeat(90));

const familyStats = {};
Object.keys(familyMap).forEach(fam => {
  const filtered = allResults.filter(r => r.family === fam);
  if (filtered.length === 0) return;
  
  const avgReturn = filtered.reduce((a, r) => a + r.totalReturn, 0) / filtered.length;
  const avgVsM = filtered.reduce((a, r) => a + r.vsMarket, 0) / filtered.length;
  const avgDD = filtered.reduce((a, r) => a + r.maxDrawdown, 0) / filtered.length;
  const avgPF = filtered.reduce((a, r) => a + r.profitFactor, 0) / filtered.length;
  const totalTrades = filtered.reduce((a, r) => a + r.totalTrades, 0);
  const beatM = filtered.filter(r => r.vsMarket > 0).length;
  
  familyStats[fam] = {
    name: familyMap[fam],
    avgReturn: avgReturn.toFixed(1),
    avgVsM: avgVsM.toFixed(1),
    avgDD: avgDD.toFixed(1),
    avgPF: avgPF.toFixed(2),
    totalTrades,
    beatM,
    beatTotal: filtered.length,
    beatRate: ((beatM / filtered.length) * 100).toFixed(0),
  };
});

console.log(`\n ${'Family'.padEnd(22)} ${'Ret%'.padEnd(10)} ${'vs M%'.padEnd(10)} ${'Beat%'.padEnd(10)} ${'DD%'.padEnd(10)} ${'PF'.padEnd(8)} ${'Trades'}`);
console.log('-'.repeat(80));

Object.entries(familyStats)
  .sort((a, b) => parseFloat(b[1].avgVsM) - parseFloat(a[1].avgVsM))
  .forEach(([fam, s]) => {
    const vsSign = parseFloat(s.avgVsM) >= 0 ? '+' : '';
    const retSign = parseFloat(s.avgReturn) >= 0 ? '+' : '';
    console.log(` ${s.name.padEnd(22)} ${retSign}${s.avgReturn.padEnd(9)} ${vsSign}${s.avgVsM.padEnd(9)} ${s.beatM}/${s.beatTotal} (${s.beatRate}%)`.padEnd(70) + ` ${s.avgDD.padEnd(10)} ${s.avgPF.padEnd(8)} ${s.totalTrades}`);
  });

// ===== TABLE 2: BEST/WORST PER FAMILY =====
console.log('\n\n' + '='.repeat(90));
console.log(' TABLE 2: BEST AND WORST STRATEGIES PER FAMILY');
console.log('='.repeat(90));

Object.keys(familyMap).forEach(fam => {
  const filtered = allResults.filter(r => r.family === fam);
  if (filtered.length === 0) return;
  
  const stratGroups = {};
  filtered.forEach(r => {
    if (!stratGroups[r.strategy]) stratGroups[r.strategy] = [];
    stratGroups[r.strategy].push(r);
  });
  
  const stratAverages = Object.entries(stratGroups).map(([name, results]) => {
    const avgReturn = results.reduce((a, r) => a + r.totalReturn, 0) / results.length;
    const avgVsM = results.reduce((a, r) => a + r.vsMarket, 0) / results.length;
    const avgDD = results.reduce((a, r) => a + r.maxDrawdown, 0) / results.length;
    const avgPF = results.reduce((a, r) => a + r.profitFactor, 0) / results.length;
    const totalTrades = results.reduce((a, r) => a + r.totalTrades, 0);
    const beatM = results.filter(r => r.vsMarket > 0).length;
    return { name, avgReturn, avgVsM, avgDD, avgPF, totalTrades, beatM, beatTotal: results.length };
  });
  
  stratAverages.sort((a, b) => b.avgVsM - a.avgVsM);
  
  console.log(`\n ${familyMap[fam]}:`);
  console.log(` ${'Strategy'.padEnd(25)} ${'Ret%'.padEnd(10)} ${'vs M%'.padEnd(10)} ${'DD%'.padEnd(8)} ${'PF'.padEnd(6)} ${'Trades'.padEnd(8)} ${'Beat'}`);
  console.log(' ' + '-'.repeat(80));
  
  stratAverages.slice(0, 3).forEach((s, i) => {
    const vsSign = s.avgVsM >= 0 ? '+' : '';
    const retSign = s.avgReturn >= 0 ? '+' : '';
    console.log(` BEST${i+1}: ${s.name.padEnd(21)} ${retSign}${s.avgReturn.toFixed(1).padEnd(9)} ${vsSign}${s.avgVsM.toFixed(1).padEnd(9)} ${s.avgDD.toFixed(0).padEnd(7)} ${s.avgPF.toFixed(2).padEnd(6)} ${s.totalTrades.toString().padEnd(8)} ${s.beatM}/${s.beatTotal}`);
  });
  
  stratAverages.slice(-3).reverse().forEach((s, i) => {
    const vsSign = s.avgVsM >= 0 ? '+' : '';
    const retSign = s.avgReturn >= 0 ? '+' : '';
    console.log(` WORST${i+1}: ${s.name.padEnd(21)} ${retSign}${s.avgReturn.toFixed(1).padEnd(9)} ${vsSign}${s.avgVsM.toFixed(1).padEnd(9)} ${s.avgDD.toFixed(0).padEnd(7)} ${s.avgPF.toFixed(2).padEnd(6)} ${s.totalTrades.toString().padEnd(8)} ${s.beatM}/${s.beatTotal}`);
  });
});

// ===== TABLE 3: BY ASSET =====
console.log('\n\n' + '='.repeat(90));
console.log(' TABLE 3: PERFORMANCE BY ASSET');
console.log('='.repeat(90));

const assetStats = {};
allResults.forEach(r => {
  if (!assetStats[r.symbol]) assetStats[r.symbol] = [];
  assetStats[r.symbol].push(r);
});

console.log(`\n ${'Asset'.padEnd(12)} ${'Ret%'.padEnd(10)} ${'vs M%'.padEnd(10)} ${'Beat%'.padEnd(12)} ${'DD%'.padEnd(10)} ${'PF'.padEnd(8)}`);
console.log('-'.repeat(65));

Object.entries(assetStats)
  .sort((a, b) => {
    const aVsM = a[1].reduce((acc, r) => acc + r.vsMarket, 0) / a[1].length;
    const bVsM = b[1].reduce((acc, r) => acc + r.vsMarket, 0) / b[1].length;
    return bVsM - aVsM;
  })
  .forEach(([symbol, results]) => {
    const avgReturn = results.reduce((a, r) => a + r.totalReturn, 0) / results.length;
    const avgVsM = results.reduce((a, r) => a + r.vsMarket, 0) / results.length;
    const avgDD = results.reduce((a, r) => a + r.maxDrawdown, 0) / results.length;
    const avgPF = results.reduce((a, r) => a + r.profitFactor, 0) / results.length;
    const beatM = results.filter(r => r.vsMarket > 0).length;
    
    const vsSign = avgVsM >= 0 ? '+' : '';
    const retSign = avgReturn >= 0 ? '+' : '';
    console.log(` ${symbol.replace('USDT', '').padEnd(12)} ${retSign}${avgReturn.toFixed(1).padEnd(9)} ${vsSign}${avgVsM.toFixed(1).padEnd(9)} ${beatM}/${results.length} (${((beatM/results.length)*100).toFixed(0)}%)`.padEnd(70) + ` ${avgDD.toFixed(1).padEnd(10)} ${avgPF.toFixed(2)}`);
  });

// ===== TABLE 4: BY PERIOD =====
console.log('\n\n' + '='.repeat(90));
console.log(' TABLE 4: PERFORMANCE BY PERIOD');
console.log('='.repeat(90));

const periodStats = {};
allResults.forEach(r => {
  if (!periodStats[r.period]) periodStats[r.period] = [];
  periodStats[r.period].push(r);
});

console.log(`\n ${'Period'.padEnd(10)} ${'Ret%'.padEnd(10)} ${'vs M%'.padEnd(10)} ${'Beat%'.padEnd(12)} ${'DD%'.padEnd(10)} ${'PF'.padEnd(8)}`);
console.log('-'.repeat(65));

Object.entries(periodStats)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .forEach(([period, results]) => {
    const avgReturn = results.reduce((a, r) => a + r.totalReturn, 0) / results.length;
    const avgVsM = results.reduce((a, r) => a + r.vsMarket, 0) / results.length;
    const avgDD = results.reduce((a, r) => a + r.maxDrawdown, 0) / results.length;
    const avgPF = results.reduce((a, r) => a + r.profitFactor, 0) / results.length;
    const beatM = results.filter(r => r.vsMarket > 0).length;
    
    const vsSign = avgVsM >= 0 ? '+' : '';
    const retSign = avgReturn >= 0 ? '+' : '';
    console.log(` ${period.padEnd(10)} ${retSign}${avgReturn.toFixed(1).padEnd(9)} ${vsSign}${avgVsM.toFixed(1).padEnd(9)} ${beatM}/${results.length} (${((beatM/results.length)*100).toFixed(0)}%)`.padEnd(70) + ` ${avgDD.toFixed(1).padEnd(10)} ${avgPF.toFixed(2)}`);
  });

// ===== TABLE 5: BEAR PERIOD ANALYSIS =====
console.log('\n\n' + '='.repeat(90));
console.log(' TABLE 5: SHORT-ONLY IN BEAR MARKET PERIODS');
console.log('='.repeat(90));

const bearPeriods = Object.entries(periodStats).filter(([period, results]) => {
  const avgMarket = results.reduce((a, r) => a + r.market, 0) / results.length;
  return avgMarket < 0;
});

bearPeriods.forEach(([period, results]) => {
  const avgMarket = results.reduce((a, r) => a + r.market, 0) / results.length;
  console.log(`\n ${period} (market: ${avgMarket >= 0 ? '+' : ''}${avgMarket.toFixed(1)}%)`);
  
  Object.keys(familyMap).forEach(fam => {
    const filtered = results.filter(r => r.family === fam);
    if (filtered.length === 0) return;
    
    const avgReturn = filtered.reduce((a, r) => a + r.totalReturn, 0) / filtered.length;
    const avgVsM = filtered.reduce((a, r) => a + r.vsMarket, 0) / filtered.length;
    const beatM = filtered.filter(r => r.vsMarket > 0).length;
    
    const vsSign = avgVsM >= 0 ? '+' : '';
    const retSign = avgReturn >= 0 ? '+' : '';
    console.log(`   ${familyMap[fam].padEnd(22)} ${retSign}${avgReturn.toFixed(1).padEnd(9)} ${vsSign}${avgVsM.toFixed(1).padEnd(9)} ${beatM}/${filtered.length}`);
  });
});

// ===== TABLE 6: LONG-ONLY vs CASH vs ACTIVE IN BEAR =====
console.log('\n\n' + '='.repeat(90));
console.log(' TABLE 6: LONG-ONLY vs CASH vs ACTIVE IN BEAR PERIODS');
console.log('='.repeat(90));

bearPeriods.forEach(([period, results]) => {
  const avgMarket = results.reduce((a, r) => a + r.market, 0) / results.length;
  console.log(`\n ${period} (market: ${avgMarket >= 0 ? '+' : ''}${avgMarket.toFixed(1)}%)`);
  
  const longOnly = results.filter(r => r.family === 'D');
  const avgLON = longOnly.reduce((a, r) => a + r.totalReturn, 0) / longOnly.length;
  const avgVsMLON = longOnly.reduce((a, r) => a + r.vsMarket, 0) / longOnly.length;
  const beatMLON = longOnly.filter(r => r.vsMarket > 0).length;
  
  const shortCond = results.filter(r => r.family === 'E');
  const avgSC = shortCond.reduce((a, r) => a + r.totalReturn, 0) / shortCond.length;
  const avgVsMSC = shortCond.reduce((a, r) => a + r.vsMarket, 0) / shortCond.length;
  const beatMSC = shortCond.filter(r => r.vsMarket > 0).length;
  
  console.log(`   ${'Strategy'.padEnd(22)} ${'Return'.padEnd(10)} ${'vs Market'.padEnd(12)} ${'Beat Rate'}`);
  console.log(`   ${'Cash (0%)'.padEnd(22)} ${'0.0'.padEnd(10)} ${(avgMarket >= 0 ? '+' : '') + avgMarket.toFixed(1) + '%'.padEnd(11)} 100% (baseline)`);
  console.log(`   ${'Long Only (D)'.padEnd(22)} ${avgLON >= 0 ? '+' : ''}${avgLON.toFixed(1).padEnd(9)} ${avgVsMLON >= 0 ? '+' : ''}${avgVsMLON.toFixed(1).padEnd(11)} ${beatMLON}/${longOnly.length}`);
  console.log(`   ${'Short Conditional (E)'.padEnd(22)} ${avgSC >= 0 ? '+' : ''}${avgSC.toFixed(1).padEnd(9)} ${avgVsMSC >= 0 ? '+' : ''}${avgVsMSC.toFixed(1).padEnd(11)} ${beatMSC}/${shortCond.length}`);
});

// ===== TABLE 7: RISK-ADJUSTED =====
console.log('\n\n' + '='.repeat(90));
console.log(' TABLE 7: RISK-ADJUSTED PERFORMANCE (Return per % Drawdown)');
console.log('='.repeat(90));

const raByFamily = {};
Object.keys(familyMap).forEach(fam => {
  const filtered = allResults.filter(r => r.family === fam);
  if (filtered.length === 0) return;
  
  const avgReturnPerDD = filtered.reduce((a, r) => a + (r.maxDrawdown > 0 ? r.totalReturn / r.maxDrawdown : 0), 0) / filtered.length;
  const avgReturn = filtered.reduce((a, r) => a + r.totalReturn, 0) / filtered.length;
  const avgDD = filtered.reduce((a, r) => a + r.maxDrawdown, 0) / filtered.length;
  
  raByFamily[fam] = { avgReturnPerDD, avgReturn, avgDD };
});

console.log(`\n ${'Family'.padEnd(22)} ${'Ret/DD'.padEnd(12)} ${'Avg Ret%'.padEnd(10)} ${'Avg DD%'.padEnd(10)}`);
console.log('-'.repeat(55));

Object.entries(raByFamily)
  .sort((a, b) => b[1].avgReturnPerDD - a[1].avgReturnPerDD)
  .forEach(([fam, s]) => {
    const retSign = s.avgReturn >= 0 ? '+' : '';
    console.log(` ${familyMap[fam].padEnd(22)} ${s.avgReturnPerDD >= 0 ? '+' : ''}${s.avgReturnPerDD.toFixed(2).padEnd(11)} ${retSign}${s.avgReturn.toFixed(1).padEnd(9)} ${s.avgDD.toFixed(1)}`);
  });

// ===== FINAL VERDICT =====
console.log('\n\n' + '='.repeat(90));
console.log(' RESEARCH VERDICT');
console.log('='.repeat(90));

// Find strategies that beat market >=40% of the time
const stratGroups = {};
allResults.forEach(r => {
  if (!stratGroups[r.strategy]) stratGroups[r.strategy] = [];
  stratGroups[r.strategy].push(r);
});

const consistentWinners = Object.entries(stratGroups)
  .map(([name, results]) => {
    const beatM = results.filter(r => r.vsMarket > 0).length;
    const avgVsM = results.reduce((a, r) => a + r.vsMarket, 0) / results.length;
    const avgDD = results.reduce((a, r) => a + r.maxDrawdown, 0) / results.length;
    return { name, beatM, beatRate: beatM / results.length, avgVsM, avgDD };
  })
  .filter(s => s.beatRate >= 0.4)
  .sort((a, b) => b.avgVsM - a.avgVsM);

console.log('\n STRATEGIES THAT BEAT MARKET >=40% OF THE TIME:');
if (consistentWinners.length === 0) {
  console.log(' None found.');
} else {
  consistentWinners.forEach(s => {
    console.log(` ${s.name.padEnd(30)} Beat: ${(s.beatRate*100).toFixed(0)}% | vs M: ${s.avgVsM >= 0 ? '+' : ''}${s.avgVsM.toFixed(1)}% | DD: ${s.avgDD.toFixed(0)}%`);
  });
}

// Strategies that work in bear markets
console.log('\n STRATEGIES THAT WORK BEST IN BEAR MARKETS:');
const bearStrategies = allResults.filter(r => r.market < 0);
const bearByStrat = {};
bearStrategies.forEach(r => {
  if (!bearByStrat[r.strategy]) bearByStrat[r.strategy] = [];
  bearByStrat[r.strategy].push(r);
});

Object.entries(bearByStrat)
  .map(([name, results]) => {
    const avgVsM = results.reduce((a, r) => a + r.vsMarket, 0) / results.length;
    const avgDD = results.reduce((a, r) => a + r.maxDrawdown, 0) / results.length;
    const beatM = results.filter(r => r.vsMarket > 0).length;
    return { name, avgVsM, avgDD, beatM, total: results.length };
  })
  .filter(s => s.beatM > 0)
  .sort((a, b) => b.avgVsM - a.avgVsM)
  .slice(0, 5)
  .forEach(s => {
    console.log(` ${s.name.padEnd(30)} vs M: ${s.avgVsM >= 0 ? '+' : ''}${s.avgVsM.toFixed(1)}% | Beat: ${s.beatM}/${s.total} | DD: ${s.avgDD.toFixed(0)}%`);
  });

console.log('\n' + '='.repeat(90));
