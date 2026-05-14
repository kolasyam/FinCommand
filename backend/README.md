# FinCommand Pro — Backend API

Node.js + Express + PostgreSQL backend for the FinCommand Pro CFO/CEO Financial Dashboard.

---

## Architecture

```
Trial Balance (monthly Dr/Cr per ledger)
    ↓
Ledger Master (IND AS Schedule III mapping, 90+ pre-seeded)
    ↓
TB Engine (period-aware computation)
    ↓  BS = cumulative from opening to period end
    ↓  P&L = sum of selected months only
    ↓
REST API → FinCommand Pro Frontend
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | PostgreSQL 14+ |
| Auth | JWT (access 15min + refresh 7d) |
| File Upload | Multer (Excel .xlsx) |
| Excel Parsing | SheetJS (xlsx) |
| Scheduling | node-cron |
| Zoho OAuth | Axios |

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- A Zoho Books account (optional, for live sync)

---

## Quick Start

### 1. Clone & install

```bash
git clone <repo>
cd fincommand-backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

Minimum required values in `.env`:
```
DB_HOST=localhost
DB_NAME=fincommand
DB_USER=fincommand_user
DB_PASSWORD=your_password
JWT_SECRET=your_32_char_secret_here
JWT_REFRESH_SECRET=another_32_char_secret
```

### 3. Create PostgreSQL database

```sql
-- Run as postgres superuser
CREATE USER fincommand_user WITH PASSWORD 'your_password';
CREATE DATABASE fincommand OWNER fincommand_user;
GRANT ALL PRIVILEGES ON DATABASE fincommand TO fincommand_user;
```

### 4. Initialise schema + seed ledger master

```bash
npm run db:init    # Creates all tables, indexes, triggers
npm run db:seed    # Creates demo company + 4 users + copies ledger master
```

### 5. Start the server

```bash
npm run dev    # Development (nodemon)
npm start      # Production
```

Server starts on http://localhost:4000

---

## API Reference

### Base URL
```
http://localhost:4000/api/v1
```

### Authentication

All endpoints except `/auth/login` and `/health` require:
```
Authorization: Bearer <access_token>
```

---

### Auth Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/login` | Login → access_token + refresh_token |
| POST | `/auth/refresh` | Refresh access token |
| POST | `/auth/logout` | Revoke refresh token |
| GET | `/auth/me` | Current user profile |
| POST | `/auth/change-password` | Change password |

**Login request:**
```json
POST /auth/login
{
  "email": "cfo@acmetech.in",
  "password": "CFO@1234"
}
```

**Login response:**
```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 900,
  "user": { "id": "...", "name": "CFO", "role": "cfo", "company_id": "..." }
}
```

---

### Trial Balance

| Method | Endpoint | Description |
|---|---|---|
| GET | `/tb` | List all uploads |
| POST | `/tb/upload` | Upload TB Excel (multipart) |
| GET | `/tb/current/:fyId` | Get current upload for FY |
| GET | `/tb/:uploadId/ledgers` | Get ledgers (filter by section/note_no/treasury_type) |
| DELETE | `/tb/:uploadId` | Delete non-current upload |

**Upload TB:**
```bash
curl -X POST http://localhost:4000/api/v1/tb/upload \
  -H "Authorization: Bearer <token>" \
  -F "trial_balance=@/path/to/tb.xlsx" \
  -F "financial_year_id=<fy_uuid>"
```

**Excel template columns (28 total):**
```
Ledger_Code | Ledger_Name | Opening_Dr | Opening_Cr |
Apr_Dr | Apr_Cr | May_Dr | May_Cr | ... | Mar_Dr | Mar_Cr
```

---

### Reports

All report endpoints accept these query params:

| Param | Values | Default | Description |
|---|---|---|---|
| `fy_id` | UUID | — | **Required** — Financial Year ID |
| `period_type` | `annual` \| `quarterly` \| `halfyear` | `annual` | Granularity |
| `period` | `Q1`..`Q4` \| `H1`\|`H2` \| null | null | Specific sub-period |
| `year_type` | `FY` \| `CY` | `FY` | Financial year vs Calendar year |

| Method | Endpoint | Description |
|---|---|---|
| GET | `/reports/mis` | MIS — Period P&L (monthly/quarterly/half-yearly/annual) |
| GET | `/reports/bs` | Balance Sheet — Schedule III IND AS (cumulative to period end) |
| GET | `/reports/pl` | P&L Account — Schedule III IND AS (for selected period) |
| GET | `/reports/notes` | Notes to Accounts 1–26 (ledger-level detail) |
| GET | `/reports/treasury` | Treasury — Cash + FDs + MFs (auto-extracted from TB) |
| GET | `/reports/cashflow` | Cash Flow Statement — IND AS 7 Indirect Method |
| GET | `/reports/ratios` | Key Financial Ratios with benchmarks |
| GET | `/reports/all` | All reports in one call |

**Example — Q2 MIS:**
```
GET /reports/mis?fy_id=<uuid>&period_type=quarterly&period=Q2&year_type=FY
```

**Example — H1 Balance Sheet:**
```
GET /reports/bs?fy_id=<uuid>&period_type=halfyear&period=H1
```

**Computation rules:**
- **Balance Sheet**: `Closing = Opening_Dr - Opening_Cr + Σ(monthly movements to period end)`
- **P&L / MIS**: `Amount = Σ(Dr - Cr movements of income/expense ledgers for selected months only)`
- **Quarterly Q2**: uses Jul+Aug+Sep month columns only
- **Half-Year H1**: uses Apr+May+Jun+Jul+Aug+Sep (months 1–6)
- **Annual**: all 12 months

---

### Financial Years

| Method | Endpoint | Description |
|---|---|---|
| GET | `/fy` | List FYs for company |
| POST | `/fy` | Create financial year |
| PUT | `/fy/:id/lock` | Lock FY (admin only, post-audit) |

---

### Ledger Master

| Method | Endpoint | Description |
|---|---|---|
| GET | `/ledger-master` | List mappings (filter by section/note_no/search) |
| POST | `/ledger-master` | Add custom ledger mapping |
| PUT | `/ledger-master/:id` | Update mapping |
| DELETE | `/ledger-master/:id` | Deactivate mapping |

---

### Zoho Books Integration

| Method | Endpoint | Description |
|---|---|---|
| GET | `/zoho/auth-url` | Get OAuth URL |
| GET | `/zoho/callback` | OAuth callback (Zoho redirects here) |
| POST | `/zoho/sync` | Manual sync (fetches 12 months TB from Zoho) |
| GET | `/zoho/status` | Connection status + last sync info |
| PUT | `/zoho/config` | Update org_id + sync frequency |
| GET | `/zoho/logs` | Last 20 sync logs |

**Sync process:**
1. Calls `GET /api/v3/trialbalance` with `from_date` & `to_date` for each of 12 months
2. Builds identical monthly TB structure as Excel upload
3. Applies Ledger Master mapping
4. Stores in `tb_ledgers` table
5. All report endpoints then use this data

---

### Company & Users

| Method | Endpoint | Description |
|---|---|---|
| GET | `/companies/me` | Company profile |
| PUT | `/companies/me` | Update company (admin) |
| GET | `/companies/users` | List users |
| POST | `/companies/users` | Create user (admin) |

---

### Audit Trail

| Method | Endpoint | Description |
|---|---|---|
| GET | `/audit` | Audit log (admin/cfo/auditor) |

Query params: `action`, `user_id`, `from`, `to`, `limit`, `offset`

---

## Role Permissions

| Role | Login | View Reports | Upload TB | Manage Users | Lock FY | View Audit |
|---|---|---|---|---|---|---|
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| cfo | ✅ | ✅ | ✅ | ✗ | ✗ | ✅ |
| ceo | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ |
| auditor | ✅ | ✅ | ✗ | ✗ | ✗ | ✅ |
| manager | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ |
| viewer | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ |

---

## Database Tables

| Table | Purpose |
|---|---|
| `companies` | Multi-entity support |
| `users` | Auth + role-based access |
| `refresh_tokens` | JWT refresh token store |
| `financial_years` | FY definitions (FY/CY, lockable) |
| `tb_uploads` | Upload metadata + validation results |
| `tb_ledgers` | Core data — ledger rows with 24 monthly Dr/Cr columns |
| `ledger_master` | IND AS Note mappings (90+ pre-seeded + custom) |
| `zoho_config` | Zoho Books OAuth tokens + sync config |
| `sync_logs` | Zoho/API sync history |
| `audit_trail` | Every action logged with user + IP |

---

## Demo Credentials (after `npm run db:seed`)

```
admin@acmetech.in   /  Admin@123  (admin)
cfo@acmetech.in     /  CFO@1234   (cfo)
ceo@acmetech.in     /  CEO@1234   (ceo)
auditor@acmetech.in /  Audit@123  (auditor)
```

---

## Connect to Frontend

In `FinCommand_Pro.html`, the upload section already has an API mode.
Point it to this backend:

```javascript
// In the dashboard JS, replace sample data fetch with:
const BASE = 'http://localhost:4000/api/v1';
const token = localStorage.getItem('fc_token');

const ledgers = await fetch(`${BASE}/reports/mis?fy_id=${fyId}&period_type=quarterly&period=Q2`, {
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json());
```

---

## Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use strong `JWT_SECRET` and `JWT_REFRESH_SECRET` (32+ chars)
- [ ] Set `DB_PASSWORD` to a strong password
- [ ] Enable PostgreSQL SSL
- [ ] Put behind Nginx reverse proxy
- [ ] Set up PM2 or systemd for process management
- [ ] Configure log rotation
- [ ] Set restrictive CORS `FRONTEND_URL`
- [ ] Enable PostgreSQL connection pooling (PgBouncer for scale)
