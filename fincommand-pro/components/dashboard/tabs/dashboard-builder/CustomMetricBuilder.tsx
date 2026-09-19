'use client';

/**
 * Structured custom-metric builder — two kinds, both built from pickers, never
 * a free-text formula box (CONSTRAINTS.md):
 *
 *  - Formula: start from one figure, then chain steps — an operator with its
 *    operand (+ − × ÷, % of, lower/higher of, if-blank-use, round) or a
 *    function applied to the running result (absolute value, % change vs
 *    last year, monthly average). Operands are any built-in metric, a number,
 *    or ANOTHER custom metric (never one that would create a cycle — those
 *    are filtered out here and rejected again by the server). Previews
 *    client-side from the loaded bundle via the same resolveCustomMetric()
 *    widgets use.
 *
 *  - From ledgers: a filter over the real Trial Balance ("Ledger name
 *    contains salary AND Note no. is 23"), movement vs closing balance,
 *    natural vs inverted sign. Previews server-side (POST
 *    /custom-metrics/preview) for the dashboard's current FY/period and lists
 *    exactly which ledgers matched, so the definition can be verified before
 *    it's saved.
 *
 * Editing shows the metric's version history; any earlier version can be
 * restored (saved as a new version — history is never rewritten).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDashboard } from '@/lib/dashboard/DashboardContext';
import { useToast } from '@/lib/dashboard/ToastContext';
import { useCustomMetricsList } from '@/lib/dashboard/TabCustomizationsContext';
import { ApiClientError } from '@/lib/dashboard/api-client';
import {
  saveCustomMetric, previewLedgerMetric, fetchCustomMetricVersions, restoreCustomMetricVersion,
  type LedgerMetricPreview, type CustomMetricVersionDTO,
} from '@/lib/dashboard/dashboard-builder-api';
import {
  buildChainExpr, flattenChain, resolveCustomMetric, customMetricCapabilities, describeCustomMetric,
  findDependents, isUnaryOp, metricKind, fromSnapshot, CUSTOM_METRIC_KEY_RE,
  type FormulaOp, type Operand, type ChainStep, type CustomMetricDefinition, type CustomMetricKind, type MetricComparison,
} from '@/lib/financial/custom-metric-engine';
import { METRIC_CATALOG, thresholdStatus, type ValueType } from '@/lib/financial/dashboard-builder-engine';
import {
  LEDGER_FILTER_FIELDS, LEDGER_FILTER_OPERATORS, LEDGER_AGGREGATIONS,
  NUMERIC_LEDGER_FIELDS, NUMERIC_ONLY_OPERATORS, TEXT_ONLY_OPERATORS, VALUELESS_OPERATORS,
  type LedgerFilterCondition, type LedgerFilterField, type LedgerFilterOperator, type LedgerMetricSpec, type LedgerAggregation,
} from '@/lib/financial/tb-engine';
import { fn, fx, pct, signedPct, type DisplayUnit } from '@/lib/utils/format';
import { ConfirmModal } from '@/components/ui/ConfirmModal';

const STEP_LABELS: Record<FormulaOp, string> = {
  add: 'Add (+)', subtract: 'Subtract (−)', multiply: 'Multiply (×)', divide: 'Divide (÷)',
  safe_divide: 'Divide — blank if zero', percent_of: 'As % of', min: 'Lower of', max: 'Higher of',
  coalesce: 'If blank, use', round: 'Round to decimals',
  abs: 'Absolute value', percent_change: '% change vs last year', avg_per_month: 'Monthly average',
};
const STEP_GROUPS: { label: string; ops: FormulaOp[] }[] = [
  { label: 'Combine with a figure', ops: ['add', 'subtract', 'multiply', 'divide', 'safe_divide', 'percent_of', 'min', 'max', 'coalesce', 'round'] },
  { label: 'Apply a function', ops: ['abs', 'percent_change', 'avg_per_month'] },
];
const VALUE_TYPES: { value: ValueType; label: string }[] = [
  { value: 'percent', label: 'Percent (%)' }, { value: 'currency', label: 'Currency' },
  { value: 'ratio', label: 'Ratio (x)' }, { value: 'days', label: 'Days' }, { value: 'number', label: 'Plain number' },
];
const FIELD_LABELS: Record<LedgerFilterField, string> = {
  ledger_name: 'Ledger name', ledger_code: 'Ledger code', note_no: 'Note no.', note_name: 'Note name',
  section: 'Section', zoho_account_type: 'Account type', amount: 'Amount (₹)',
};
const OPERATOR_LABELS: Record<LedgerFilterOperator, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', in: 'is any of', not_in: 'is none of',
  gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most', between: 'is between',
  is_empty: 'is empty', is_not_empty: 'is not empty',
};
const AGGREGATION_OPTIONS: Record<LedgerAggregation, string> = {
  sum: 'Total of matched ledgers', avg: 'Average per ledger', count: 'Number of ledgers',
  min: 'Smallest ledger figure', max: 'Largest ledger figure',
};
const COMPARISON_OPTIONS: { value: MetricComparison; label: string; delta: string }[] = [
  { value: 'prior_year', label: 'Same period last year', delta: 'vs last year' },
  { value: 'prior_period', label: 'Previous period', delta: 'vs previous period' },
  { value: 'none', label: 'No comparison', delta: '' },
];
const SECTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'inc', label: 'Income (P&L)' }, { value: 'exp', label: 'Expense (P&L)' },
  { value: 'anc', label: 'Non-current assets' }, { value: 'ac', label: 'Current assets' },
  { value: 'eq', label: 'Equity' }, { value: 'lnc', label: 'Non-current liabilities' }, { value: 'lc', label: 'Current liabilities' },
];
// A left-associative chain of N steps nests N deep — capped at the engine's MAX_DEPTH (8) so a chain built here is never rejected after the fact.
const MAX_STEPS = 8;
const MAX_CONDITIONS = 10;

function slugify(label: string): string {
  const s = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  return /^[a-z]/.test(s) ? s : `m_${s}`.slice(0, 50);
}

function defaultStep(): ChainStep {
  return { op: 'percent_of', operand: { type: 'metric', key: 'revenue' } };
}
function defaultCondition(): LedgerFilterCondition {
  return { field: 'ledger_name', operator: 'contains', value: '' };
}

const isNumericField = (f: LedgerFilterField) => NUMERIC_LEDGER_FIELDS.includes(f);
/** Same field/operator pairing validateLedgerSpec() enforces — the operator list only ever offers what the server accepts. */
function operatorFitsField(op: LedgerFilterOperator, field: LedgerFilterField): boolean {
  return isNumericField(field) ? !TEXT_ONLY_OPERATORS.includes(op) : !NUMERIC_ONLY_OPERATORS.includes(op);
}
const isNumText = (v: string) => v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')));
/** Reshapes a condition's value for its operator: '' when none is needed, [from, to] for between, a list for any-of/none-of, else one value. */
function valueShapeFor(op: LedgerFilterOperator, prev: string | string[]): string | string[] {
  if (VALUELESS_OPERATORS.includes(op)) return '';
  const parts = Array.isArray(prev) ? prev : String(prev).split(',').map((v) => v.trim());
  if (op === 'between') return [parts[0] ?? '', parts[1] ?? ''];
  if (op === 'in' || op === 'not_in') return parts.filter(Boolean);
  return Array.isArray(prev) ? prev.filter(Boolean).join(', ') : prev;
}
/** Client mirror of validateLedgerSpec()'s per-condition rules, so Save is only enabled for what the server will accept. */
function conditionValid(c: LedgerFilterCondition): boolean {
  if (VALUELESS_OPERATORS.includes(c.operator)) return true;
  const numeric = isNumericField(c.field);
  if (c.operator === 'between') {
    const [lo = '', hi = ''] = Array.isArray(c.value) ? c.value : [];
    return isNumText(lo) && isNumText(hi) && Number(lo.replace(/,/g, '')) <= Number(hi.replace(/,/g, ''));
  }
  if (Array.isArray(c.value)) return c.value.length > 0 && (!numeric || c.value.every(isNumText));
  const v = String(c.value);
  return v.trim() !== '' && (!numeric || isNumText(v));
}

/** Same per-valueType formatting widgets use, in the dashboard's selected unit. */
function formatPreview(value: number | null, valueType: ValueType, decimals: number, unit: DisplayUnit): string {
  if (value == null) return '—';
  switch (valueType) {
    case 'percent': return pct(value, decimals);
    case 'ratio': return fx(value, decimals);
    case 'days': return `${Math.round(value)}d`;
    case 'number': return value.toLocaleString('en-IN', { maximumFractionDigits: decimals });
    default: return fn(value, decimals, unit);
  }
}

/** Every custom metric that (transitively) depends on `key` — offering any of them as an operand of `key` would create a cycle. */
function transitiveDependents(key: string, defs: CustomMetricDefinition[]): Set<string> {
  const out = new Set<string>();
  const queue = [key];
  while (queue.length) {
    const k = queue.shift()!;
    for (const d of findDependents(k, defs)) {
      if (!out.has(d)) { out.add(d); queue.push(d); }
    }
  }
  return out;
}

interface OperandOption { key: string; label: string }

function OperandEditor({ operand, onChange, builtInGroups, customOptions }: {
  operand: Operand; onChange: (o: Operand) => void;
  builtInGroups: [string, OperandOption[]][]; customOptions: OperandOption[];
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
      <select
        value={operand.type}
        onChange={(e) => onChange(e.target.value === 'const' ? { type: 'const', value: 0 } : { type: 'metric', key: 'revenue' })}
        style={{ ...SELECT_STYLE, width: 100, flex: 'none' }}
        aria-label="Operand type"
      >
        <option value="metric">Metric</option>
        <option value="const">Number</option>
      </select>
      {operand.type === 'metric' ? (
        <select value={operand.key} onChange={(e) => onChange({ type: 'metric', key: e.target.value })} style={{ ...SELECT_STYLE, flex: 1, minWidth: 0 }} aria-label="Metric">
          {builtInGroups.map(([group, opts]) => (
            <optgroup key={group} label={group}>
              {opts.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </optgroup>
          ))}
          {customOptions.length > 0 && (
            <optgroup label="Custom metrics">
              {customOptions.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </optgroup>
          )}
        </select>
      ) : (
        <input
          type="number" value={Number.isFinite(operand.value) ? operand.value : ''}
          onChange={(e) => onChange({ type: 'const', value: e.target.value === '' ? NaN : Number(e.target.value) })}
          style={{ ...INPUT_STYLE, flex: 1 }} aria-label="Number"
        />
      )}
    </div>
  );
}

export function CustomMetricBuilder({
  open, onClose, onSaved, editing = null,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (def: CustomMetricDefinition) => void;
  /** When set, opens pre-filled to edit this metric; the key becomes read-only (immutable after creation — widgets bound to it keep working). */
  editing?: CustomMetricDefinition | null;
}) {
  const { bundle, displayUnit, currentFyId, granularity, subPeriod, yearType } = useDashboard();
  const toast = useToast();
  const { customMetrics } = useCustomMetricsList();

  const [kind, setKind] = useState<CustomMetricKind>('formula');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [key, setKey] = useState('');
  const [firstOperand, setFirstOperand] = useState<Operand>({ type: 'metric', key: 'revenue' });
  const [steps, setSteps] = useState<ChainStep[]>([defaultStep()]);
  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [conditions, setConditions] = useState<LedgerFilterCondition[]>([defaultCondition()]);
  const [measure, setMeasure] = useState<'movement' | 'closing'>('movement');
  const [sign, setSign] = useState<'natural' | 'invert'>('natural');
  const [aggregation, setAggregation] = useState<LedgerAggregation>('sum');
  const [comparison, setComparison] = useState<MetricComparison>('prior_year');
  const [warnValue, setWarnValue] = useState('');
  const [valueType, setValueType] = useState<ValueType>('percent');
  const [decimals, setDecimals] = useState(1);
  /** Once the user picks a format themselves, switching kind never overrides it. */
  const [formatTouched, setFormatTouched] = useState(false);
  const [hasTarget, setHasTarget] = useState(false);
  const [targetValue, setTargetValue] = useState('');
  const [thresholdDirection, setThresholdDirection] = useState<'higher_is_better' | 'lower_is_better'>('higher_is_better');
  const [changeNote, setChangeNote] = useState('');
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const [ledgerPreview, setLedgerPreview] = useState<LedgerMetricPreview | null>(null);
  const [ledgerPreviewError, setLedgerPreviewError] = useState<string | null>(null);
  const [ledgerPreviewLoading, setLedgerPreviewLoading] = useState(false);
  const previewSeq = useRef(0);

  const [versions, setVersions] = useState<CustomMetricVersionDTO[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<CustomMetricVersionDTO | null>(null);
  const [restoring, setRestoring] = useState(false);

  function seedFrom(def: CustomMetricDefinition | null) {
    if (def) {
      const k = metricKind(def);
      setKind(k);
      setLabel(def.label);
      setDescription(def.description ?? '');
      setKeyTouched(true);
      setKey(def.key);
      const flat = def.expression ? flattenChain(def.expression) : null;
      setFirstOperand(flat?.first ?? { type: 'metric', key: 'revenue' });
      setSteps(flat?.steps.length ? flat.steps : [defaultStep()]);
      setMatch(def.ledgerSpec?.match ?? 'all');
      setConditions(def.ledgerSpec?.conditions.length ? def.ledgerSpec.conditions : [defaultCondition()]);
      setMeasure(def.ledgerSpec?.measure ?? 'movement');
      setSign(def.ledgerSpec?.sign ?? 'natural');
      setAggregation(def.ledgerSpec?.aggregation ?? 'sum');
      setComparison(def.comparison ?? 'prior_year');
      setWarnValue(def.thresholds?.warn != null ? String(def.thresholds.warn) : '');
      setValueType(def.valueType);
      setDecimals(def.decimals);
      setFormatTouched(true);
      setHasTarget(def.thresholds != null);
      setTargetValue(def.thresholds ? String(def.thresholds.target) : '');
      setThresholdDirection(def.thresholds?.direction ?? 'higher_is_better');
      setBaseVersion(def.version ?? null);
    } else {
      setKind('formula');
      setLabel(''); setDescription(''); setKeyTouched(false); setKey('');
      setFirstOperand({ type: 'metric', key: 'revenue' });
      setSteps([defaultStep()]);
      setMatch('all'); setConditions([defaultCondition()]); setMeasure('movement'); setSign('natural'); setAggregation('sum');
      setComparison('prior_year'); setWarnValue('');
      setValueType('percent'); setDecimals(1); setFormatTouched(false);
      setHasTarget(false); setTargetValue(''); setThresholdDirection('higher_is_better');
      setBaseVersion(null);
    }
    setChangeNote('');
    setLedgerPreview(null); setLedgerPreviewError(null);
  }

  // Seed (or reset) the form whenever the modal opens.
  useEffect(() => {
    if (open) seedFrom(editing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  async function loadVersions(metricKey: string) {
    setVersionsLoading(true);
    try {
      const res = await fetchCustomMetricVersions(metricKey);
      setVersions(res.versions);
    } catch {
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }
  useEffect(() => {
    if (open && editing) loadVersions(editing.key);
    else setVersions([]);
  }, [open, editing]);

  const effectiveKey = editing ? editing.key : (keyTouched ? key : slugify(label));
  const keyValid = CUSTOM_METRIC_KEY_RE.test(effectiveKey);

  // Operand choices: built-ins grouped like the catalog, then this company's
  // custom metrics minus itself and anything that depends on it (a cycle).
  const builtInGroups = useMemo(() => {
    const groups = new Map<string, OperandOption[]>();
    METRIC_CATALOG.forEach((m) => {
      if (!groups.has(m.group)) groups.set(m.group, []);
      groups.get(m.group)!.push({ key: m.key, label: m.label });
    });
    return [...groups.entries()];
  }, []);
  const customOptions = useMemo(() => {
    const blocked = editing ? transitiveDependents(editing.key, customMetrics) : new Set<string>();
    return customMetrics
      .filter((m) => m.key !== effectiveKey && !blocked.has(m.key))
      .map((m) => ({ key: m.key, label: m.label }));
  }, [customMetrics, editing, effectiveKey]);

  const expression = useMemo(() => buildChainExpr(firstOperand, steps), [firstOperand, steps]);
  const ledgerSpec: LedgerMetricSpec = useMemo(() => ({ match, conditions, measure, sign, aggregation }), [match, conditions, measure, sign, aggregation]);
  const targetValid = !hasTarget || (targetValue.trim() !== '' && Number.isFinite(Number(targetValue)));
  // Optional warn level: must sit on the bad side of the target (below it
  // when higher is better) — same rule validateCustomMetricDefinition() applies.
  const warnSet = hasTarget && warnValue.trim() !== '';
  const warnError = !warnSet ? null
    : !Number.isFinite(Number(warnValue)) ? 'Enter a number'
    : !targetValid ? null
    : thresholdDirection === 'higher_is_better' && Number(warnValue) >= Number(targetValue) ? 'Must be below the target'
    : thresholdDirection === 'lower_is_better' && Number(warnValue) <= Number(targetValue) ? 'Must be above the target'
    : null;
  const warnValid = warnError == null;

  const draft: CustomMetricDefinition = useMemo(() => ({
    key: effectiveKey || '__draft__',
    label: label.trim() || 'Draft metric',
    description: description.trim() || null,
    kind,
    valueType, decimals,
    expression: kind === 'formula' ? expression : null,
    ledgerSpec: kind === 'ledger' ? ledgerSpec : null,
    thresholds: hasTarget && targetValid
      ? { target: Number(targetValue), direction: thresholdDirection, ...(warnSet && warnValid ? { warn: Number(warnValue) } : {}) }
      : null,
    comparison,
  }), [effectiveKey, label, description, kind, valueType, decimals, expression, ledgerSpec, hasTarget, targetValid, targetValue, thresholdDirection, warnSet, warnValid, warnValue, comparison]);

  const others = useMemo(() => customMetrics.filter((m) => m.key !== draft.key), [customMetrics, draft.key]);
  const formulaResolved = useMemo(
    () => (kind === 'formula' && bundle ? resolveCustomMetric(draft, bundle, others) : null),
    [kind, bundle, draft, others],
  );
  const capabilities = useMemo(() => customMetricCapabilities(draft, others), [draft, others]);
  const description_ = useMemo(() => describeCustomMetric(draft, customMetrics), [draft, customMetrics]);

  const operandsValid = (firstOperand.type === 'const' ? Number.isFinite(firstOperand.value) : true)
    && steps.every((s) => {
      if (isUnaryOp(s.op)) return true;
      if (!s.operand) return false;
      if (s.op === 'round') return s.operand.type === 'const' && Number.isInteger(s.operand.value) && s.operand.value >= 0 && s.operand.value <= 6;
      return s.operand.type === 'const' ? Number.isFinite(s.operand.value) : true;
    });
  const conditionsValid = conditions.length > 0 && conditions.every(conditionValid);
  const bodyValid = kind === 'formula' ? operandsValid && steps.length > 0 : conditionsValid;
  const canSave = !!label.trim() && keyValid && targetValid && warnValid && bodyValid && !saving;

  // Live server-side preview for ledger metrics, debounced; stale responses ignored.
  const periodType = granularity === '3year' ? 'annual' : granularity;
  const period = granularity === '3year' ? null : subPeriod;
  useEffect(() => {
    if (!open || kind !== 'ledger') return;
    if (!conditionsValid || !currentFyId) { setLedgerPreview(null); setLedgerPreviewError(null); return; }
    const seq = ++previewSeq.current;
    setLedgerPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await previewLedgerMetric({ ledgerSpec, fyId: currentFyId, periodType, period, yearType, comparison });
        if (seq !== previewSeq.current) return;
        setLedgerPreview(res); setLedgerPreviewError(null);
      } catch (e) {
        if (seq !== previewSeq.current) return;
        setLedgerPreview(null);
        setLedgerPreviewError(e instanceof ApiClientError ? e.message : 'Preview failed');
      } finally {
        if (seq === previewSeq.current) setLedgerPreviewLoading(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [open, kind, ledgerSpec, conditionsValid, currentFyId, periodType, period, yearType, comparison]);

  // A ledger metric is a sum of ledger amounts — default it to Currency, not
  // the formula default Percent (which rendered e.g. "15116966.4%").
  function changeKind(k: CustomMetricKind) {
    setKind(k);
    if (!formatTouched) {
      const asCount = k === 'ledger' && aggregation === 'count';
      setValueType(asCount ? 'number' : k === 'ledger' ? 'currency' : 'percent');
      setDecimals(asCount ? 0 : k === 'ledger' ? 2 : 1);
    }
  }
  // "Number of ledgers" is a count, not rupees — follow it in the format
  // unless the user has already chosen one.
  function changeAggregation(a: LedgerAggregation) {
    setAggregation(a);
    if (!formatTouched) {
      setValueType(a === 'count' ? 'number' : 'currency');
      setDecimals(a === 'count' ? 0 : 2);
    }
  }

  function updateStep(i: number, patch: Partial<ChainStep>) {
    setSteps((prev) => prev.map((s, idx) => {
      if (idx !== i) return s;
      const next = { ...s, ...patch };
      if (patch.op) {
        if (isUnaryOp(patch.op)) delete next.operand;
        else if (patch.op === 'round') next.operand = { type: 'const', value: 2 };
        else if (!next.operand || (s.op === 'round')) next.operand = { type: 'metric', key: 'revenue' };
      }
      return next;
    }));
  }
  function removeStep(i: number) { setSteps((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)); }
  function addStep() { setSteps((prev) => (prev.length < MAX_STEPS ? [...prev, defaultStep()] : prev)); }

  function updateCondition(i: number, patch: Partial<LedgerFilterCondition>) {
    setConditions((prev) => prev.map((c, idx) => {
      if (idx !== i) return c;
      const next = { ...c, ...patch };
      if (patch.field) {
        // An operator the new field can't take falls back to its most useful one.
        if (!operatorFitsField(next.operator, next.field)) {
          next.operator = next.field === 'amount' ? 'gt' : isNumericField(next.field) ? 'equals' : 'contains';
        }
        // A text value is meaningless for a number field and vice versa.
        if (isNumericField(next.field) !== isNumericField(c.field)) next.value = '';
      }
      if (patch.operator || patch.field) {
        // Keep the typed value but reshape it for the operator (single, list, [from, to], none).
        next.value = valueShapeFor(next.operator, next.value);
      }
      const isList = next.operator === 'in' || next.operator === 'not_in';
      if (patch.field === 'section' && !isList && !VALUELESS_OPERATORS.includes(next.operator)) next.value = 'exp';
      return next;
    }));
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await saveCustomMetric({
        metricKey: effectiveKey, label: label.trim(), description: description.trim() || null, kind, valueType, decimals,
        expression: kind === 'formula' ? expression : null,
        ledgerSpec: kind === 'ledger' ? ledgerSpec : null,
        targetValue: hasTarget ? Number(targetValue) : null,
        thresholdDirection: hasTarget ? thresholdDirection : null,
        warnValue: warnSet ? Number(warnValue) : null,
        comparison,
        ...(editing && baseVersion != null ? { expectedVersion: baseVersion } : {}),
        ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
      });
      toast(editing
        ? (res.changedFields.length ? `"${res.metric.label}" saved as version ${res.metric.version}` : 'No changes to save')
        : `Custom metric "${res.metric.label}" created`);
      onSaved(res.metric);
      onClose();
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to save this custom metric');
    } finally {
      setSaving(false);
    }
  }

  async function confirmRestore() {
    if (!restoreTarget || !editing || baseVersion == null) return;
    setRestoring(true);
    try {
      const res = await restoreCustomMetricVersion(editing.key, restoreTarget.version, baseVersion);
      toast(res.message ?? `Restored version ${restoreTarget.version} — now version ${res.metric.version}`);
      seedFrom(res.metric);
      onSaved(res.metric);
      await loadVersions(editing.key);
      setRestoreTarget(null);
    } catch (e) {
      toast(e instanceof ApiClientError ? e.message : 'Failed to restore this version');
    } finally {
      setRestoring(false);
    }
  }

  if (!open) return null;

  const previewValue = kind === 'formula' ? formulaResolved?.value ?? null : ledgerPreview?.value ?? null;
  const previewPrevious = kind === 'formula' ? formulaResolved?.previous ?? null : ledgerPreview?.previous ?? null;
  const previewDelta = comparison !== 'none' && previewValue != null && previewPrevious != null && previewPrevious !== 0
    ? ((previewValue - previewPrevious) / Math.abs(previewPrevious)) * 100 : null;
  const comparisonMeta = COMPARISON_OPTIONS.find((c) => c.value === comparison)!;
  // The dashboard bundle only carries previous-period statements once some
  // saved metric asks for them — a formula metric being switched to it here
  // shows its change after the first save.
  const priorPeriodPending = kind === 'formula' && comparison === 'prior_period' && !bundle?.prior_period;
  const targetStatus = hasTarget && targetValid ? thresholdStatus(previewValue, draft.thresholds) : null;

  return (
    <div style={OVERLAY_STYLE} onClick={onClose}>
      <div style={{ ...PANEL_STYLE, width: 680 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={editing ? 'Edit custom metric' : 'New custom metric'}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{editing ? 'Edit custom metric' : 'New custom metric'}</div>
          {editing && baseVersion != null && <span style={{ fontSize: 11, color: '#9ca3af' }}>version {baseVersion}</span>}
        </div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 14 }}>
          Build a KPI from real figures — no formula typing. Every change is previewed before you save, and every save is versioned.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
          <div>
            <label style={LABEL_STYLE}>Name</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Salary % of Revenue" maxLength={150} style={INPUT_STYLE} />
          </div>
          <div>
            <label style={LABEL_STYLE}>Description (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this number means" maxLength={300} style={INPUT_STYLE} />
          </div>
        </div>

        <label style={LABEL_STYLE}>Build it from</label>
        <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {([['formula', 'Existing metrics (formula)'], ['ledger', 'Trial Balance ledgers (filter)']] as [CustomMetricKind, string][]).map(([k, text]) => (
            <button
              key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => changeKind(k)}
              style={{ ...SEGMENT_STYLE, ...(kind === k ? SEGMENT_ACTIVE : {}) }}
            >{text}</button>
          ))}
        </div>

        {kind === 'formula' ? (
          <div style={SECTION_STYLE}>
            <label style={LABEL_STYLE}>Start with</label>
            <div style={{ marginBottom: 10 }}>
              <OperandEditor operand={firstOperand} onChange={setFirstOperand} builtInGroups={builtInGroups} customOptions={customOptions} />
            </div>
            {steps.map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-end', marginBottom: 8 }}>
                <div style={{ width: 190, flex: 'none' }}>
                  <label style={LABEL_STYLE}>{i === 0 ? 'Then' : 'And then'}</label>
                  <select value={step.op} onChange={(e) => updateStep(i, { op: e.target.value as FormulaOp })} style={SELECT_STYLE} aria-label={`Step ${i + 1} operation`}>
                    {STEP_GROUPS.map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.ops.map((o) => <option key={o} value={o}>{STEP_LABELS[o]}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </div>
                {isUnaryOp(step.op) ? (
                  <div style={{ flex: 1, fontSize: 11, color: '#9ca3af', padding: '10px 2px' }}>
                    {step.op === 'abs' && 'Drops the minus sign from the result so far.'}
                    {step.op === 'percent_change' && 'Growth of the result so far vs the same period last year (%). No monthly trend.'}
                    {step.op === 'avg_per_month' && 'Divides the result so far by the months in the selected period.'}
                  </div>
                ) : step.op === 'round' ? (
                  <input
                    type="number" min={0} max={6} step={1}
                    value={step.operand?.type === 'const' ? step.operand.value : 2}
                    onChange={(e) => updateStep(i, { operand: { type: 'const', value: Math.max(0, Math.min(6, Math.round(Number(e.target.value) || 0))) } })}
                    style={{ ...INPUT_STYLE, flex: 1 }} aria-label="Decimal places"
                  />
                ) : (
                  <OperandEditor
                    operand={step.operand ?? { type: 'metric', key: 'revenue' }}
                    onChange={(o) => updateStep(i, { operand: o })}
                    builtInGroups={builtInGroups} customOptions={customOptions}
                  />
                )}
                <button
                  type="button" className="btn btn-cancel-dark btn-sm" onClick={() => removeStep(i)}
                  disabled={steps.length <= 1} title="Remove this step" aria-label="Remove this step" style={{ flex: 'none' }}
                >✕</button>
              </div>
            ))}
            <button type="button" className="btn btn-cancel-dark btn-sm" disabled={steps.length >= MAX_STEPS} onClick={addStep}>
              + Add another step
            </button>
          </div>
        ) : (
          <div style={SECTION_STYLE}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: '#e5e7eb' }}>
              Include ledgers matching
              <select value={match} onChange={(e) => setMatch(e.target.value as 'all' | 'any')} style={{ ...SELECT_STYLE, width: 90 }} aria-label="Match">
                <option value="all">all</option>
                <option value="any">any</option>
              </select>
              of these conditions:
            </div>
            {conditions.map((c, i) => {
              const isList = c.operator === 'in' || c.operator === 'not_in';
              return (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                  <select value={c.field} onChange={(e) => updateCondition(i, { field: e.target.value as LedgerFilterField })} style={{ ...SELECT_STYLE, width: 140, flex: 'none' }} aria-label="Field">
                    {LEDGER_FILTER_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
                  </select>
                  <select value={c.operator} onChange={(e) => updateCondition(i, { operator: e.target.value as LedgerFilterOperator })} style={{ ...SELECT_STYLE, width: 150, flex: 'none' }} aria-label="Operator">
                    {LEDGER_FILTER_OPERATORS.filter((o) => operatorFitsField(o, c.field)).map((o) => <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>)}
                  </select>
                  {VALUELESS_OPERATORS.includes(c.operator) ? (
                    <div style={{ flex: 1, fontSize: 11, color: '#6b7280', padding: '0 4px' }}>no value needed</div>
                  ) : c.operator === 'between' ? (
                    <div style={{ flex: 1, display: 'flex', gap: 6, alignItems: 'center' }}>
                      {[0, 1].map((side) => {
                        const pair = Array.isArray(c.value) ? c.value : ['', ''];
                        const v = pair[side] ?? '';
                        return (
                          <input
                            key={side} value={v} inputMode="decimal"
                            onChange={(e) => updateCondition(i, { value: side === 0 ? [e.target.value, pair[1] ?? ''] : [pair[0] ?? '', e.target.value] })}
                            placeholder={side === 0 ? 'from' : 'to'} aria-label={side === 0 ? 'Lower bound' : 'Upper bound'}
                            style={{ ...INPUT_STYLE, flex: 1, borderColor: v && !isNumText(v) ? '#f87171' : undefined }}
                          />
                        );
                      })}
                    </div>
                  ) : c.field === 'section' && !isList ? (
                    <select value={String(c.value)} onChange={(e) => updateCondition(i, { value: e.target.value })} style={{ ...SELECT_STYLE, flex: 1 }} aria-label="Section">
                      {SECTION_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  ) : (
                    <input
                      value={Array.isArray(c.value) ? c.value.join(', ') : c.value}
                      onChange={(e) => updateCondition(i, { value: isList ? e.target.value.split(',').map((v) => v.trim()).filter(Boolean) : e.target.value })}
                      placeholder={isList ? 'comma, separated, values' : c.field === 'note_no' ? 'e.g. 23' : c.field === 'amount' ? 'e.g. 100000' : 'e.g. salary'}
                      inputMode={isNumericField(c.field) && !isList ? 'decimal' : undefined}
                      style={{ ...INPUT_STYLE, flex: 1, borderColor: String(c.value).trim() && !conditionValid(c) ? '#f87171' : undefined }} aria-label="Value"
                    />
                  )}
                  <button
                    type="button" className="btn btn-cancel-dark btn-sm" onClick={() => setConditions((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : p))}
                    disabled={conditions.length <= 1} title="Remove condition" aria-label="Remove condition" style={{ flex: 'none' }}
                  >✕</button>
                </div>
              );
            })}
            <button type="button" className="btn btn-cancel-dark btn-sm" disabled={conditions.length >= MAX_CONDITIONS}
              onClick={() => setConditions((p) => [...p, defaultCondition()])} style={{ marginBottom: 10 }}>
              + Add condition
            </button>
            {conditions.some((c) => c.field === 'amount') && (
              <div style={{ fontSize: 10, color: '#6b7280', margin: '-4px 0 10px' }}>
                Amount is each ledger&apos;s own figure for the selected period (the measure below, after the sign setting), in rupees.
              </div>
            )}
            <div style={{ marginBottom: 8 }}>
              <label style={LABEL_STYLE}>Combine as</label>
              <select value={aggregation} onChange={(e) => changeAggregation(e.target.value as LedgerAggregation)} style={SELECT_STYLE}>
                {LEDGER_AGGREGATIONS.map((a) => <option key={a} value={a}>{AGGREGATION_OPTIONS[a]}</option>)}
              </select>
              {aggregation !== 'sum' && (
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>
                  Counts only ledgers with a non-zero figure in the period — a dormant ledger never drags an average down.
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={LABEL_STYLE}>Measure</label>
                <select value={measure} onChange={(e) => setMeasure(e.target.value as 'movement' | 'closing')} style={SELECT_STYLE}>
                  <option value="movement">Movement in the period (P&amp;L-style)</option>
                  <option value="closing">Closing balance at period end (Balance-Sheet-style)</option>
                </select>
              </div>
              <div>
                <label style={LABEL_STYLE}>Sign</label>
                <select value={sign} onChange={(e) => setSign(e.target.value as 'natural' | 'invert')} style={SELECT_STYLE}>
                  <option value="natural">Natural (each ledger&apos;s normal balance)</option>
                  <option value="invert">Inverted</option>
                </select>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 1fr', gap: 8, marginBottom: 10 }}>
          <div>
            <label style={LABEL_STYLE}>Display as</label>
            <select value={valueType} onChange={(e) => { setFormatTouched(true); setValueType(e.target.value as ValueType); }} style={SELECT_STYLE}>
              {VALUE_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label style={LABEL_STYLE}>Decimals</label>
            <input type="number" min={0} max={6} value={decimals} onChange={(e) => { setFormatTouched(true); setDecimals(Math.max(0, Math.min(6, Number(e.target.value) || 0))); }} style={INPUT_STYLE} />
          </div>
          <div>
            <label style={LABEL_STYLE}>Compare with</label>
            <select value={comparison} onChange={(e) => setComparison(e.target.value as MetricComparison)} style={SELECT_STYLE}>
              {COMPARISON_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', color: '#e5e7eb', marginBottom: hasTarget ? 8 : 0 }}>
            <input type="checkbox" checked={hasTarget} onChange={(e) => setHasTarget(e.target.checked)} />
            Set a target (gauges show progress toward it; cards turn green, amber or red)
          </label>
          {hasTarget && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={LABEL_STYLE}>Target value</label>
                <input type="number" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} placeholder="e.g. 20" style={INPUT_STYLE} />
              </div>
              <div>
                <label style={LABEL_STYLE}>Direction</label>
                <select value={thresholdDirection} onChange={(e) => setThresholdDirection(e.target.value as 'higher_is_better' | 'lower_is_better')} style={SELECT_STYLE}>
                  <option value="higher_is_better">Higher is better</option>
                  <option value="lower_is_better">Lower is better</option>
                </select>
              </div>
              <div>
                <label style={LABEL_STYLE}>Warn level (optional)</label>
                <input
                  type="number" value={warnValue} onChange={(e) => setWarnValue(e.target.value)}
                  placeholder={thresholdDirection === 'higher_is_better' ? 'amber below target' : 'amber above target'}
                  style={{ ...INPUT_STYLE, borderColor: warnError ? '#f87171' : undefined }}
                />
                {warnError
                  ? <div style={{ fontSize: 10, color: '#f87171', marginTop: 3 }}>{warnError}</div>
                  : warnSet && targetValid && (
                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>
                      Amber between {Math.min(Number(warnValue), Number(targetValue))} and {Math.max(Number(warnValue), Number(targetValue))}, red beyond {warnValue}.
                    </div>
                  )}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: editing ? '1fr 1fr' : '1fr', gap: 8, marginBottom: 4 }}>
          <div>
            <label style={LABEL_STYLE}>Saved as (key)</label>
            <input
              value={effectiveKey} disabled={!!editing}
              onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toLowerCase()); }}
              style={{ ...INPUT_STYLE, fontFamily: 'var(--mono, monospace)', color: keyValid ? '#e5e7eb' : '#f87171', opacity: editing ? 0.6 : 1 }}
            />
            {!keyValid && effectiveKey && <div style={{ fontSize: 10, color: '#f87171', marginTop: 3 }}>3-50 lowercase letters/digits/underscores, starting with a letter.</div>}
            {editing && <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>The key never changes — widgets bound to it keep working.</div>}
          </div>
          {editing && (
            <div>
              <label style={LABEL_STYLE}>What changed? (optional)</label>
              <input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={300} placeholder="e.g. Excluded salary payable ledgers" style={INPUT_STYLE} />
            </div>
          )}
        </div>

        {/* ── Live preview ── */}
        <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(91,159,224,.1)', border: '1px solid rgba(91,159,224,.25)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
            <span>Live preview{kind === 'ledger' && ledgerPreview ? ` · ${ledgerPreview.periodLabel}` : ''}</span>
            {kind === 'ledger' && ledgerPreviewLoading && <span>calculating…</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#5b9fe0' }} aria-live="polite">
              {formatPreview(previewValue, valueType, decimals, displayUnit)}
            </div>
            {previewDelta != null && (
              <div style={{ fontSize: 11, color: previewDelta >= 0 ? '#4ade80' : '#f87171' }}>{signedPct(previewDelta)} {comparisonMeta.delta}</div>
            )}
            {priorPeriodPending && (
              <div style={{ fontSize: 11, color: '#9ca3af' }}>change vs previous period shows after saving</div>
            )}
            {targetStatus != null && (
              <div style={{ fontSize: 11, color: targetStatus === 'good' ? '#4ade80' : targetStatus === 'warn' ? '#fbbf24' : '#f87171' }}>
                {targetStatus === 'good' ? '✓ meets target' : targetStatus === 'warn' ? '! in the warning zone' : '✗ off target'} ({thresholdDirection === 'higher_is_better' ? '≥' : '≤'} {targetValue})
              </div>
            )}
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>{description_}</div>
          {kind === 'ledger' && ledgerPreviewError && <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>{ledgerPreviewError}</div>}
          {kind === 'ledger' && !conditionsValid && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Fill in every condition to see the value.</div>}
          {kind === 'ledger' && ledgerPreview && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: '#e5e7eb', marginBottom: 4 }}>
                {ledgerPreview.matchedCount} ledger{ledgerPreview.matchedCount === 1 ? '' : 's'} matched
                {ledgerPreview.matchedCount > ledgerPreview.matchedLedgers.length && ` (top ${ledgerPreview.matchedLedgers.length} shown)`}
              </div>
              {ledgerPreview.matchedCount === 0 && <div style={{ fontSize: 11, color: '#fbbf24' }}>No ledger matches these conditions — check the spelling or loosen a condition.</div>}
              {ledgerPreview.matchedLedgers.length > 0 && (
                <div style={{ maxHeight: 130, overflowY: 'auto', border: '1px solid rgba(255,255,255,.08)', borderRadius: 6 }}>
                  {ledgerPreview.matchedLedgers.map((l, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 8px', fontSize: 11, color: '#d1d5db', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</span>
                      <span style={{ fontFamily: 'var(--mono, monospace)', flex: 'none' }}>{fn(l.value, 2, displayUnit)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6 }}>
            Usable in: stat cards, gauges, YoY tables
            {capabilities.supportsSeries && ', line/bar charts, sparklines, monthly tables'}
            {capabilities.supportsBreakdown && ', donuts and ranked tables (one row per ledger)'}.
            {!capabilities.supportsSeries && kind === 'formula' && ' (Charts need every input to have a monthly trend.)'}
          </div>
        </div>

        {/* ── Version history ── */}
        {editing && (
          <div style={{ marginTop: 12 }}>
            <label style={LABEL_STYLE}>Version history</label>
            {versionsLoading && <div style={{ fontSize: 11, color: '#9ca3af' }}>Loading…</div>}
            {!versionsLoading && versions.length === 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>No history recorded yet.</div>}
            {versions.length > 0 && (
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid rgba(255,255,255,.08)', borderRadius: 6 }}>
                {versions.map((v) => {
                  const isCurrent = v.version === baseVersion;
                  return (
                    <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,.05)' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#e5e7eb', width: 30, flex: 'none' }}>v{v.version}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: '#d1d5db', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {v.changeNote || (v.changedFields.includes('created') ? 'Created' : `Changed: ${v.changedFields.join(', ') || '—'}`)}
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7280' }}>
                          {new Date(v.createdAt).toLocaleString('en-IN')}{v.changedByName ? ` · ${v.changedByName}` : ''}
                          {' · '}{describeCustomMetric(fromSnapshot(v.snapshot), customMetrics)}
                        </div>
                      </div>
                      {isCurrent ? (
                        <span style={{ fontSize: 10, color: '#4ade80', flex: 'none' }}>current</span>
                      ) : (
                        <button type="button" className="btn btn-cancel-dark btn-sm" style={{ flex: 'none' }} onClick={() => setRestoreTarget(v)}>Restore</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-cancel-dark" onClick={onClose}>Cancel</button>
          <button className="btn btn-pr" disabled={!canSave} onClick={handleSave}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Save metric'}</button>
        </div>
      </div>

      <ConfirmModal
        open={!!restoreTarget}
        title={`Restore version ${restoreTarget?.version}?`}
        message={`The current definition stays in history — version ${restoreTarget?.version}'s content is saved as a new version. Widgets using this metric update immediately.`}
        confirmLabel="Restore"
        danger={false}
        busy={restoring}
        onConfirm={confirmRestore}
        onCancel={() => setRestoreTarget(null)}
      />
    </div>
  );
}

const OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(6,10,18,.55)', backdropFilter: 'blur(8px)',
};
const PANEL_STYLE: React.CSSProperties = {
  width: 460, maxWidth: 'calc(100vw - 32px)', background: '#0f1826',
  border: '1px solid rgba(255,255,255,.1)', borderRadius: 14, padding: 24,
  boxShadow: '0 24px 60px rgba(0,0,0,.5)', maxHeight: '90vh', overflowY: 'auto',
};
const SECTION_STYLE: React.CSSProperties = {
  padding: 12, borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', marginBottom: 12,
};
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '9px 11px', fontSize: 12, border: '1px solid rgba(255,255,255,.14)',
  borderRadius: 8, color: '#e5e7eb', background: 'rgba(255,255,255,.04)', outline: 'none',
};
const SELECT_STYLE: React.CSSProperties = { ...INPUT_STYLE, cursor: 'pointer' };
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 500,
  display: 'block', marginBottom: 5,
};
const SEGMENT_STYLE: React.CSSProperties = {
  flex: 1, padding: '8px 10px', fontSize: 12, borderRadius: 8, cursor: 'pointer',
  border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: '#d1d5db',
};
const SEGMENT_ACTIVE: React.CSSProperties = { background: 'rgba(24,95,165,.35)', borderColor: '#5b9fe0', color: '#fff', fontWeight: 600 };
