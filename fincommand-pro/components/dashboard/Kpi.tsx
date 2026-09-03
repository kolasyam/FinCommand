'use client';

export function Kpi({ label, value, change, tone = 'neu' }: { label: string; value: string; change?: string; tone?: 'up' | 'dn' | 'neu' }) {
  const isValNeg = value.includes('(') || tone === 'dn';
  const isValPos = tone === 'up';
  const valTone = isValNeg ? 'dn' : isValPos ? 'up' : '';
  return (
    <div className="kpi">
      <div className="lbl">{label}</div>
      <div className={`val ${valTone}`}>{value}</div>
      {change && <div className={`chg ${tone}`}>{change}</div>}
    </div>
  );
}
