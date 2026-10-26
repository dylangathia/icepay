# IcePay

Payroll for Kenyan employers: PAYE, SHIF, NSSF (Tier I/II) and the Affordable Housing Levy, with a
process → roll back → post workflow.

## Running

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`).

```sh
npm install
npm start          # http://localhost:3000
npm test
```

Sign in with **admin / admin123**. You'll be asked to set a new password before you can continue.
Then add your team under **Settings → Users**.

## Users and roles

| Role | Can do |
|---|---|
| Administrator | Everything, including settings and users |
| Payroll Officer | Manage employees, benefits & deductions, open periods, process and roll back payroll |
| Approver | Review and **post** payroll, email payslips, view the audit log |
| Viewer | Read-only: employees, payroll registers, payslips, audit log |

Everyone signed in can view employees, payroll registers and payslips.

- New users and password resets get a temporary password that must be changed at first sign-in.
- Deactivated users are signed out on their next request.
- You can't change your own role or deactivate yourself, and at least one active administrator must always remain.
- **Four-eyes rule** (optional, in Settings → Tax & statutory → Payroll rules): the person who processed a payroll
  cannot also post it.

| Variable         | Default           | Purpose                                  |
|------------------|-------------------|------------------------------------------|
| `PORT`           | `3000`            | HTTP port                                |
| `DB_FILE`        | `data/icepay.db`  | SQLite database file                     |
| `SESSION_SECRET` | random per start  | Set this so sessions survive restarts    |

## First-time setup

1. **Settings → Company**: name, KRA PIN, NSSF and SHIF employer numbers.
2. **Settings → Tax & statutory**: check the seeded rates against current KRA, SHA and NSSF notices.
3. **Settings → Departments / Designations**: build your structure.
4. **Benefits / Deductions**: define pay items, then assign them on each employee's page (or "Assign to all").
5. **Employees**: add staff.
6. **Settings → Payroll periods**: open the first month.

## Payroll workflow

```
OPEN ──process──▶ PROCESSED ──post──▶ POSTED (locked)
  ▲                   │
  └────roll back──────┘
```

- **Process** calculates payslips for every `ACTIVE` employee hired on or before the month end, plus a final
  payslip for anyone whose last working day falls in that month. Suspended employees are skipped.
- **Roll back** deletes that period's payslips and reopens it. You can change salaries, items or rates and then process again.
- **Post** is final and needs you to type `POST` to confirm. Database triggers also block any update or
  delete on a posted period or its payslips, so even direct SQL cannot change them.
- Periods must be posted in order: February cannot be processed until January is posted.
- After posting you can **Email payslips** (needs Settings → Mail server) and **Export CSV**.

## How pay is calculated

| Step | Rule (defaults, all editable in Settings) |
|---|---|
| Gross pay | Basic + all benefits. Percentage items are a % of **basic salary** |
| NSSF | 6% of gross up to KES 8,000 (Tier I) + 6% of gross between 8,000 and 72,000 (Tier II). Employer matches |
| SHIF | 2.75% of gross, minimum KES 300 |
| Housing Levy | 1.5% of gross. Employer matches |
| Taxable pay | Basic + *taxable* benefits − (NSSF + *tax-exempt* deductions, capped at KES 30,000) − SHIF − Housing Levy |
| PAYE | Monthly bands 10% / 25% / 30% / 32.5% / 35%, less personal relief of KES 2,400 and insurance relief |
| Insurance relief | 15% of qualifying premiums, max KES 5,000/month, never more than the remaining tax |
| Net pay | Gross − PAYE − NSSF − SHIF − Housing Levy − all other deductions |

### Joiners and leavers (proration)

When an employee joins or leaves mid-month, pay is prorated by calendar days: **days employed ÷ days in the month**.

- **Prorated:** basic salary and fixed-amount benefits. Percentage benefits follow automatically because they are a % of the prorated basic.
- **Not prorated:** fixed-amount deductions such as loans and SACCO contributions are recovered in full.
- **Statutory deductions:** NSSF, SHIF and Housing Levy are calculated on the prorated gross.
- **Terminations:** the date entered is the employee's last working day. They get a final payslip for that month and drop off payroll afterwards. The date must fall after the last posted month.
- **Switching it off:** Settings → Tax & statutory → Payroll rules.

### Insurance relief

Two sources of premiums qualify:
- Deductions with **"Insurance premium"** ticked. These must be "after tax", because premiums earn relief rather than reducing taxable pay.
- **Insurance premiums paid privately** on the employee's profile, for policies the employee pays directly with proof of payment.

Benefits are either **taxable** or **tax exempt**. Tax-exempt benefits count towards gross pay but not taxable pay.
Deductions are either **taxable** (taken after tax, e.g. loans, SACCO) or **tax exempt** (taken before tax, e.g. pension).

## Layout

```
src/payroll/calculator.js   pure pay calculations (unit tested)
src/payroll/service.js      process / roll back / post
src/db.js                   schema, triggers, seed data
src/routes/                 Express routes per module
views/                      EJS templates
test/                       node:test suites
```
