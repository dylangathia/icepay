const test = require('node:test');
const assert = require('node:assert/strict');
const { computePayslip, computeTax, computeNssf } = require('../src/payroll/calculator');
const { DEFAULT_SETTINGS } = require('../src/db');

const settings = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, Number(v)]));
const bands = [
  { lower_limit: 0, upper_limit: 24000, rate: 10 },
  { lower_limit: 24000, upper_limit: 32333, rate: 25 },
  { lower_limit: 32333, upper_limit: 500000, rate: 30 },
  { lower_limit: 500000, upper_limit: 800000, rate: 32.5 },
  { lower_limit: 800000, upper_limit: null, rate: 35 },
];
const calc = (basicSalary, items = [], s = settings) => computePayslip({ basicSalary, items, settings: s, bands });

test('PAYE bands', () => {
  assert.equal(computeTax(24000, bands), 2400);
  assert.equal(computeTax(32333, bands), 4483.25);
  assert.equal(computeTax(1000000, bands), 2400 + 2083.25 + 140300.1 + 97500 + 70000);
});

test('NSSF tiers are capped at the upper earnings limit', () => {
  assert.deepEqual(computeNssf(5000, settings), { tier1: 300, tier2: 0, total: 300 });
  assert.deepEqual(computeNssf(50000, settings), { tier1: 480, tier2: 2520, total: 3000 });
  assert.deepEqual(computeNssf(500000, settings), { tier1: 480, tier2: 3840, total: 4320 });
});

test('KES 50,000 basic salary', () => {
  const p = calc(50000);
  assert.equal(p.gross_pay, 50000);
  assert.equal(p.nssf, 3000);
  assert.equal(p.shif, 1375);
  assert.equal(p.housing_levy, 750);
  assert.equal(p.taxable_pay, 44875);
  assert.equal(p.tax_charged, 8245.85);
  assert.equal(p.paye, 5845.85);
  assert.equal(p.net_pay, 39029.15);
});

test('KES 100,000 basic salary hits the NSSF cap', () => {
  const p = calc(100000);
  assert.equal(p.nssf, 4320);
  assert.equal(p.taxable_pay, 91430);
  assert.equal(p.paye, 19812.35);
  assert.equal(p.net_pay, 71617.65);
});

test('low earners pay no PAYE and SHIF minimum applies', () => {
  const p = calc(15000);
  assert.equal(p.paye, 0);
  assert.equal(p.personal_relief, p.tax_charged);
  assert.equal(calc(5000).shif, 300);
});

test('benefits: percentage vs fixed, taxable vs exempt', () => {
  const p = calc(50000, [
    { kind: 'BENEFIT', code: 'HOUSE', name: 'House', calc_type: 'PERCENT', value: 15, taxable: 1 },
    { kind: 'BENEFIT', code: 'PERDIEM', name: 'Per diem', calc_type: 'FIXED', value: 4000, taxable: 0 },
  ]);
  assert.equal(p.total_benefits, 7500 + 4000);
  assert.equal(p.gross_pay, 61500);
  // NSSF/SHIF/AHL on full gross, but only taxable earnings are taxed
  const expectedTaxable = 57500 - p.nssf - p.shif - p.housing_levy;
  assert.equal(p.taxable_pay, Math.round(expectedTaxable * 100) / 100);
});

test('deductions: tax-exempt reduces taxable pay, after-tax does not', () => {
  const base = calc(80000);
  const p = calc(80000, [
    { kind: 'DEDUCTION', code: 'PENSION', name: 'Pension', calc_type: 'PERCENT', value: 5, taxable: 0 },
    { kind: 'DEDUCTION', code: 'SACCO', name: 'Sacco', calc_type: 'FIXED', value: 3000, taxable: 1 },
  ]);
  assert.equal(p.exempt_deductions, 4000);
  assert.equal(p.other_deductions, 3000);
  assert.equal(p.taxable_pay, base.taxable_pay - 4000);
  assert.ok(p.paye < base.paye);
  assert.equal(p.net_pay, Math.round((p.gross_pay - p.total_deductions) * 100) / 100);
});

test('pension relief is capped', () => {
  const p = calc(500000, [{ kind: 'DEDUCTION', code: 'PEN', name: 'Pension', calc_type: 'FIXED', value: 50000, taxable: 0 }]);
  assert.equal(p.taxable_pay, 500000 - settings.pension_relief_cap - p.shif - p.housing_levy);
});

test('proration: basic and fixed benefits prorated, fixed deductions recovered in full', () => {
  const p = computePayslip({
    basicSalary: 62000, settings, bands, daysWorked: 10, daysInPeriod: 31,
    items: [
      { kind: 'BENEFIT', code: 'HOUSE', name: 'House', calc_type: 'PERCENT', value: 10, taxable: 1 },
      { kind: 'BENEFIT', code: 'TRAVEL', name: 'Travel', calc_type: 'FIXED', value: 3100, taxable: 1 },
      { kind: 'DEDUCTION', code: 'LOAN', name: 'Loan', calc_type: 'FIXED', value: 5000, taxable: 1 },
    ],
  });
  assert.equal(p.monthly_basic, 62000);
  assert.equal(p.basic_salary, 20000);          // 62,000 x 10/31
  assert.equal(p.total_benefits, 2000 + 1000);  // 10% of prorated basic + 3,100 x 10/31
  assert.equal(p.other_deductions, 5000);
  assert.equal(p.lines[0].name, 'Basic Salary (10/31 days)');
  assert.equal(p.days_worked, 10);
});

test('full month is not prorated', () => {
  const p = computePayslip({ basicSalary: 50000, items: [], settings, bands, daysWorked: 31, daysInPeriod: 31 });
  assert.equal(p.basic_salary, 50000);
  assert.equal(p.lines[0].name, 'Basic Salary');
});

test('insurance relief: 15% of premiums, capped, and never below zero tax', () => {
  const ins = (value) => [{ kind: 'DEDUCTION', code: 'LIFE', name: 'Life cover', calc_type: 'FIXED', value, taxable: 1, insurance_relief: 1 }];
  const base = calc(100000);

  const p = calc(100000, ins(4000));
  assert.equal(p.insurance_relief, 600);
  assert.equal(p.paye, Math.round((base.paye - 600) * 100) / 100);
  assert.equal(p.taxable_pay, base.taxable_pay);  // premiums do not reduce taxable pay

  assert.equal(calc(300000, ins(50000)).insurance_relief, 5000);  // capped

  const declared = computePayslip({ basicSalary: 100000, items: [], settings, bands, insurancePremium: 2000 });
  assert.equal(declared.insurance_relief, 300);

  const low = calc(26000, ins(20000));
  assert.equal(low.paye, 0);
  assert.equal(low.insurance_relief, round(low.tax_charged - low.personal_relief));
});

const round = (n) => Math.round(n * 100) / 100;

test('housing levy can be disabled', () => {
  const p = calc(50000, [], { ...settings, housing_levy_enabled: 0 });
  assert.equal(p.housing_levy, 0);
  assert.ok(!p.lines.some((l) => l.code === 'AHL'));
});
