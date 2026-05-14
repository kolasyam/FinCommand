# FinCommand Pro — AI Development Rules

## Tech Stack
*   **Runtime:** Node.js 18+ (LTS)
*   **Backend Framework:** Express.js for RESTful API architecture.
*   **Database:** PostgreSQL for relational data, using `pg` pool for connectivity.
*   **Authentication:** JWT-based (Access + Refresh tokens) with `bcryptjs` for password hashing.
*   **Financial Engine:** Custom `tbEngine.js` for IND AS Schedule III compliant computations.
*   **File Processing:** `SheetJS (xlsx)` for parsing Trial Balance uploads and generating reports.
*   **Frontend:** Vanilla JavaScript (ES6+) within a single-page architecture (`FinCommand_Pro.html`).
*   **Visualization:** `Chart.js` for interactive financial trends and KPIs.
*   **Reporting:** `jsPDF` and `jspdf-autotable` for professional PDF generation.
*   **Testing:** `Jest` for unit tests and `Supertest` for API integration testing.

## Development Rules

### 1. Financial Logic & Computations
*   **Rule:** Never implement financial logic (BS, P&L, Ratios, MIS) directly in routes or the frontend.
*   **Implementation:** All computation logic must reside in `backend/services/tbEngine.js`. This ensures consistency across API endpoints and exports.

### 2. API Security & Authorization
*   **Rule:** All non-public endpoints must be protected.
*   **Implementation:** Use the `authenticate` middleware from `backend/middleware/auth.js`. Use role-based guards (`isAdmin`, `isCFO`, `canWrite`) to enforce permissions as defined in the README.

### 3. Request Validation
*   **Rule:** No raw request data should be processed without validation.
*   **Implementation:** Use `express-validator` in every route to validate `body`, `query`, and `params`. Return `422 Unprocessable Entity` for validation failures.

### 4. Audit & Logging
*   **Rule:** Every state-changing action (POST, PUT, DELETE) must be logged.
*   **Implementation:** Apply the `audit(action, entityType)` middleware to these routes to ensure the `audit_trail` table is populated.

### 5. Database Transactions
*   **Rule:** Multi-step database operations must be atomic.
*   **Implementation:** Use `db.withTransaction(async (client) => { ... })` to ensure data integrity, especially during Trial Balance uploads or Zoho syncs.

### 6. Frontend Architecture
*   **Rule:** Maintain the "Single File" dashboard approach for the current frontend.
*   **Implementation:** Keep logic modular within `FinCommand_Pro.html`. Use the `DATA_MODE` flag to switch between 'sample' and 'api' modes. Ensure all new UI components match the existing CSS variable-based design system.

### 7. Error Handling
*   **Rule:** Avoid silent failures or generic try/catch blocks that swallow errors.
*   **Implementation:** Allow errors to bubble up to the global error handler in `server.js`. This ensures consistent JSON error responses and proper logging.

### 8. Testing Requirements
*   **Rule:** New features must include corresponding tests.
*   **Implementation:** Add unit tests in `backend/tests/unit/` for logic and integration tests in `backend/tests/integration/` for new API endpoints.