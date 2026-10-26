// Pure Kenyan payroll calculations. All amounts are monthly KES.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function computeTax(taxablePay, bands) {
  const sorted = [...bands].sort((a, b) => a.lower_limit - b.lower_limit);
  let tax = 0;
  for (const band of sorted) {
    const upper = band.upper_limit == null ? Infinity : band.upper_limit;
    const portion = Math.min(taxablePay, upper) - band.lower_limit;
    if (portion > 0) tax += portion * band.rate / 100;
  }
  return round2(tax);
}

// NSSF Act 2013: Tier I on earnings up to the lower limit, Tier II between lower and upper limits.
function computeNssf(pensionablePay, s) {
  const rate = s.nssf_rate / 100;
  const tier1 = Math.min(pensionablePay, s.nssf_lower_limit) * rate;
  const tier2 = Math.max(0, Math.min(pensionablePay, s.nssf_upper_limit) - s.nssf_lower_limit) * rate;
  return { tier1: round2(tier1), tier2: round2(tier2), total: round2(tier1 + tier2) };
}

function computeShif(grossPay, s) {
  if (grossPay <= 0) return 0;
  return round2(Math.max(grossPay * s.shif_rate / 100, s.shif_minimum));
}

function computeHousingLevy(grossPay, s) {
  if (!s.housing_levy_enabled) return 0;
  return round2(grossPay * s.housing_levy_rate / 100);
}

// Percentage items are a % of the (prorated) basic. Fixed amounts are multiplied by `factor`:
// the proration factor for benefits, 1 for deductions (loans etc. are recovered in full).
function itemAmount(item, basicSalary, factor = 1) {
  return round2(item.calc_type === 'PERCENT' ? basicSalary * item.value / 100 : item.value * factor);
}

/**
 * @param {object} input
 * @param {number} input.basicSalary  full monthly basic salary
 * @param {Array<{kind,code,name,calc_type,value,taxable,insurance_relief}>} input.items  employee benefits & deductions
 * @param {object} input.settings  statutory settings (see db.DEFAULT_SETTINGS)
 * @param {Array<{lower_limit,upper_limit,rate}>} input.bands  PAYE bands
 * @param {number} [input.daysWorked]  calendar days worked in the period (defaults to the full period)
 * @param {number} [input.daysInPeriod]  calendar days in the period
 * @param {number} [input.insurancePremium]  premiums the employee pays outside payroll
 */
function computePayslip({ basicSalary, items, settings: s, bands, daysWorked, daysInPeriod, insurancePremium = 0 }) {
  const days = daysInPeriod || 30;
  const worked = Math.min(daysWorked ?? days, days);
  const factor = worked / days;
  const prorated = factor < 1;

  const monthlyBasic = round2(basicSalary);
  const basic = round2(monthlyBasic * factor);
  const lines = [{
    category: 'EARNING', code: 'BASIC', amount: basic, taxable: 1,
    name: prorated ? `Basic Salary (${worked}/${days} days)` : 'Basic Salary',
  }];

  let totalBenefits = 0;
  let taxableBenefits = 0;
  for (const item of items.filter((i) => i.kind === 'BENEFIT')) {
    const amount = itemAmount(item, basic, factor);
    if (amount === 0) continue;
    totalBenefits += amount;
    if (item.taxable) taxableBenefits += amount;
    lines.push({ category: 'EARNING', code: item.code, name: item.name, amount, taxable: item.taxable ? 1 : 0 });
  }
  totalBenefits = round2(totalBenefits);
  const grossPay = round2(basic + totalBenefits);
  const grossTaxable = round2(basic + taxableBenefits);

  const nssf = computeNssf(grossPay, s);
  const shif = computeShif(grossPay, s);
  const housingLevy = computeHousingLevy(grossPay, s);

  let exemptDeductions = 0;
  let otherDeductions = 0;
  let premiums = Math.max(0, Number(insurancePremium) || 0);
  const deductionLines = [];
  for (const item of items.filter((i) => i.kind === 'DEDUCTION')) {
    const amount = itemAmount(item, basic);
    if (amount === 0) continue;
    if (item.taxable) otherDeductions += amount;
    else exemptDeductions += amount;
    if (item.insurance_relief) premiums += amount;
    deductionLines.push({ category: 'DEDUCTION', code: item.code, name: item.name, amount, taxable: item.taxable ? 1 : 0 });
  }
  exemptDeductions = round2(exemptDeductions);
  otherDeductions = round2(otherDeductions);

  const pensionRelief = Math.min(nssf.total + exemptDeductions, s.pension_relief_cap);
  const taxablePay = round2(Math.max(0, grossTaxable
    - pensionRelief
    - (s.shif_tax_deductible ? shif : 0)
    - (s.housing_levy_tax_deductible ? housingLevy : 0)));

  const taxCharged = computeTax(taxablePay, bands);
  // Reliefs reduce tax charged but never below zero
  const personalRelief = round2(Math.min(s.personal_relief, taxCharged));
  const insuranceEntitlement = Math.min(premiums * (s.insurance_relief_rate || 0) / 100, s.insurance_relief_cap || 0);
  const insuranceRelief = round2(Math.min(insuranceEntitlement, taxCharged - personalRelief));
  const paye = round2(taxCharged - personalRelief - insuranceRelief);

  const statutory = [
    { category: 'STATUTORY', code: 'PAYE', name: 'PAYE', amount: paye, taxable: 0 },
    { category: 'STATUTORY', code: 'NSSF', name: 'NSSF', amount: nssf.total, taxable: 0 },
    { category: 'STATUTORY', code: 'SHIF', name: 'SHIF', amount: shif, taxable: 0 },
  ];
  if (housingLevy > 0) {
    statutory.push({ category: 'STATUTORY', code: 'AHL', name: 'Housing Levy', amount: housingLevy, taxable: 0 });
  }
  lines.push(...statutory, ...deductionLines);

  const totalDeductions = round2(paye + nssf.total + shif + housingLevy + exemptDeductions + otherDeductions);

  return {
    monthly_basic: monthlyBasic,
    days_worked: worked,
    days_in_period: days,
    basic_salary: basic,
    total_benefits: totalBenefits,
    gross_pay: grossPay,
    nssf: nssf.total,
    shif,
    housing_levy: housingLevy,
    exempt_deductions: exemptDeductions,
    taxable_pay: taxablePay,
    tax_charged: taxCharged,
    personal_relief: personalRelief,
    insurance_relief: insuranceRelief,
    paye,
    other_deductions: otherDeductions,
    total_deductions: totalDeductions,
    net_pay: round2(grossPay - totalDeductions),
    employer_nssf: nssf.total,
    employer_housing_levy: housingLevy,
    lines,
  };
}

module.exports = { round2, computeTax, computeNssf, computeShif, computeHousingLevy, computePayslip };
