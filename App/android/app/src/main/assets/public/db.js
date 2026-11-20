// Offline repository for Adeel POS. Existing Capacitor Preferences keys remain compatible.
(function () {
  const { Preferences } = Capacitor.Plugins;
  const SETTINGS_KEYS = [
    'licenseKey', 'password', 'shopName', 'shopPhone', 'language',
    'sectionsEnabled', 'stockTrackingEnabled', 'lastAutoBackupAt', 'lastExternalBackupAt',
    'printerTransport', 'printerAddress', 'printerName', 'printerPaperWidth', 'printerAutoPrint',
    'shopAddress', 'shopLogo'
  ];
  let invoiceSaveQueue = Promise.resolve();

  function safeParse(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }

  function getPreferences() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  }

  async function readJson(key, fallback) {
    try {
      const Prefs = getPreferences();
      if (Prefs && typeof Prefs.get === 'function') {
        const { value } = await Prefs.get({ key });
        return safeParse(value, fallback);
      }
    } catch (_) {}
    return safeParse(localStorage.getItem(key), fallback);
  }

  async function writeJson(key, value) {
    const jsonStr = JSON.stringify(value);
    try {
      const Prefs = getPreferences();
      if (Prefs && typeof Prefs.set === 'function') {
        await Prefs.set({ key, value: jsonStr });
        return;
      }
    } catch (_) {}
    localStorage.setItem(key, jsonStr);
  }

  async function getSetting(key, fallback = null) {
    try {
      const Prefs = getPreferences();
      if (Prefs && typeof Prefs.get === 'function') {
        const { value } = await Prefs.get({ key: 'setting_' + key });
        return value !== null && value !== undefined ? value : fallback;
      }
    } catch (_) {}
    const val = localStorage.getItem('setting_' + key);
    return val !== null ? val : fallback;
  }

  async function setSetting(key, value) {
    const strVal = String(value);
    try {
      const Prefs = getPreferences();
      if (Prefs && typeof Prefs.set === 'function') {
        await Prefs.set({ key: 'setting_' + key, value: strVal });
        return;
      }
    } catch (_) {}
    localStorage.setItem('setting_' + key, strVal);
  }

  function nextNumericValue(items, field) {
    return items.reduce((highest, item) => Math.max(highest, Number(item && item[field]) || 0), 0) + 1;
  }

  function generateInvoiceNumber(invoices) {
    const highest = invoices.reduce((max, invoice) => {
      const match = String(invoice && invoice.invoiceNumber || '').match(/INV-(\d+)/i);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 0);
    return `INV-${String(highest + 1).padStart(6, '0')}`;
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function makeId(prefix, seed) {
    const random = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `${prefix}_${seed ? hashText(seed) : random}`;
  }

  function normalizeProduct(product, index) {
    const name = String(product && product.name || '').trim().slice(0, 80);
    const price = Number(product && product.price) || 0;
    // stock and cost were added in v3. Products saved before that simply have
    // no such field, so they default to 0 here — nothing is lost or deleted,
    // and an existing shop's product list keeps working exactly as before.
    // cost is the purchase price, used only to calculate profit in reports.
    const stock = Number(product && product.stock);
    const cost = Number(product && product.cost);
    return {
      ...product,
      id: product && product.id ? String(product.id) : makeId('p', `${name}|${price}|${index}`),
      name,
      price,
      stock: Number.isFinite(stock) ? Math.trunc(stock) : 0,
      cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
      lowStockAt: Math.max(0, Math.trunc(Number(product && product.lowStockAt) || 0)),
      trackStock: product && typeof product.trackStock === 'boolean' ? product.trackStock : true,
      sectionId: product && product.sectionId ? String(product.sectionId) : '',
      isQuick: product && typeof product.isQuick === 'boolean' ? product.isQuick : true,
      active: product && typeof product.active === 'boolean' ? product.active : true
    };
  }

  async function getProducts() {
    const raw = await readJson('quickItems', []);
    const source = Array.isArray(raw) ? raw : [];
    const products = source.map(normalizeProduct).filter(product => product.name && product.price > 0).slice(0, 500);
    const migrated = JSON.stringify(source) !== JSON.stringify(products);
    if (migrated) await writeJson('quickItems', products);
    return products;
  }

  async function setProducts(products) {
    const normalized = (Array.isArray(products) ? products : [])
      .map(normalizeProduct)
      .filter(product => product.name && product.price > 0)
      .slice(0, 500);
    await writeJson('quickItems', normalized);
  }

  async function getSections() {
    const raw = await readJson('productSections', []);
    if (!Array.isArray(raw)) return [];
    return raw.map((section, index) => ({
      id: section.id ? String(section.id) : makeId('s', `${section.name}|${index}`),
      name: String(section.name || '').trim().slice(0, 40),
      order: Number.isFinite(Number(section.order)) ? Number(section.order) : index,
      active: section.active !== false
    })).filter(section => section.name).sort((a, b) => a.order - b.order);
  }

  async function setSections(sections) {
    const normalized = (Array.isArray(sections) ? sections : []).map((section, index) => ({
      id: section.id ? String(section.id) : makeId('s', `${section.name}|${Date.now()}|${index}`),
      name: String(section.name || '').trim().slice(0, 40),
      order: index,
      active: section.active !== false
    })).filter(section => section.name).slice(0, 50);
    await writeJson('productSections', normalized);
  }

  async function saveInvoiceNow({ customerName, items, subtotal, discount, total, paymentMethod, tendered, change }) {
    const invoices = await readInvoices();
    // Cost is captured from the product list AT THE MOMENT OF SALE and stored
    // on the invoice item itself. This is deliberate: if the shopkeeper edits a
    // product's purchase price later, past invoices keep the cost that actually
    // applied that day, so historical profit never silently changes.
    const products = await getProducts();
    const costById = new Map(products.map(product => [product.id, product.cost]));

    const normalizedItems = (Array.isArray(items) ? items : []).map(item => {
      const productId = item.productId || '';
      const knownCost = costById.has(productId) ? Number(costById.get(productId)) : 0;
      return {
        productId,
        name: String(item.name || '').trim().slice(0, 80),
        price: Number(item.price) || 0,
        cost: Number.isFinite(knownCost) && knownCost > 0 ? knownCost : 0,
        quantity: Math.max(1, Math.trunc(Number(item.quantity) || 1))
      };
    });

    const totalValue = Number(total) || 0;
    const tenderedValue = Number(tendered);
    const hasTendered = Number.isFinite(tenderedValue) && tenderedValue > 0;

    const invoice = {
      id: nextNumericValue(invoices, 'id'),
      invoiceNumber: generateInvoiceNumber(invoices),
      customer_name: String(customerName || '').trim().slice(0, 80),
      items: normalizedItems,
      subtotal: Number(subtotal) || 0,
      discount: Number(discount) || 0,
      total: totalValue,
      tendered: hasTendered ? tenderedValue : 0,
      change: hasTendered
        ? Math.max(0, (Number.isFinite(Number(change)) ? Number(change) : tenderedValue - totalValue))
        : 0,
      payment_method: paymentMethod || 'Cash',
      print_status: 'pending',
      voided: false,
      created_at: new Date().toISOString()
    };
    invoices.push(invoice);
    await writeInvoices(invoices);
    // Stock is reduced only after the invoice is safely written, so a failure
    // here can never lose a sale — the sale is the source of truth.
    try { await applyStockChange(normalizedItems, -1); } catch (_) { /* stock is advisory, never blocks a sale */ }
    await createBackup('sale');
    return invoice;
  }

  // Adjusts stock for a list of invoice items. direction -1 on sale,
  // +1 when a sale is voided so the goods come back into stock.
  const STOCK_HISTORY_LIMIT = 200;

  async function logStockChange(name, delta, reason) {
    if (!delta) return; // nothing actually changed, nothing to log
    await logStockChangesBatch([{ name, delta, reason }]);
  }

  // Writes multiple history entries in a single read-modify-write. Logging
  // each entry of a large CSV import independently (many concurrent
  // read-then-write calls) would race and silently drop entries — batching
  // makes it exactly one storage operation regardless of how many rows.
  async function logStockChangesBatch(entries) {
    const valid = entries.filter(entry => entry && entry.delta);
    if (!valid.length) return;
    try {
      const history = await readJson('stockHistory', []);
      const list = Array.isArray(history) ? history : [];
      const now = new Date().toISOString();
      valid.forEach(entry => list.push({ name: String(entry.name || '').slice(0, 80), delta: entry.delta, reason: entry.reason, at: now }));
      await writeJson('stockHistory', list.slice(-STOCK_HISTORY_LIMIT));
    } catch (_) { /* History is a convenience log — never block the real stock change over it. */ }
  }

  async function getStockHistory() {
    const history = await readJson('stockHistory', []);
    return (Array.isArray(history) ? history : []).slice().reverse(); // newest first
  }

  async function applyStockChange(items, direction, reason = 'sale') {
    if (!Array.isArray(items) || !items.length) return;
    const products = await readJson('quickItems', []);
    if (!Array.isArray(products) || !products.length) return;
    const byId = new Map(products.map(product => [String(product.id), product]));
    let touched = false;
    const historyEntries = [];
    for (const item of items) {
      const product = byId.get(String(item.productId || ''));
      if (!product) continue;
      if (product.trackStock === false) continue;
      const current = Number(product.stock);
      const base = Number.isFinite(current) ? current : 0;
      const delta = direction * (Number(item.quantity) || 0);
      product.stock = base + delta;
      touched = true;
      historyEntries.push({ name: product.name, delta, reason });
    }
    if (touched) await writeJson('quickItems', products);
    await logStockChangesBatch(historyEntries);
  }

  // Manual stock adjustment from the Stock screen (restock, correction, waste).
  async function adjustStock(productId, delta) {
    const products = await readJson('quickItems', []);
    if (!Array.isArray(products)) return null;
    const product = products.find(entry => String(entry.id) === String(productId));
    if (!product) return null;
    const current = Number(product.stock);
    product.stock = (Number.isFinite(current) ? current : 0) + (Number(delta) || 0);
    await writeJson('quickItems', products);
    return product.stock;
  }

  // Sets stock to an exact number (used when the shopkeeper counts shelf stock).
  async function setStock(productId, value) {
    const products = await readJson('quickItems', []);
    if (!Array.isArray(products)) return null;
    const product = products.find(entry => String(entry.id) === String(productId));
    if (!product) return null;
    product.stock = Math.trunc(Number(value) || 0);
    await writeJson('quickItems', products);
    return product.stock;
  }

  function saveInvoice(input) {
    const task = invoiceSaveQueue.then(() => saveInvoiceNow(input));
    invoiceSaveQueue = task.catch(() => undefined);
    return task;
  }

  async function updateInvoice(id, updates) {
    const invoices = await readInvoices();
    const index = invoices.findIndex(invoice => String(invoice.id) === String(id));
    if (index === -1) return null;
    invoices[index] = { ...invoices[index], ...updates };
    await writeInvoices(invoices);
    return invoices[index];
  }

  async function getInvoice(id) {
    const invoices = await readInvoices();
    return invoices.find(invoice => String(invoice.id) === String(id)) || null;
  }

  function localDateStart(dateString) {
    const [year, month, day] = dateString.split('-').map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  async function getInvoicesInRange(startDate, endDate) {
    const invoices = await readInvoices();
    const start = localDateStart(startDate);
    const endExclusive = localDateStart(endDate);
    endExclusive.setDate(endExclusive.getDate() + 1);
    return invoices.filter(invoice => {
      const date = new Date(invoice.created_at);
      return Number.isFinite(date.getTime()) && date >= start && date < endExclusive;
    }).reverse();
  }

  function summarize(invoices) {
    const active = invoices.filter(invoice => !invoice.voided);

    // Profit = (selling price - purchase cost) x quantity, minus any discount
    // given on the invoice. Only items that actually carry a stored cost can
    // be counted. Invoices created before cost tracking existed, and items
    // whose product had no purchase price entered, are reported separately as
    // "unknown" rather than being silently treated as 100% profit — showing a
    // confidently wrong profit number would be worse than showing none.
    let grossProfit = 0;
    let itemsWithCost = 0;
    let itemsWithoutCost = 0;
    let invoicesWithoutAnyCost = 0;

    for (const invoice of active) {
      const items = invoice.items || [];
      let invoiceHasCost = false;
      for (const item of items) {
        const cost = Number(item.cost) || 0;
        const quantity = Number(item.quantity) || 0;
        if (cost > 0) {
          grossProfit += ((Number(item.price) || 0) - cost) * quantity;
          itemsWithCost += quantity;
          invoiceHasCost = true;
        } else {
          itemsWithoutCost += quantity;
        }
      }
      if (invoiceHasCost) grossProfit -= Number(invoice.discount) || 0;
      else if (items.length) invoicesWithoutAnyCost += 1;
    }

    return {
      totalRevenue: active.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0),
      totalDiscount: active.reduce((sum, invoice) => sum + (Number(invoice.discount) || 0), 0),
      totalInvoices: active.length,
      totalItems: active.reduce((sum, invoice) => sum + (invoice.items || []).reduce((itemSum, item) => itemSum + (Number(item.quantity) || 0), 0), 0),
      grossProfit,
      itemsWithCost,
      itemsWithoutCost,
      invoicesWithoutAnyCost,
      profitIsPartial: itemsWithoutCost > 0,
      failedPrints: active.filter(invoice => invoice.print_status === 'failed').length,
      voidedCount: invoices.length - active.length,
      invoices
    };
  }

  async function getDailySummary() {
    const today = AdeelCore.localDateString();
    return { startDate: today, endDate: today, ...summarize(await getInvoicesInRange(today, today)) };
  }

  async function getMonthlySummary(yearMonth) {
    const [year, month] = yearMonth.split('-').map(Number);
    const start = `${yearMonth}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${yearMonth}-${String(lastDay).padStart(2, '0')}`;
    return { yearMonth, startDate: start, endDate: end, ...summarize(await getInvoicesInRange(start, end)) };
  }

  // Day-by-day sales totals for a date range, for the Reports graph. Every
  // calendar day in [startDate, endDate] gets an entry — including days with
  // zero sales, as 0 — so the graph never silently drops a day. Only active
  // (non-voided) invoices are counted, matching summarize()'s totalRevenue.
  async function getDailyBreakdown(startDate, endDate) {
    const invoices = await getInvoicesInRange(startDate, endDate);
    const totalsByDate = new Map();
    for (const invoice of invoices) {
      if (invoice.voided) continue;
      const date = new Date(invoice.created_at);
      if (!Number.isFinite(date.getTime())) continue;
      const key = AdeelCore.localDateString(date);
      totalsByDate.set(key, (totalsByDate.get(key) || 0) + (Number(invoice.total) || 0));
    }

    const days = [];
    const cursor = localDateStart(startDate);
    const end = localDateStart(endDate);
    while (cursor <= end) {
      const key = AdeelCore.localDateString(cursor);
      days.push({ date: key, total: totalsByDate.get(key) || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  async function setSaleDraft(draft) {
    await writeJson('saleDraft', draft || {});
  }

  async function getSaleDraft() {
    return readJson('saleDraft', {});
  }

  // --- Held bills ------------------------------------------------------
  // A held bill is a fully separate mechanism from saleDraft above: saleDraft
  // recovers one in-progress cart after an unexpected app close, while held
  // bills are an explicit, user-triggered "park this bill and start another"
  // action that can hold many bills at once, each with its own number, and
  // survives normal app restarts (Preferences-backed, not in-memory).
  let heldBillsQueue = Promise.resolve();

  async function readHeldBills() {
    const heldBills = await readJson('heldBills', []);
    return Array.isArray(heldBills) ? heldBills : [];
  }

  async function writeHeldBills(heldBills) {
    await writeJson('heldBills', Array.isArray(heldBills) ? heldBills : []);
  }

  function generateHoldNumber(heldBills) {
    const highest = heldBills.reduce((max, bill) => {
      const match = String(bill && bill.holdNumber || '').match(/H-(\d+)/i);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 0);
    return `H-${String(highest + 1).padStart(4, '0')}`;
  }

  async function getHeldBills() {
    const heldBills = await readHeldBills();
    // Held bills are always appended in the order they were parked (the
    // queue above serializes writes), so array index is a reliable
    // tiebreaker when two bills share the same millisecond-resolution
    // createdAt timestamp (e.g. two quick taps, or concurrent holds).
    // Without this, Array#sort's stability would leave same-timestamp
    // bills in oldest-first order, which looks wrong in a "newest first" list.
    return heldBills
      .map((bill, index) => ({ bill, index }))
      .sort((a, b) => {
        const diff = new Date(b.bill.createdAt) - new Date(a.bill.createdAt);
        return diff !== 0 ? diff : b.index - a.index;
      })
      .map(entry => entry.bill);
  }

  async function getHeldBill(id) {
    const heldBills = await readHeldBills();
    return heldBills.find(bill => String(bill.id) === String(id)) || null;
  }

  async function holdBillNow(snapshot) {
    const heldBills = await readHeldBills();
    const record = {
      id: makeId('hold'),
      holdNumber: generateHoldNumber(heldBills),
      createdAt: new Date().toISOString(),
      note: String(snapshot && snapshot.note || '').trim().slice(0, 60),
      cart: Array.isArray(snapshot && snapshot.cart) ? snapshot.cart.map(item => ({ ...item })) : [],
      customerName: String(snapshot && snapshot.customerName || ''),
      discountAmount: Number(snapshot && snapshot.discountAmount) || 0,
      paymentMethod: String(snapshot && snapshot.paymentMethod || 'Cash'),
      tendered: Number(snapshot && snapshot.tendered) || 0
    };
    heldBills.push(record);
    await writeHeldBills(heldBills);
    return record;
  }

  function holdBill(snapshot) {
    const task = heldBillsQueue.then(() => holdBillNow(snapshot));
    heldBillsQueue = task.catch(() => undefined);
    return task;
  }

  async function deleteHeldBillNow(id) {
    const heldBills = await readHeldBills();
    const next = heldBills.filter(bill => String(bill.id) !== String(id));
    const removed = next.length !== heldBills.length;
    if (removed) await writeHeldBills(next);
    return removed;
  }

  function deleteHeldBill(id) {
    const task = heldBillsQueue.then(() => deleteHeldBillNow(id));
    heldBillsQueue = task.catch(() => undefined);
    return task;
  }

  async function clearSaleDraft() {
    await Preferences.remove({ key: 'saleDraft' });
  }

  async function collectSettings() {
    const settings = {};
    for (const key of SETTINGS_KEYS) settings[key] = await getSetting(key, '');
    return settings;
  }

  async function createBackup(reason = 'manual') {
    const snapshot = {
      format: 'adeel-pos-mobile-backup',
      version: 2,
      createdAt: new Date().toISOString(),
      reason,
      data: {
        invoices: await readInvoices(),
        products: await getProducts(),
        sections: await getSections(),
        settings: await collectSettings()
      }
    };
    await writeJson('autoBackupLatest', snapshot);
    await setSetting('lastAutoBackupAt', snapshot.createdAt);
    // Fire-and-forget: never await this from here. It only touches the
    // filesystem (permission checks, file I/O, folder listing) well after
    // the real backup above already succeeded, so a slow SD card or a
    // denied permission can never add delay to a sale being completed.
    maybeMirrorExternalBackup(snapshot, reason);
    return snapshot;
  }

  // --- External (uninstall-proof) backup mirror -----------------------------
  // Preferences — used for every read/write above — lives inside the app's
  // own data directory, which Android deletes the moment the app is
  // uninstalled. That is exactly how a shopkeeper who reinstalled the app
  // lost everything. Every snapshot above is also mirrored, best-effort,
  // into the phone's public Documents folder (Directory.Documents), which
  // Android does NOT delete on uninstall — it is shared storage, not
  // app-private storage. This mirror can never fail or block the real
  // (Preferences) backup above it: a phone without the Filesystem plugin,
  // one that denies the storage permission, or one that hits a write error
  // still gets the exact same in-app backup/restore behaviour as before.
  const EXTERNAL_BACKUP_DIR = 'AdeelPOS/backups';
  const EXTERNAL_BACKUP_KEEP = 10;
  const EXTERNAL_BACKUP_THROTTLE_MS = 30 * 60 * 1000; // at most once every 30 minutes

  function getFilesystemPlugin() {
    const plugins = (typeof Capacitor !== 'undefined' && Capacitor.Plugins) || {};
    return plugins.Filesystem || null;
  }

  function externalBackupFileName(snapshot) {
    return `backup-${String(snapshot.createdAt).replace(/[:.]/g, '-')}.json`;
  }

  async function ensurePublicStoragePermission(Filesystem) {
    try {
      if (typeof Filesystem.checkPermissions !== 'function') return true;
      const status = await Filesystem.checkPermissions();
      if (!status || status.publicStorage === 'granted') return true;
      if (typeof Filesystem.requestPermissions !== 'function') return true;
      const requested = await Filesystem.requestPermissions();
      return !requested || requested.publicStorage !== 'denied';
    } catch (_) {
      // Android 11+ needs no permission at all for files the app created in
      // Documents — an unsupported/erroring permission call here is normal
      // on those versions, not a real failure, so let writeFile be the judge.
      return true;
    }
  }

  async function pruneExternalBackups(Filesystem) {
    try {
      const { files } = await Filesystem.readdir({ path: EXTERNAL_BACKUP_DIR, directory: 'DOCUMENTS' });
      const names = (files || [])
        .map(entry => (typeof entry === 'string' ? entry : entry.name))
        .filter(name => /^backup-.*\.json$/.test(name))
        .sort(); // ISO-derived timestamps in the filename sort chronologically
      const stale = names.slice(0, Math.max(0, names.length - EXTERNAL_BACKUP_KEEP));
      for (const name of stale) {
        await Filesystem.deleteFile({ path: `${EXTERNAL_BACKUP_DIR}/${name}`, directory: 'DOCUMENTS' }).catch(() => undefined);
      }
    } catch (_) { /* Rotation is housekeeping — never worth failing the backup over. */ }
  }

  async function writeExternalBackup(snapshot) {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) return false;
    try {
      const granted = await ensurePublicStoragePermission(Filesystem);
      if (!granted) return false;
      await Filesystem.writeFile({
        path: `${EXTERNAL_BACKUP_DIR}/${externalBackupFileName(snapshot)}`,
        data: JSON.stringify(snapshot),
        directory: 'DOCUMENTS',
        encoding: 'utf8',
        recursive: true
      });
      await pruneExternalBackups(Filesystem);
      return true;
    } catch (_) {
      // Best-effort mirror only — never surface this as an error to the
      // shopkeeper, and never let it affect the real Preferences backup.
      return false;
    }
  }

  async function maybeMirrorExternalBackup(snapshot, reason) {
    try {
      const lastAt = await getSetting('lastExternalBackupAt', '');
      const elapsed = lastAt ? Date.now() - new Date(lastAt).getTime() : Infinity;
      // A manual "Save/share backup" tap is the shopkeeper actively caring
      // about their backup right now — always refresh the mirror for that,
      // regardless of the throttle that protects busy sale-by-sale calls.
      const due = reason === 'manual' || !Number.isFinite(elapsed) || elapsed >= EXTERNAL_BACKUP_THROTTLE_MS;
      if (!due) return;
      const wrote = await writeExternalBackup(snapshot);
      if (wrote) await setSetting('lastExternalBackupAt', snapshot.createdAt);
    } catch (_) { /* never let the mirror affect the real backup flow */ }
  }

  async function listExternalBackups() {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) return [];
    try {
      const { files } = await Filesystem.readdir({ path: EXTERNAL_BACKUP_DIR, directory: 'DOCUMENTS' });
      return (files || [])
        // Real objects with name/mtime on Filesystem v6+; defensively also
        // accept a bare filename string in case an older plugin build ever
        // returns the legacy shape.
        .filter(entry => /^backup-.*\.json$/.test(typeof entry === 'string' ? entry : entry.name))
        .map(entry => {
          const name = typeof entry === 'string' ? entry : entry.name;
          // mtime (from readdir) is the real, unambiguous write time in
          // milliseconds — far more reliable than trying to reverse-parse a
          // timestamp back out of the filename.
          const mtime = typeof entry === 'object' && Number.isFinite(entry.mtime) ? entry.mtime : null;
          return { name, path: `${EXTERNAL_BACKUP_DIR}/${name}`, mtime };
        })
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || (a.name < b.name ? 1 : -1)); // newest first
    } catch (_) {
      return [];
    }
  }

  async function readExternalBackup(path) {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) throw new Error('Filesystem plugin unavailable');
    const { data } = await Filesystem.readFile({ path, directory: 'DOCUMENTS', encoding: 'utf8' });
    return JSON.parse(String(data));
  }

  function validateBackup(snapshot) {
    return Boolean(
      snapshot && snapshot.format === 'adeel-pos-mobile-backup' &&
      snapshot.data && Array.isArray(snapshot.data.invoices) &&
      Array.isArray(snapshot.data.products) && Array.isArray(snapshot.data.sections) &&
      snapshot.data.settings && typeof snapshot.data.settings === 'object'
    );
  }

  async function restoreBackup(snapshot) {
    if (!validateBackup(snapshot)) throw new Error('Invalid backup file');
    await createBackup('before_restore');
    await writeInvoices(snapshot.data.invoices);
    await setProducts(snapshot.data.products);
    await setSections(snapshot.data.sections);
    for (const [key, value] of Object.entries(snapshot.data.settings)) {
      if (SETTINGS_KEYS.includes(key)) await setSetting(key, value);
    }
    return true;
  }

  window.db = {
    saveInvoice,
    updateInvoice,
    getInvoice,
    getInvoicesInRange,
    getDailySummary,
    getMonthlySummary,
    getDailyBreakdown,
    currentLocalYearMonth: AdeelCore.currentLocalYearMonth,
    getSetting,
    setSetting,
    getQuickItems: getProducts,
    setQuickItems: setProducts,
    getProducts,
    setProducts,
    adjustStock,
    setStock,
    applyStockChange,
    logStockChange,
    logStockChangesBatch,
    getStockHistory,
    getSections,
    setSections,
    makeId,
    getSaleDraft,
    setSaleDraft,
    clearSaleDraft,
    getHeldBills,
    getHeldBill,
    holdBill,
    deleteHeldBill,
    createBackup,
    validateBackup,
    restoreBackup,
    listExternalBackups,
    readExternalBackup
  };

  // --- Phase 4: Firebase-Ready Data Repository Abstraction Layer ----------
  const FirebaseAdapter = {
    enabled: false,
    config: null,
    async init(config) {
      this.config = config;
      this.enabled = Boolean(config && config.apiKey && config.projectId);
      console.log('[FirebaseAdapter] Configured:', this.enabled);
    },
    async fetchRemoteProducts() {
      if (!this.enabled) return null;
      return null;
    },
    async pushRemoteProduct(product) {
      if (!this.enabled) return false;
      return true;
    },
    async syncInvoicesToCloud(invoice) {
      if (!this.enabled) return false;
      return true;
    }
  };

  const DataRepository = {
    async getProducts() {
      if (FirebaseAdapter.enabled) {
        const remote = await FirebaseAdapter.fetchRemoteProducts();
        if (remote && remote.length) return remote;
      }
      return await getProducts();
    },

    async setProducts(products) {
      await setProducts(products);
      if (FirebaseAdapter.enabled) {
        for (const p of products) {
          await FirebaseAdapter.pushRemoteProduct(p);
        }
      }
    },

    async saveInvoice(invoiceData) {
      const saved = await saveInvoice(invoiceData);
      if (FirebaseAdapter.enabled) {
        await FirebaseAdapter.syncInvoicesToCloud(saved);
      }
      return saved;
    },

    getSections,
    setSections,
    getSetting,
    setSetting,
    createBackup,
    restoreBackup,
    validateBackup,

    Firebase: FirebaseAdapter
  };

  window.DataRepository = DataRepository;
})();
