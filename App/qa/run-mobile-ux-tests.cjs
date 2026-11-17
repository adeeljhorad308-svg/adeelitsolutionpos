'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');
const core = require('../www/core.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'www', 'styles.css'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'www', 'app.js'), 'utf8');
const dbSource = fs.readFileSync(path.join(root, 'www', 'db.js'), 'utf8');
const licenseSource = fs.readFileSync(path.join(root, 'www', 'license.js'), 'utf8');
const resetLicenseSource = fs.readFileSync(path.join(root, 'www', 'reset-license.js'), 'utf8');
const receiptImageSource = fs.readFileSync(path.join(root, 'www', 'receipt-image.js'), 'utf8');
const androidManifestSource = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeDatabase(options = {}) {
  const store = new Map();
  const Preferences = {
    async get({ key }) { return { value: store.has(key) ? store.get(key) : null }; },
    async set({ key, value }) { store.set(key, String(value)); },
    async remove({ key }) { store.delete(key); }
  };
  const plugins = { Preferences };
  // Only tests that explicitly pass a fake Filesystem exercise the external
  // (uninstall-proof) backup mirror's real read/write/prune logic — every
  // other test runs with NO Filesystem plugin at all, which is itself the
  // most common real case (older Android, or the plugin genuinely missing)
  // and must keep every existing backup/restore behaviour working unchanged.
  if (options.filesystem) plugins.Filesystem = options.filesystem;
  const sandbox = {
    Capacitor: { Plugins: plugins },
    AdeelCore: core,
    crypto: webcrypto,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Promise,
    console
  };
  sandbox.window = sandbox;
  vm.runInNewContext(dbSource, sandbox, { filename: 'db.js' });
  return { db: sandbox.db, store };
}

// A tiny in-memory stand-in for the native Filesystem plugin, so the
// external (uninstall-proof) backup mirror can be exercised for real —
// actual writeFile/readdir/deleteFile/permission calls — without a device.
function makeFakeFilesystem(options = {}) {
  const files = new Map(); // path -> { data, mtime }
  const permissionState = options.permissionState || 'granted';
  let clock = 0;
  return {
    files,
    async checkPermissions() { return { publicStorage: permissionState }; },
    async requestPermissions() { return { publicStorage: permissionState }; },
    async writeFile({ path, data }) {
      clock += 1;
      files.set(path, { data, mtime: clock });
      return { uri: path };
    },
    async readFile({ path }) {
      if (!files.has(path)) throw new Error('ENOENT: ' + path);
      return { data: files.get(path).data };
    },
    async readdir({ path: dirPath }) {
      const prefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';
      const entries = [];
      for (const [filePath, meta] of files.entries()) {
        if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes('/')) {
          entries.push({ name: filePath.slice(prefix.length), type: 'file', size: meta.data.length, ctime: meta.mtime, mtime: meta.mtime });
        }
      }
      return { files: entries };
    },
    async deleteFile({ path }) { files.delete(path); }
  };
}

function makeLicenseVerifier(machineId, options = {}) {
  const sandbox = {
    Capacitor: { Plugins: { Device: { async getId() { return { identifier: machineId }; } } } },
    crypto: options.crypto || webcrypto,
    nacl: options.nacl || require('tweetnacl'),
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    TextDecoder,
    Uint8Array,
    Date,
    Number,
    String,
    Math,
    Promise,
    console
  };
  sandbox.window = sandbox;
  vm.runInNewContext(licenseSource, sandbox, { filename: 'license.js' });
  return sandbox.license;
}

function makeResetVerifier(machineId, options = {}) {
  const sandbox = {
    Capacitor: { Plugins: { Device: { async getId() { return { identifier: machineId }; } } } },
    crypto: options.crypto || webcrypto,
    nacl: options.nacl || require('tweetnacl'),
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    TextDecoder,
    Uint8Array,
    Date,
    Number,
    String,
    Math,
    Promise,
    console
  };
  sandbox.window = sandbox;
  vm.runInNewContext(resetLicenseSource, sandbox, { filename: 'reset-license.js' });
  return sandbox.resetLicense;
}

test('all static DOM references exist and HTML ids are unique', () => {
  const htmlIds = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
  assert.strictEqual(new Set(htmlIds).size, htmlIds.length, 'Duplicate HTML id found');
  const referenced = Array.from(appSource.matchAll(/byId\('([^']+)'\)/g), match => match[1]);
  const missing = Array.from(new Set(referenced)).filter(id => !htmlIds.includes(id));
  assert.deepStrictEqual(missing, []);
});

test('four-digit PIN auto-advance uses a real array and cannot throw on NodeList.every', () => {
  assert.match(appSource, /Array\.from\(boxes\)\.every\(input => input\.value\)/);
  assert.doesNotMatch(appSource, /if \(boxes\.every\(/);
});

test('signed mobile license fixtures verify offline without a customer-side secret', async () => {
  // NOTE: these fixtures must be re-signed with whichever private key
  // currently matches www/license.js's baked-in public key (the owner
  // tool's generate-license-mobile-v2.js). The key pair was rotated once
  // already in this project's history after the original private key was
  // lost; if it is ever rotated again, regenerate these two fixtures the
  // same way (sign a payload of `2|ADEEL_POS_MOBILE|<machineId>|<YYYYMMDD>`
  // with the current private key) or this test will fail even though real
  // licenses issued by the current tool verify correctly.
  const machineId = '6F03BE30C25C6B3B';
  const verifier = makeLicenseVerifier(machineId);
  const validKey = 'AP2.MnxBREVFTF9QT1NfTU9CSUxFfDZGMDNCRTMwQzI1QzZCM0J8MjA5OTEyMzE.9uao4v-7IcM410q_Rq95N9-i1zmIKIGJvbHiDcZPKdIrc1olVKbCKkxnsgUrWFXMxtmTNA7pD2fKegO8s_1RBA';
  const expiredKey = 'AP2.MnxBREVFTF9QT1NfTU9CSUxFfDZGMDNCRTMwQzI1QzZCM0J8MjAyMDAxMDE.SDNK6hrXHzUp6LQmzi14PEVSSvpn7t6-_UA0-i5dkJ3EOY2Gg9qHiCFYrSpoIRbx6Myj6IRfmfGFPTh87GF7Cg';
  assert.strictEqual((await verifier.checkLicense(machineId, validKey)).valid, true);
  const noEd25519WebCrypto = { subtle: { async importKey() { throw new Error('Ed25519 unavailable'); } } };
  const fallbackVerifier = makeLicenseVerifier(machineId, { crypto: noEd25519WebCrypto });
  assert.strictEqual((await fallbackVerifier.checkLicense(machineId, validKey)).valid, true);
  assert.strictEqual((await verifier.checkLicense('AAAAAAAAAAAAAAAA', validKey)).valid, false);
  assert.strictEqual((await verifier.checkLicense(machineId, expiredKey)).reason, 'expired');
  // Flip a character well inside the signature, not the very last one or two —
  // those can land on base64 padding bits that don't affect the decoded
  // bytes at all, which would make this assertion falsely pass regardless
  // of whether tamper-detection actually works.
  const tamperIdx = validKey.length - 10;
  const tamperedKey = `${validKey.slice(0, tamperIdx)}${validKey[tamperIdx] === 'A' ? 'B' : 'A'}${validKey.slice(tamperIdx + 1)}`;
  assert.strictEqual((await verifier.checkLicense(machineId, tamperedKey)).valid, false);
  assert.doesNotMatch(licenseSource, /SECRET|createHmac|generateLicenseKey/);
});

test('reset-license (Forgot PIN) is a fully isolated license type from the real activation license', async () => {
  const machineId = '6F03BE30C25C6B3B';
  const resetVerifier = makeResetVerifier(machineId);
  const validResetKey = 'RESET2.MnxBREVFTF9QT1NfTU9CSUxFX1JFU0VUfDZGMDNCRTMwQzI1QzZCM0J8MjA5OTEyMzE.aA8l0PZ47qXzdO-2xvuYehyNiFYSdqNRdebf8sd8C32WXLZ2uq6Bdgk2L3QvXT-pfbkm88lcFv3kC8TECTmKDQ';
  const expiredResetKey = 'RESET2.MnxBREVFTF9QT1NfTU9CSUxFX1JFU0VUfDZGMDNCRTMwQzI1QzZCM0J8MjAyMDAxMDE.PbRQW3yNcEWM7FFfU0wcdS5oiWEfVCQKUR1_py9G9DZRfYHCeJx3sShW9QhngGeic7OioDog9TfRmfsMJkAoBQ';
  // A valid reset key verifies through the reset verifier, offline, over the fallback path too.
  assert.strictEqual((await resetVerifier.checkResetKey(machineId, validResetKey)).valid, true);
  const noEd25519WebCrypto = { subtle: { async importKey() { throw new Error('Ed25519 unavailable'); } } };
  const fallbackResetVerifier = makeResetVerifier(machineId, { crypto: noEd25519WebCrypto });
  assert.strictEqual((await fallbackResetVerifier.checkResetKey(machineId, validResetKey)).valid, true);
  assert.strictEqual((await resetVerifier.checkResetKey('AAAAAAAAAAAAAAAA', validResetKey)).valid, false);
  assert.strictEqual((await resetVerifier.checkResetKey(machineId, expiredResetKey)).reason, 'expired');
  const resetTamperIdx = validResetKey.length - 10;
  const tamperedResetKey = `${validResetKey.slice(0, resetTamperIdx)}${validResetKey[resetTamperIdx] === 'A' ? 'B' : 'A'}${validResetKey.slice(resetTamperIdx + 1)}`;
  assert.strictEqual((await resetVerifier.checkResetKey(machineId, tamperedResetKey)).valid, false);
  // Isolation guarantee: a reset key must never be accepted as an activation
  // license, and a real activation key must never be accepted as a reset key.
  const activationVerifier = makeLicenseVerifier(machineId);
  const realActivationKey = 'AP2.MnxBREVFTF9QT1NfTU9CSUxFfDZGMDNCRTMwQzI1QzZCM0J8MjA5OTEyMzE.9uao4v-7IcM410q_Rq95N9-i1zmIKIGJvbHiDcZPKdIrc1olVKbCKkxnsgUrWFXMxtmTNA7pD2fKegO8s_1RBA';
  assert.strictEqual((await activationVerifier.checkLicense(machineId, validResetKey)).valid, false);
  assert.strictEqual((await resetVerifier.checkResetKey(machineId, realActivationKey)).valid, false);
  assert.doesNotMatch(resetLicenseSource, /SECRET|createHmac|generateLicenseKey/);
  // The reset-license module must never touch the real activation license's
  // storage key or verification function.
  assert.doesNotMatch(resetLicenseSource, /db\.(get|set)Setting\(['"]licenseKey['"]/);
  assert.doesNotMatch(resetLicenseSource, /checkLicense\(/);
});

test('one cart row remains synchronized across repeated taps', () => {
  let cart = [];
  const product = { id: 'p_tea', name: 'Tea', price: 120 };
  cart = core.addCartItem(cart, product, 1);
  cart = core.addCartItem(cart, product, 1);
  cart = core.addCartItem(cart, product, 1);
  assert.strictEqual(cart.length, 1);
  assert.strictEqual(cart[0].quantity, 3);
  cart = core.changeCartQuantity(cart, core.productIdentity(cart[0]), -2);
  assert.strictEqual(cart[0].quantity, 1);
  cart = core.changeCartQuantity(cart, core.productIdentity(cart[0]), -1);
  assert.strictEqual(cart.length, 0);
});

test('discount is bounded and totals stay non-negative', () => {
  const cart = [{ name: 'Milk', price: 320, quantity: 2 }];
  assert.deepStrictEqual(core.calculateTotals(cart, 40), { subtotal: 640, discount: 40, total: 600 });
  assert.deepStrictEqual(core.calculateTotals(cart, 900), { subtotal: 640, discount: 640, total: 0 });
});

test('section-aware and legacy CSV formats both parse', () => {
  const sectioned = core.parseProductsCsv('\uFEFFName,Price,Section\r\nMilk,320,Grocery\r\nWater,120,Drinks\r\nBag,30,\r\n');
  assert.strictEqual(sectioned.products.length, 3);
  assert.strictEqual(sectioned.products[1].section, 'Drinks');
  assert.strictEqual(sectioned.products[2].section, '');
  assert.strictEqual(sectioned.hasSectionColumn, true);
  const legacy = core.parseProductsCsv('Name,Price\nTea,520\n');
  assert.strictEqual(legacy.products.length, 1);
  assert.strictEqual(legacy.hasSectionColumn, false);
});

test('legacy quick items migrate without losing name, price or quick status', async () => {
  const { db, store } = makeDatabase();
  store.set('quickItems', JSON.stringify([{ name: 'Tea', price: 120 }]));
  const products = await db.getProducts();
  assert.strictEqual(products.length, 1);
  assert.strictEqual(products[0].name, 'Tea');
  assert.strictEqual(products[0].price, 120);
  assert.strictEqual(products[0].isQuick, true);
  assert.ok(products[0].id);
});

test('invoice number stays unique after restored gaps and invoice is snapshotted', async () => {
  const { db, store } = makeDatabase();
  store.set('invoices', JSON.stringify([{ id: 9, invoiceNumber: 'INV-000042', items: [], total: 0, created_at: new Date().toISOString() }]));
  const invoice = await db.saveInvoice({ customerName: '', items: [{ productId: 'p1', name: 'Milk', price: 320, quantity: 2 }], subtotal: 640, discount: 40, total: 600, paymentMethod: 'Cash' });
  assert.strictEqual(invoice.invoiceNumber, 'INV-000043');
  assert.strictEqual(invoice.id, 10);
  assert.strictEqual(invoice.items[0].name, 'Milk');
  assert.strictEqual(invoice.print_status, 'pending');
});

test('daily sales breakdown is zero-filled per day and excludes voided invoices', async () => {
  const { db, store } = makeDatabase();
  const mk = (dateStr, total, voided = false) => ({ created_at: new Date(dateStr + 'T10:00:00').toISOString(), total, voided, items: [] });
  store.set('invoices', JSON.stringify([
    mk('2026-09-13', 1000),
    mk('2026-09-13', 500),
    mk('2026-09-15', 12000),
    mk('2026-09-16', 300, true), // voided — must not count
    mk('2026-09-19', 4500)
  ]));
  const days = await db.getDailyBreakdown('2026-09-13', '2026-09-19');
  assert.strictEqual(days.length, 7, 'every calendar day in range must be present, including gaps');
  const byDate = Object.fromEntries(days.map(d => [d.date, d.total]));
  assert.strictEqual(byDate['2026-09-13'], 1500);
  assert.strictEqual(byDate['2026-09-14'], 0);
  assert.strictEqual(byDate['2026-09-15'], 12000);
  assert.strictEqual(byDate['2026-09-16'], 0, 'voided invoice must not be counted');
  assert.strictEqual(byDate['2026-09-17'], 0);
  assert.strictEqual(byDate['2026-09-18'], 0);
  assert.strictEqual(byDate['2026-09-19'], 4500);
});

test('reports screen renders a day-wise sales graph without an external charting library', () => {
  assert.match(html, /id="salesGraphCanvas"/);
  assert.match(appSource, /async function renderSalesGraph\(/);
  assert.match(appSource, /await db\.getDailyBreakdown\(/);
  assert.match(appSource, /await renderSalesGraph\(\);/);
  // No remote/CDN chart library — keeps the app fully offline.
  assert.doesNotMatch(appSource, /chart\.js|chartjs|d3\.js|<script[^>]+cdn/i);
  // Thousands formatting: e.g. 12000 -> "12K", 1500 -> "1.5K", 0 -> "0".
  const formatStart = appSource.indexOf('function formatThousands');
  const formatBody = appSource.slice(formatStart, appSource.indexOf('\n}', formatStart) + 2);
  const sandbox = {};
  vm.runInNewContext(formatBody, sandbox);
  assert.strictEqual(sandbox.formatThousands(12000), '12K');
  assert.strictEqual(sandbox.formatThousands(1500), '1.5K');
  assert.strictEqual(sandbox.formatThousands(0), '0');
  assert.strictEqual(sandbox.formatThousands(999), '999');
});

test('draft sale recovery and versioned backup restore work offline', async () => {
  const { db } = makeDatabase();
  await db.setProducts([{ id: 'p1', name: 'Milk', price: 320, sectionId: '', isQuick: true }]);
  await db.setSections([{ id: 's1', name: 'Grocery' }]);
  await db.setSaleDraft({ cart: [{ productId: 'p1', name: 'Milk', price: 320, quantity: 2 }], discount: 20 });
  assert.strictEqual((await db.getSaleDraft()).cart[0].quantity, 2);
  const backup = await db.createBackup('test');
  assert.strictEqual(backup.version, 2);
  assert.strictEqual(db.validateBackup(backup), true);
  await db.restoreBackup(backup);
  assert.strictEqual((await db.getProducts())[0].name, 'Milk');
});

test('held bills get unique numbers even under concurrent holds, and survive a simulated app restart', async () => {
  const { db, store } = makeDatabase();

  // Two "Hold bill" taps racing each other (e.g. a fast double-tap) must
  // still produce two distinct records with distinct hold numbers — this is
  // exactly the class of bug logStockChangesBatch was written to prevent
  // for stock history, so held bills use the same serialized-queue pattern.
  const [billA, billB] = await Promise.all([
    db.holdBill({ cart: [{ name: 'Tea', price: 120, quantity: 2 }], customerName: 'Ali', discountAmount: 0, paymentMethod: 'Cash' }),
    db.holdBill({ cart: [{ name: 'Milk', price: 320, quantity: 1 }], customerName: '', discountAmount: 10, paymentMethod: 'Card' })
  ]);
  assert.notStrictEqual(billA.id, billB.id);
  assert.notStrictEqual(billA.holdNumber, billB.holdNumber);
  assert.match(billA.holdNumber, /^H-\d{4}$/);
  assert.match(billB.holdNumber, /^H-\d{4}$/);

  let list = await db.getHeldBills();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, billB.id, 'newest held bill must come first');

  // Simulate the app being closed and reopened: a brand-new db instance
  // reading from the same underlying Preferences store must still see both.
  const restarted = makeDatabase();
  restarted.store.clear();
  for (const [key, value] of store) restarted.store.set(key, value);
  const afterRestart = await restarted.db.getHeldBills();
  assert.strictEqual(afterRestart.length, 2);
  assert.deepStrictEqual(afterRestart.map(b => b.id).sort(), [billA.id, billB.id].sort());

  // Deleting one held bill leaves the other untouched.
  const deleted = await db.deleteHeldBill(billA.id);
  assert.strictEqual(deleted, true);
  list = await db.getHeldBills();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, billB.id);
  assert.strictEqual(list[0].cart[0].name, 'Milk');
  assert.strictEqual(list[0].discountAmount, 10);
  assert.strictEqual(list[0].paymentMethod, 'Card');

  // Deleting an id that no longer exists is reported, not thrown.
  assert.strictEqual(await db.deleteHeldBill(billA.id), false);
});

test('Hold Bill / New Bill / Held Bills wiring never touches invoices, stock or the saved-sale draft', () => {
  assert.match(html, /id="holdBillBtn"/);
  assert.match(html, /id="newBillBtn"/);
  assert.match(html, /id="heldBillsBtn"/);
  assert.match(html, /id="heldBillsTask"/);
  // Resuming a held bill never silently discards whatever is already on
  // screen — it parks the in-progress bill first.
  const resumeStart = appSource.indexOf('async function resumeHeldBill');
  const resumeBody = appSource.slice(resumeStart, appSource.indexOf('\n}', resumeStart));
  assert.match(resumeBody, /if \(!currentBillIsEmpty\(\)\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*await db\.holdBill\(snapshotCurrentBill\(\)\);/);
  // holdCurrentBill/resumeHeldBill only ever call db.holdBill/deleteHeldBill —
  // never db.saveInvoice, so a held bill can never become an invoice by
  // itself; it only becomes one when the shopkeeper actually completes it
  // through the normal checkout flow after resuming.
  const holdStart = appSource.indexOf('async function holdCurrentBill');
  const holdBody = appSource.slice(holdStart, appSource.indexOf('\n}', holdStart));
  assert.doesNotMatch(holdBody, /saveInvoice/);
  assert.doesNotMatch(resumeBody, /saveInvoice/);
});

test('mobile layout has one scrolling region per primary task and fixed sale actions', () => {
  assert.match(css, /\.sale-screen\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.product-grid-scroll\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.sale-cart-bar\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.checkout-footer\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.doesNotMatch(css, /\.checkout-list\s*\{[^}]*max-height/s);
});

test('touch targets, 360px protection and safe areas are present', () => {
  assert.match(css, /min-height:\s*48px/);
  assert.match(css, /grid-template-columns:\s*44px minmax\(38px, auto\) 44px/);
  assert.match(css, /@media \(max-width:\s*359px\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('receipt uses exact Item, Qty, Price, Total order and omits Received', () => {
  const receiptStart = appSource.indexOf('function buildReceiptHTML');
  const receiptEnd = appSource.indexOf('async function requestPrint');
  const receipt = appSource.slice(receiptStart, receiptEnd);
  assert.match(receipt, /<th>Item<\/th><th>Qty<\/th><th>Price<\/th><th>Total<\/th>/);
  assert.doesNotMatch(receipt, /Received/i);
  assert.doesNotMatch(receipt, />Rate</i);
  assert.match(receipt, /@media print and \(max-width:58mm\)/);
});

test('expired licenses lock only new selling paths', () => {
  assert.match(appSource, /if \(licenseState\.expired\)/);
  assert.match(appSource, /licenseState\.expired \? 'disabled aria-disabled="true"'/);
  assert.match(appSource, /openManualItemBtn'\)\.disabled = licenseState\.expired/);
  assert.match(appSource, /showMainScreen\('reports'\)/);
  assert.match(html, /data-settings-panel="backup"/);
  assert.match(html, /id="exportReportBtn"/);
});

test('offline UI has no remote fonts, gradients or internet assets', () => {
  assert.doesNotMatch(html + css + appSource, /https?:\/\//i);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/i);
  assert.match(html, /<script src="core\.js"><\/script>/);
  assert.match(html, /<script src="vendor\/nacl-fast\.min\.js"><\/script>/);
});

test('brand typefaces (Inter, JetBrains Mono) are bundled locally and used as the primary/data fonts', () => {
  // Every @font-face src must be a local relative path, never a remote host —
  // Google Fonts or any other CDN would break the offline guarantee above.
  const fontFaceBlocks = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  assert.ok(fontFaceBlocks.length >= 7, 'expected @font-face rules for Inter (4 weights) and JetBrains Mono (3 weights)');
  for (const block of fontFaceBlocks) {
    assert.match(block, /src: url\('fonts\/(inter|jetbrains-mono|noto-nastaliq-urdu|noto-naskh-arabic)\/[a-z0-9-]+\.woff2'\) format\('woff2'\);/);
  }
  // The actual font files referenced above must exist on disk (this is what
  // actually ships offline-capable typography, not just a CSS promise).
  const referencedFiles = [...css.matchAll(/url\('(fonts\/[a-z0-9\/-]+\.woff2)'\)/g)].map(m => m[1]);
  assert.ok(referencedFiles.length >= 7);
  for (const relPath of referencedFiles) {
    const fullPath = path.join(root, 'www', relPath);
    assert.ok(fs.existsSync(fullPath), `missing bundled font file: ${relPath}`);
    assert.ok(fs.statSync(fullPath).size > 1000, `bundled font file looks empty: ${relPath}`);
  }
  // Inter is the primary UI typeface (brand kit), JetBrains Mono the
  // data/code typeface, both ahead of their system-font fallbacks.
  assert.match(css, /html, body \{[^}]*font-family: 'Inter', Roboto/);
  assert.match(css, /\.mono \{ font-family: 'JetBrains Mono', 'Courier New', monospace/);
  // No leftover bare "Roboto"/"Courier New" font declaration (font-family
  // shorthand or the `font:` shorthand) that skipped the Inter/JetBrains
  // Mono upgrade above.
  const fontDeclarations = css.match(/\bfont(-family)?:\s*[^;]+;/g) || [];
  for (const decl of fontDeclarations) {
    if (/Roboto/.test(decl)) {
      assert.match(decl, /'Inter',\s*Roboto/, `Roboto declaration missing Inter lead: ${decl}`);
    }
    if (/Courier New/.test(decl)) {
      assert.match(decl, /'JetBrains Mono',\s*'Courier New'/, `Courier New declaration missing JetBrains Mono lead: ${decl}`);
    }
  }
});

test('Urdu is rendered with a bundled offline Nastaliq/Naskh font, never just system Tahoma/Arial', () => {
  const urduRule = css.match(/html\[lang='ur'\] body \{[^}]*\}/);
  assert.ok(urduRule, 'expected an html[lang="ur"] body font rule');
  const urduBody = urduRule[0];
  // Bundled fonts must lead the stack; system names stay only as a
  // last-resort fallback after them, never the first/only option.
  assert.match(urduBody, /font-family: 'Noto Nastaliq Urdu', 'Noto Naskh Arabic', 'Noto Sans Arabic', Tahoma, Arial, sans-serif;/);
  // Both bundled Urdu font families need all 4 weights, same as Inter, and
  // every file referenced must actually exist on disk (not just a CSS promise).
  for (const family of ['noto-nastaliq-urdu', 'noto-naskh-arabic']) {
    for (const weight of [400, 500, 600, 700]) {
      const relPath = `fonts/${family}/${family}-arabic-${weight}-normal.woff2`;
      assert.match(css, new RegExp(`src: url\\('${relPath}'\\) format\\('woff2'\\);`));
      const fullPath = path.join(root, 'www', relPath);
      assert.ok(fs.existsSync(fullPath), `missing bundled Urdu font file: ${relPath}`);
      assert.ok(fs.statSync(fullPath).size > 1000, `bundled Urdu font file looks empty: ${relPath}`);
    }
  }
});

test('Reports tabs and Products/Sections tabs share one consistent visual style, matching the primary-button brand color', () => {
  // The old screen-specific classes must carry NO styling of their own now —
  // they stay pure JS hooks (see setupEvents / loadReportTab / switchProductTab).
  assert.doesNotMatch(css, /\.report-tab\s*\{/);
  assert.doesNotMatch(css, /\.report-tabs\s*\{/);
  assert.doesNotMatch(css, /\.products-subtab\s*\{/);
  assert.doesNotMatch(css, /\.products-subtabs\s*\{/);
  // Both tab bars in the HTML carry the shared class alongside their JS hook.
  assert.match(html, /class="report-tabs tab-pill-bar"/);
  assert.match(html, /class="report-tab tab-pill active"/);
  assert.match(html, /class="products-subtabs tab-pill-bar"/);
  assert.match(html, /class="products-subtab tab-pill active"/);
  // The shared active style matches .btn-primary's emerald fill + obsidian
  // text exactly, instead of the old white-on-emerald / white-pill split.
  assert.match(css, /\.tab-pill\.active \{ background: var\(--emerald\); color: var\(--obsidian\);/);
  assert.match(css, /\.btn-primary \{ background: var\(--emerald\); color: var\(--obsidian\);/);
});

test('Help & About shows real contact branding — phone, email and FBR registration — as tappable call/email rows', () => {
  const aboutStart = html.indexOf('data-panel="about"');
  const aboutEnd = html.indexOf('</div>\n      <div class="settings-panel hidden" data-panel="', aboutStart);
  const aboutBody = html.slice(aboutStart, aboutEnd === -1 ? aboutStart + 2000 : aboutEnd);
  assert.match(aboutBody, /FBR/);
  assert.match(aboutBody, /href="tel:\+923124927023"/);
  assert.match(aboutBody, /0312-4927023/);
  assert.match(aboutBody, /href="mailto:adeelitsolution@gmail\.com"/);
  assert.match(aboutBody, />adeelitsolution@gmail\.com</);
  // Real <a> links (not buttons) must not render as underlined browser-blue
  // text — they share .settings-row, which now resets text-decoration.
  assert.match(css, /\.settings-row \{[^}]*text-decoration: none;/);
});

test('brand colors are unchanged by the design-system polish pass', () => {
  assert.match(css, /--obsidian: #0B0D0C;/);
  assert.match(css, /--emerald: #0F9F6E;/);
  assert.match(css, /--canvas: #F6F7F4;/);
  assert.match(css, /--paper: #FFFFFF;/);
  assert.match(css, /--danger: #DC2626;/);
});

test('tab switches, button taps and task-screen opens have tasteful CSS-only motion (no JS animation library)', () => {
  assert.match(css, /\.tab-pill \{[^}]*transition: background 0\.15s ease, color 0\.15s ease;/);
  assert.match(css, /\.btn \{[^}]*transition: transform 0\.1s ease, opacity 0\.15s ease;/);
  assert.match(css, /\.btn:active:not\(:disabled\) \{ transform: scale\(0\.97\); \}/);
  assert.match(css, /\.task-screen \{[^}]*animation: taskScreenIn 0\.22s ease-out;/);
  assert.match(css, /@keyframes taskScreenIn/);
  // prefers-reduced-motion must still neutralize every animation/transition,
  // including the ones just added, for accessibility.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/);
});

test('CSV import is previewed and backed up before mutation', () => {
  assert.match(html, /id="csvImportSummary"/);
  assert.match(appSource, /createBackup\('before_csv_import'\)/);
  assert.match(appSource, /enableSectionsAfterImport/);
});

test('printed receipt logo is slightly bigger and still fits both 58mm and 80mm paper widths', () => {
  const sizeMatch = receiptImageSource.match(/const LOGO_SIZE = (\d+);/);
  assert.ok(sizeMatch, 'LOGO_SIZE constant not found in receipt-image.js');
  const logoSize = Number(sizeMatch[1]);
  assert.ok(logoSize > 170, 'printed logo should be bigger than the original 170-dot size');
  const paperWidthMatch = receiptImageSource.match(/const PAPER_DOTS = \{ ?58: (\d+), ?80: (\d+) ?\};/);
  assert.ok(paperWidthMatch, 'PAPER_DOTS constant not found in receipt-image.js');
  const narrowestPaperDots = Number(paperWidthMatch[1]);
  // The logo box is centered on the full paper width (see drawImage call
  // below), so it just needs to stay comfortably under the narrowest
  // supported paper (58mm) with real margin either side, not touch the edge.
  assert.ok(logoSize < narrowestPaperDots * 0.7, 'printed logo is too large for 58mm paper');
});

test('printer failure cannot be presented as an invoice save failure', () => {
  const completionStart = appSource.indexOf('async function completeSale');
  const completionEnd = appSource.indexOf('async function loadReportTab');
  const completion = appSource.slice(completionStart, completionEnd);
  assert.ok(completion.indexOf('invoice = await db.saveInvoice') < completion.indexOf('cart = []'));
  assert.ok(completion.indexOf('cart = []') < completion.indexOf('await printInvoice(invoice)'));
  assert.match(completion, /invoice is now permanently saved/i);
  assert.match(completion, /retry printing from Reports/);
});

test('product and section counts use correct English singular grammar', () => {
  assert.match(appSource, /count === 1 \? 'product' : 'products'/);
  assert.match(appSource, /productCountLabel\(count\)/);
});

test('the on-screen keyboard resizes the WebView instead of covering the whole screen', () => {
  // Without android:windowSoftInputMode="adjustResize" on the activity, the
  // Android default does not shrink the WebView's viewport when the
  // keyboard opens, so the app's 100dvh flex layouts never recalculate and
  // the keyboard can cover the whole screen, including the field the
  // shopkeeper is typing into (reported worst on the Stock search box).
  assert.match(androidManifestSource, /<activity[\s\S]*?android:windowSoftInputMode="adjustResize"[\s\S]*?>/);
});

test('printer transport/paper-width toggle buttons cannot accidentally switch the app language', () => {
  // Regression: these buttons used to share the .lang-btn class with the
  // real Urdu/English switch. setupLanguageSwitches() binds a click
  // listener to every .lang-btn (app.js), and clicking a button with no
  // data-lang attribute called applyLanguage(undefined), which always
  // resolved to Urdu — so tapping Bluetooth/USB/58mm/80mm silently reset
  // the whole app's language. Only real language buttons may carry
  // .lang-btn; everything else must use .pill-toggle only.
  for (const id of ['printerTransportBtBtn', 'printerTransportUsbBtn', 'printer58Btn', 'printer80Btn']) {
    const buttonHtml = html.match(new RegExp(`<button id="${id}"[^>]*>`))[0];
    assert.doesNotMatch(buttonHtml, /\blang-btn\b/, `${id} must not carry the lang-btn class`);
    assert.match(buttonHtml, /\bpill-toggle\b/, `${id} should still get the shared toggle visual style`);
    assert.doesNotMatch(buttonHtml, /data-lang=/, `${id} must not have a data-lang attribute`);
  }
  // The real language switches must still exist and still carry both classes.
  const realLangButtons = html.match(/<button class="[^"]*lang-btn[^"]*" data-lang="(ur|en)">/g) || [];
  assert.ok(realLangButtons.length >= 8, 'expected the language switch to appear on every auth screen + settings');
  for (const tag of realLangButtons) {
    assert.match(tag, /\bpill-toggle\b/);
  }
});

test('hardware back button returns to Billing, then requires a second press to exit', () => {
  // The App plugin listener is wired and routed to a single handler.
  assert.match(appSource, /Capacitor\.Plugins\.App\.addListener\('backButton', handleHardwareBack\)/);
  // Any open task-screen/overlay closes first, one layer at a time.
  const handlerStart = appSource.indexOf('function handleHardwareBack');
  assert.ok(handlerStart !== -1, 'handleHardwareBack function not found');
  const handlerBody = appSource.slice(handlerStart, appSource.indexOf('\n}', handlerStart));
  assert.match(handlerBody, /if \(taskStack\.length\) \{\s*\n\s*history\.back\(\);/);
  // From any non-billing screen, back navigates to billing.
  assert.match(handlerBody, /if \(currentScreen !== 'billing'\) \{\s*\n\s*showMainScreen\('billing'\);/);
  // From billing itself (nothing else to close), it arms the exit prompt rather than exiting immediately.
  assert.match(handlerBody, /armExitOnNextBack\(\);\s*$/);
  // The exit prompt requires a second press within a short window before calling exitApp.
  const armStart = appSource.indexOf('function armExitOnNextBack');
  const armBody = appSource.slice(armStart, appSource.indexOf('\n}', armStart));
  assert.match(armBody, /now - lastExitPromptAt < 2000/);
  assert.match(armBody, /Capacitor\.Plugins\.App\.exitApp\(\)/);
  // @capacitor/app must actually be declared as a dependency, or none of this works on-device.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['@capacitor/app'], '@capacitor/app is missing from package.json dependencies');
});

test('Stock is its own top-level nav screen, separate from Products (Products/Sections only)', () => {
  // Bottom nav has exactly 5 screens now, Stock included, in a 5-column grid.
  assert.match(css, /\.bottomnav\s*\{[^}]*grid-template-columns:\s*repeat\(5, 1fr\)/s);
  assert.match(html, /<nav class="bottomnav"[\s\S]*data-screen="billing"[\s\S]*data-screen="reports"[\s\S]*data-screen="products"[\s\S]*data-screen="stock"[\s\S]*data-screen="more"[\s\S]*<\/nav>/);
  // Stock has its own top-level screen, outside of #productsScreen.
  assert.match(html, /<section id="stockScreen" class="content-screen stock-screen hidden">/);
  const productsScreenStart = html.indexOf('id="productsScreen"');
  const productsScreenEnd = html.indexOf('</section>', productsScreenStart);
  const productsScreenHtml = html.slice(productsScreenStart, productsScreenEnd);
  assert.doesNotMatch(productsScreenHtml, /id="stockPane"/);
  assert.doesNotMatch(productsScreenHtml, /data-product-tab="stock"/);
  // Products screen keeps exactly the Products/Sections switch (2 tabs).
  const subtabCount = (productsScreenHtml.match(/class="products-subtab["\s]/g) || []).length;
  assert.strictEqual(subtabCount, 2);
  // The low-stock nav badge now lives on the Stock nav button, not Products.
  assert.match(html, /data-screen="stock"[^>]*>[\s\S]*?id="stockAlertBadge"/);
  const productsNavStart = html.indexOf('data-screen="products"');
  const productsNavEnd = html.indexOf('</button>', productsNavStart);
  assert.doesNotMatch(html.slice(productsNavStart, productsNavEnd), /stockAlertBadge/);
  // showMainScreen renders stock content when the stock screen opens.
  assert.match(appSource, /if \(screen === 'stock'\) renderStockManagement\(\);/);
  // switchProductTab no longer knows about a stock tab at all.
  const switchTabStart = appSource.indexOf('function switchProductTab');
  const switchTabBody = appSource.slice(switchTabStart, appSource.indexOf('\n}', switchTabStart));
  assert.doesNotMatch(switchTabBody, /stock/);
});

test('creating your first section automatically turns sections on (no silent hidden switch)', () => {
  const saveSectionStart = appSource.indexOf('async function saveSection');
  const saveSectionEnd = appSource.indexOf('\nasync function deleteSection', saveSectionStart);
  const saveSectionBody = appSource.slice(saveSectionStart, saveSectionEnd);
  assert.match(saveSectionBody, /const isNewSection = !editingSectionId;/);
  assert.match(saveSectionBody, /if \(isNewSection && !sectionsEnabled\) \{/);
  assert.match(saveSectionBody, /sectionsEnabled = true;/);
  assert.match(saveSectionBody, /await db\.setSetting\('sectionsEnabled', 'true'\);/);
  // Editing an existing section must never flip the switch back on/off as
  // a side effect — only creating a brand-new one does.
  assert.doesNotMatch(saveSectionBody.split('if (isNewSection')[0], /sectionsEnabled = /);
});

test('stock tracking is off by default for shops that never used it, and never nags with out-of-stock alerts anywhere', () => {
  // The per-product state function must be gated by the shop-level switch,
  // not just each product's own trackStock flag — otherwise a shop that
  // never turned tracking on still sees every 0-quantity product flagged
  // "out of stock" (the reported permanent Stock nav badge).
  const stateStart = appSource.indexOf('function stockStateOf');
  const stateBody = appSource.slice(stateStart, appSource.indexOf('\n}', stateStart));
  assert.match(stateBody, /if \(!stockTrackingEnabled\) return 'untracked';/);
  // Migration: an existing shop that already entered real stock numbers
  // must not have tracking silently turned off under them; a shop that
  // never touched stock must not have it silently turned on.
  const migrateStart = appSource.indexOf('async function loadStockTrackingSetting');
  const migrateBody = appSource.slice(migrateStart, appSource.indexOf('\n}', migrateStart));
  assert.match(migrateBody, /getSetting\('stockTrackingEnabled', null\)/);
  assert.match(migrateBody, /\(Number\(product\.stock\) \|\| 0\) > 0/);
  assert.match(migrateBody, /\(Number\(product\.lowStockAt\) \|\| 0\) > 0/);
  assert.match(migrateBody, /product\.trackStock === false/);
  // The toggle exists on the Stock screen, defaults reflected, and wired.
  assert.match(html, /id="stockTrackingEnabledToggle" type="checkbox" role="switch"/);
  assert.match(appSource, /byId\('stockTrackingEnabledToggle'\)\.checked = stockTrackingEnabled;/);
  assert.match(appSource, /byId\('stockTrackingEnabledToggle'\)\.addEventListener\('change'/);
  // The setting is included in backup/restore like sectionsEnabled is.
  assert.match(dbSource, /'sectionsEnabled', 'stockTrackingEnabled', 'lastAutoBackupAt'/);
});

test('held bill rows show explicit labeled Resume and Discard buttons, not an implicit tap or icon-only delete', () => {
  const renderStart = appSource.indexOf('async function renderHeldBillsList');
  const renderEnd = appSource.indexOf('\nasync function resumeHeldBill', renderStart);
  const renderBody = appSource.slice(renderStart, renderEnd);
  assert.match(renderBody, /class="btn btn-primary btn-compact held-bill-resume"/);
  assert.match(renderBody, /class="btn btn-secondary btn-compact held-bill-discard"/);
  assert.match(renderBody, /Resume/);
  assert.match(renderBody, /Discard/);
  // The old implicit "tap anywhere on the row" resume button and the
  // unlabeled trash-icon delete button must both be gone.
  assert.doesNotMatch(renderBody, /class="held-bill-delete"/);
  assert.doesNotMatch(css, /\.held-bill-delete\b/);
});

test('Hold/New/Held bills action row has real spacing from the Custom item row above it', () => {
  assert.match(css, /\.bill-actions-row \{ margin-top: 12px; \}/);
});

test('section chips form a horizontally swipeable strip showing every section, with no "More" button', () => {
  assert.match(css, /\.section-chip-bar \{[\s\S]*?overflow-x: auto;[\s\S]*?\}/);
  assert.match(css, /\.section-chip \{[\s\S]*?flex: 0 0 auto;/);
  const optionsStart = appSource.indexOf('function sectionOptionsForBar');
  const optionsBody = appSource.slice(optionsStart, appSource.indexOf('\n}', optionsStart));
  assert.match(optionsBody, /activeSections\(\)/);
  const barStart = appSource.indexOf('function renderSectionBar');
  const barBody = appSource.slice(barStart, appSource.indexOf('\n}', barStart));
  assert.doesNotMatch(barBody, /'more'/);
  assert.doesNotMatch(barBody, /openSectionPicker/);
  // The now-unreachable full-screen section picker must be fully removed,
  // not left behind as dead/unreachable code.
  assert.doesNotMatch(appSource, /function openSectionPicker/);
  assert.doesNotMatch(appSource, /sectionPickerContext/);
  assert.doesNotMatch(html, /id="sectionPickerTask"/);
  assert.doesNotMatch(html, /id="allSectionChoices"/);
});

test('Stock screen has no CSV of its own — its intro points to the merged CSV on Products, and only History remains', () => {
  const stockPaneStart = html.indexOf('id="stockPane"');
  const stockPaneEnd = html.indexOf('id="stockManageList"', stockPaneStart);
  const stockPaneBody = html.slice(stockPaneStart, stockPaneEnd);
  assert.match(stockPaneBody, /class="pane-intro"/);
  // The intro must send shopkeepers to the Products screen for CSV, not
  // describe stock-only Export/Import buttons that no longer exist here.
  assert.match(stockPaneBody, /Products screen/);
  assert.match(stockPaneBody, /History/);
  assert.doesNotMatch(stockPaneBody, /id="exportStockCsvBtn"/);
  assert.doesNotMatch(stockPaneBody, /id="importStockCsvBtn"/);
  assert.doesNotMatch(stockPaneBody, /id="stockCsvFileInput"/);
  assert.match(stockPaneBody, /id="stockHistoryBtn"/);
});

test('one merged CSV Export/Import lives only on the Products screen and covers name, price, section, stock and cost together', () => {
  const productsPaneStart = html.indexOf('id="productsPane"');
  const productsPaneEnd = html.indexOf('id="productManageList"', productsPaneStart);
  const productsPaneBody = html.slice(productsPaneStart, productsPaneEnd);
  assert.match(productsPaneBody, /id="exportProductsCsvBtn"/);
  assert.match(productsPaneBody, /id="importProductsBtn"/);

  // The old stock-only CSV export/import/parse path must be fully gone —
  // there is exactly one CSV entry point in the whole app now.
  assert.doesNotMatch(html, /id="stockCsvImportTask"/);
  assert.doesNotMatch(html, /id="exportStockCsvBtn"/);
  assert.doesNotMatch(html, /id="importStockCsvBtn"/);
  assert.doesNotMatch(appSource, /function exportStockCsv/);
  assert.doesNotMatch(appSource, /function handleStockCsvFileChosen/);
  assert.doesNotMatch(appSource, /function applyStockCsvImport/);
  assert.doesNotMatch(appSource, /core\.parseStockCsv/);
  assert.doesNotMatch(dbSource, /parseStockCsv/);
  const coreSource = fs.readFileSync(path.join(root, 'www', 'core.js'), 'utf8');
  assert.doesNotMatch(coreSource, /function parseStockCsv/);
  assert.match(coreSource, /function parseProductsCsv/);
});

test('parseProductsCsv reads optional Stock and Cost columns alongside Name/Price/Section', () => {
  const full = core.parseProductsCsv('Name,Price,Section,Stock,Cost\nMilk,320,Grocery,40,250\nWater,120,Drinks,,\n');
  assert.strictEqual(full.hasStockColumn, true);
  assert.strictEqual(full.hasCostColumn, true);
  assert.strictEqual(full.products[0].stock, 40);
  assert.strictEqual(full.products[0].cost, 250);
  // A row that leaves Stock/Cost blank must not invent values for them.
  assert.strictEqual(full.products[1].stock, undefined);
  assert.strictEqual(full.products[1].cost, undefined);

  // Files without those columns must keep working exactly as before.
  const legacy = core.parseProductsCsv('Name,Price\nTea,520\n');
  assert.strictEqual(legacy.hasStockColumn, false);
  assert.strictEqual(legacy.hasCostColumn, false);
  assert.strictEqual(legacy.products[0].stock, undefined);
});

test('importing a Products CSV with Stock/Cost columns updates existing products, creates new ones with stock, and logs stock history', () => {
  const applyStart = appSource.indexOf('async function applyCsvImport');
  const applyEnd = appSource.indexOf('\nasync function shareOrDownloadText', applyStart);
  const applyBody = appSource.slice(applyStart, applyEnd);
  assert.match(applyBody, /imported\.stock !== undefined/);
  assert.match(applyBody, /imported\.cost !== undefined/);
  assert.match(applyBody, /logStockChangesBatch/);
  assert.match(applyBody, /reason: 'csv_import'/);
});

test('the redundant Stock summary card at the top of Settings/More is gone; the Stock screen keeps its own summary', () => {
  assert.doesNotMatch(html, /id="moreStockOverview"/);
  assert.doesNotMatch(html, /stock-summary-link/);
  assert.doesNotMatch(appSource, /renderMoreStockOverview/);
  assert.doesNotMatch(appSource, /byId\('moreStockOverview'\)/);
  assert.doesNotMatch(css, /\.stock-summary-link\b/);
  // The Stock screen's own summary card (inside #stockPane) must still exist.
  assert.match(html, /id="stockSummary" class="stock-summary"/);
});

test('the Settings "Product organization" row is worded as a shortcut, not a separate duplicate screen', () => {
  const rowStart = html.indexOf('id="productOrganizationShortcut"');
  const rowEnd = html.indexOf('</button>', rowStart);
  const rowBody = html.slice(rowStart, rowEnd);
  assert.match(rowBody, /Sections shortcut/);
  assert.match(rowBody, /not a separate screen/);
  const clickStart = appSource.indexOf("byId('productOrganizationShortcut')");
  const clickLine = appSource.slice(clickStart, appSource.indexOf('\n', clickStart));
  assert.match(clickLine, /showMainScreen\('products'\)/);
  assert.match(clickLine, /switchProductTab\('sections'\)/);
});

test('the customer-facing sample CSV template demonstrates the full merged format (Stock/Cost included) and actually parses', () => {
  const sampleCsv = fs.readFileSync(path.join(root, 'samples', 'products-import-template.csv'), 'utf8');
  assert.match(sampleCsv.split('\n')[0], /^Name,Price,Section,Stock,Cost$/);
  const parsed = core.parseProductsCsv(sampleCsv);
  assert.strictEqual(parsed.hasStockColumn, true);
  assert.strictEqual(parsed.hasCostColumn, true);
  assert.ok(parsed.products.length >= 3);
  // A blank Stock/Cost cell in the sample must stay genuinely optional, not
  // silently forced to 0 — this is the exact row the sample uses to show that.
  const soap = parsed.products.find(p => /Soap/.test(p.name));
  assert.ok(soap);
  assert.strictEqual(soap.stock, undefined);
  assert.strictEqual(soap.cost, undefined);
});

test('createBackup mirrors every snapshot to the phone\'s public Documents folder (uninstall-proof), and the mirror never breaks the real backup when no Filesystem plugin exists', async () => {
  // No `filesystem` option here on purpose — this is the most common real
  // case (older Android, or the plugin genuinely unavailable) and every
  // existing backup/restore behaviour must keep working exactly as before.
  const { db } = makeDatabase();
  const snapshot = await db.createBackup('manual');
  assert.strictEqual(snapshot.format, 'adeel-pos-mobile-backup');
  const backups = await db.listExternalBackups();
  assert.strictEqual(backups.length, 0); // gracefully empty, not an error
});

test('with the Filesystem plugin present, the mirror writes a real file into AdeelPOS/backups under Directory.Documents, and it reads back byte-identical', async () => {
  const fakeFs = makeFakeFilesystem();
  const { db } = makeDatabase({ filesystem: fakeFs });
  const snapshot = await db.createBackup('manual');
  await new Promise(resolve => setTimeout(resolve, 0)); // let the fire-and-forget mirror finish
  const paths = [...fakeFs.files.keys()];
  assert.strictEqual(paths.length, 1);
  assert.match(paths[0], /^AdeelPOS\/backups\/backup-.*\.json$/);
  const backups = await db.listExternalBackups();
  assert.strictEqual(backups.length, 1);
  const restored = await db.readExternalBackup(backups[0].path);
  // `snapshot` is built from an object literal inside db.js's vm sandbox
  // (its own V8 realm) while `restored` comes back through JSON.parse; both
  // hold identical data but their Array/Object prototypes differ by realm,
  // which trips assert.deepStrictEqual's prototype check on otherwise-equal
  // values. Round-tripping both through this test file's own JSON strips
  // that mismatch and compares the data itself.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(snapshot)));
});

test('the mirror is throttled so a sale-by-sale backup does not write a file every single time, but a manual export always forces a fresh one', async () => {
  const fakeFs = makeFakeFilesystem();
  const { db } = makeDatabase({ filesystem: fakeFs });
  await db.createBackup('sale');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(fakeFs.files.size, 1, 'the very first backup ever should always mirror once');
  await db.createBackup('sale');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(fakeFs.files.size, 1, 'a second sale moments later must not write another file yet (throttled)');
  await db.createBackup('manual');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(fakeFs.files.size, 2, 'an explicit manual export must always force a fresh mirror regardless of the throttle');
});

test('external backups rotate — only the newest 10 are kept on the phone', async () => {
  const fakeFs = makeFakeFilesystem();
  const { db } = makeDatabase({ filesystem: fakeFs });
  for (let i = 0; i < 12; i += 1) {
    await db.createBackup('manual'); // manual always bypasses the throttle
    await new Promise(resolve => setTimeout(resolve, 2)); // distinct millisecond timestamps
  }
  const backups = await db.listExternalBackups();
  assert.strictEqual(backups.length, 10, 'rotation must cap the phone copy at 10 kept backups');
});

test('a denied public-storage permission (Android 10 and older) never breaks or throws from the real backup', async () => {
  const fakeFs = makeFakeFilesystem({ permissionState: 'denied' });
  const { db } = makeDatabase({ filesystem: fakeFs });
  const snapshot = await db.createBackup('manual');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(snapshot.format, 'adeel-pos-mobile-backup');
  assert.strictEqual(fakeFs.files.size, 0, 'no file should be written once permission is denied');
  assert.strictEqual((await db.listExternalBackups()).length, 0);
});

test('storage permission for the external backup mirror is declared only for Android 10 and older, and the Filesystem plugin is installed', () => {
  assert.match(androidManifestSource, /<uses-permission android:name="android\.permission\.READ_EXTERNAL_STORAGE" android:maxSdkVersion="29" \/>/);
  assert.match(androidManifestSource, /<uses-permission android:name="android\.permission\.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" \/>/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(packageJson.dependencies['@capacitor/filesystem'], 'expected @capacitor/filesystem as a dependency');
});

test('the Backup & Recovery panel lists automatic phone backups and lets you restore any one directly, not just from a picked file', () => {
  const backupPanelStart = html.indexOf('data-panel="backup"');
  const backupPanelEnd = html.indexOf('data-panel="license"', backupPanelStart);
  const backupPanelBody = html.slice(backupPanelStart, backupPanelEnd);
  assert.match(backupPanelBody, /id="externalBackupsList"/);
  assert.match(backupPanelBody, /Restore from file/);
  assert.match(appSource, /function renderExternalBackupsList/);
  assert.match(appSource, /function restoreExternalBackupByPath/);
  assert.match(appSource, /data-restore-external/);
  assert.match(appSource, /byId\('externalBackupsList'\)\.addEventListener\('click'/);
  assert.match(appSource, /panel === 'backup'.*renderExternalBackupsList/);
});

(async () => {
  let passed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      console.error(`FAIL ${entry.name}`);
      console.error(error.stack || error.message);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log(`\n${passed} mobile UX checks passed.`);
})();
