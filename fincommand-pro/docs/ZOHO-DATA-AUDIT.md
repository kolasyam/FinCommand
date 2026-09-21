# ZOHO-DATA-AUDIT.md — What we read from Zoho, and whether it is right (2026-09-21)

> [!NOTE]
> The owner asked: *are we reading all of the company's data from Zoho, and using the maximum of it correctly?* This is the answer, checked against Zoho itself. **No.** The sync reads Zoho's **financial statements** (plus customer and vendor summaries), not every record in Zoho. What it reads is now shown to be **complete and correct for the statements**, but the audit found one material defect in the customer figures, one silent gap in the vendor figures, and one truncated read. All three are fixed in code (the vendor gap had already been fixed by Phase 0), and a failure of this kind is now reported instead of silent. **The stored data is unchanged until each year is re-synced with the current code.**
>
> Method: the stored raw Zoho responses (read-only) reconciled against Zoho's own totals; through the assistant's separate Zoho Books connector, **read-only** calls to the Real Variable organisation (`60029248187`) for invoices, expenses, contacts and the chart of accounts; and, once Zoho was reconnected on 2026-09-21, the sync's own bills request run against live Zoho in memory (no token refresh, no writes). Nothing in Zoho or in the production database was changed by the audit.

## 1. What the sync reads, per financial year

| Zoho data | Endpoint | Used for | Verdict |
|---|---|---|---|
| Profit & Loss, monthly (12) | `/reports/profitandloss` | every income/expense ledger and its monthly movement | ✅ **Complete and exact.** In all 24 months (two years) the net profit built from the extracted accounts equals Zoho's own "Net Profit/Loss" line, to the paisa. |
| Balance Sheet, opening + month-end (13) | `/reports/balancesheet` | every asset/liability/equity ledger, opening balances | ✅ **Assets:** the extracted accounts equal Zoho's Assets total in 26/26 snapshots. No parent account holds a balance of its own that extraction would skip. **Liabilities & equity:** equal Zoho's total except for one computed row, "Current Year Earnings" (see §2). At 31 March 2026 the extracted accounts balance to the paisa (93,182,002.78 on both sides) with **no** adjustment, which is strong evidence nothing is missing. |
| Sales by Customer, monthly (12) | `/reports/salesbycustomer` | Top Customers, Customer Margin | ⚠ → ✅ **Defect, fixed.** See §3. |
| Vendor bills (year) | `/bills` | Vendor Expense | ⚠ → ✅ **Was empty in every stored batch** because the old build sent a timestamp Zoho rejects (HTTP 400), swallowed silently. Fixed in Phase 0; live test: 187 bills → 32 vendors. See §4. |
| Expenses (year) | `/expenses` | customer direct cost (only expenses tagged to a customer) | ✅ Works as designed. In this organisation no expense carries a customer or vendor, so the Customer Margin cost side is genuinely empty. |
| Contacts | `/contacts` | contact details, outstanding balances | ✅ **Exact.** 53 vendors and 6 customers in Zoho, 53 and 6 stored. |
| Chart of accounts | `/chartofaccounts` | account type/code hints | ⚠ → ✅ Read only the first 200 accounts of at least 299. Fixed (pages through all). Impact was small (§5). |
| Organisation | `/organizations/{id}` | base currency | ✅ |

### Not read at all (exists in Zoho)
Individual **invoices, bills, credit notes and payments** (so no receivable or payable ageing by customer or vendor); **journal entries**; **bank and card transactions** and reconciliation status; **GST / tax reports** (the organisation is GST-registered); **fixed assets**; **purchase and sales orders** (both enabled); **items / product-wise sales**; **projects and timesheets**; **budgets**; **reporting tags and branches** (a "Head Office" location exists). The Ind AS statements are derived from the trial balance, so none of these is needed for them; they would enable ageing, GST reconciliation, per-product margin and similar. Each would be a new, separately planned addition.

The assistant's connector also lists a second organisation on the same Zoho login ("Aura Educational Society"). It is unrelated and was not touched.

## 2. The Balance Sheet, and the "Current Year Earnings" row
Zoho's own Balance Sheet responses do not balance: its stated Assets and Liabilities-&-Equities totals differ in every snapshot (gaps of about 3M to 18M), because its computed "Current Year Earnings" row (no account behind it) is **the same constant in all 13 snapshots of a year** (10,505,839.50 for FY 2025-26), so it cannot be a real year-to-date figure. The sync does not use that row. It rebuilds each month from the account-level snapshots and the P&L, and carries only the opening earnings brought forward as one derived ledger (`ZOHO-RE-BF`, `DB-PHASE-0.md` §3.6). The year-end balance with no adjustment at all is the evidence that the account-level data is right and Zoho's summary row is not.

The **stored** years still carry the old defect (the opening snapshot dated one day early, `DB-PHASE-0.md` §3.6), which is why they show "Out of Balance". The fix is in the code and takes effect when each year is re-synced.

## 3. The material defect: customers invoiced in another currency were dropped
The sync skipped every Sales-by-Customer row whose `currency_code` differed from the company's base currency, on the assumption that the amount was in that customer's own currency and "no conversion rate" was available. **The amounts are already in the base currency**; `currency_code` only names the currency the customer is invoiced in.

**Proof from Zoho's own invoices** (Real Variable's USD customer, FY 2025-26; USD total × the invoice's exchange rate = the report's figure, to the rupee):

| Invoice date | USD × rate | Report (₹) |
|---|---|---|
| 30 Apr 2025 | 100,000 × 84.20 | 8,420,000 |
| 30 Jun 2025 | 50,000 × 85.5439 | 4,277,195 |
| 31 Jul 2025 | 5,000 × 87.55 | 437,750 |
| 31 Aug 2025 | 5,000 × 87.85 | 439,250 |
| 30 Sep 2025 | 10,000 × 88.79 | 887,900 |
| 31 Oct 2025 | 5,000 × 88.72 | 443,600 |
| 30 Nov 2025 | 48,000 × 89.40 | 4,291,200 |
| 31 Dec 2025 | 35,000 × 89.92 | 3,147,200 |
| 31 Jan 2026 | 5,000 × 91.50 | 457,500 |
| 31 Mar 2026 | 50,000 × 94.35 | 4,717,500 |

10 of 10 match. Also, all customers together add up to the company's revenue (FY 2024-25: 33,548,133.24 = 33,548,133.24), which they could not if some rows were in dollars.

**Effect on Real Variable (real data):** the dominant customer, invoiced in USD, was missing from both years.

| | Dashboard showed | After the fix |
|---|---|---|
| FY 2024-25 | 1 customer, 1.1% of revenue, "Healthy"; 372K of 33.55M accounted for | top customer **94.3%** of revenue, **"Concentration Risk"**; 33.55M of 33.55M accounted for |
| FY 2025-26 | 1 customer, 19.9%, "Key Account" | top customer **84.7%**, **"Concentration Risk"** |

So Top Customers and Customer Margin understated the company's single biggest concentration risk. **Fix:** `lib/services/zoho/people.ts` (`aggregateSalesByCustomer`) counts every row at Zoho's base-currency amount, and lists the other-currency customers as information only. A credit note stays a negative month. Unit-tested with the real numbers above.

## 4. The vendor gap — cause proven, and already fixed by Phase 0
- **Symptom:** 0 vendor-spend rows in every stored batch (both years), so the Vendor Expense tab was empty, although 53 vendors exist and 12 of them carry an outstanding payable (1,183,756.78), and Accounts Payable moves every month.
- **Cause (tested against live Zoho on 2026-09-21, read-only):** the **old build** asked Zoho for the year's bills with `date_start=2025-03-31T18:30:00.000Z`, a JavaScript Date turned into a timestamp on an Indian machine (the timezone bug documented in `DB-PHASE-0.md` §3.6). Zoho answers **HTTP 400 "Invalid value passed for date_start"**. The old code treated the failed fetch as non-fatal and moved on, and wrote the failure only to the server console, so every sync since 27 August stored no vendors and left no trace. (The same happened to the expenses request.) It was reproduced on a sync that ran at 06:37 UTC that day with a freshly connected token: still 0 vendors.
- **With the corrected request** (a plain date, as the current code sends): Zoho returns **187 bills** for FY 2025-26, all in rupees, ₹12,332,487.50 in total, every one with a vendor name. The corrected aggregation turns them into **32 vendors**, monthly totals of about 0.6M to 1.5M, largest vendor 15.7% of bills, top five 64%.
- **What is in place:** the timestamp bug was fixed in Phase 0 (dates are text); foreign-currency bills are counted through Zoho's own `bcy_total` and never a guessed rate; the year's bills and expenses are stored with each batch; and any failed or empty bills fetch is now written in plain words on the sync log and returned as the sync's `warning`. A silent failure like this can no longer happen.
- **Still true:** expenses in this organisation carry no vendor (the largest are salary runs and loan EMIs), so the vendor report covers the spend that goes through bills.

## 5. The chart-of-accounts read
One unpaged request returns the first 200 accounts. Real Variable has at least 299 (page 2 returned 99 more). Of 435 stored ledgers, 115 are defined only on the pages that were not read. Impact was small: the classifier uses the type from the report layout first and the chart of accounts only as a fallback, and every stored ledger has a type. Fixed anyway (`fetchAllPages`); a hit of the 50-page cap would be reported, not hidden.

## 6. What still needs a person
**Where things stand (2026-09-21).** Zoho was reconnected at 06:37 UTC and the Upload tab **automatically synced FY 2025-26 on the old build** still running on `:4000`. That batch carries the old defects: no balance check recorded, 202 ledgers (no brought-forward line), the opening balance taken a day early, the USD customer dropped, 0 vendors, and the old raw-data column filled in again. Nothing was lost (the previous batch is kept as superseded), but the current FY 2025-26 figures are old-code figures, and FY 2024-25 has not been synced.
1. **Restart `:4000` on the current code** (stop it, then `npm run build` and `npm run start`). Until then any sync, including the automatic one after connecting Zoho, runs the old code.
2. **Then run "Sync Trial Balance" for each year.** That produces batches with the correct opening balance (the year balances), the USD customer, the 32 vendors, and the plain-language notes on the sync log. Nothing else is needed for the fixes to reach the dashboard.
3. **Token note:** the current code encrypts Zoho tokens (`TOKEN_ENCRYPTION_KEY`) the next time it refreshes one. The token connected today is stored in plain text, which the current code still reads; once the current code refreshes it, the old build could no longer read it, so do not run both builds against the same database after that.
4. **After the first sync on the current code:** check the year balances, read the sync's notes, and decide about vendor spend booked as expenses or journals.
5. **Optional, needs the owner's approval:** rebuild the two earlier batches' customer rows from their stored Zoho responses, without a sync (production data; would come with a before/after and a backup of the old rows). A fresh sync makes this unnecessary for the years that are re-synced.

## 7. Verification
`npx tsc --noEmit` 0 errors · `npx jest --runInBand` 27 suites / 519 tests (added `zoho-people`, 19 tests) · reconciliation of 24 P&L and 26 Balance Sheet snapshots against Zoho's own totals · 10/10 invoices checked against Zoho · contacts 53/53 and 6/6 · the before/after of Top Customers on real data above (in-process, no writes) · the sync's bills request against live Zoho: the old request rejected with HTTP 400, the current one returns 187 bills, replayed through the corrected aggregation into 32 vendors.
