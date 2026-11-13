// Scenario tests for the Rafeeq simulation (rafeeq-mvp.html).
// Each case drives the page like a user would and checks what the
// patient band, companion band and nurse dashboard show.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const tmp = path.resolve(SRC);

const results = [];
async function run(name, fn, page) {
  await page.click('#reset');
  await page.selectOption('#timeout', '10');
  await page.$eval('#dist', el => { el.value = 3; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(300);
  const t0 = Date.now();
  let ok = false, detail = '';
  try { detail = await fn(); ok = true; } catch (e) { detail = e.message.split('\n')[0]; }
  results.push({ name, ok, detail, ms: Date.now() - t0 });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  ' + detail);
}
const txt = (page, sel) => page.$eval(sel, el => el.innerText.trim());
function expect(cond, msg) { if (!cond) throw new Error(msg); }
async function setDist(page, v) {
  await page.$eval('#dist', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, v);
  await page.waitForTimeout(200);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
  await page.goto('file://' + tmp);
  await page.waitForTimeout(800);

  await run('1. Stable readings: no alert reaches the nurse', async () => {
    const a = await txt(page, '#alerts');
    expect(a.includes('لا توجد تنبيهات'), 'nurse panel not empty: ' + a);
    return 'nurse panel empty';
  }, page);

  await run('2. Mild change, companion responds in time: nurse not alerted', async () => {
    await page.click('#sc-mild');
    await page.waitForTimeout(400);
    const c = await txt(page, '#cMsg');
    expect(c.includes('تغيّر في حالة المريض'), 'companion not alerted: ' + c);
    expect(!(await page.isDisabled('#ack')), 'respond button disabled');
    await page.click('#ack');
    await page.waitForTimeout(11500); // wait past the 10 s timeout
    const a = await txt(page, '#alerts');
    expect(!a.includes('تصعيد'), 'nurse was alerted anyway: ' + a);
    return 'companion alerted, response logged, nurse panel stayed clear after 10 s';
  }, page);

  await run('3. Mild change, no response: alert escalates to nurse after the 10 s timeout', async () => {
    await page.click('#sc-mild');
    await page.waitForTimeout(5000);
    let a = await txt(page, '#alerts');
    expect(!a.includes('تصعيد'), 'escalated too early: ' + a);
    await page.waitForTimeout(6500);
    a = await txt(page, '#alerts');
    expect(a.includes('تصعيد من المرافق'), 'no escalation: ' + a);
    const log = await txt(page, '#log');
    expect(log.includes('انتهت المهلة'), 'log missing timeout reason');
    return 'no nurse alert at 5 s; nurse alert present by 11.5 s; reason logged';
  }, page);

  await run('4. Mild change while companion is far (30 m): nurse alerted at once', async () => {
    await setDist(page, 30);
    await page.click('#sc-mild');
    await page.waitForTimeout(400);
    const a = await txt(page, '#alerts');
    expect(a.includes('تصعيد'), 'nurse not alerted: ' + a);
    return 'nurse alert within 0.4 s';
  }, page);

  await run('5. Severe deterioration: nurse and companion alerted together', async () => {
    await page.click('#sc-severe');
    await page.waitForTimeout(400);
    const a = await txt(page, '#alerts');
    const c = await txt(page, '#cMsg');
    expect(a.includes('تدهور حاد'), 'nurse not alerted: ' + a);
    expect(c.includes('تدهور حاد'), 'companion not alerted: ' + c);
    return 'critical alert on both within 0.4 s';
  }, page);

  await run('6. Companion walks away during an open alert: escalates to nurse', async () => {
    await page.click('#sc-mild');
    await page.waitForTimeout(1500);
    await setDist(page, 40);
    await page.waitForTimeout(1500);
    const a = await txt(page, '#alerts');
    expect(a.includes('تصعيد'), 'not escalated: ' + a);
    const log = await txt(page, '#log');
    expect(log.includes('ابتعد أثناء تنبيه'), 'reason not logged');
    return 'escalated within about 1 s of leaving; reason logged';
  }, page);

  await run('7. Companion out of range: monitoring interval tightens and patient shows as alone', async () => {
    let iv = await txt(page, '#interval');
    expect(iv.includes('60'), 'base interval wrong: ' + iv);
    await setDist(page, 20);
    iv = await txt(page, '#interval');
    const q = await txt(page, '#queue');
    expect(iv.includes('15'), 'interval did not tighten: ' + iv);
    expect(q.includes('وحده'), 'queue does not show alone');
    return '60 s with companion, 15 s beyond 15 m; queue marks patient alone';
  }, page);

  await run('8. Handover to nurse: nurse sees the patient is in their care', async () => {
    await page.click('#ho-nurse');
    await page.waitForTimeout(300);
    const a = await txt(page, '#alerts');
    expect(a.includes('في عهدتك'), 'no handover notice: ' + a);
    return 'handover notice shown and logged';
  }, page);

  await run('9. Handover to another relative: band re-paired to the new companion', async () => {
    await page.click('#ho-alt');
    await page.waitForTimeout(300);
    const n = await txt(page, '#cName');
    expect(n.includes('الابن'), 'name not changed: ' + n);
    return 'companion changed from daughter to son';
  }, page);

  await run('10. Companion reports chest pain: priority rises and nurse alerted', async () => {
    const before = await page.$$eval('#queue tr', rs => rs.map(r => r.innerText));
    const sc0 = Number(before.find(r => r.includes('أ-12')).split('\t')[1]);
    await page.click('#rep-chest');
    await page.waitForTimeout(300);
    const after = await page.$$eval('#queue tr', rs => rs.map(r => r.innerText));
    const sc1 = Number(after.find(r => r.includes('أ-12')).split('\t')[1]);
    const a = await txt(page, '#alerts');
    expect(sc1 === sc0 + 3, `score ${sc0} -> ${sc1}`);
    expect(a.includes('تصعيد'), 'nurse not alerted');
    return `priority score ${sc0} -> ${sc1}; nurse alerted`;
  }, page);

  await run('11. Turn call: companion band directs to clinic 3', async () => {
    await page.click('#callTurn');
    await page.waitForTimeout(300);
    const c = await txt(page, '#cMsg');
    expect(c.includes('عيادة 3'), 'no call: ' + c);
    return 'turn call shown on companion band';
  }, page);

  await run('12. Nurse can open each patient card with all vital signs', async () => {
    const ids = ['ب-07', 'ج-03', 'د-19', 'أ-12'];
    for (const id of ids) {
      await page.click(`#queue button[data-id="${id}"]`);
      await page.waitForTimeout(150);
      const d = await txt(page, '#detail');
      expect(d.includes('بطاقة المريض ' + id), 'card not switched to ' + id);
      for (const k of ['النبض', 'الأكسجين', 'معدل التنفس', 'حرارة الجلد', 'الوعي', 'الحركة', 'ضغط الدم'])
        expect(d.includes(k), id + ' missing ' + k);
    }
    return 'switched between 4 patients; each card shows 7 vital fields';
  }, page);

  await run('13. Companion reports confusion: 3 NEWS2 points and nurse alerted', async () => {
    await page.click('#rep-conf');
    await page.waitForTimeout(300);
    const d = await txt(page, '#detail');
    const a = await txt(page, '#alerts');
    expect(d.includes('تشوّش'), 'card does not show confusion');
    expect(a.includes('تشوّش'), 'nurse not alerted');
    return 'confusion shown on card with 3 points; nurse alerted';
  }, page);

  // ---- screenshots for the prototype slide ----
  await page.reload(); await page.waitForTimeout(800);
  await page.click('#reset');
  await page.selectOption('#timeout', '10');
  await page.waitForTimeout(500);
  const dev = await page.$('.devices');
  await dev.screenshot({ path: path.join(OUT, 'shot-1-stable.png') });
  await page.click('#sc-mild');
  await page.waitForTimeout(2200);
  await dev.screenshot({ path: path.join(OUT, 'shot-2-companion.png') });
  await page.waitForTimeout(9500);
  await dev.screenshot({ path: path.join(OUT, 'shot-3-nurse.png') });
  await page.click('#queue button[data-id="ب-07"]');
  await page.waitForTimeout(300);
  await (await page.$('section[aria-label="لوحة الممرض"]')).screenshot({ path: path.join(OUT, 'shot-4-nurse-card.png') });

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
  await browser.close();
})();
