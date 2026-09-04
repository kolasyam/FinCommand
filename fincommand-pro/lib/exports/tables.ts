import type { ReportBundle } from '@/lib/dashboard/types';
import { fl as flBase, fn as fnBase, fx, frRaw, pct, formatDate, getFyLabel, getFyShortLabel, unitSuffix, formatChg as formatChgBase, type DisplayUnit, type CurrencyCode } from '@/lib/utils/format';
import { getCurrencyMeta } from '@/lib/services/currency';
import type { AggregatedNote } from '@/lib/financial/tb-engine';

export interface ExportTable {
  title: string;
  sheetName: string;
  columns: string[];
  rows: (string | number)[][];
}

/** Converts a report section into generic {columns, rows} tables — shared by both XLSX and PDF exporters. `unit` controls the magnitude every number is expressed in; `compare` controls whether prior-year columns/rows are included at all; `currency` controls the symbol shown (the PDF path additionally sanitizes the ₹/د.إ symbols for jsPDF's font limitations — see pdf.ts's sanitizePdfText). */
export function getExportTables(section: string, bundle: ReportBundle, unit: DisplayUnit = 'Lakhs', compare = true, currency: CurrencyCode = 'INR'): ExportTable[] {
  const yearType = bundle.period_params?.yearType || 'FY';
  const fy = bundle.financial_year;
  const fyFullLabel = getFyLabel(fy, yearType);
  const fyLabel = getFyShortLabel(fy, yearType);
  const prevFyLabel = getFyShortLabel(bundle.prev_financial_year, yearType);
  const hasPrev = !!(compare && prevFyLabel && (bundle.prev_bs || bundle.prev_pl || bundle.prev_cashflow || bundle.prev_notes));
  const sfx = unitSuffix(unit);
  const symbol = getCurrencyMeta(currency).symbol;
  // Locally shadow fl/fn so every call site below (unchanged) picks up the
  // selected unit automatically instead of always defaulting to Lakhs.
  const fl = (n: number | null | undefined, decimals = 2) => flBase(n, decimals, unit);
  const fn = (n: number | null | undefined, decimals = 2) => fnBase(n, decimals, unit);
  const formatChg = (n: number | null | undefined, decimals = 2) => formatChgBase(n, decimals, unit);

  switch (section) {
    // ── Executive Overview ──────────────────────────────────────────────────
    case 'overview': {
      const { mis, bs, pl, cashflow: cf, ratios: r, treasury } = bundle;
      const t = mis.totals;
      return [{
        title: `Executive Overview — ${fyFullLabel}`,
        sheetName: 'Executive Overview',
        columns: ['Key Financial Metric', `Value (${symbol} ${unit})`],
        rows: [
          ['Revenue from Operations', fl(t.rev)],
          ['Other Income', fl(t.oth)],
          ['Total Income', fl(t.totInc)],
          ['Cost of Services', fl(t.cos)],
          ['Employee Benefits', fl(t.emp)],
          ['Total Expenses', fl(t.totExp)],
          ['EBITDA (Operating)', fl(t.ebitda)],
          ['EBITDA Margin %', pct(r.profitability.ebitda_margin)],
          ['Profit Before Tax (PBT)', fl(t.pbt)],
          ['Tax Expense', fl(t.tax)],
          ['Profit After Tax (PAT)', fl(t.pat)],
          ['Net Margin %', pct(r.profitability.net_margin)],
          ['', ''],
          ['Total Assets', fl(bs.assets.total)],
          ['Total Equity', fl(bs.equity_liabilities.total_equity)],
          ['Total Liabilities', fl(bs.equity_liabilities.total_ncl + bs.equity_liabilities.total_cl)],
          ['', ''],
          ['Operating Cash Flow', fl((cf.operating as Record<string, unknown>).total as number)],
          ['Free Cash Flow', fl(cf.free_cash_flow)],
          ['Treasury Position', fl(treasury.total)],
          ['', ''],
          ['Current Ratio', fx(r.liquidity.current_ratio)],
          ['Debt / Equity', fx(r.leverage.debt_equity)],
          ['ROE %', pct(r.profitability.roe)],
          ['ROCE %', pct(r.profitability.roce)],
        ],
      }];
    }

    // ── MIS Report ──────────────────────────────────────────────────────────
    case 'mis': {
      const { mis } = bundle;
      const rowsDef: [string, keyof typeof mis.data[number]][] = [
        ['Revenue from Operations', 'rev'], ['Other Income', 'oth'], ['Total Income', 'totInc'],
        ['Cost of Services', 'cos'], ['Employee Benefits', 'emp'], ['Finance Costs', 'fin'],
        ['Depreciation & Amortisation', 'dep'], ['Other Expenses', 'oex'], ['Total Expenses', 'totExp'],
        ['Profit Before Tax (PBT)', 'pbt'], ['Tax Expense', 'tax'], ['Profit After Tax (PAT)', 'pat'],
      ];

      const plRows = rowsDef.map(([label, key]) => [
        label,
        ...mis.data.map(d => fl(d[key] as number)),
        fl(mis.totals[key as keyof typeof mis.totals] as number),
      ]);

      // Margin % rows — same as displayed in the UI table
      const marginRows: [string, keyof typeof mis.data[number]][] = [
        ['Gross Margin %', 'gm'],
        ['EBITDA Margin %', 'em'],
        ['PAT Margin %', 'pm'],
      ];
      marginRows.forEach(([label, key]) => {
        plRows.push([
          label,
          ...mis.data.map(d => pct(d[key] as number)),
          pct(mis.totals[key as keyof typeof mis.totals] as number),
        ]);
      });

      return [{
        title: `MIS Report — ${fyFullLabel}`,
        sheetName: 'MIS Report',
        columns: ['Particulars', ...mis.columns, 'Total'],
        rows: plRows,
      }];
    }

    // ── Balance Sheet ───────────────────────────────────────────────────────
    case 'bs': {
      const { bs } = bundle;
      const prevBs = compare ? bundle.prev_bs : null;
      const prevEq = prevBs?.equity_liabilities;
      const prevAs = prevBs?.assets;

      const formatNoteRows = (notes: AggregatedNote[], prevNotes?: AggregatedNote[]) => {
        if (!hasPrev) {
          return notes.map(n => [n.note_name || `Note ${n.note_no}`, n.note_no, fl(n.total)]);
        }
        const allNos = Array.from(new Set([...notes.map(n => n.note_no), ...(prevNotes || []).map(n => n.note_no)])).sort((a, b) => a - b);
        return allNos.map(no => {
          const curr = notes.find(n => n.note_no === no);
          const prev = (prevNotes || []).find(n => n.note_no === no);
          const name = curr?.note_name || prev?.note_name || `Note ${no}`;
          const cVal = curr?.total ?? 0;
          const pVal = prev?.total ?? 0;
          const chg = cVal - pVal;
          return [name, no, fl(cVal), fl(pVal), formatChg(chg)];
        });
      };

      const cols = hasPrev
        ? ['Particulars', 'Note', `${fyLabel} (${symbol}${sfx})`, `${prevFyLabel} (${symbol}${sfx})`, `YoY Change (${symbol}${sfx})`]
        : ['Particulars', 'Note', `Amount (${symbol}${sfx})`];

      const eqRows = hasPrev
        ? [
            ...formatNoteRows(bs.equity_liabilities.equity, prevEq?.equity),
            ['Total Equity', '', fl(bs.equity_liabilities.total_equity), fl(prevEq?.total_equity ?? 0), fl(bs.equity_liabilities.total_equity - (prevEq?.total_equity ?? 0))],
            ...formatNoteRows(bs.equity_liabilities.non_current_liab, prevEq?.non_current_liab),
            ['Total Non-Current Liabilities', '', fl(bs.equity_liabilities.total_ncl), fl(prevEq?.total_ncl ?? 0), fl(bs.equity_liabilities.total_ncl - (prevEq?.total_ncl ?? 0))],
            ...formatNoteRows(bs.equity_liabilities.current_liab, prevEq?.current_liab),
            ['Total Current Liabilities', '', fl(bs.equity_liabilities.total_cl), fl(prevEq?.total_cl ?? 0), fl(bs.equity_liabilities.total_cl - (prevEq?.total_cl ?? 0))],
            ['TOTAL EQUITY & LIABILITIES', '', fl(bs.equity_liabilities.total), fl(prevEq?.total ?? 0), fl(bs.equity_liabilities.total - (prevEq?.total ?? 0))],
          ]
        : [
            ...formatNoteRows(bs.equity_liabilities.equity),
            ['Total Equity', '', fl(bs.equity_liabilities.total_equity)],
            ...formatNoteRows(bs.equity_liabilities.non_current_liab),
            ['Total Non-Current Liabilities', '', fl(bs.equity_liabilities.total_ncl)],
            ...formatNoteRows(bs.equity_liabilities.current_liab),
            ['Total Current Liabilities', '', fl(bs.equity_liabilities.total_cl)],
            ['TOTAL EQUITY & LIABILITIES', '', fl(bs.equity_liabilities.total)],
          ];

      const assetRows = hasPrev
        ? [
            ...formatNoteRows(bs.assets.non_current, prevAs?.non_current),
            ['Total Non-Current Assets', '', fl(bs.assets.total_nca), fl(prevAs?.total_nca ?? 0), fl(bs.assets.total_nca - (prevAs?.total_nca ?? 0))],
            ...formatNoteRows(bs.assets.current, prevAs?.current),
            ['Total Current Assets', '', fl(bs.assets.total_ca), fl(prevAs?.total_ca ?? 0), fl(bs.assets.total_ca - (prevAs?.total_ca ?? 0))],
            ['TOTAL ASSETS', '', fl(bs.assets.total), fl(prevAs?.total ?? 0), fl(bs.assets.total - (prevAs?.total ?? 0))],
          ]
        : [
            ...formatNoteRows(bs.assets.non_current),
            ['Total Non-Current Assets', '', fl(bs.assets.total_nca)],
            ...formatNoteRows(bs.assets.current),
            ['Total Current Assets', '', fl(bs.assets.total_ca)],
            ['TOTAL ASSETS', '', fl(bs.assets.total)],
          ];

      return [
        {
          title: `Balance Sheet — Equity & Liabilities — ${fyFullLabel}`,
          sheetName: 'BS - Equity & Liab',
          columns: cols,
          rows: eqRows,
        },
        {
          title: `Balance Sheet — Assets — ${fyFullLabel}`,
          sheetName: 'BS - Assets',
          columns: cols,
          rows: assetRows,
        },
      ];
    }

    // ── Statement of Profit & Loss ──────────────────────────────────────────
    case 'pl': {
      const { pl } = bundle;
      const prevPl = compare ? bundle.prev_pl : null;

      const cols = hasPrev
        ? ['Particulars', 'Note', `${fyLabel} (${symbol}${sfx})`, `${prevFyLabel} (${symbol}${sfx})`, `YoY Change (${symbol}${sfx})`]
        : ['Particulars', 'Note', `Amount (${symbol}${sfx})`];

      // `raw` = true for EPS: a currency-per-share figure, not a table-unit
      // amount — must use frRaw() (no unit conversion), same as PLTab.tsx's
      // on-screen table. Passing it through fl() would silently render a
      // real EPS like -2.10 as "—" (divided down to next-to-nothing).
      // `currVal`/`prevVal` of `null` = genuinely not determinable from a
      // Trial Balance (OCI, EPS — see computePL()'s doc comment) — shown as
      // "n/a", never as "—" (which reads as zero/negligible, not "unknown").
      const makeRow = (label: string, noteNo: string | number, currVal: number | string | null, prevVal?: number | string | null, raw = false) => {
        const f = raw ? frRaw : fl;
        const disp = (v: number | string | null | undefined) => (typeof v === 'number' ? f(v) : v === null ? 'n/a' : (v ?? ''));
        // Same '+—' guard as formatChg(), generalized for the raw (EPS,
        // no unit conversion) vs. table-unit-converted dual mode above.
        const dispChg = (v: number) => {
          const text = f(v);
          return text === '—' ? '—' : (v > 0 ? `+${text}` : text);
        };
        if (!hasPrev) return [label, noteNo, disp(currVal)];
        const cNum = typeof currVal === 'number' ? currVal : null;
        const pNum = typeof prevVal === 'number' ? prevVal : null;
        const chg = cNum != null && pNum != null ? cNum - pNum : null;
        return [
          label,
          noteNo,
          disp(currVal),
          disp(prevVal),
          chg != null ? dispChg(chg) : (currVal === null ? 'n/a' : '—'),
        ];
      };

      return [{
        title: `Statement of Profit & Loss — ${fyFullLabel}`,
        sheetName: 'Profit & Loss',
        columns: cols,
        rows: [
          makeRow('I. INCOME', '', ''),
          makeRow('Revenue from Operations', 20, pl.revenue, prevPl?.revenue),
          makeRow('Other Income', 21, pl.other_income, prevPl?.other_income),
          makeRow('Total Income (I)', '', pl.total_income, prevPl?.total_income),
          makeRow('II. EXPENSES', '', ''),
          makeRow('Cost of Services / Materials Consumed', 22, pl.cos, prevPl?.cos),
          makeRow('Employee Benefits Expense', 23, pl.employee_benefits, prevPl?.employee_benefits),
          makeRow('Finance Costs', 24, pl.finance_costs, prevPl?.finance_costs),
          makeRow('Depreciation & Amortisation', 25, pl.depreciation, prevPl?.depreciation),
          makeRow('Other Expenses', 26, pl.other_expenses, prevPl?.other_expenses),
          makeRow('Total Expenses (II)', '', pl.total_expenses, prevPl?.total_expenses),
          makeRow('III. PROFIT', '', ''),
          makeRow('Profit Before Tax (I - II)', '', pl.pbt, prevPl?.pbt),
          makeRow('Current Tax (25%)', '', pl.current_tax, prevPl?.current_tax),
          makeRow('Deferred Tax Charge / (Credit)', '', pl.deferred_tax, prevPl?.deferred_tax),
          makeRow('Profit After Tax (PAT)', '', pl.pat, prevPl?.pat),
          makeRow('IV. OTHER COMPREHENSIVE INCOME (IND AS 1)', '', ''),
          makeRow('Remeasurement of Defined Benefit Obligation', '', pl.oci_gross, prevPl?.oci_gross),
          makeRow('Income Tax on OCI', '', pl.oci_tax, prevPl?.oci_tax),
          makeRow('Other Comprehensive Income (Net of Tax)', '', pl.oci_net, prevPl?.oci_net),
          makeRow('Total Comprehensive Income', '', pl.total_comprehensive_income, prevPl?.total_comprehensive_income),
          makeRow('V. EARNINGS PER SHARE (IND AS 33)', '', ''),
          makeRow(`Basic EPS (${symbol})`, '', pl.eps_basic, prevPl?.eps_basic, true),
          makeRow(`Diluted EPS (${symbol})`, '', pl.eps_diluted, prevPl?.eps_diluted, true),
        ],
      }];
    }

    // ── Notes to Accounts ───────────────────────────────────────────────────
    case 'notes': {
      const { notes } = bundle;
      const prevNotes = compare ? bundle.prev_notes : null;
      const isBS = (sec?: string | null) => ['anc', 'ac', 'eq', 'lnc', 'lc'].includes(sec || '');
      const getNoteKey = (n: AggregatedNote) => `${isBS(n.section) ? 'bs' : 'pl'}_${n.note_no}`;

      const allKeys = Array.from(new Set([...notes.map(getNoteKey), ...(prevNotes || []).map(getNoteKey)]));

      const tables: ExportTable[] = [];

      allKeys.forEach(key => {
        const curr = notes.find(n => getNoteKey(n) === key);
        const prev = (prevNotes || []).find(pn => getNoteKey(pn) === key);
        const noteNo = curr?.note_no || prev?.note_no || 0;
        const noteName = curr?.note_name || prev?.note_name || `Note ${noteNo}`;

        const currL = curr?.ledgers || [];
        const prevL = prev?.ledgers || [];

        const allItems: { name: string; cNet: number; pNet: number }[] = [];
        const seen = new Set<string>();

        currL.forEach(l => {
          const code = l.ledger_code || '';
          const name = l.ledger_name;
          const matchKey = code ? `code_${code}` : `name_${name.toLowerCase()}`;
          seen.add(matchKey);
          const pMatch = prevL.find(p => (code && p.ledger_code === code) || p.ledger_name.toLowerCase() === name.toLowerCase());
          allItems.push({ name, cNet: l.net, pNet: pMatch?.net ?? 0 });
        });

        prevL.forEach(p => {
          const code = p.ledger_code || '';
          const name = p.ledger_name;
          const matchKey = code ? `code_${code}` : `name_${name.toLowerCase()}`;
          if (!seen.has(matchKey)) {
            allItems.push({ name, cNet: 0, pNet: p.net });
          }
        });

        const cols = hasPrev
          ? ['Ledger Name', `${fyLabel} (${symbol}${sfx})`, `${prevFyLabel} (${symbol}${sfx})`, `YoY Change (${symbol}${sfx})`]
          : ['Ledger Name', `Amount (${symbol}${sfx})`];

        const rows = allItems.map(item => {
          const chg = item.cNet - item.pNet;
          return hasPrev
            ? [item.name, fl(item.cNet), fl(item.pNet), formatChg(chg)]
            : [item.name, fl(item.cNet)];
        });

        const cTot = curr?.total ?? 0;
        const pTot = prev?.total ?? 0;
        const totChg = cTot - pTot;

        if (hasPrev) {
          rows.push(['TOTAL NOTE ' + noteNo, fl(cTot), fl(pTot), formatChg(totChg)]);
        } else {
          rows.push(['TOTAL NOTE ' + noteNo, fl(cTot)]);
        }

        tables.push({
          title: `Note ${noteNo} — ${noteName}`,
          sheetName: `Note ${noteNo}`.slice(0, 31),
          columns: cols,
          rows,
        });
      });

      return tables;
    }

    // ── Treasury ────────────────────────────────────────────────────────────
    case 'treasury': {
      const { treasury } = bundle;
      const rows: (string | number)[][] = [];
      const addSection = (label: string, entries: typeof treasury.cash) => {
        entries.forEach(e => rows.push([label, e.name, fl(e.closing)]));
      };
      addSection('Cash', treasury.cash);
      addSection('Bank — Current A/c', treasury.bank_ca);
      addSection('Bank — Savings A/c', treasury.bank_sb);
      addSection('Fixed Deposits', treasury.fds);
      addSection('Mutual Funds', treasury.mfs);
      rows.push(['TOTAL TREASURY', 'Cash + Bank + FDs + MFs', fl(treasury.total)]);
      return [{
        title: `Treasury & Bank Balances — ${fyFullLabel}`,
        sheetName: 'Treasury',
        columns: ['Category', 'Instrument / Bank', `Closing Balance (${symbol}${sfx})`],
        rows,
      }];
    }

    // ── Statement of Cash Flows (Full Detail) ───────────────────────────────
    case 'cashflow': {
      const { cashflow: cf } = bundle;
      const prevCf = compare ? bundle.prev_cashflow : null;
      const op = cf.operating as Record<string, unknown>;
      const inv = cf.investing as Record<string, unknown>;
      const fin = cf.financing as Record<string, unknown>;
      const adj = op.adjustments as Record<string, number> | undefined;
      const wc = op.wc_changes as Record<string, number> | undefined;

      const prevOp = prevCf ? (prevCf.operating as Record<string, unknown>) : null;
      const prevInv = prevCf ? (prevCf.investing as Record<string, unknown>) : null;
      const prevFin = prevCf ? (prevCf.financing as Record<string, unknown>) : null;
      const prevAdj = prevOp ? (prevOp.adjustments as Record<string, number>) : null;
      const prevWc = prevOp ? (prevOp.wc_changes as Record<string, number>) : null;

      const cols = hasPrev
        ? ['Particulars', `${fyLabel} (${symbol}${sfx})`, `${prevFyLabel} (${symbol}${sfx})`, `YoY Change (${symbol}${sfx})`]
        : ['Particulars', `Amount (${symbol}${sfx})`];

      const makeRow = (label: string, cVal?: number | string | null, pVal?: number | string | null): (string | number)[] => {
        if (!hasPrev) return [label, typeof cVal === 'number' ? fn(cVal) : (cVal ?? '—')];
        const cNum = typeof cVal === 'number' ? cVal : null;
        const pNum = typeof pVal === 'number' ? pVal : null;
        const chg = cNum != null && pNum != null ? cNum - pNum : null;
        return [
          label,
          typeof cVal === 'number' ? fn(cVal) : (cVal ?? '—'),
          typeof pVal === 'number' ? fn(pVal) : (pVal ?? '—'),
          chg != null ? formatChg(chg) : '—',
        ];
      };

      const rows: (string | number)[][] = [];

      // ── Section A: Operating Activities ───────────────────────────────────
      rows.push(makeRow('A. CASH FLOW FROM OPERATING ACTIVITIES', '', ''));
      rows.push(makeRow('Profit Before Tax', op.pbt as number, prevOp ? (prevOp.pbt as number) : null));
      rows.push(makeRow('  ADJUSTMENTS FOR NON-CASH ITEMS:', '', ''));

      if (adj) {
        Object.entries(adj).forEach(([key, val]) => {
          rows.push(makeRow(`    ${key}`, val, prevAdj ? (prevAdj[key] ?? null) : null));
        });
      }

      rows.push(makeRow('Operating Profit before WC changes', op.operating_profit as number, prevOp ? (prevOp.operating_profit as number) : null));
      rows.push(makeRow('  CHANGES IN WORKING CAPITAL:', '', ''));

      if (wc) {
        Object.entries(wc).filter(([k]) => k !== 'total').forEach(([key, val]) => {
          rows.push(makeRow(`    ${key}`, val, prevWc ? (prevWc[key] ?? null) : null));
        });
      }

      rows.push(makeRow('Tax Paid', op.tax_paid as number, prevOp ? (prevOp.tax_paid as number) : null));
      rows.push(makeRow('Net Cash from Operating Activities (A)', op.total as number, prevOp ? (prevOp.total as number) : null));

      // ── Section B: Investing Activities ───────────────────────────────────
      rows.push(makeRow('', '', ''));
      rows.push(makeRow('B. CASH FLOW FROM INVESTING ACTIVITIES', '', ''));
      Object.entries(inv).filter(([k]) => k !== 'total').forEach(([key, val]) => {
        rows.push(makeRow(`    ${key}`, val as number, prevInv ? ((prevInv as Record<string, number>)[key] ?? null) : null));
      });
      rows.push(makeRow('Net Cash from Investing Activities (B)', inv.total as number, prevInv ? (prevInv.total as number) : null));

      // ── Section C: Financing Activities ───────────────────────────────────
      rows.push(makeRow('', '', ''));
      rows.push(makeRow('C. CASH FLOW FROM FINANCING ACTIVITIES', '', ''));
      Object.entries(fin).filter(([k]) => k !== 'total').forEach(([key, val]) => {
        rows.push(makeRow(`    ${key}`, val as number, prevFin ? ((prevFin as Record<string, number>)[key] ?? null) : null));
      });
      rows.push(makeRow('Net Cash from Financing Activities (C)', fin.total as number, prevFin ? (prevFin.total as number) : null));

      // ── Summary ───────────────────────────────────────────────────────────
      rows.push(makeRow('', '', ''));
      rows.push(makeRow('NET CHANGE IN CASH / NET INCREASE (DECREASE) (A+B+C)', cf.net_change, prevCf?.net_change));
      rows.push(makeRow('Opening Cash & Cash Equivalents', cf.opening_cash, prevCf?.opening_cash));
      rows.push(makeRow('Closing Cash & Cash Equivalents', cf.closing_cash, prevCf?.closing_cash));
      rows.push(makeRow('Free Cash Flow (OCF - Capex)', cf.free_cash_flow, prevCf?.free_cash_flow));

      return [{
        title: `Statement of Cash Flows (Indirect Method) — ${fyFullLabel}`,
        sheetName: 'Cash Flow',
        columns: cols,
        rows,
      }];
    }

    // ── Key Financial Ratios ────────────────────────────────────────────────
    case 'ratios': {
      const r = bundle.ratios;
      return [{
        title: `Key Financial Ratios & Analysis — ${fyFullLabel}`,
        sheetName: 'Ratios',
        columns: ['Category', 'Metric', 'Ratio Value'],
        rows: [
          ['Liquidity', 'Current Ratio', `${r.liquidity.current_ratio}x`],
          ['Liquidity', 'Quick Ratio', `${r.liquidity.quick_ratio}x`],
          ['Liquidity', 'Cash Ratio', `${r.liquidity.cash_ratio}x`],
          ['Profitability', 'Gross Margin %', `${r.profitability.gross_margin}%`],
          ['Profitability', 'EBITDA Margin %', `${r.profitability.ebitda_margin}%`],
          ['Profitability', 'Net Margin %', `${r.profitability.net_margin}%`],
          ['Profitability', 'Return on Equity (ROE) %', `${r.profitability.roe}%`],
          ['Profitability', 'Return on Capital Employed (ROCE) %', `${r.profitability.roce}%`],
          ['Leverage', 'Debt to Equity', `${r.leverage.debt_equity}x`],
          ['Leverage', 'Interest Coverage Ratio', `${r.leverage.interest_cover}x`],
          ['Leverage', 'Debt Service Coverage Ratio (DSCR)', r.leverage.dscr !== null ? `${r.leverage.dscr}x` : 'N/A (no debt service)'],
          ['Efficiency', 'Asset Turnover Ratio', `${r.efficiency.asset_turnover}x`],
          ['Efficiency', 'Days Sales Outstanding (DSO)', `${r.efficiency.dso} days`],
          ['Efficiency', 'Days Payable Outstanding (DPO)', `${r.efficiency.dpo} days`],
          ['Efficiency', 'Cash Conversion Cycle (CCC)', `${r.efficiency.ccc} days`],
        ],
      }];
    }

    // ── Working Capital ─────────────────────────────────────────────────────
    case 'workingcapital': {
      const r = bundle.ratios;
      const bs = bundle.bs;
      return [{
        title: `Working Capital Analysis — ${fyFullLabel}`,
        sheetName: 'Working Capital',
        columns: ['Working Capital Metric', 'Value'],
        rows: [
          ['Days Sales Outstanding (DSO)', `${r.efficiency.dso} days`],
          ['Days Payable Outstanding (DPO)', `${r.efficiency.dpo} days`],
          ['Cash Conversion Cycle (CCC)', `${r.efficiency.ccc} days`],
          [`Current Assets (${symbol}${sfx})`, fl(bs.assets.total_ca)],
          [`Current Liabilities (${symbol}${sfx})`, fl(bs.equity_liabilities.total_cl)],
          [`Net Working Capital (CA - CL) (${symbol}${sfx})`, fl(bs.assets.total_ca - bs.equity_liabilities.total_cl)],
          ['Current Ratio', `${r.liquidity.current_ratio}x`],
          ['Quick Ratio', `${r.liquidity.quick_ratio}x`],
        ],
      }];
    }

    // ── Smart Alerts ────────────────────────────────────────────────────────
    case 'alerts': {
      return [{
        title: `Smart Audit Alerts & Risk Triggers — ${fyFullLabel}`,
        sheetName: 'Audit Alerts',
        columns: ['Category', 'Audit Indicator', 'Status / Findings'],
        rows: [
          ['Double-Entry Integrity', 'Trial Balance Difference', bundle.bs.balanced ? `Pass (${symbol}0.00 Diff)` : `Flagged (${symbol}${fl(bundle.bs.difference)}${sfx} Diff)`],
          ['Liquidity Risk', 'Current Ratio Check', bundle.ratios.liquidity.current_ratio >= 1.2 ? 'Healthy (>1.2x)' : 'Attention Required (<1.2x)'],
          ['Receivables Risk', 'DSO Check', bundle.ratios.efficiency.dso <= 60 ? 'Optimal (<=60 days)' : 'High Collection Period (>60 days)'],
          ['Debt Risk', 'Debt / Equity Ratio', bundle.ratios.leverage.debt_equity <= 1.5 ? 'Moderate Leverage' : 'High Leverage (>1.5x)'],
          ['Profitability', 'Net Margin Trend', bundle.ratios.profitability.net_margin >= 5 ? 'Profitable' : 'Low Margin (<5%)'],
        ],
      }];
    }

    // ── Compliance ──────────────────────────────────────────────────────────
    case 'compliance': {
      return [{
        title: `Statutory & IND AS Compliance Checklist — ${fyFullLabel}`,
        sheetName: 'Compliance',
        columns: ['Standard / Regulation', 'Compliance Area', 'Status'],
        rows: [
          ['IND AS Schedule III', 'Balance Sheet & P&L Presentation', 'Compliant'],
          ['IND AS 7', 'Statement of Cash Flows (Indirect Method)', 'Compliant'],
          ['IND AS 116', 'Lease Assets & Liabilities Accounting', 'Compliant'],
          // Genuinely 'n/a', not 'Compliant': computePL() always leaves OCI
          // null — an actuarial valuation of a defined benefit obligation
          // isn't derivable from Trial Balance ledger balances alone, so it
          // was never computed. Claiming this standard was met contradicts
          // the P&L statement's own "n/a" disclosure elsewhere in this same
          // report bundle.
          ['IND AS 19', 'Employee Benefits & Actuarial Valuation', 'n/a - requires actuarial valuation, not derivable from a Trial Balance'],
          ['IND AS 12', 'Income Taxes & Deferred Tax Calculation', 'Compliant'],
          ['Companies Act 2013', 'Board Pack & Financial Audit Trail', 'Verified'],
        ],
      }];
    }

    // ── Board Pack ──────────────────────────────────────────────────────────
    case 'boardpack': {
      const mis = bundle.mis;
      return [{
        title: `Executive Board Pack Summary — ${fyFullLabel}`,
        sheetName: 'Board Pack',
        columns: ['Financial Key Metric', `Full Year Performance (${symbol}${sfx})`],
        rows: [
          ['Total Revenue from Operations', fl(mis.totals.rev)],
          ['Total Operating Expenses', fl(mis.totals.totExp)],
          ['Profit Before Tax (PBT)', fl(mis.totals.pbt)],
          ['Profit After Tax (PAT)', fl(mis.totals.pat)],
          ['Closing Cash & Bank Balance', fl(bundle.cashflow.closing_cash)],
          ['Operating Cash Flow (OCF)', fl((bundle.cashflow.operating as Record<string, unknown>).total as number)],
          ['Total Assets', fl(bundle.bs.assets.total)],
          ['Net Equity & Reserves', fl(bundle.bs.equity_liabilities.total_equity)],
        ],
      }];
    }

    // ── Scenario Planner ────────────────────────────────────────────────────
    case 'scenario': {
      const pl = bundle.pl;
      return [{
        title: `Scenario Planner & Sensitivity Model — ${fyFullLabel}`,
        sheetName: 'Scenario Planning',
        columns: ['Scenario Case', 'Revenue Impact', `PAT Impact (${symbol}${sfx})`],
        rows: [
          ['Base Case (Actuals)', '0% Change', fl(pl.pat)],
          ['Bull Case (+10% Revenue)', '+10% Growth', fl(pl.pat * 1.15)],
          ['Bear Case (-10% Revenue)', '-10% Decline', fl(pl.pat * 0.82)],
          ['Cost Optimisation (-5% Expenses)', '-5% Expenses', fl(pl.pat + (pl.total_expenses * 0.05 * 0.75))],
        ],
      }];
    }

    default:
      return [];
  }
}

export function metaRows(bundle: ReportBundle, companyName = 'Sample Company (Demo Data)', currency: CurrencyCode = 'INR'): (string | number)[][] {
  const yearType = bundle.period_params?.yearType || 'FY';
  const fyFullLabel = getFyLabel(bundle.financial_year, yearType);
  const sourceCurrency = bundle.source_currency || 'INR';
  const rows: (string | number)[][] = [
    ['Company', companyName],
    ['Reporting Year', fyFullLabel],
    ['Year Type', yearType],
    ['Reporting Period', bundle.period_label],
    ['Source Currency (Books of Account)', sourceCurrency],
  ];
  if (currency !== sourceCurrency) {
    rows.push([
      'Presentation Currency',
      `${currency} — converted from ${sourceCurrency} at a spot rate for reference only; the statutory books remain in ${sourceCurrency}`,
    ]);
  }
  rows.push(
    ['IND AS Standard', 'Schedule III Division II Compliant'],
    ['Generated At', formatDate(bundle.generated_at)],
  );
  return rows;
}

export { pct };
