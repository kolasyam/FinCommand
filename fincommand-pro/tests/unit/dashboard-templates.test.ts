import { DASHBOARD_TEMPLATES, findTemplate } from '@/lib/dashboard-builder/templates';
import { STARTER_WIDGETS_BY_TAB } from '@/lib/dashboard-builder/default-layout';
import {
  parseWidgetsInput, isValidGridBounds, isKnownMetricKey, TAB_KEYS, WIDGET_MIN_SERIES, type DashboardWidget,
} from '@/lib/financial/dashboard-builder-engine';

function overlaps(a: DashboardWidget, b: DashboardWidget): boolean {
  return a.gridX < b.gridX + b.gridW && a.gridX + a.gridW > b.gridX && a.gridY < b.gridY + b.gridH && a.gridY + a.gridH > b.gridY;
}

describe('template gallery', () => {
  test('template keys are unique and resolvable', () => {
    const keys = DASHBOARD_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((k) => expect(findTemplate(k)?.key).toBe(k));
    expect(findTemplate('does-not-exist')).toBeUndefined();
  });

  describe.each(DASHBOARD_TEMPLATES.map((t) => [t.key, t] as const))('%s', (_key, template) => {
    test('has a name, description and at least 4 widgets', () => {
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.widgets.length).toBeGreaterThanOrEqual(4);
    });
    test('passes parseWidgetsInput — the exact validation a real Save runs', () => {
      const parsed = parseWidgetsInput(template.widgets);
      expect(parsed).not.toHaveProperty('error');
    });
    test('every widget sits inside the 12-column grid and meets its minimum series', () => {
      template.widgets.forEach((w) => {
        expect(isValidGridBounds({ x: w.gridX, y: w.gridY, w: w.gridW, h: w.gridH })).toBe(true);
        expect(w.series.length).toBeGreaterThanOrEqual(WIDGET_MIN_SERIES[w.widgetType]);
      });
    });
    test('binds only real catalog metrics (never a fabricated figure)', () => {
      template.widgets.forEach((w) => w.series.forEach((s) => expect(isKnownMetricKey(s.metricKey)).toBe(true)));
    });
    test('no two widgets overlap', () => {
      const ws = template.widgets;
      for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
        expect([ws[i].id, ws[j].id, overlaps(ws[i], ws[j])]).toEqual([ws[i].id, ws[j].id, false]);
      }
    });
  });
});

test('STARTER_WIDGETS_BY_TAB covers exactly the fixed tabs (used to copy a fixed tab into a new custom tab)', () => {
  expect(new Set(Object.keys(STARTER_WIDGETS_BY_TAB))).toEqual(new Set(TAB_KEYS));
  Object.values(STARTER_WIDGETS_BY_TAB).forEach((ws) => expect(parseWidgetsInput(ws)).not.toHaveProperty('error'));
});
