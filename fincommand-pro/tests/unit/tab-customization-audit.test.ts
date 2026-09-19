/**
 * Corrected audit of the REAL "Customize This View" engine — 9 customizable
 * tabs (My Dashboard + the 8 generalized tabs), not the 17 a mismatched spec
 * assumed. For every tab_key this programmatically verifies the exact things
 * a real "Add Widget" + "Save" click-through would exercise: every starter
 * widget sits validly on the 12-column grid, meets its own minimum series
 * requirement, references only real METRIC_CATALOG keys, doesn't overlap a
 * sibling widget, and — the strongest check — actually passes
 * parseWidgetsInput(), the exact function PUT /api/v1/dashboard-layout runs
 * against a real Save. This is a code-level/live-DB audit, not a browser
 * click-through: this environment has no browser-automation tool, so drag/
 * resize pointer-interaction fidelity needs manual QA in the running app.
 */
import {
  parseWidgetsInput, isValidGridBounds, isKnownMetricKey, TAB_KEYS, WIDGET_MIN_SERIES,
  type DashboardWidget, type TabKey,
} from '@/lib/financial/dashboard-builder-engine';
import {
  SYSTEM_DEFAULT_WIDGETS, OVERVIEW_DEFAULT_WIDGETS, MIS_DEFAULT_WIDGETS, RATIOS_DEFAULT_WIDGETS,
  TREASURY_DEFAULT_WIDGETS, WORKING_CAPITAL_DEFAULT_WIDGETS, CUSTOMER_MARGIN_DEFAULT_WIDGETS,
  VENDOR_EXPENSE_DEFAULT_WIDGETS, BOARDPACK_DEFAULT_WIDGETS, BALANCE_SHEET_DEFAULT_WIDGETS,
  PL_DEFAULT_WIDGETS, CASHFLOW_DEFAULT_WIDGETS, NOTES_DEFAULT_WIDGETS,
} from '@/lib/dashboard-builder/default-layout';

const TAB_DEFAULT_WIDGETS: Record<TabKey, DashboardWidget[]> = {
  'my-dashboard': SYSTEM_DEFAULT_WIDGETS,
  overview: OVERVIEW_DEFAULT_WIDGETS,
  mis: MIS_DEFAULT_WIDGETS,
  ratios: RATIOS_DEFAULT_WIDGETS,
  funds: TREASURY_DEFAULT_WIDGETS,
  wc: WORKING_CAPITAL_DEFAULT_WIDGETS,
  'customer-margin': CUSTOMER_MARGIN_DEFAULT_WIDGETS,
  'vendor-expense': VENDOR_EXPENSE_DEFAULT_WIDGETS,
  boardpack: BOARDPACK_DEFAULT_WIDGETS,
  bs: BALANCE_SHEET_DEFAULT_WIDGETS,
  pl: PL_DEFAULT_WIDGETS,
  cashflow: CASHFLOW_DEFAULT_WIDGETS,
  notes: NOTES_DEFAULT_WIDGETS,
};

function overlaps(a: DashboardWidget, b: DashboardWidget): boolean {
  const aRight = a.gridX + a.gridW, aBottom = a.gridY + a.gridH;
  const bRight = b.gridX + b.gridW, bBottom = b.gridY + b.gridH;
  return a.gridX < bRight && aRight > b.gridX && a.gridY < bBottom && aBottom > b.gridY;
}

describe('TAB_KEYS matches the real, corrected 13-tab scope', () => {
  test('exactly My Dashboard + the 12 generalized tabs (Balance Sheet, P&L Account, Cash Flow, and Notes to Accounts all added as an opt-in supplementary grid alongside their unmodifiable statutory tables — see TabKey\'s own doc comment) — never the 17 a mismatched spec assumed', () => {
    expect(new Set(TAB_KEYS)).toEqual(new Set([
      'my-dashboard', 'overview', 'mis', 'ratios', 'funds', 'wc', 'customer-margin', 'vendor-expense', 'boardpack', 'bs', 'pl', 'cashflow', 'notes',
    ]));
  });

  test('every TAB_KEYS entry has a corresponding starter widget set (nothing missing, nothing extra)', () => {
    expect(new Set(TAB_KEYS)).toEqual(new Set(Object.keys(TAB_DEFAULT_WIDGETS)));
  });
});

describe.each(TAB_KEYS)('starter widgets for tab_key="%s"', (tabKey) => {
  const widgets = TAB_DEFAULT_WIDGETS[tabKey];

  test('has at least one starter widget (never blank on first "Customize")', () => {
    expect(widgets.length).toBeGreaterThan(0);
  });

  test('every widget sits fully within the 12-column grid with valid dimensions', () => {
    widgets.forEach((w) => {
      expect(isValidGridBounds({ x: w.gridX, y: w.gridY, w: w.gridW, h: w.gridH }, 12)).toBe(true);
    });
  });

  test('every widget meets its own WIDGET_MIN_SERIES', () => {
    widgets.forEach((w) => {
      expect(w.series.length).toBeGreaterThanOrEqual(WIDGET_MIN_SERIES[w.widgetType]);
    });
  });

  test('every bound series metric key is real (resolves through METRIC_CATALOG)', () => {
    widgets.forEach((w) => {
      w.series.forEach((s) => {
        expect(isKnownMetricKey(s.metricKey)).toBe(true);
      });
    });
  });

  test('no two starter widgets overlap on the grid', () => {
    const collisions: string[] = [];
    for (let i = 0; i < widgets.length; i++) {
      for (let j = i + 1; j < widgets.length; j++) {
        if (overlaps(widgets[i], widgets[j])) collisions.push(`${widgets[i].id} <-> ${widgets[j].id}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  test('the whole starter set actually passes parseWidgetsInput — the exact function a real Save runs', () => {
    const raw = widgets.map((w) => ({
      widgetType: w.widgetType, title: w.title, subtitle: w.subtitle,
      gridX: w.gridX, gridY: w.gridY, gridW: w.gridW, gridH: w.gridH,
      series: w.series, vizConfig: w.vizConfig,
    }));
    const result = parseWidgetsInput(raw, 12);
    expect('widgets' in result).toBe(true);
    if ('widgets' in result) expect(result.widgets).toHaveLength(widgets.length);
  });
});
