export function summarize(values) {
  const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a,b) => a-b);
  if (!valid.length) return null;
  return { count: valid.length, average: valid.reduce((a,b)=>a+b,0)/valid.length,
    low: valid[0], high: valid.at(-1), p99: valid[Math.ceil(valid.length*.99)-1] };
}
