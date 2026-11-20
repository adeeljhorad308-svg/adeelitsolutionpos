// Adeel POS Mobile — mobile-first retail UX on top of the existing offline engine.
const core = window.AdeelCore;
const byId = id => document.getElementById(id);

let cart = [];
let products = [];
let sections = [];
let sectionsEnabled = false;
let stockTrackingEnabled = false;
let currentLang = 'ur';
let currentScreen = 'billing';
let currentReportTab = 'today';
let currentReportSummary = null;
let activeInvoiceId = null;
let editingProductId = null;
let editingSectionId = null;
let saleFilter = 'quick';
let pickerFilter = 'quick';
let saleSearch = '';
let pickerSearch = '';
let productSearch = '';
let customerName = '';
let discountAmount = 0;
let selectedPaymentMethod = 'Cash';
const PAYMENT_METHODS = ['Cash', 'Card', 'JazzCash', 'EasyPaisa', 'Bank Transfer', 'Split Payment'];
let pendingImport = null;
let saleInProgress = false;
let appReady = false;
let hiddenAt = 0;
let draftTimer = null;
let bannerAction = null;
let toastTimer = null;
const taskStack = [];
const licenseState = { valid: false, expired: false, expiry: null, machineId: '', key: '' };
const shopConfig = { shopName: 'میری دکان', shopPhone: '', shopAddress: '', shopLogo: '', currency: 'Rs', brandFooter: 'Software by Adeel Jhorad · Contact: 0312-4927023' };

function t(ur, en) {
  return currentLang === 'ur' ? ur : en;
}

function money(value) {
  return `${Math.round(Number(value) || 0).toLocaleString('en-PK')} ${shopConfig.currency}`;
}

function productCountLabel(count) {
  return currentLang === 'ur' ? `${count} مصنوعات` : `${count} ${count === 1 ? 'product' : 'products'}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  // Deliberately NOT using toLocaleString() with a locale string (e.g. 'ur-PK').
  // Many Android devices ship a WebView with a reduced ICU dataset, and can
  // silently produce blank, wrong, or garbled output for less-common locales
  // — this has been seen to strip values out of the printed receipt on real
  // phones even though it worked fine on other devices/emulators. Building
  // the string by hand guarantees byte-identical output on every device.
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${day} ${month} ${year}, ${hours}:${minutes} ${ampm}`;
}

function applyLanguage(lang, rerender = true) {
  currentLang = lang === 'en' ? 'en' : 'ur';
  const root = byId('htmlRoot');
  root.lang = currentLang;
  root.dir = currentLang === 'ur' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-ur]').forEach(element => {
    const value = currentLang === 'ur' ? element.dataset.ur : element.dataset.en;
    if (value !== undefined) element.textContent = value;
  });
  document.querySelectorAll('[data-ur-placeholder]').forEach(element => {
    element.placeholder = currentLang === 'ur' ? element.dataset.urPlaceholder : element.dataset.enPlaceholder;
  });
  document.querySelectorAll('.lang-btn').forEach(button => button.classList.toggle('active', button.dataset.lang === currentLang));
  if (rerender && appReady) renderDynamicUI();
}

function setupLanguageSwitches() {
  document.querySelectorAll('.lang-btn').forEach(button => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async () => {
      applyLanguage(button.dataset.lang);
      await db.setSetting('language', button.dataset.lang);
    });
  });
}

function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function showBanner(message, actionLabel = '', action = null) {
  byId('persistentBannerText').textContent = message;
  const actionButton = byId('persistentBannerAction');
  actionButton.textContent = actionLabel;
  actionButton.classList.toggle('hidden', !actionLabel || !action);
  bannerAction = action;
  byId('persistentBanner').classList.remove('hidden');
}

function hideBanner() {
  byId('persistentBanner').classList.add('hidden');
  bannerAction = null;
}

function setButtonBusy(button, busy, urText, enText) {
  if (!button) return;
  if (!button.dataset.originalUr) {
    button.dataset.originalUr = button.dataset.ur || button.textContent;
    button.dataset.originalEn = button.dataset.en || button.textContent;
  }
  button.disabled = busy;
  button.textContent = busy ? t(urText, enText) : t(button.dataset.originalUr, button.dataset.originalEn);
}

function openTask(id) {
  const task = byId(id);
  if (!task || !task.classList.contains('hidden')) return;
  task.classList.remove('hidden');
  taskStack.push(id);
  history.pushState({ adeelTask: id }, '');
}

function closeTopTask() {
  const id = taskStack.pop();
  if (!id) return;
  byId(id)?.classList.add('hidden');
}

function requestCloseTask() {
  if (taskStack.length) history.back();
}

function clearTaskStack() {
  taskStack.splice(0).forEach(id => byId(id)?.classList.add('hidden'));
}

async function loadShopConfig() {
  shopConfig.shopName = await db.getSetting('shopName', shopConfig.shopName);
  shopConfig.shopPhone = await db.getSetting('shopPhone', '');
  shopConfig.shopAddress = await db.getSetting('shopAddress', '');
  shopConfig.shopLogo = await db.getSetting('shopLogo', '');
  byId('loginShopName').textContent = shopConfig.shopName;
  byId('topShopName').textContent = shopConfig.shopName;
}

async function refreshLicenseState(rawKey) {
  const key = rawKey !== undefined ? rawKey : await db.getSetting('licenseKey', '');
  const machineId = await license.getMachineId();
  const result = await license.checkLicense(machineId, key);
  licenseState.key = key;
  licenseState.machineId = machineId;
  licenseState.valid = result.valid;
  licenseState.expired = result.reason === 'expired';
  licenseState.expiry = result.expiry || null;
  return result;
}

async function boot() {
  setupEvents();
  setupLanguageSwitches();
  const savedLanguage = await db.getSetting('language', 'ur');
  applyLanguage(savedLanguage, false);
  await loadShopConfig();
  const result = await refreshLicenseState();
  if (result.valid || (result.reason === 'expired' && licenseState.key)) {
    await showLoginScreen();
  } else {
    byId('machineIdDisplay').textContent = licenseState.machineId;
    byId('activationScreen').classList.remove('hidden');
  }
}

async function showLoginScreen() {
  byId('activationScreen').classList.add('hidden');
  byId('mainApp').classList.add('hidden');
  byId('loginScreen').classList.remove('hidden');
  document.querySelectorAll('.pin-box').forEach(input => { input.value = ''; });
  setTimeout(() => document.querySelector('.pin-box')?.focus(), 80);
}

async function activateLicense(inputId, messageId, afterActivation) {
  const key = byId(inputId).value.trim();
  const message = byId(messageId);
  message.className = 'form-message error';
  if (!key) {
    message.textContent = t('لائسنس کوڈ درج کریں۔', 'Enter the license key.');
    return;
  }
  const result = await refreshLicenseState(key);
  if (!result.valid) {
    message.textContent = result.reason === 'expired'
      ? t(`یہ لائسنس ${result.expiry} کو ختم ہو چکا ہے۔`, `This license expired on ${result.expiry}.`)
      : t('لائسنس کوڈ درست نہیں۔', 'The license key is invalid.');
    return;
  }
  await db.setSetting('licenseKey', key);
  message.className = 'form-message success';
  message.textContent = t('لائسنس فعال ہو گیا۔', 'License activated.');
  if (typeof afterActivation === 'function') await afterActivation(result);
}

let failedPinCount = 0;
let pinLockoutUntil = 0;

async function attemptLogin() {
  const message = byId('loginError');
  const now = Date.now();

  if (now < pinLockoutUntil) {
    const remainingSec = Math.ceil((pinLockoutUntil - now) / 1000);
    message.textContent = t(`3 ناکام کوششیں! سیکیورٹی کی خاطر ${remainingSec} سیکنڈ انتظار کریں۔`, `3 failed attempts! Please wait ${remainingSec}s for security.`);
    return;
  }

  const boxes = Array.from(document.querySelectorAll('.pin-box'));
  const entered = boxes.map(box => box.value).join('');

  if (!/^\d{4}$/.test(entered)) {
    message.textContent = t('مکمل 4 ہندسوں کا پن درج کریں۔', 'Enter the complete four-digit PIN.');
    return;
  }

  const savedPin = await db.getSetting('password', '0000');
  if (entered !== savedPin) {
    failedPinCount++;
    if (failedPinCount >= 3) {
      pinLockoutUntil = Date.now() + 30000;
      failedPinCount = 0;
      message.textContent = t('3 ناکام کوششیں! سیکیورٹی کی خاطر 30 سیکنڈ انتظار کریں۔', '3 failed attempts! Please wait 30s for security.');
    } else {
      const left = 3 - failedPinCount;
      message.textContent = t(`پن درست نہیں۔ (${left} کوششیں باقی)`, `Incorrect PIN. (${left} attempts left)`);
    }
    boxes.forEach(box => { box.value = ''; });
    boxes[0]?.focus();
    return;
  }

  failedPinCount = 0;
  pinLockoutUntil = 0;
  message.textContent = '';
  byId('loginScreen').classList.add('hidden');
  byId('mainApp').classList.remove('hidden');
  await initializeAppState();
}

// --- Forgot PIN / Reset License -------------------------------------------
// Entirely separate from the app's real activation license: reset-license.js
// verifies a different, independently-signed key type (RESET2. prefix) that
// can only unlock the "set a new PIN" step below. Nothing here reads or
// writes the 'licenseKey' setting or calls anything in license.js.
let resetVerifiedOnce = false;

async function showForgotPinScreen() {
  byId('loginScreen').classList.add('hidden');
  byId('forgotPinScreen').classList.remove('hidden');
  byId('resetStep1').classList.remove('hidden');
  byId('resetStep2').classList.add('hidden');
  byId('resetKeyInput').value = '';
  byId('resetKeyError').textContent = '';
  byId('newResetPin').value = '';
  byId('confirmResetPin').value = '';
  byId('resetPinError').textContent = '';
  resetVerifiedOnce = false;
  const machineId = await resetLicense.getMachineId();
  byId('resetMachineIdDisplay').textContent = machineId;
}

function showLoginScreenFromReset() {
  byId('forgotPinScreen').classList.add('hidden');
  byId('loginScreen').classList.remove('hidden');
  document.querySelectorAll('.pin-box').forEach(input => { input.value = ''; });
  setTimeout(() => document.querySelector('.pin-box')?.focus(), 80);
}

async function verifyResetKey() {
  const key = byId('resetKeyInput').value.trim();
  const message = byId('resetKeyError');
  message.className = 'form-message error';
  if (!key) {
    message.textContent = t('ری سیٹ کوڈ درج کریں۔', 'Enter the reset code.');
    return;
  }
  const machineId = await resetLicense.getMachineId();
  const result = await resetLicense.checkResetKey(machineId, key);
  if (!result.valid) {
    message.textContent = result.reason === 'expired'
      ? t(`یہ ری سیٹ کوڈ ${result.expiry} کو ختم ہو چکا ہے۔ نیا کوڈ منگوائیں۔`, `This reset code expired on ${result.expiry}. Ask for a new one.`)
      : t('ری سیٹ کوڈ درست نہیں۔', 'The reset code is invalid.');
    return;
  }
  message.textContent = '';
  resetVerifiedOnce = true;
  byId('resetStep1').classList.add('hidden');
  byId('resetStep2').classList.remove('hidden');
  setTimeout(() => byId('newResetPin')?.focus(), 80);
}

async function saveResetPin() {
  const message = byId('resetPinError');
  message.className = 'form-message error';
  if (!resetVerifiedOnce) {
    // Defensive guard: this screen must never be reachable without a
    // verified reset key, however it was opened.
    message.textContent = t('پہلے ری سیٹ کوڈ کی تصدیق کریں۔', 'Verify the reset code first.');
    return;
  }
  const newPin = byId('newResetPin').value;
  const confirmPin = byId('confirmResetPin').value;
  if (!/^\d{4}$/.test(newPin)) {
    message.textContent = t('نیا پن مکمل 4 ہندسوں کا ہونا چاہیے۔', 'The new PIN must contain exactly four digits.');
    return;
  }
  if (newPin !== confirmPin) {
    message.textContent = t('دونوں پن ایک جیسے نہیں ہیں۔', 'The two PINs do not match.');
    return;
  }
  await db.setSetting('password', newPin);
  message.className = 'form-message success';
  message.textContent = t('پن تبدیل ہو گیا۔ اب لاگ ان کریں۔', 'PIN changed. You can log in now.');
  resetVerifiedOnce = false;
  setTimeout(showLoginScreenFromReset, 1200);
}

// --- Hardware back button --------------------------------------------------
// One back-press from anywhere inside the logged-in app returns to the
// Billing (main) screen; a second back-press from Billing itself, within a
// short window, exits the app (the standard Android "press back again to
// exit" pattern). An open task-screen/overlay (checkout, editors, settings,
// pickers — anything opened via openTask()) is closed first, one layer at a
// time, before that navigation kicks in at all.
let lastExitPromptAt = 0;

function activeAuthScreen() {
  if (!byId('activationScreen').classList.contains('hidden')) return 'activation';
  if (!byId('loginScreen').classList.contains('hidden')) return 'login';
  if (!byId('forgotPinScreen').classList.contains('hidden')) return 'forgotPin';
  return null; // mainApp (logged in) is active
}

function armExitOnNextBack() {
  const now = Date.now();
  if (now - lastExitPromptAt < 2000) {
    Capacitor.Plugins.App.exitApp();
    return;
  }
  lastExitPromptAt = now;
  showToast(t('دوبارہ Back دبائیں تاکہ ایپ بند ہو جائے', 'Press back again to exit'));
}

function handleHardwareBack() {
  const authScreen = activeAuthScreen();
  if (authScreen === 'forgotPin') {
    // Inside the Forgot PIN flow: step 2 (new PIN) steps back to step 1
    // (reset code) before stepping all the way back to the login screen.
    if (!byId('resetStep2').classList.contains('hidden')) {
      byId('resetStep2').classList.add('hidden');
      byId('resetStep1').classList.remove('hidden');
      return;
    }
    showLoginScreenFromReset();
    return;
  }
  if (authScreen === 'activation' || authScreen === 'login') {
    armExitOnNextBack();
    return;
  }
  if (taskStack.length) {
    history.back();
    return;
  }
  if (currentScreen === 'products' && sectionShortcutOrigin === 'more') {
    sectionShortcutOrigin = null;
    showMainScreen('more');
    return;
  }
  if (currentScreen !== 'billing') {
    showMainScreen('billing');
    return;
  }
  armExitOnNextBack();
}

async function initializeAppState() {
  await loadShopConfig();
  await loadPrinterSettings();
  products = await db.getProducts();
  sections = await db.getSections();
  sectionsEnabled = (await db.getSetting('sectionsEnabled', 'false')) === 'true';
  await loadStockTrackingSetting();
  const draft = await db.getSaleDraft();
  cart = Array.isArray(draft.cart) ? draft.cart.filter(item => item && item.name && Number(item.price) > 0 && Number(item.quantity) > 0) : [];
  customerName = String(draft.customerName || '');
  discountAmount = Math.max(0, Number(draft.discount) || 0);
  if (!products.some(product => product.isQuick)) saleFilter = 'all';
  appReady = true;
  renderDynamicUI();
  await refreshStockAlertBadge();
  await refreshHeldBillsButton();
  await updateLicenseUI();
  if (licenseState.expired) {
    showMainScreen('reports');
    showBanner(
      t('لائسنس ختم ہے۔ رپورٹس اور بیک اپ محفوظ ہیں؛ نئی فروخت بند ہے۔', 'License expired. Reports and backups remain available; new selling is locked.'),
      t('تجدید', 'Renew'),
      () => openSettingsPanel('license')
    );
  } else {
    showMainScreen('billing');
  }
  await loadReportTab('today');
  await updateBackupStatus();
  // Refresh the uninstall-proof external backup mirror on every app open too
  // (throttled inside db.js), not just after a sale — so a shop that mostly
  // checks reports without selling still gets protected regularly.
  db.createBackup('app_open').catch(() => undefined);
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    db.setSaleDraft({ cart, customerName, discount: discountAmount, updatedAt: new Date().toISOString() }).catch(() => undefined);
  }, 120);
}

function showMainScreen(screen) {
  currentScreen = screen;
  document.querySelectorAll('.content-screen').forEach(element => element.classList.add('hidden'));
  byId(`${screen}Screen`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.screen === screen));
  const titles = {
    billing: t('فروخت', 'Sale'), reports: t('رپورٹس', 'Reports'),
    products: t('مصنوعات', 'Products'), stock: t('اسٹاک', 'Stock'), more: t('مزید', 'More')
  };
  byId('topScreenTitle').textContent = titles[screen];
  if (screen === 'reports') loadReportTab(currentReportTab);
  if (screen === 'products') renderProductManagement();
  if (screen === 'stock') renderStockManagement();
  if (screen === 'more') updateBackupStatus();
}

function activeSections() {
  return sections.filter(section => section.active !== false).sort((a, b) => a.order - b.order);
}

function sectionName(sectionId) {
  return sections.find(section => section.id === sectionId)?.name || t('بغیر سیکشن', 'No section');
}

function filteredProducts(filter, search) {
  const query = core.normalizeText(search);
  let list = products.filter(product => product.active !== false);
  if (query) return list.filter(product => core.normalizeText(product.name).includes(query));
  if (filter === 'quick') list = list.filter(product => product.isQuick);
  else if (filter !== 'all') list = list.filter(product => product.sectionId === filter);
  return list;
}

function sectionOptionsForBar() {
  // Every active section is shown, all the time — the bar scrolls
  // horizontally (swipe) instead of hiding sections behind a "More" button
  // that required an extra tap to even see what else existed.
  return sectionsEnabled ? activeSections() : [];
}

function renderSectionBar(containerId, selected, context) {
  const container = byId(containerId);
  const options = [
    { id: 'all', name: t('تمام', 'All') },
    { id: 'quick', name: t('فوری', 'Quick') },
    ...sectionOptionsForBar().map(section => ({ id: section.id, name: section.name }))
  ];
  container.innerHTML = options.map(option => `
    <button class="section-chip ${selected === option.id ? 'active' : ''}" data-section-id="${core.escapeHTML(option.id)}">${core.escapeHTML(option.name)}</button>
  `).join('');
  container.querySelectorAll('.section-chip').forEach(button => {
    button.addEventListener('click', () => {
      const id = button.dataset.sectionId;
      if (context === 'sale') { saleFilter = id; renderSaleProducts(); }
      else { pickerFilter = id; renderPickerProducts(); }
    });
  });
  const activeChip = container.querySelector('.section-chip.active');
  if (activeChip) activeChip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function getCartQuantity(productId) {
  return cart.find(item => item.productId === productId)?.quantity || 0;
}

function productTileHTML(product) {
  const quantity = getCartQuantity(product.id);
  const locked = licenseState.expired ? 'disabled aria-disabled="true"' : '';
  return `<button class="quick-item-btn ${quantity > 0 ? 'selected' : ''}" data-product-id="${core.escapeHTML(product.id)}" aria-pressed="${quantity > 0}" ${locked}>
    <span class="qi-quantity-badge">${quantity || ''}</span>
    <span class="qi-name">${core.escapeHTML(product.name)}</span>
    <span class="qi-price">${money(product.price)}</span>
  </button>`;
}

function bindProductTiles(container) {
  container.querySelectorAll('.quick-item-btn').forEach(button => {
    button.addEventListener('click', () => {
      if (licenseState.expired) {
        showToast(t('لائسنس تجدید کے بعد نئی فروخت ممکن ہے۔', 'Renew the license to create a new sale.'));
        return;
      }
      const product = products.find(item => item.id === button.dataset.productId);
      if (product) addProductToCart(product);
    });
  });
}

function renderSaleProducts() {
  renderSectionBar('saleSectionBar', saleFilter, 'sale');
  const list = filteredProducts(saleFilter, saleSearch);
  const grid = byId('quickItemGrid');
  grid.innerHTML = list.map(productTileHTML).join('');
  bindProductTiles(grid);
  byId('quickItemEmptyMsg').classList.toggle('hidden', list.length > 0);
  byId('expiredSaleState').classList.toggle('hidden', !licenseState.expired);
  byId('openManualItemBtn').disabled = licenseState.expired;
}

function renderPickerProducts() {
  renderSectionBar('pickerSectionBar', pickerFilter, 'picker');
  const list = filteredProducts(pickerFilter, pickerSearch);
  const grid = byId('pickerProductGrid');
  grid.innerHTML = list.map(productTileHTML).join('');
  bindProductTiles(grid);
}


function addProductToCart(product, quantity = 1) {
  cart = core.addCartItem(cart, product, quantity);
  afterCartChange();
}

function changeCart(identity, delta) {
  cart = core.changeCartQuantity(cart, identity, delta);
  afterCartChange();
}

function removeCart(identity) {
  cart = core.removeCartItem(cart, identity);
  afterCartChange();
}

function afterCartChange() {
  scheduleDraftSave();
  renderCartBar();
  renderCheckout();
  renderSaleProducts();
  if (!byId('productPickerTask').classList.contains('hidden')) renderPickerProducts();
}

function currentTotals() {
  return core.calculateTotals(cart, discountAmount);
}

function renderCartBar() {
  const quantity = core.totalQuantity(cart);
  const totals = currentTotals();
  byId('saleCartQty').textContent = String(quantity);
  byId('saleCartTotal').textContent = money(totals.total);
  byId('reviewSaleBtn').disabled = quantity === 0 || licenseState.expired;
}

function cartRowHTML(item) {
  const identity = encodeURIComponent(core.productIdentity(item));
  return `<div class="cart-row">
    <div class="cart-row-top"><span class="cart-row-name">${core.escapeHTML(item.name)}</span><span class="cart-row-total">${money(item.price * item.quantity)}</span></div>
    <div class="cart-row-bottom"><span class="unit-price">${money(item.price)} ${t('فی عدد', 'each')}</span><div class="qty-control"><button data-cart-action="minus" data-identity="${identity}" aria-label="Decrease">−</button><span>${item.quantity}</span><button data-cart-action="plus" data-identity="${identity}" aria-label="Increase">+</button></div><button class="remove-item" data-cart-action="remove" data-identity="${identity}" aria-label="Remove">×</button></div>
  </div>`;
}

function renderCheckout() {
  const list = byId('checkoutCartList');
  list.innerHTML = cart.length ? cart.map(cartRowHTML).join('') : `<div class="empty-state"><strong>${t('بل خالی ہے', 'Cart is empty')}</strong><span>${t('مصنوعات شامل کرکے دوبارہ کوشش کریں۔', 'Add products and try again.')}</span></div>`;
  list.querySelectorAll('[data-cart-action]').forEach(button => {
    button.addEventListener('click', () => {
      const identity = decodeURIComponent(button.dataset.identity);
      if (button.dataset.cartAction === 'plus') changeCart(identity, 1);
      else if (button.dataset.cartAction === 'minus') changeCart(identity, -1);
      else removeCart(identity);
    });
  });
  const totals = currentTotals();
  byId('checkoutSubtotal').textContent = money(totals.subtotal);
  byId('checkoutTotal').textContent = money(totals.total);
  byId('checkoutDiscountValue').textContent = `−${money(totals.discount)}`;
  byId('checkoutDiscountLabel').classList.toggle('hidden', totals.discount <= 0);
  updateChangeDue();
  byId('checkoutDiscountValue').classList.toggle('hidden', totals.discount <= 0);
  byId('completeSaleBtn').disabled = cart.length === 0 || saleInProgress || licenseState.expired;
  const customerButton = byId('checkoutCustomerBtn');
  customerButton.textContent = customerName || t('+ کسٹمر', '+ Customer');
  customerButton.classList.toggle('has-value', Boolean(customerName));
  const discountButton = byId('checkoutDiscountBtn');
  discountButton.textContent = totals.discount > 0 ? `${t('ڈسکاؤنٹ', 'Discount')}: ${money(totals.discount)}` : t('+ ڈسکاؤنٹ', '+ Discount');
  discountButton.classList.toggle('has-value', totals.discount > 0);
}

function openCheckout() {
  if (!cart.length || licenseState.expired) return;
  selectedPaymentMethod = 'Cash';
  byId('tenderedInput').value = '';
  updatePaymentChip();
  renderCheckout();
  byId('checkoutMessage').textContent = '';
  openTask('checkoutTask');
}

// --- Hold Bill / New Bill / Held Bills -------------------------------------
// A held bill parks the current in-progress cart (with its customer,
// discount and payment choices) under its own record — completely separate
// from a saved invoice. Nothing here touches invoices, stock or reports
// until a parked bill is actually resumed and completed later. Held bills
// live in Preferences (db.holdBill / getHeldBills / deleteHeldBill), so they
// survive a normal app close, not just a screen change.
let heldBillsSearch = '';
let lastNewBillPromptAt = 0;

function currentBillIsEmpty() {
  return cart.length === 0 && !customerName && !(discountAmount > 0);
}

function snapshotCurrentBill() {
  return {
    cart: cart.map(item => ({ ...item })),
    customerName,
    discountAmount,
    paymentMethod: selectedPaymentMethod,
    tendered: Number(byId('tenderedInput')?.value) || 0
  };
}

function resetCurrentBill() {
  cart = [];
  customerName = '';
  discountAmount = 0;
  selectedPaymentMethod = 'Cash';
  if (byId('tenderedInput')) byId('tenderedInput').value = '';
}

async function holdCurrentBill() {
  if (!cart.length) {
    showToast(t('بل خالی ہے، ہولڈ کرنے کیلئے کچھ نہیں۔', 'The bill is empty — nothing to hold.'));
    return;
  }
  const record = await db.holdBill(snapshotCurrentBill());
  resetCurrentBill();
  renderDynamicUI();
  await refreshHeldBillsButton();
  showToast(t(`بل ${record.holdNumber} ہولڈ ہو گیا۔`, `Bill ${record.holdNumber} held.`));
}

function startNewBill() {
  if (currentBillIsEmpty()) return;
  const now = Date.now();
  if (now - lastNewBillPromptAt < 2500) {
    resetCurrentBill();
    renderDynamicUI();
    lastNewBillPromptAt = 0;
    showToast(t('نیا بل شروع ہو گیا۔', 'New bill started.'));
    return;
  }
  lastNewBillPromptAt = now;
  showToast(t('موجودہ بل ضائع کرنے کیلئے دوبارہ دبائیں، یا پہلے ہولڈ کریں۔', 'Tap again to discard the current bill, or hold it first.'));
}

async function refreshHeldBillsButton() {
  const heldBills = await db.getHeldBills();
  const button = byId('heldBillsBtn');
  button.textContent = heldBills.length
    ? t(`ہولڈ بلز (${heldBills.length})`, `Held bills (${heldBills.length})`)
    : t('ہولڈ بلز', 'Held bills');
}

async function renderHeldBillsList() {
  const heldBills = await db.getHeldBills();
  const query = core.normalizeText(heldBillsSearch);
  const list = query
    ? heldBills.filter(bill =>
        core.normalizeText(bill.holdNumber).includes(query) ||
        core.normalizeText(bill.customerName || '').includes(query) ||
        core.normalizeText(bill.note || '').includes(query) ||
        (bill.cart || []).some(item => core.normalizeText(item.name).includes(query)))
    : heldBills;

  byId('heldBillsCountText').textContent = heldBills.length
    ? t(`${list.length} / ${heldBills.length} بل`, `${list.length} of ${heldBills.length} bill(s)`)
    : t('کوئی ہولڈ بل نہیں', 'No held bills');

  const container = byId('heldBillsList');
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><strong>${t('کوئی ہولڈ بل نہیں ملا', 'No held bills found')}</strong><span>${t('بل میں چیزیں شامل کرکے "ہولڈ بل" دبائیں۔', 'Add items to the bill, then tap "Hold bill".')}</span></div>`;
    return;
  }

  container.innerHTML = list.map(bill => {
    const qty = (bill.cart || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const total = core.calculateTotals(bill.cart || [], bill.discountAmount || 0).total;
    const label = bill.customerName ? core.escapeHTML(bill.customerName) : t('کوئی کسٹمر نہیں', 'No customer');
    return `<div class="held-bill-row">
        <div class="held-bill-info">
          <span><strong>${core.escapeHTML(bill.holdNumber)}</strong><small>${label} · ${qty} ${t('مقدار', 'qty')} · ${core.escapeHTML(formatDateTime(bill.createdAt))}</small></span>
          <span class="invoice-total">${money(total)}</span>
        </div>
        <div class="held-bill-row-actions">
          <button class="btn btn-primary btn-compact held-bill-resume" data-hold-id="${core.escapeHTML(bill.id)}" data-ur="▶ واپس لائیں" data-en="▶ Resume">${t('▶ واپس لائیں', '▶ Resume')}</button>
          <button class="btn btn-secondary btn-compact held-bill-discard" data-hold-delete-id="${core.escapeHTML(bill.id)}" data-ur="ضائع کریں" data-en="Discard">${t('ضائع کریں', 'Discard')}</button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-hold-id]').forEach(button => {
    button.addEventListener('click', () => resumeHeldBill(button.dataset.holdId));
  });
  container.querySelectorAll('[data-hold-delete-id]').forEach(button => {
    button.addEventListener('click', async event => {
      event.stopPropagation();
      const id = button.dataset.holdDeleteId;
      const bill = heldBills.find(entry => entry.id === id);
      if (!confirm(t(`بل ${bill ? bill.holdNumber : ''} ضائع کریں؟ یہ واپس نہیں آئے گا۔`, `Discard bill ${bill ? bill.holdNumber : ''}? This cannot be undone.`))) return;
      await db.deleteHeldBill(id);
      await refreshHeldBillsButton();
      await renderHeldBillsList();
    });
  });
}

async function resumeHeldBill(id) {
  const bill = await db.getHeldBill(id);
  if (!bill) return;
  if (!currentBillIsEmpty()) {
    // Never silently discard an in-progress bill on the screen — park it
    // first, exactly like tapping "Hold bill" would.
    await db.holdBill(snapshotCurrentBill());
  }
  cart = (bill.cart || []).map(item => ({ ...item }));
  customerName = bill.customerName || '';
  discountAmount = Number(bill.discountAmount) || 0;
  selectedPaymentMethod = bill.paymentMethod || 'Cash';
  await db.deleteHeldBill(id);
  renderDynamicUI();
  await refreshHeldBillsButton();
  requestCloseTask();
  showToast(t(`بل ${bill.holdNumber} واپس آ گیا۔`, `Bill ${bill.holdNumber} restored.`));
}

function updatePaymentChip() {
  const chip = byId('checkoutPaymentBtn');
  chip.textContent = t(paymentMethodLabelUr(selectedPaymentMethod), selectedPaymentMethod);
  chip.classList.toggle('has-value', selectedPaymentMethod !== 'Cash');
}

function paymentMethodLabelUr(method) {
  const labels = {
    Cash: 'نقد', Card: 'کارڈ', JazzCash: 'JazzCash', EasyPaisa: 'EasyPaisa',
    'Bank Transfer': 'بینک ٹرانسفر', 'Split Payment': 'ملی جلی ادائیگی'
  };
  return labels[method] || method;
}

function renderPaymentMethodList() {
  byId('paymentMethodList').innerHTML = PAYMENT_METHODS.map(method => `
    <button class="settings-row payment-method-row ${method === selectedPaymentMethod ? 'active' : ''}" data-method="${method}">
      <span class="settings-icon">${method === selectedPaymentMethod ? '●' : '○'}</span>
      <span><strong>${core.escapeHTML(t(paymentMethodLabelUr(method), method))}</strong></span>
    </button>`).join('');
  byId('paymentMethodList').querySelectorAll('[data-method]').forEach(button => {
    button.addEventListener('click', () => {
      selectedPaymentMethod = button.dataset.method;
      updatePaymentChip();
      requestCloseTask();
    });
  });
}

function updateChangeDue() {
  const totals = currentTotals();
  const tendered = Number(byId('tenderedInput').value);
  const hasTendered = Number.isFinite(tendered) && tendered > 0;
  const change = hasTendered ? Math.max(0, tendered - totals.total) : 0;
  byId('changeDueValue').textContent = money(change);
  byId('changeDueValue').classList.toggle('warn-text', hasTendered && tendered < totals.total);
}

function buildReceiptHTML(invoice) {
  const itemRows = (invoice.items || []).map(item => `<tr><td colspan="4" class="item-name">${core.escapeHTML(item.name)}</td></tr><tr class="item-nums"><td></td><td class="num">${item.quantity}</td><td class="num">${Math.round(item.price)}</td><td class="num">${Math.round(item.price * item.quantity)}</td></tr>`).join('');
  const totalQuantity = (invoice.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const logoHtml = shopConfig.shopLogo
    ? `<img src="${shopConfig.shopLogo}" alt="logo" />`
    : `<svg viewBox="0 0 200 200"><path d="M100 20 L168 168 L100 132 L32 168 Z M100 74 L128 150 L100 134 L72 150 Z" fill="#000" fill-rule="evenodd"/></svg>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 80mm auto; margin: 3mm; } *{box-sizing:border-box} body{width:74mm;margin:0 auto;color:#000;font:11px/1.35 'Courier New',monospace} .center{text-align:center}.logo{max-width:56px;max-height:56px;margin:0 auto}.logo svg,.logo img{width:100%;height:100%;object-fit:contain}h1{font-size:19px;margin:3px 0 1px}.phone,.address{font-size:10px}.rule{border-top:1px dashed #000;margin:7px 0}.meta{display:grid;grid-template-columns:auto 1fr;gap:2px 8px}.meta span:nth-child(even){text-align:right}.mono{font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:2px 1px;vertical-align:top}th{text-align:left;border-bottom:1px solid #000;font-size:10px}th:nth-child(1){width:40%}th:nth-child(2){width:15%}th:nth-child(3){width:20%}th:nth-child(4){width:25%}th:nth-child(n+2),.item-nums td.num{text-align:right}.item-name{padding-top:4px}.num{font-variant-numeric:tabular-nums}.totals{margin-top:4px}.line{display:flex;justify-content:space-between;padding:2px 0}.grand{font-size:15px;font-weight:bold;border-top:1px solid #000;margin-top:3px;padding-top:5px}.footer{margin-top:9px;text-align:center}.brand-box{display:inline-block;margin-top:8px;padding:4px 10px;border:1px solid #000;border-radius:8px;font-size:9px;line-height:1.5}@media print and (max-width:58mm){@page{size:58mm auto;margin:2mm}body{width:54mm;font-size:9px}h1{font-size:15px}.logo{max-width:48px;max-height:48px}.grand{font-size:13px}.brand-box{font-size:8px}}
  </style></head><body>
    <div class="center"><div class="logo">${logoHtml}</div><h1>${core.escapeHTML(shopConfig.shopName)}</h1>${shopConfig.shopPhone ? `<div class="phone">Phone: ${core.escapeHTML(shopConfig.shopPhone)}</div>` : ''}${shopConfig.shopAddress ? `<div class="address">Address: ${core.escapeHTML(shopConfig.shopAddress)}</div>` : ''}</div>
    <div class="rule"></div><div class="meta"><span>Invoice</span><span class="mono">${core.escapeHTML(invoice.invoiceNumber)}</span><span>Date/Time</span><span>${core.escapeHTML(formatDateTime(invoice.created_at))}</span>${invoice.customer_name ? `<span>Customer</span><span>${core.escapeHTML(invoice.customer_name)}</span>` : ''}<span>Payment</span><span>${core.escapeHTML(invoice.payment_method || 'Cash')}</span></div>
    <div class="rule"></div><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${itemRows}</tbody></table><div class="rule"></div>
    <div class="totals"><div class="line"><span>Subtotal</span><span class="num">${Math.round(invoice.subtotal)} ${shopConfig.currency}</span></div>${invoice.discount > 0 ? `<div class="line"><span>Discount</span><span class="num">−${Math.round(invoice.discount)} ${shopConfig.currency}</span></div>` : ''}<div class="line grand"><span>TOTAL</span><span class="num">${Math.round(invoice.total)} ${shopConfig.currency}</span></div>${invoice.tendered > 0 ? `<div class="line"><span>Tendered</span><span class="num">${Math.round(invoice.tendered)} ${shopConfig.currency}</span></div><div class="line"><span>Change</span><span class="num">${Math.round(invoice.change)} ${shopConfig.currency}</span></div>` : ''}<div class="line"><span>Total quantity</span><span class="num">${totalQuantity}</span></div></div>
    <div class="footer"><strong>Thank you! Visit again.</strong><div class="brand-box">Software by Adeel Jhorad<br>Contact: 0312-4927023</div><div class="mono" style="margin-top:6px">${core.escapeHTML(invoice.invoiceNumber)}</div></div>
  </body></html>`;
}

function buildReceiptEscPos(invoice, paperWidthMm) {
  const b = new EscPos.ReceiptBuilder(paperWidthMm);
  const totalQuantity = (invoice.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);

  b.align('CENTER').bold(true).doubleSize(true).line(shopConfig.shopName).doubleSize(false).bold(false);
  if (shopConfig.shopPhone) b.line(shopConfig.shopPhone);
  b.hr();
  b.align('LEFT');
  b.twoCol('Invoice', invoice.invoiceNumber);
  b.line('Date: ' + formatDateTime(invoice.created_at));
  if (invoice.customer_name) b.line('Customer: ' + invoice.customer_name);
  b.line('Payment: ' + (invoice.payment_method || 'Cash'));
  b.hr();
  (invoice.items || []).forEach(item => {
    b.itemRow(item.name, item.quantity, Math.round(item.price * item.quantity));
  });
  b.hr();
  b.twoCol('Subtotal', Math.round(invoice.subtotal) + ' ' + shopConfig.currency);
  if (invoice.discount > 0) b.twoCol('Discount', '-' + Math.round(invoice.discount) + ' ' + shopConfig.currency);
  b.bold(true);
  b.twoCol('TOTAL', Math.round(invoice.total) + ' ' + shopConfig.currency);
  b.bold(false);
  b.twoCol('Total quantity', String(totalQuantity));
  b.hr();
  b.align('CENTER');
  b.line('Thank you - visit again');
  b.line('');
  b.hr('.');
  b.line('Software by Adeel Jhorad');
  b.line('Contact: 0312-4927023');
  b.hr('.');
  b.feed(3);
  b.cut();
  return b.toBase64();
}

async function requestPrint(html) {
  const plugin = Capacitor.Plugins && Capacitor.Plugins.PrinterPlugin;
  if (!plugin || typeof plugin.printHtml !== 'function') throw new Error('Printer unavailable');
  await plugin.printHtml({ html });
}

// --- Bluetooth thermal printer: state & control ---------------------------
// This is the ONLY printing path used by the normal sale flow (complete
// sale, reprint, test print). The old system print-dialog path
// (requestPrint/buildReceiptHTML) is kept solely for the explicit
// "Save/Share PDF" button in invoice history — a distinct, manual action,
// never triggered automatically.
let printerState = { transport: '', address: '', name: '', paperWidth: 58, autoPrint: true, connected: false };
let printerSettingsTab = 'bluetooth'; // which device list is showing in the Printer Settings UI right now — independent of the saved/connected printer

function getPluginFor(transport) {
  if (transport === 'usb') return Capacitor.Plugins && Capacitor.Plugins.UsbPrinterPlugin;
  if (transport === 'bluetooth') return Capacitor.Plugins && Capacitor.Plugins.BluetoothPrinterPlugin;
  return null;
}

function getActivePlugin() {
  return getPluginFor(printerState.transport);
}

async function loadPrinterSettings() {
  printerState.transport = await db.getSetting('printerTransport', '');
  printerState.address = await db.getSetting('printerAddress', '');
  printerState.name = await db.getSetting('printerName', '');
  printerState.paperWidth = Number(await db.getSetting('printerPaperWidth', 58)) || 58;
  printerState.autoPrint = (await db.getSetting('printerAutoPrint', 'true')) !== 'false';
  printerSettingsTab = printerState.transport || 'bluetooth';
}

async function refreshPrinterStatus() {
  const plugin = getActivePlugin();
  if (!plugin) { printerState.connected = false; return; }
  try {
    const status = await plugin.getStatus();
    printerState.connected = !!status.connected;
  } catch (_) {
    printerState.connected = false;
  }
}

async function ensurePrinterConnected() {
  const plugin = getActivePlugin();
  if (!plugin) throw new Error('no_printer_selected');
  await refreshPrinterStatus();
  if (printerState.connected) return true;
  if (!printerState.address) throw new Error('no_printer_selected');
  const param = printerState.transport === 'usb' ? { key: printerState.address } : { address: printerState.address };
  await plugin.connect(param);
  printerState.connected = true;
  return true;
}

async function connectToPrinter(transport, addressOrKey, name) {
  const plugin = getPluginFor(transport);
  if (!plugin) throw new Error(transport === 'usb' ? 'usb_unsupported' : 'bluetooth_unsupported');
  const param = transport === 'usb' ? { key: addressOrKey } : { address: addressOrKey };
  await plugin.connect(param);
  printerState.transport = transport;
  printerState.address = addressOrKey;
  printerState.name = name;
  printerState.connected = true;
  await db.setSetting('printerTransport', transport);
  await db.setSetting('printerAddress', addressOrKey);
  await db.setSetting('printerName', name);
}

async function disconnectPrinterSession() {
  const plugin = getActivePlugin();
  if (plugin) { try { await plugin.disconnect(); } catch (_) { /* best-effort */ } }
  printerState.connected = false;
}

async function forgetPrinter() {
  await disconnectPrinterSession();
  printerState.transport = '';
  printerState.address = '';
  printerState.name = '';
  await db.setSetting('printerTransport', '');
  await db.setSetting('printerAddress', '');
  await db.setSetting('printerName', '');
}

async function setPaperWidth(mm) {
  printerState.paperWidth = mm;
  await db.setSetting('printerPaperWidth', String(mm));
}

async function setAutoPrint(enabled) {
  printerState.autoPrint = enabled;
  await db.setSetting('printerAutoPrint', enabled ? 'true' : 'false');
}

function printerErrorCode(err, fallback = 'printer_error') {
  if (!err) return fallback;
  const candidates = [err.message, err.code, err.errorMessage, err.error && err.error.message];
  const known = [
    'bluetooth_unsupported', 'bluetooth_off', 'usb_unsupported', 'permission_denied',
    'no_printer_selected', 'no_address', 'no_device', 'device_not_found',
    'no_printer_interface', 'connect_failed', 'connect_cancelled', 'invalid_address',
    'not_connected', 'print_failed', 'invalid_data', 'list_failed', 'status_failed'
  ];
  for (const value of candidates) {
    if (!value) continue;
    const text = String(value);
    const exact = known.find(code => text === code || text.includes(code));
    if (exact) return exact;
  }
  return fallback;
}

function printerErrorMessage(code) {
  const map = {
    bluetooth_unsupported: ['یہ ڈیوائس بلوٹوتھ سپورٹ نہیں کرتی۔', 'This device does not support Bluetooth.'],
    bluetooth_off: ['بلوٹوتھ آف ہے۔ اسے آن کریں۔', 'Bluetooth is off. Please turn it on.'],
    usb_unsupported: ['یہ ڈیوائس USB پرنٹر سپورٹ نہیں کرتی۔', 'This device does not support USB printers.'],
    permission_denied: ['اجازت درکار ہے۔', 'Permission is required.'],
    no_printer_selected: ['کوئی پرنٹر منتخب نہیں۔', 'No printer selected.'],
    no_address: ['کوئی پرنٹر منتخب نہیں۔', 'No printer selected.'],
    no_device: ['کوئی پرنٹر منتخب نہیں۔', 'No printer selected.'],
    device_not_found: ['USB پرنٹر نہیں ملا۔ دوبارہ لگائیں۔', 'USB printer not found. Try reconnecting the cable.'],
    no_printer_interface: ['یہ USB ڈیوائس پرنٹر نہیں لگتی۔', 'This USB device does not look like a printer.'],
    connect_failed: ['پرنٹر سے رابطہ نہیں ہو سکا۔', 'Could not connect to the printer.'],
    not_connected: ['پرنٹر منسلک نہیں ہے۔', 'The printer is not connected.'],
    print_failed: ['پرنٹ ناکام ہوا۔ دوبارہ کوشش کریں۔', 'Print failed. Please retry.'],
    connect_cancelled: ['رابطہ منسوخ ہو گیا۔ دوبارہ کوشش کریں۔', 'Connection was cancelled. Please try again.'],
    invalid_address: ['غلط پرنٹر ایڈریس۔', 'Invalid printer address.'],
    invalid_data: ['ڈیٹا کا مسئلہ۔ دوبارہ کوشش کریں۔', 'A data problem occurred. Please retry.'],
    list_failed: ['فہرست حاصل نہیں ہو سکی۔', 'Could not load the device list.'],
    status_failed: ['پرنٹر کی صورتحال معلوم نہیں ہو سکی۔', 'Could not check printer status.'],
    activity_destroyed: ['ایپ بند ہو گئی، دوبارہ کوشش کریں۔', 'The app was closed. Please try again.']
  };
  const pair = map[code] || ['پرنٹر کا مسئلہ۔', 'A printer problem occurred.'];
  return t(pair[0], pair[1]);
}

async function printInvoiceViaPrinter(invoice) {
  await ensurePrinterConnected();
  const plugin = getActivePlugin();
  const invoiceForPrint = { ...invoice, dateTimeLabel: formatDateTime(invoice.created_at) };
  const base64 = await ReceiptImage.buildReceiptRasterBase64(invoiceForPrint, shopConfig, printerState.paperWidth);
  await plugin.printRaw({ bytes: base64 });
}

async function printInvoice(invoice, retry = false) {
  try {
    if (!printerState.address) throw new Error('no_printer_selected');
    await printInvoiceViaPrinter(invoice);
    try { await db.updateInvoice(invoice.id, { print_status: 'requested', last_print_requested_at: new Date().toISOString() }); } catch (_) { /* Invoice is already safe. */ }
    if (retry) hideBanner();
    showToast(t('پرنٹ بھیج دیا گیا۔', 'Sent to printer.'));
    return true;
  } catch (err) {
    printerState.connected = false;
    try { await db.updateInvoice(invoice.id, { print_status: 'failed', last_print_error_at: new Date().toISOString() }); } catch (_) { /* Keep recovery UI available. */ }
    const code = printerErrorCode(err);
    const isNoPrinter = code === 'no_printer_selected' || code === 'no_address';
    showBanner(
      t(`${invoice.invoiceNumber} محفوظ ہے۔ ${printerErrorMessage(code)}`, `${invoice.invoiceNumber} is saved. ${printerErrorMessage(code)}`),
      isNoPrinter ? t('پرنٹر منتخب کریں', 'Select printer') : t('دوبارہ پرنٹ', 'Retry print'),
      async () => {
        if (isNoPrinter) {
          openSettingsPanel('printer');
        } else {
          const saved = await db.getInvoice(invoice.id);
          if (saved) await printInvoice(saved, true);
        }
      }
    );
    return false;
  }
}

async function completeSale() {
  if (saleInProgress || !cart.length || licenseState.expired) return;
  saleInProgress = true;
  const button = byId('completeSaleBtn');
  const message = byId('checkoutMessage');
  message.className = 'form-message';
  message.textContent = '';
  setButtonBusy(button, true, 'فروخت محفوظ ہو رہی ہے…', 'Saving sale…');  const totals = currentTotals();
  const tenderedValue = Number(byId('tenderedInput').value);
  const hasTendered = Number.isFinite(tenderedValue) && tenderedValue > 0;
  let invoice;
  try {
    invoice = await db.saveInvoice({
      customerName,
      items: cart.map(item => ({ ...item })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      total: totals.total,
      paymentMethod: selectedPaymentMethod,
      tendered: hasTendered ? tenderedValue : 0,
      change: hasTendered ? Math.max(0, tenderedValue - totals.total) : 0
    });
  } catch (_) {
    message.className = 'form-message error';
    message.textContent = t('فروخت محفوظ نہیں ہو سکی۔ دوبارہ کوشش کریں۔', 'The sale could not be saved. Please retry.');
    saleInProgress = false;
    setButtonBusy(button, false, '', '');
    renderCheckout();
    return;
  }

  // The invoice is now permanently saved. Printing and UI cleanup are
  // recovery actions and must never be presented as an invoice save failure.
  cart = [];
  customerName = '';
  discountAmount = 0;
  try { await db.clearSaleDraft(); } catch (_) { /* Saved invoice remains authoritative. */ }
  renderDynamicUI();
  await refreshStockAlertBadge();
  try { await loadReportTab(currentReportTab); } catch (_) { /* Refresh reports on next visit. */ }
  showToast(t(`${invoice.invoiceNumber} محفوظ ہو گیا۔`, `${invoice.invoiceNumber} saved.`));
  requestCloseTask();

  if (printerState.autoPrint) {
    setButtonBusy(button, true, 'پرنٹ ہو رہا ہے…', 'Printing…');
    try { await printInvoice(invoice); } catch (_) {
      showBanner(
        t(`${invoice.invoiceNumber} محفوظ ہے؛ رپورٹس سے دوبارہ پرنٹ کریں۔`, `${invoice.invoiceNumber} is saved; retry printing from Reports.`)
      );
    }
  }
  saleInProgress = false;
  setButtonBusy(button, false, '', '');
  renderCheckout();
}

async function loadReportTab(tab) {
  currentReportTab = tab;
  document.querySelectorAll('.report-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  currentReportSummary = tab === 'today'
    ? await db.getDailySummary()
    : await db.getMonthlySummary(core.currentLocalYearMonth());
  renderReportSummary();
  renderInvoiceList();
  await renderSalesGraph();
}

// --- Reports: daily sales graph --------------------------------------------
// A plain Canvas bar chart — no charting library, so the app stays fully
// offline and the bundle stays small. Always shows the last 7 calendar days
// (today included) regardless of the Today/Month tab selection above, since
// a single day has nothing to trend against.
function formatThousands(value) {
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  if (Math.abs(rounded) >= 1000) {
    const thousands = rounded / 1000;
    return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
  }
  return String(rounded);
}

async function renderSalesGraph() {
  const canvas = byId('salesGraphCanvas');
  if (!canvas) return;
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const days = await db.getDailyBreakdown(core.localDateString(start), core.localDateString(today));

  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
  const cssHeight = 140;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const maxTotal = Math.max(...days.map(day => day.total), 1);
  const topPad = 20;
  const bottomPad = 18;
  const barAreaHeight = cssHeight - topPad - bottomPad;
  const gap = 10;
  const barWidth = (cssWidth - gap * (days.length + 1)) / days.length;
  const todayKey = core.localDateString(today);

  ctx.textAlign = 'center';
  days.forEach((day, index) => {
    const x = gap + index * (barWidth + gap);
    const barHeight = Math.max(2, (day.total / maxTotal) * barAreaHeight);
    const y = topPad + (barAreaHeight - barHeight);
    const isToday = day.date === todayKey;

    ctx.fillStyle = isToday ? '#0F9F6E' : '#8FD9BE';
    const radius = Math.min(6, barWidth / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + barHeight);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.lineTo(x + barWidth - radius, y);
    ctx.arcTo(x + barWidth, y, x + barWidth, y + radius, radius);
    ctx.lineTo(x + barWidth, y + barHeight);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#2A2E2C';
    ctx.font = '600 10px Roboto, system-ui, sans-serif';
    if (day.total > 0) ctx.fillText(formatThousands(day.total), x + barWidth / 2, Math.max(11, y - 6));

    const dayNumber = String(new Date(day.date + 'T00:00:00').getDate());
    ctx.fillStyle = isToday ? '#0F9F6E' : '#667069';
    ctx.font = isToday ? '700 11px Roboto, system-ui, sans-serif' : '600 11px Roboto, system-ui, sans-serif';
    ctx.fillText(dayNumber, x + barWidth / 2, cssHeight - 4);
  });
}

function renderReportSummary() {
  const summary = currentReportSummary || { totalRevenue: 0, totalInvoices: 0, totalItems: 0, grossProfit: 0, profitIsPartial: false, itemsWithoutCost: 0 };
  const hasAnyCostData = (summary.itemsWithCost || 0) > 0;
  const profitValue = hasAnyCostData
    ? `<strong>${money(summary.grossProfit)}</strong>`
    : `<strong class="metric-muted">—</strong>`;
  byId('reportSummary').innerHTML = `
    <div class="summary-metric"><span>${t('کل فروخت', 'Sales')}</span><strong>${money(summary.totalRevenue)}</strong></div>
    <div class="summary-metric"><span>${t('انوائس', 'Invoices')}</span><strong>${summary.totalInvoices}</strong></div>
    <div class="summary-metric"><span>${t('مقدار', 'Quantity')}</span><strong>${summary.totalItems}</strong></div>
    <div class="summary-metric profit-metric"><span>${t('منافع', 'Profit')}</span>${profitValue}</div>`;
  byId('profitNote').classList.toggle('hidden', !summary.profitIsPartial);
  if (summary.profitIsPartial) {
    byId('profitNote').textContent = hasAnyCostData
      ? t(`${summary.itemsWithoutCost} اشیاء کی خرید قیمت درج نہیں — ان کا منافع شامل نہیں۔`, `${summary.itemsWithoutCost} item(s) have no purchase price — their profit is not included.`)
      : t('کسی مصنوعات کی خرید قیمت درج نہیں — اسٹاک سکرین سے شامل کریں۔', 'No products have a purchase price yet — add one from the Stock screen.');
  }
}

function renderInvoiceList() {
  const invoices = currentReportSummary?.invoices || [];
  const list = byId('reportList');
  if (!invoices.length) {
    list.innerHTML = `<div class="empty-state"><strong>${t('کوئی انوائس نہیں', 'No invoices')}</strong><span>${t('اس مدت میں کوئی فروخت محفوظ نہیں ہوئی۔', 'No sales were saved in this period.')}</span></div>`;
    return;
  }
  list.innerHTML = invoices.map(invoice => {
    const quantity = (invoice.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    return `<button class="invoice-row" data-invoice-id="${invoice.id}"><span><strong>${core.escapeHTML(invoice.invoiceNumber)}</strong><small>${core.escapeHTML(formatDateTime(invoice.created_at))} · ${quantity} ${t('مقدار', 'qty')}</small>${invoice.print_status === 'failed' ? `<small class="print-failed">${t('پرنٹ باقی ہے', 'Print pending')}</small>` : ''}</span><span class="invoice-total">${money(invoice.total)}</span></button>`;
  }).join('');
  list.querySelectorAll('.invoice-row').forEach(row => row.addEventListener('click', () => openInvoiceDetail(row.dataset.invoiceId)));
}

async function openInvoiceDetail(id) {
  const invoice = await db.getInvoice(id);
  if (!invoice) return;
  activeInvoiceId = invoice.id;
  byId('invoiceDetailNumber').textContent = invoice.invoiceNumber;
  const itemRows = (invoice.items || []).map(item => `<div class="invoice-detail-item"><span><strong>${core.escapeHTML(item.name)}</strong><small>${item.quantity} × ${money(item.price)}</small></span><strong class="mono">${money(item.price * item.quantity)}</strong></div>`).join('');
  byId('invoiceDetailBody').innerHTML = `
    <div class="invoice-meta"><div>${core.escapeHTML(formatDateTime(invoice.created_at))}</div>${invoice.customer_name ? `<div>${t('کسٹمر', 'Customer')}: ${core.escapeHTML(invoice.customer_name)}</div>` : ''}<div>${t('ادائیگی', 'Payment')}: ${core.escapeHTML(invoice.payment_method || 'Cash')}</div>${invoice.print_status === 'failed' ? `<div class="warning">${t('پرنٹ دوبارہ کوشش طلب ہے۔', 'Print retry is required.')}</div>` : ''}</div>
    <div>${itemRows}</div><div class="invoice-detail-totals"><div class="invoice-total-line"><span>${t('سب ٹوٹل', 'Subtotal')}</span><span>${money(invoice.subtotal)}</span></div>${invoice.discount > 0 ? `<div class="invoice-total-line"><span>${t('ڈسکاؤنٹ', 'Discount')}</span><span>−${money(invoice.discount)}</span></div>` : ''}<div class="invoice-total-line grand"><span>${t('کل', 'Total')}</span><span>${money(invoice.total)}</span></div></div>`;
  openTask('invoiceDetailTask');
}

function buildReportHTML(summary, title) {
  const rows = (summary.invoices || []).map(invoice => {
    const qty = (invoice.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    return `<tr><td>${core.escapeHTML(invoice.invoiceNumber)}</td><td>${core.escapeHTML(formatDateTime(invoice.created_at))}</td><td class="num">${qty}</td><td class="num">${Math.round(invoice.total)}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:12px Arial,sans-serif;color:#000}h1{font-size:20px;margin:0}.muted{color:#444;margin:4px 0 14px}.summary{display:flex;gap:24px;border:1px solid #000;padding:10px;margin-bottom:14px}.summary b{display:block;font-size:16px}table{width:100%;border-collapse:collapse}th,td{padding:6px;border-bottom:1px solid #bbb;text-align:left}.num{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:bold;border-top:2px solid #000}.footer{text-align:center;margin-top:20px;font-size:10px}</style></head><body><h1>${core.escapeHTML(shopConfig.shopName)} — ${core.escapeHTML(title)}</h1><div class="muted">${core.escapeHTML(summary.startDate)} — ${core.escapeHTML(summary.endDate)}</div><div class="summary"><span>Sales<b>${money(summary.totalRevenue)}</b></span><span>Invoices<b>${summary.totalInvoices}</b></span><span>Quantity<b>${summary.totalItems}</b></span></div><table><thead><tr><th>Invoice</th><th>Date & time</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">${money(summary.totalRevenue)}</td></tr></tfoot></table><div class="footer">Powered by Adeel IT Solutions</div></body></html>`;
}

async function exportCurrentReport() {
  if (!currentReportSummary?.invoices?.length) {
    showToast(t('برآمد کرنے کیلئے کوئی انوائس نہیں۔', 'There are no invoices to export.'));
    return;
  }
  const title = currentReportTab === 'today' ? t('آج کی رپورٹ', 'Today report') : t('ماہانہ رپورٹ', 'Monthly report');
  try {
    await requestPrint(buildReportHTML(currentReportSummary, title));
    showToast(t('PDF محفوظ کرنے کیلئے پرنٹ ڈائیلاگ استعمال کریں۔', 'Use the print dialog to save as PDF.'));
  } catch (_) {
    showBanner(t('رپورٹ پرنٹ ڈائیلاگ نہیں کھل سکا۔', 'The report print dialog could not open.'));
  }
}

function renderProductManagement() {
  const query = core.normalizeText(productSearch);
  const list = products.filter(product => !query || core.normalizeText(product.name).includes(query));
  byId('productCountText').textContent = productCountLabel(list.length);
  const container = byId('productManageList');
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><strong>${t('کوئی مصنوعات نہیں', 'No products')}</strong><span>${t('نئی مصنوعات شامل کریں یا CSV درآمد کریں۔', 'Add a product or import a CSV file.')}</span></div>`;
  } else {
    container.innerHTML = list.map(product => `
      <div class="product-row">
        <div class="product-row-top">
          <span><strong>${core.escapeHTML(product.name)}</strong><small>${product.sectionId ? core.escapeHTML(sectionName(product.sectionId)) : t('بغیر سیکشن', 'No section')}${product.isQuick ? ` · ${t('فوری', 'Quick')}` : ''}</small></span>
          <span class="product-price">${money(product.price)}</span>
        </div>
        <div class="card-action-bar">
          <button class="btn-card-action" data-edit-product="${core.escapeHTML(product.id)}">✎ ${t('تبدیل کریں', 'Edit')}</button>
          <button class="btn-card-action" data-dup-product="${core.escapeHTML(product.id)}">📋 ${t('ڈپلیکیٹ', 'Duplicate')}</button>
        </div>
      </div>`).join('');

    container.querySelectorAll('[data-edit-product]').forEach(btn => btn.addEventListener('click', () => openProductEditor(btn.dataset.editProduct)));
    container.querySelectorAll('[data-dup-product]').forEach(btn => btn.addEventListener('click', () => duplicateProduct(btn.dataset.dupProduct)));
  }
  renderSectionsManagement();
}

async function duplicateProduct(id) {
  const original = products.find(p => p.id === id);
  if (!original) return;
  const clone = {
    ...original,
    id: `prod_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: `${original.name} (${t('کاپی', 'Copy')})`
  };
  products.push(clone);
  await db.setProducts(products);
  await db.createBackup('product_duplicate');
  renderProductManagement();
  showToast(t('مصنوعات کاپی ہو گئی۔', 'Product duplicated successfully.'));
}

function renderSectionsManagement() {
  byId('sectionsEnabledToggle').checked = sectionsEnabled;
  const container = byId('sectionManageList');
  const list = activeSections();
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><strong>${t('کوئی سیکشن نہیں', 'No sections')}</strong><span>${t('سیکشن اختیاری ہیں۔ ضرورت ہو تو شامل کریں۔', 'Sections are optional. Add them only when needed.')}</span></div>`;
    return;
  }
  container.innerHTML = list.map(section => {
    const count = products.filter(product => product.sectionId === section.id).length;
    return `<button class="section-row" data-section-id="${core.escapeHTML(section.id)}"><span><strong>${core.escapeHTML(section.name)}</strong><small>${productCountLabel(count)}</small></span><b>›</b></button>`;
  }).join('');
  container.querySelectorAll('.section-row').forEach(row => row.addEventListener('click', () => openSectionEditor(row.dataset.sectionId)));
}

function fillProductSectionSelect(selectedId = '') {
  const select = byId('productSectionSelect');
  select.innerHTML = `<option value="">${t('بغیر سیکشن', 'No section')}</option>${activeSections().map(section => `<option value="${core.escapeHTML(section.id)}">${core.escapeHTML(section.name)}</option>`).join('')}`;
  select.value = selectedId || '';
}

function openProductEditor(id = null) {
  editingProductId = id;
  const product = products.find(item => item.id === id);
  byId('productEditorTitle').textContent = product ? t('مصنوعات تبدیل کریں', 'Edit product') : t('نئی مصنوعات', 'New product');
  byId('productNameInput').value = product?.name || '';
  byId('productPriceInput').value = product?.price || '';
  fillProductSectionSelect(product?.sectionId || '');
  byId('productQuickToggle').checked = product ? Boolean(product.isQuick) : false;
  byId('deleteProductBtn').classList.toggle('hidden', !product);
  byId('productEditorMessage').textContent = '';
  openTask('productEditorTask');
  setTimeout(() => byId('productNameInput').focus(), 80);
}

async function saveProduct() {
  const name = byId('productNameInput').value.trim().replace(/\s+/g, ' ').slice(0, 80);
  const price = Number(byId('productPriceInput').value);
  const message = byId('productEditorMessage');
  if (!name || !Number.isFinite(price) || price <= 0) {
    message.textContent = t('درست نام اور قیمت درج کریں۔', 'Enter a valid name and price.');
    return;
  }
  const duplicate = products.find(product => product.id !== editingProductId && core.normalizeText(product.name) === core.normalizeText(name));
  if (duplicate) {
    message.textContent = t('اس نام کی مصنوعات پہلے موجود ہے۔', 'A product with this name already exists.');
    return;
  }
  if (editingProductId) {
    products = products.map(product => product.id === editingProductId ? { ...product, name, price, sectionId: byId('productSectionSelect').value, isQuick: byId('productQuickToggle').checked } : product);
  } else {
    products.push({ id: db.makeId('p'), name, price, sectionId: byId('productSectionSelect').value, isQuick: byId('productQuickToggle').checked, active: true });
  }
  await db.setProducts(products);
  await db.createBackup('product_change');
  products = await db.getProducts();
  renderDynamicUI();
  requestCloseTask();
  showToast(t('مصنوعات محفوظ ہو گئی۔', 'Product saved.'));
}

function openConfirmModal({ title, text, icon = '⚠️', type = 'danger', okText, cancelText, onConfirm }) {
  byId('confirmModalTitle').textContent = title || t('تصدیق کریں', 'Confirm');
  byId('confirmModalText').textContent = text || '';
  byId('confirmModalIcon').textContent = icon;
  byId('confirmModalIcon').className = `modal-icon-wrapper ${type}`;

  const okBtn = byId('confirmModalOkBtn');
  const cancelBtn = byId('confirmModalCancelBtn');
  if (okText) okBtn.textContent = okText;
  if (cancelText) cancelBtn.textContent = cancelText;

  const modal = byId('confirmModal');
  modal.classList.remove('hidden');

  const closeModal = () => {
    modal.classList.add('hidden');
    const newOk = okBtn.cloneNode(true);
    const newCancel = cancelBtn.cloneNode(true);
    okBtn.replaceWith(newOk);
    cancelBtn.replaceWith(newCancel);
  };

  byId('confirmModalCancelBtn').onclick = closeModal;
  byId('confirmModalOkBtn').onclick = async () => {
    closeModal();
    if (onConfirm) await onConfirm();
  };
}

async function deleteProduct() {
  const product = products.find(item => item.id === editingProductId);
  if (!product) return;
  openConfirmModal({
    title: t('مصنوعات حذف کریں', 'Delete Product'),
    text: t(`“${product.name}” حذف کریں؟ پرانے انوائس تبدیل نہیں ہوں گے۔`, `Delete “${product.name}”? Old invoices will not change.`),
    type: 'danger',
    onConfirm: async () => {
      products = products.filter(item => item.id !== editingProductId);
      await db.setProducts(products);
      await db.createBackup('product_delete');
      requestCloseTask();
      renderDynamicUI();
      showToast(t('مصنوعات حذف ہو گئی۔', 'Product deleted.'));
    }
  });
}

function openSectionEditor(id = null) {
  editingSectionId = id;
  const section = sections.find(item => item.id === id);
  byId('sectionNameInput').value = section?.name || '';
  byId('deleteSectionBtn').classList.toggle('hidden', !section);
  byId('sectionEditorMessage').textContent = '';
  openTask('sectionEditorTask');
  setTimeout(() => byId('sectionNameInput').focus(), 80);
}

async function saveSection() {
  const name = byId('sectionNameInput').value.trim().replace(/\s+/g, ' ').slice(0, 40);
  const message = byId('sectionEditorMessage');
  if (!name) { message.textContent = t('سیکشن کا نام درج کریں۔', 'Enter a section name.'); return; }
  if (sections.some(section => section.id !== editingSectionId && core.normalizeText(section.name) === core.normalizeText(name))) {
    message.textContent = t('یہ سیکشن پہلے موجود ہے۔', 'This section already exists.');
    return;
  }
  const isNewSection = !editingSectionId;
  if (editingSectionId) sections = sections.map(section => section.id === editingSectionId ? { ...section, name } : section);
  else sections.push({ id: db.makeId('s'), name, order: sections.length, active: true });
  await db.setSections(sections);
  sections = await db.getSections();
  if (isNewSection && !sectionsEnabled) {
    sectionsEnabled = true;
    await db.setSetting('sectionsEnabled', 'true');
    const toggle = byId('sectionsEnabledToggle');
    if (toggle) toggle.checked = true;
  }
  renderDynamicUI();
  requestCloseTask();
}

async function deleteSection() {
  const section = sections.find(item => item.id === editingSectionId);
  if (!section) return;
  const count = products.filter(product => product.sectionId === section.id).length;
  openConfirmModal({
    title: t('سیکشن حذف کریں', 'Delete Section'),
    text: t(`“${section.name}” حذف کریں؟ ${count} مصنوعات بغیر سیکشن ہو جائیں گی۔`, `Delete “${section.name}”? ${count} products will become unsectioned.`),
    type: 'danger',
    onConfirm: async () => {
      products = products.map(product => product.sectionId === section.id ? { ...product, sectionId: '' } : product);
      sections = sections.filter(item => item.id !== section.id);
      await db.setProducts(products);
      await db.setSections(sections);
      await db.createBackup('section_delete');
      requestCloseTask();
      renderDynamicUI();
      showToast(t('سیکشن حذف ہو گیا۔', 'Section deleted.'));
    }
  });
}

function switchProductTab(tab) {
  document.querySelectorAll('.products-subtab').forEach(button => {
    button.classList.toggle('active', button.dataset.productTab === tab);
  });
  const productsPane = byId('productsPane');
  const sectionsPane = byId('sectionsPane');
  if (tab === 'products') {
    productsPane.classList.remove('hidden');
    sectionsPane.classList.add('hidden');
    renderProductManagement();
  } else {
    sectionsPane.classList.remove('hidden');
    productsPane.classList.add('hidden');
    renderSectionsManagement();
  }
}

// --- Stock management ----------------------------------------------------
let activeStockProductId = '';

function stockSummaryChipsHTML(products) {
  const tracked = products.filter(product => product.trackStock !== false);
  const outCount = tracked.filter(product => stockStateOf(product) === 'out').length;
  const lowCount = tracked.filter(product => stockStateOf(product) === 'low').length;
  const stockValue = tracked.reduce((sum, product) => sum + (Number(product.stock) || 0) * (Number(product.cost) || 0), 0);
  return `
    <div class="stock-chip ${outCount ? 'danger' : ''}"><strong>${outCount}</strong><span>${t('ختم', 'Out')}</span></div>
    <div class="stock-chip ${lowCount ? 'warn' : ''}"><strong>${lowCount}</strong><span>${t('کم', 'Low')}</span></div>
    <div class="stock-chip"><strong>${Math.round(stockValue)}</strong><span>${t('اسٹاک قیمت', 'Stock value')}</span></div>`;
}

async function renderStockHistory() {
  const history = await db.getStockHistory();
  const list = byId('stockHistoryList');
  if (!history.length) {
    list.innerHTML = `<p class="empty-note">${t('ابھی کوئی ریکارڈ نہیں۔', 'No history yet.')}</p>`;
    return;
  }
  const reasonLabel = { sale: t('فروخت', 'Sale'), manual: t('دستی', 'Manual'), csv_import: t('CSV درآمد', 'CSV import') };
  list.innerHTML = history.map(entry => `
    <div class="settings-row stock-history-row">
      <span class="settings-icon ${entry.delta > 0 ? 'plus' : 'minus'}">${entry.delta > 0 ? '+' : ''}${entry.delta}</span>
      <span><strong>${core.escapeHTML(entry.name)}</strong><small>${reasonLabel[entry.reason] || entry.reason} · ${core.escapeHTML(formatDateTime(entry.at))}</small></span>
    </div>`).join('');
}

function stockStateOf(product) {
  // Shops that never turned stock tracking on start every product at 0
  // quantity by default, which used to read as "out of stock" everywhere —
  // a permanent, unwanted nav badge for shopkeepers who don't use this
  // feature at all. When the shop-level switch is off, nothing is ever
  // flagged low/out, here or anywhere else that calls this function.
  if (!stockTrackingEnabled) return 'untracked';
  if (product.trackStock === false) return 'untracked';
  const stock = Number(product.stock) || 0;
  const lowAt = Number(product.lowStockAt) || 0;
  if (stock <= 0) return 'out';
  if (lowAt > 0 && stock <= lowAt) return 'low';
  return 'ok';
}

async function loadStockTrackingSetting() {
  const stored = await db.getSetting('stockTrackingEnabled', null);
  if (stored === null) {
    // Never explicitly set — either a brand-new install, or an existing
    // shop updating from before this switch existed. Auto-detect real
    // usage so nothing changes for a shop that was already tracking stock;
    // a shop that never touched stock (the common complaint) starts off.
    const hasUsedStock = products.some(product =>
      (Number(product.stock) || 0) > 0 || (Number(product.lowStockAt) || 0) > 0 || product.trackStock === false);
    stockTrackingEnabled = hasUsedStock;
    await db.setSetting('stockTrackingEnabled', String(stockTrackingEnabled));
  } else {
    stockTrackingEnabled = stored === 'true';
  }
}

async function refreshStockAlertBadge() {
  const list = await db.getProducts();
  const alertCount = list.filter(product => ['low', 'out'].includes(stockStateOf(product))).length;
  const badge = byId('stockAlertBadge');
  badge.textContent = alertCount > 99 ? '99+' : String(alertCount);
  badge.classList.toggle('hidden', alertCount === 0);
}

async function renderStockManagement() {
  byId('stockTrackingEnabledToggle').checked = stockTrackingEnabled;
  const products = await db.getProducts();
  const query = core.normalizeText(byId('stockSearchInput').value || '');
  const lowOnly = byId('lowStockOnlyToggle').checked;

  const missingCost = products.filter(product => !(Number(product.cost) > 0)).length;
  byId('stockSummary').innerHTML = stockSummaryChipsHTML(products);

  let list = products;
  if (query) list = list.filter(product => core.normalizeText(product.name).includes(query));
  if (lowOnly) list = list.filter(product => ['low', 'out'].includes(stockStateOf(product)));

  byId('stockCountText').textContent = missingCost
    ? t(`${list.length} مصنوعات · ${missingCost} کی خرید قیمت نہیں`, `${list.length} products · ${missingCost} without purchase price`)
    : t(`${list.length} مصنوعات`, `${list.length} products`);

  if (!list.length) {
    byId('stockManageList').innerHTML = `<p class="empty-note">${t('کوئی مصنوعات نہیں ملی۔', 'No products found.')}</p>`;
    return;
  }

  byId('stockManageList').innerHTML = list.map(product => {
    const state = stockStateOf(product);
    const stock = Number(product.stock) || 0;
    const badge = state === 'untracked'
      ? `<span class="stock-badge muted">${t('ٹریک نہیں', 'Not tracked')}</span>`
      : `<span class="stock-badge ${state}">${stock}</span>`;
    const costLine = Number(product.cost) > 0
      ? `${t('خرید', 'Cost')} ${Math.round(product.cost)}`
      : `<span class="warn-text">${t('خرید قیمت نہیں', 'No purchase price')}</span>`;
    return `
      <div class="stock-card-row" data-edit-stock="${core.escapeHTML(product.id)}" style="cursor: pointer;">
        <div class="stock-card-top">
          ${badge}
          <span><strong>${core.escapeHTML(product.name)}</strong><small>${t('قیمت', 'Price')} ${Math.round(product.price)} · ${costLine}</small></span>
          <button class="btn btn-secondary btn-compact" type="button">✎ ${t('تبدیل', 'Edit')}</button>
        </div>
      </div>`;
  }).join('');

  byId('stockManageList').querySelectorAll('[data-edit-stock]').forEach(card => {
    card.addEventListener('click', () => openStockEditor(card.dataset.editStock));
  });
}

async function quickAdjustStock(id, delta) {
  const productList = await db.getProducts();
  const product = productList.find(p => p.id === id);
  if (!product) return;
  const current = Number(product.stock) || 0;
  product.stock = Math.max(0, current + delta);
  await db.setProducts(productList);
  products = productList;
  await db.createBackup('stock_quick_adjust');
  await refreshStockAlertBadge();
  await renderStockManagement();
  showToast(t(`اسٹاک اپ ڈیٹ: ${product.stock}`, `Stock updated: ${product.stock}`));
}

async function openStockEditor(productId) {
  const products = await db.getProducts();
  const product = products.find(entry => entry.id === productId);
  if (!product) return;
  activeStockProductId = productId;
  byId('stockEditorTitle').textContent = t('اسٹاک', 'Stock');
  byId('stockEditorProduct').innerHTML = `<strong>${core.escapeHTML(product.name)}</strong>`;
  byId('stockValueInput').value = Number(product.stock) || 0;
  byId('stockSalePriceInput').value = Number(product.price) || 0;
  byId('stockCostInput').value = Number(product.cost) > 0 ? product.cost : '';
  byId('stockLowAtInput').value = Number(product.lowStockAt) || '';
  byId('stockTrackToggle').checked = product.trackStock !== false;
  byId('stockEditorMessage').textContent = '';
  byId('stockEditorMessage').className = 'form-message';
  openTask('stockEditorTask');
}

function bumpStockValue(delta) {
  const input = byId('stockValueInput');
  const current = Math.trunc(Number(input.value) || 0);
  input.value = Math.max(0, current + delta);
}

async function saveStockEditor() {
  const message = byId('stockEditorMessage');
  const stock = Math.trunc(Number(byId('stockValueInput').value) || 0);
  const salePrice = Number(byId('stockSalePriceInput').value);
  const costRaw = byId('stockCostInput').value.trim();
  const cost = costRaw === '' ? 0 : Number(costRaw);
  const lowAt = Math.max(0, Math.trunc(Number(byId('stockLowAtInput').value) || 0));

  if (stock < 0) {
    message.className = 'form-message error';
    message.textContent = t('اسٹاک منفی نہیں ہو سکتا۔', 'Stock cannot be negative.');
    return;
  }
  if (!Number.isFinite(salePrice) || salePrice <= 0) {
    message.className = 'form-message error';
    message.textContent = t('فروخت قیمت درست نہیں۔', 'Sale price is not valid.');
    return;
  }
  if (costRaw !== '' && (!Number.isFinite(cost) || cost < 0)) {
    message.className = 'form-message error';
    message.textContent = t('خرید قیمت درست نہیں۔', 'Purchase price is not valid.');
    return;
  }

  const products = await db.getProducts();
  const product = products.find(entry => entry.id === activeStockProductId);
  if (!product) return;

  // A purchase price above the selling price is allowed (clearance sales do
  // happen) but it means this product sells at a loss, so it is worth saying
  // plainly rather than letting a typo quietly distort the profit report.
  const sellsAtLoss = cost > 0 && cost > salePrice;
  const stockDelta = stock - (Number(product.stock) || 0);

  product.stock = stock;
  product.price = salePrice;
  product.cost = cost;
  product.lowStockAt = lowAt;
  product.trackStock = byId('stockTrackToggle').checked;
  await db.setProducts(products);
  if (stockDelta !== 0) await db.logStockChange(product.name, stockDelta, 'manual');

  requestCloseTask();
  await renderStockManagement();
  await refreshStockAlertBadge();
  showToast(sellsAtLoss
    ? t('محفوظ ہو گیا — خرید قیمت فروخت سے زیادہ ہے۔', 'Saved — purchase price is higher than selling price.')
    : t('اسٹاک محفوظ ہو گیا۔', 'Stock saved.'));
}

function prepareImportPreview(parsed) {
  const unique = new Map();
  let duplicateCsvRows = 0;
  parsed.products.forEach(product => {
    const key = core.normalizeText(product.name);
    if (unique.has(key)) duplicateCsvRows += 1;
    unique.set(key, product);
  });
  const importProducts = Array.from(unique.values());
  const existingNames = new Set(products.map(product => core.normalizeText(product.name)));
  const existingSectionNames = new Set(sections.map(section => core.normalizeText(section.name)));
  const newSectionNames = Array.from(new Set(importProducts.map(product => product.section).filter(Boolean).map(name => name.trim())))
    .filter(name => !existingSectionNames.has(core.normalizeText(name)));
  pendingImport = {
    parsed,
    products: importProducts,
    newCount: importProducts.filter(product => !existingNames.has(core.normalizeText(product.name))).length,
    updateCount: importProducts.filter(product => existingNames.has(core.normalizeText(product.name))).length,
    rejectedCount: parsed.rejected.length + duplicateCsvRows,
    noSectionCount: importProducts.filter(product => !product.section).length,
    newSectionNames
  };
  byId('csvImportSummary').innerHTML = `
    <div class="import-metric"><span>${t('درست مصنوعات', 'Valid products')}</span><strong>${importProducts.length}</strong></div>
    <div class="import-metric"><span>${t('نئی مصنوعات', 'New products')}</span><strong>${pendingImport.newCount}</strong></div>
    <div class="import-metric"><span>${t('اپ ڈیٹ ہوں گی', 'Will update')}</span><strong>${pendingImport.updateCount}</strong></div>
    <div class="import-metric"><span>${t('نئے سیکشن', 'New sections')}</span><strong>${newSectionNames.length}</strong></div>
    <div class="import-metric"><span>${t('بغیر سیکشن', 'Without section')}</span><strong>${pendingImport.noSectionCount}</strong></div>
    <div class="import-metric"><span>${t('رد / ڈپلیکیٹ قطاریں', 'Rejected / duplicate rows')}</span><strong>${pendingImport.rejectedCount}</strong></div>
    ${(parsed.hasStockColumn || parsed.hasCostColumn) ? `<p class="field-hint">${t('اسٹاک اور/یا خرید قیمت بھی اپ ڈیٹ ہوں گے۔', 'Stock and/or purchase price will be updated too.')}</p>` : ''}`;
  const sectionRow = byId('enableSectionsImportRow');
  sectionRow.classList.toggle('hidden', !parsed.hasSectionColumn || importProducts.every(product => !product.section));
  byId('enableSectionsAfterImport').checked = sectionsEnabled || !sectionRow.classList.contains('hidden');
  byId('csvImportMessage').textContent = '';
  openTask('csvImportTask');
}

async function applyCsvImport() {
  if (!pendingImport) return;
  const button = byId('confirmCsvImportBtn');
  setButtonBusy(button, true, 'درآمد ہو رہی ہے…', 'Importing…');
  try {
    await db.createBackup('before_csv_import');
    const nextSections = sections.map(section => ({ ...section }));
    pendingImport.newSectionNames.forEach(name => nextSections.push({ id: db.makeId('s'), name, order: nextSections.length, active: true }));
    const sectionMap = new Map(nextSections.map(section => [core.normalizeText(section.name), section.id]));
    const nextProducts = products.map(product => ({ ...product }));
    const productMap = new Map(nextProducts.map((product, index) => [core.normalizeText(product.name), index]));
    const historyEntries = [];
    pendingImport.products.forEach(imported => {
      const key = core.normalizeText(imported.name);
      const sectionId = imported.section ? sectionMap.get(core.normalizeText(imported.section)) || '' : '';
      if (productMap.has(key)) {
        const index = productMap.get(key);
        const existing = nextProducts[index];
        if (imported.stock !== undefined) {
          const delta = imported.stock - (Number(existing.stock) || 0);
          if (delta !== 0) historyEntries.push({ name: imported.name, delta, reason: 'csv_import' });
        }
        nextProducts[index] = {
          ...existing,
          name: imported.name,
          price: imported.price,
          sectionId: pendingImport.parsed.hasSectionColumn ? sectionId : existing.sectionId,
          stock: imported.stock !== undefined ? imported.stock : existing.stock,
          cost: imported.cost !== undefined ? imported.cost : existing.cost
        };
      } else if (nextProducts.length < 500) {
        productMap.set(key, nextProducts.length);
        const newProduct = { id: db.makeId('p'), name: imported.name, price: imported.price, sectionId, isQuick: false, active: true };
        if (imported.stock !== undefined) {
          newProduct.stock = imported.stock;
          if (imported.stock > 0) historyEntries.push({ name: imported.name, delta: imported.stock, reason: 'csv_import' });
        }
        if (imported.cost !== undefined) newProduct.cost = imported.cost;
        nextProducts.push(newProduct);
      }
    });
    await db.logStockChangesBatch(historyEntries);
    await db.setSections(nextSections);
    await db.setProducts(nextProducts);
    if (!byId('enableSectionsImportRow').classList.contains('hidden')) {
      sectionsEnabled = byId('enableSectionsAfterImport').checked;
      await db.setSetting('sectionsEnabled', String(sectionsEnabled));
    }
    sections = await db.getSections();
    products = await db.getProducts();
    pendingImport = null;
    renderDynamicUI();
    requestCloseTask();
    showToast(t('CSV مصنوعات کامیابی سے درآمد ہو گئیں۔', 'CSV products imported successfully.'));
  } catch (_) {
    byId('csvImportMessage').textContent = t('CSV درآمد نہیں ہو سکی۔ فائل چیک کریں۔', 'The CSV could not be imported. Check the file.');
  } finally {
    setButtonBusy(button, false, '', '');
  }
}

async function shareOrDownloadText(text, fileName, mimeType, shareTitle) {
  const file = new File([text], fileName, { type: mimeType });
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    await navigator.share({ title: shareTitle, files: [file] });
    return;
  }
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareOrDownloadJson(snapshot) {
  const text = JSON.stringify(snapshot, null, 2);
  const fileName = `Adeel-POS-Backup-${core.localDateString()}.json`;
  await shareOrDownloadText(text, fileName, 'application/json', 'Adeel POS Backup');
}

function csvField(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function exportProductsCsv() {
  const list = await db.getProducts();
  const rows = [['Name', 'Price', 'Section', 'Stock', 'Cost'].join(',')];
  list.forEach(product => {
    const sectionName = sections.find(section => section.id === product.sectionId)?.name || '';
    rows.push([
      csvField(product.name), product.price || 0, csvField(sectionName), product.stock || 0, product.cost || ''
    ].join(','));
  });
  await shareOrDownloadText(rows.join('\n'), `Adeel-POS-Products-${core.localDateString()}.csv`, 'text/csv', 'Adeel POS Products');
}

async function updateBackupStatus() {
  const value = await db.getSetting('lastAutoBackupAt', '');
  const label = value ? formatDateTime(value) : t('ابھی بیک اپ نہیں بنا', 'No backup created yet');
  byId('lastBackupStatus').textContent = label;
  byId('backupStatusSummary').textContent = value ? t(`آخری بیک اپ: ${label}`, `Last backup: ${label}`) : t('ابھی بیک اپ نہیں بنا', 'No backup created yet');
}

async function exportBackup() {
  const message = byId('backupMessage');
  message.textContent = '';
  try {
    const snapshot = await db.createBackup('manual');
    await shareOrDownloadJson(snapshot);
    message.className = 'form-message success';
    message.textContent = t('بیک اپ تیار ہے۔', 'Backup is ready.');
    await updateBackupStatus();
  } catch (_) {
    message.className = 'form-message error';
    message.textContent = t('بیک اپ محفوظ نہیں ہو سکا۔', 'The backup could not be saved.');
  }
}

async function restoreBackupFile(file) {
  const message = byId('backupMessage');
  try {
    const snapshot = JSON.parse(await file.text());
    if (!db.validateBackup(snapshot)) throw new Error('invalid');
    openConfirmModal({
      title: t('بیک اپ بحال کریں', 'Restore Backup'),
      text: t('موجودہ ڈیٹا کا حفاظتی بیک اپ بنا کر یہ فائل بحال کریں؟', 'Create a safety backup and restore this file?'),
      type: 'warning',
      onConfirm: async () => {
        await db.restoreBackup(snapshot);
        message.className = 'form-message success';
        message.textContent = t('بیک اپ بحال ہو گیا۔ ایپ دوبارہ کھل رہی ہے۔', 'Backup restored. The app is reloading.');
        setTimeout(() => location.reload(), 700);
      }
    });
  } catch (_) {
    message.className = 'form-message error';
    message.textContent = t('یہ درست Adeel POS بیک اپ فائل نہیں۔', 'This is not a valid Adeel POS backup file.');
  }
}

async function renderExternalBackupsList() {
  const list = byId('externalBackupsList');
  const entries = await db.listExternalBackups();
  if (!entries.length) {
    list.innerHTML = `<p class="empty-note">${t('ابھی کوئی خودکار بیک اپ نہیں — تھوڑی دیر ایپ استعمال کریں، خود بخود بن جائے گا۔', 'No automatic backups yet — use the app a little and one will appear on its own.')}</p>`;
    return;
  }
  list.innerHTML = entries.map(entry => `
    <div class="backup-row">
      <span><strong>${core.escapeHTML(formatDateTime(entry.mtime))}</strong><small>${core.escapeHTML(entry.name)}</small></span>
      <button class="btn btn-secondary btn-compact" data-restore-external="${core.escapeHTML(entry.path)}" data-ur="بحال کریں" data-en="Restore">${t('بحال کریں', 'Restore')}</button>
    </div>`).join('');
}

async function restoreExternalBackupByPath(path) {
  const message = byId('backupMessage');
  try {
    const snapshot = await db.readExternalBackup(path);
    if (!db.validateBackup(snapshot)) throw new Error('invalid');
    openConfirmModal({
      title: t('بیک اپ بحال کریں', 'Restore Backup'),
      text: t('موجودہ ڈیٹا کا حفاظتی بیک اپ بنا کر یہ بیک اپ بحال کریں؟', 'Create a safety backup and restore this backup?'),
      type: 'warning',
      onConfirm: async () => {
        await db.restoreBackup(snapshot);
        message.className = 'form-message success';
        message.textContent = t('بیک اپ بحال ہو گیا۔ ایپ دوبارہ کھل رہی ہے۔', 'Backup restored. The app is reloading.');
        setTimeout(() => location.reload(), 700);
      }
    });
  } catch (_) {
    message.className = 'form-message error';
    message.textContent = t('یہ بیک اپ بحال نہیں ہو سکا۔', 'This backup could not be restored.');
  }
}

async function updateLicenseUI() {
  byId('settingsMachineId').textContent = licenseState.machineId || await license.getMachineId();
  const status = licenseState.valid
    ? t(`فعال تا ${licenseState.expiry}`, `Active until ${licenseState.expiry}`)
    : licenseState.expired
      ? t(`ختم: ${licenseState.expiry}`, `Expired: ${licenseState.expiry}`)
      : t('فعال نہیں', 'Not active');
  byId('licenseExpiryDisplay').textContent = status;
  byId('licenseStatusSummary').textContent = status;
  byId('expiredSaleState').classList.toggle('hidden', !licenseState.expired);
  renderCartBar();
}

function settingsPanelTitle(panel) {
  const titles = {
    shop: t('دکان اور رسید', 'Shop & receipt'), printer: t('پرنٹر', 'Printer'),
    backup: t('بیک اپ اور بحالی', 'Backup & recovery'), license: t('لائسنس', 'License'),
    security: t('پن اور سیکیورٹی', 'PIN & security'), language: t('زبان', 'Language'),
    about: t('مدد اور معلومات', 'Help & about')
  };
  return titles[panel] || t('سیٹنگز', 'Settings');
}

async function openSettingsPanel(panel) {
  byId('settingsTaskTitle').textContent = settingsPanelTitle(panel);
  document.querySelectorAll('.settings-panel').forEach(element => element.classList.toggle('hidden', element.dataset.panel !== panel));
  if (panel === 'shop') {
    byId('settingShopName').value = shopConfig.shopName;
    byId('settingShopPhone').value = shopConfig.shopPhone;
    byId('settingShopAddress').value = shopConfig.shopAddress || '';
    pendingShopLogo = null;
    renderLogoPreview(shopConfig.shopLogo || '');
    byId('shopSaveMsg').className = 'form-message';
    byId('shopSaveMsg').textContent = '';
  }
  if (panel === 'license') await updateLicenseUI();
  if (panel === 'backup') { await updateBackupStatus(); await renderExternalBackupsList(); }
  if (panel === 'printer') await renderPrinterSettingsPanel();
  openTask('settingsTask');
}

let pendingShopLogo = null; // null = no change staged; '' = staged removal; dataURL = staged new logo

function renderLogoPreview(dataUrl) {
  const preview = byId('shopLogoPreview');
  const removeBtn = byId('removeLogoBtn');
  if (dataUrl) {
    preview.innerHTML = `<img src="${dataUrl}" alt="logo" />`;
    removeBtn.classList.remove('hidden');
  } else {
    preview.innerHTML = `<span class="logo-preview-empty">${t('کوئی لوگو نہیں', 'No logo')}</span>`;
    removeBtn.classList.add('hidden');
  }
}

// Resizes any chosen PNG down to a small square so it stays cheap to store
// and prints crisply on a 58/80mm receipt without needing any library.
function resizeLogoFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('invalid_image'));
      img.onload = () => {
        // Step 1: draw at full resolution so we can inspect real pixels.
        const full = document.createElement('canvas');
        full.width = img.width;
        full.height = img.height;
        const fullCtx = full.getContext('2d');
        fullCtx.drawImage(img, 0, 0);

        // Step 2: find the bounding box of actual content (skip transparent
        // and near-white pixels). Many exported logos carry a lot of empty
        // padding around the real mark — printing the whole file at a fixed
        // box size then makes the visible mark look far smaller than the
        // box itself. Cropping to just the content first means the mark
        // fills the printed logo box edge-to-edge instead.
        let { data } = fullCtx.getImageData(0, 0, full.width, full.height);
        let minX = full.width, minY = full.height, maxX = 0, maxY = 0;
        let foundContent = false;
        const isBackground = (r, g, b, a) => a < 12 || (r > 248 && g > 248 && b > 248);
        for (let py = 0; py < full.height; py++) {
          for (let px = 0; px < full.width; px++) {
            const i = (py * full.width + px) * 4;
            if (!isBackground(data[i], data[i + 1], data[i + 2], data[i + 3])) {
              if (px < minX) minX = px;
              if (px > maxX) maxX = px;
              if (py < minY) minY = py;
              if (py > maxY) maxY = py;
              foundContent = true;
            }
          }
        }

        let cropX = 0, cropY = 0, cropW = full.width, cropH = full.height;
        if (foundContent) {
          const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.06);
          cropX = Math.max(0, minX - pad);
          cropY = Math.max(0, minY - pad);
          cropW = Math.min(full.width, maxX + pad) - cropX;
          cropH = Math.min(full.height, maxY + pad) - cropY;
        }
        // A blank/fully-transparent file falls back to using the whole
        // image rather than producing a zero-size crop.

        // Step 3: resize the cropped content to the final stored size.
        const MAX = 240;
        const scale = Math.min(1, MAX / Math.max(cropW, cropH));
        const w = Math.max(1, Math.round(cropW * scale));
        const h = Math.max(1, Math.round(cropH * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(full, cropX, cropY, cropW, cropH, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleLogoFileChosen(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.type !== 'image/png') {
    byId('shopSaveMsg').className = 'form-message error';
    byId('shopSaveMsg').textContent = t('صرف PNG فائل منتخب کریں۔', 'Please choose a PNG file.');
    return;
  }
  try {
    const dataUrl = await resizeLogoFile(file);
    pendingShopLogo = dataUrl;
    renderLogoPreview(dataUrl);
    byId('shopSaveMsg').className = 'form-message';
    byId('shopSaveMsg').textContent = '';
  } catch (_) {
    byId('shopSaveMsg').className = 'form-message error';
    byId('shopSaveMsg').textContent = t('لوگو لوڈ نہیں ہو سکا۔', 'Could not load the logo.');
  }
}

async function saveShopDetails() {
  const name = byId('settingShopName').value.trim().slice(0, 80);
  const phone = byId('settingShopPhone').value.trim().slice(0, 40);
  const address = byId('settingShopAddress').value.trim().slice(0, 120);
  if (!name) return;
  await db.setSetting('shopName', name);
  await db.setSetting('shopPhone', phone);
  await db.setSetting('shopAddress', address);
  if (pendingShopLogo !== null) {
    await db.setSetting('shopLogo', pendingShopLogo);
    shopConfig.shopLogo = pendingShopLogo;
    pendingShopLogo = null;
  }
  shopConfig.shopName = name;
  shopConfig.shopPhone = phone;
  shopConfig.shopAddress = address;
  byId('topShopName').textContent = name;
  byId('loginShopName').textContent = name;
  byId('shopSaveMsg').className = 'form-message success';
  byId('shopSaveMsg').textContent = t('محفوظ ہو گیا۔', 'Saved.');
  await db.createBackup('settings_change');
}

async function changePin() {
  const oldPin = byId('oldPassword').value;
  const newPin = byId('newPassword').value;
  const savedPin = await db.getSetting('password', '0000');
  const message = byId('pwdMsg');
  message.className = 'form-message error';
  if (oldPin !== savedPin) { message.textContent = t('پرانا پن درست نہیں۔', 'The old PIN is incorrect.'); return; }
  if (!/^\d{4}$/.test(newPin)) { message.textContent = t('نیا پن مکمل 4 ہندسوں کا ہونا چاہیے۔', 'The new PIN must contain exactly four digits.'); return; }
  await db.setSetting('password', newPin);
  byId('oldPassword').value = '';
  byId('newPassword').value = '';
  message.className = 'form-message success';
  message.textContent = t('پن تبدیل ہو گیا۔', 'PIN changed.');
}

async function runTestPrint() {
  const message = byId('printerTestMessage');
  const now = new Date().toISOString();
  const sample = { id: 'test', invoiceNumber: 'TEST-0001', customer_name: '', payment_method: 'Cash', created_at: now, items: [{ name: 'Test Item', price: 100, quantity: 1 }, { name: 'اردو ٹیسٹ چاول', price: 250, quantity: 2 }], subtotal: 600, discount: 0, total: 600 };
  try {
    await printInvoiceViaPrinter(sample);
    message.className = 'form-message success';
    message.textContent = t('ٹیسٹ پرنٹ بھیج دیا گیا۔', 'Test print sent.');
  } catch (err) {
    message.className = 'form-message error';
    message.textContent = printerErrorMessage(printerErrorCode(err));
  }
}

async function renderPrinterSettingsPanel() {
  await refreshPrinterStatus();
  const statusBox = byId('printerStatusBox');
  const pairedList = byId('printerPairedList');
  const message = byId('printerTestMessage');
  message.textContent = '';
  message.className = 'form-message';

  if (printerState.address) {
    const transportLabel = printerState.transport === 'usb' ? t('USB', 'USB') : t('بلوٹوتھ', 'Bluetooth');
    statusBox.className = 'form-message ' + (printerState.connected ? 'success' : 'error');
    statusBox.textContent = printerState.connected
      ? t(`منسلک (${transportLabel}): ${printerState.name}`, `Connected (${transportLabel}): ${printerState.name}`)
      : t(`محفوظ شدہ پرنٹر (${transportLabel}): ${printerState.name} (غیر منسلک)`, `Saved printer (${transportLabel}): ${printerState.name} (not connected)`);
  } else {
    statusBox.className = 'form-message';
    statusBox.textContent = t('کوئی پرنٹر منتخب نہیں۔', 'No printer selected.');
  }

  byId('printerConnectedActions').classList.toggle('hidden', !printerState.address);
  byId('printer58Btn').classList.toggle('active', printerState.paperWidth === 58);
  byId('printer80Btn').classList.toggle('active', printerState.paperWidth === 80);
  byId('printerAutoPrintToggle').checked = printerState.autoPrint;
  byId('printerTransportBtBtn').classList.toggle('active', printerSettingsTab === 'bluetooth');
  byId('printerTransportUsbBtn').classList.toggle('active', printerSettingsTab === 'usb');

  pairedList.innerHTML = t('فہرست لوڈ ہو رہی ہے…', 'Loading devices…');
  const plugin = getPluginFor(printerSettingsTab);
  if (!plugin) {
    pairedList.textContent = printerSettingsTab === 'usb'
      ? t('USB پرنٹر سپورٹ نہیں ہے۔', 'USB printers are not supported on this device.')
      : t('بلوٹوتھ دستیاب نہیں۔', 'Bluetooth is unavailable.');
    return;
  }
  try {
    const result = printerSettingsTab === 'usb' ? await plugin.listUsbPrinters() : await plugin.listPairedPrinters();
    const devices = (result && result.devices) || [];
    if (!devices.length) {
      pairedList.textContent = printerSettingsTab === 'usb'
        ? t('کوئی USB پرنٹر منسلک نہیں ملا۔ کیبل چیک کریں۔', 'No USB printer detected. Check the cable connection.')
        : t('کوئی جوڑا ہوا آلہ نہیں ملا۔ پہلے Android کی بلوٹوتھ سیٹنگز میں پرنٹر جوڑیں۔', 'No paired devices found. Pair your printer in Android Bluetooth settings first.');
      return;
    }
    pairedList.innerHTML = devices.map(device => {
      const key = printerSettingsTab === 'usb' ? device.key : device.address;
      const sub = printerSettingsTab === 'usb' ? '' : `<small>${core.escapeHTML(device.address)}</small>`;
      return `
      <button class="settings-row" data-printer-key="${core.escapeHTML(key)}" data-printer-name="${core.escapeHTML(device.name)}">
        <span class="settings-icon">▣</span>
        <span><strong>${core.escapeHTML(device.name)}</strong>${sub}<small class="printer-row-status"></small></span>
        <b>›</b>
      </button>`;
    }).join('');
    pairedList.querySelectorAll('[data-printer-key]').forEach(button => {
      button.addEventListener('click', () => selectPrinterDevice(button, printerSettingsTab));
    });
  } catch (err) {
    pairedList.textContent = printerErrorMessage(err && err.message);
  }
}

async function selectPrinterDevice(button, transport) {
  const key = button.dataset.printerKey;
  const name = button.dataset.printerName;
  const rowStatus = button.querySelector('.printer-row-status');
  const message = byId('printerTestMessage');

  // Feedback appears right on the tapped row AND in the message area AND
  // as a toast — three places, so it's never missed regardless of where
  // on the screen the user is looking or how far they've scrolled.
  button.disabled = true;
  rowStatus.className = 'printer-row-status';
  rowStatus.textContent = t('رابطہ ہو رہا ہے…', 'Connecting…');
  message.className = 'form-message';
  message.textContent = t('رابطہ ہو رہا ہے…', 'Connecting…');

  try {
    await connectToPrinter(transport, key, name);
    rowStatus.className = 'printer-row-status success';
    rowStatus.textContent = t('منسلک ✓', 'Connected ✓');
    message.className = 'form-message success';
    message.textContent = t('پرنٹر منسلک ہو گیا۔', 'Printer connected.');
    showToast(t('پرنٹر منسلک ہو گیا۔', 'Printer connected.'));
  } catch (err) {
    const code = printerErrorCode(err);
    const detail = err && err.code && err.code !== code ? err.code : ''; // native technical detail, if any — shown so a repeat failure can be diagnosed exactly instead of guessed at
    rowStatus.className = 'printer-row-status error';
    rowStatus.textContent = t('ناکام', 'Failed');
    message.className = 'form-message error';
    message.textContent = printerErrorMessage(code) + (detail ? ` (${detail})` : '');
    showToast(printerErrorMessage(code));
  }
  button.disabled = false;
  await renderPrinterSettingsPanel();
}

async function reconnectPrinterAction() {
  const message = byId('printerTestMessage');
  message.className = 'form-message';
  message.textContent = t('دوبارہ رابطہ ہو رہا ہے…', 'Reconnecting…');
  try {
    await ensurePrinterConnected();
    message.className = 'form-message success';
    message.textContent = t('پرنٹر منسلک ہو گیا۔', 'Printer connected.');
  } catch (err) {
    message.className = 'form-message error';
    message.textContent = printerErrorMessage(printerErrorCode(err));
  }
  await renderPrinterSettingsPanel();
}

async function disconnectPrinterAction() {
  await disconnectPrinterSession();
  await renderPrinterSettingsPanel();
}

async function changePrinterAction() {
  await forgetPrinter();
  await renderPrinterSettingsPanel();
}

function renderDynamicUI() {
  renderSaleProducts();
  renderPickerProducts();
  renderCartBar();
  renderCheckout();
  renderProductManagement();
  renderReportSummary();
  renderInvoiceList();
  updateLicenseUI();
}

function setupEvents() {
  byId('activateBtn').addEventListener('click', () => activateLicense('licenseKeyInput', 'activationError', showLoginScreen));
  byId('loginBtn').addEventListener('click', attemptLogin);
  byId('forgotPinLink').addEventListener('click', showForgotPinScreen);
  byId('backToLoginBtn').addEventListener('click', showLoginScreenFromReset);
  byId('verifyResetKeyBtn').addEventListener('click', verifyResetKey);
  byId('saveResetPinBtn').addEventListener('click', saveResetPin);
  document.querySelectorAll('.pin-box').forEach((box, index, boxes) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      if (box.value && index < boxes.length - 1) boxes[index + 1].focus();
      if (Array.from(boxes).every(input => input.value)) attemptLogin();
    });
    box.addEventListener('keydown', event => {
      if (event.key === 'Backspace' && !box.value && index > 0) boxes[index - 1].focus();
      if (event.key === 'Enter') attemptLogin();
    });
  });

  document.querySelectorAll('.nav-btn').forEach(button => button.addEventListener('click', () => showMainScreen(button.dataset.screen)));
  byId('saleSearchInput').addEventListener('input', event => { saleSearch = event.target.value; renderSaleProducts(); });
  byId('pickerSearchInput').addEventListener('input', event => { pickerSearch = event.target.value; renderPickerProducts(); });
  byId('productSearchInput').addEventListener('input', event => { productSearch = event.target.value; renderProductManagement(); });
  byId('reviewSaleBtn').addEventListener('click', openCheckout);
  byId('holdBillBtn').addEventListener('click', holdCurrentBill);
  byId('newBillBtn').addEventListener('click', startNewBill);
  byId('heldBillsBtn').addEventListener('click', () => {
    heldBillsSearch = '';
    byId('heldBillsSearchInput').value = '';
    renderHeldBillsList();
    openTask('heldBillsTask');
  });
  byId('heldBillsSearchInput').addEventListener('input', event => { heldBillsSearch = event.target.value; renderHeldBillsList(); });
  byId('openManualItemBtn').addEventListener('click', () => {
    byId('manualItemName').value = '';
    byId('manualItemPrice').value = '';
    byId('manualItemQty').value = '1';
    byId('manualItemMessage').textContent = '';
    openTask('manualItemTask');
    setTimeout(() => byId('manualItemName').focus(), 80);
  });
  byId('addManualItemBtn').addEventListener('click', () => {
    const name = byId('manualItemName').value.trim().slice(0, 80);
    const price = Number(byId('manualItemPrice').value);
    const quantity = Math.max(1, Math.trunc(Number(byId('manualItemQty').value) || 1));
    if (!name || !Number.isFinite(price) || price <= 0) {
      byId('manualItemMessage').textContent = t('درست نام اور قیمت درج کریں۔', 'Enter a valid name and price.');
      return;
    }
    cart = core.addCartItem(cart, { name, price }, quantity);
    afterCartChange();
    requestCloseTask();
  });
  byId('checkoutAddItemsBtn').addEventListener('click', () => { renderPickerProducts(); openTask('productPickerTask'); });
  byId('checkoutCustomerBtn').addEventListener('click', () => { byId('customerDraftInput').value = customerName; openTask('customerTask'); });
  byId('saveCustomerBtn').addEventListener('click', () => { customerName = byId('customerDraftInput').value.trim().slice(0, 80); scheduleDraftSave(); renderCheckout(); requestCloseTask(); });
  byId('checkoutDiscountBtn').addEventListener('click', () => { byId('discountDraftInput').value = discountAmount || 0; byId('discountMessage').textContent = ''; openTask('discountTask'); });
  byId('checkoutPaymentBtn').addEventListener('click', () => { renderPaymentMethodList(); openTask('paymentMethodTask'); });
  byId('tenderedInput').addEventListener('input', updateChangeDue);
  byId('saveDiscountBtn').addEventListener('click', () => {
    const value = Math.max(0, Number(byId('discountDraftInput').value) || 0);
    const subtotal = core.calculateTotals(cart, 0).subtotal;
    if (value > subtotal) { byId('discountMessage').textContent = t('ڈسکاؤنٹ سب ٹوٹل سے زیادہ نہیں ہو سکتا۔', 'Discount cannot exceed the subtotal.'); return; }
    discountAmount = value;
    scheduleDraftSave();
    renderCheckout();
    renderCartBar();
    requestCloseTask();
  });
  byId('completeSaleBtn').addEventListener('click', completeSale);

  document.querySelectorAll('.report-tab').forEach(button => button.addEventListener('click', () => loadReportTab(button.dataset.tab)));
  byId('exportReportBtn').addEventListener('click', exportCurrentReport);
  byId('reprintInvoiceBtn').addEventListener('click', async () => { const invoice = await db.getInvoice(activeInvoiceId); if (invoice) await printInvoice(invoice, true); });
  byId('invoicePdfBtn').addEventListener('click', async () => { const invoice = await db.getInvoice(activeInvoiceId); if (invoice) await requestPrint(buildReceiptHTML(invoice)); });

  document.querySelectorAll('.products-subtab').forEach(button => button.addEventListener('click', () => switchProductTab(button.dataset.productTab)));
  byId('stockSearchInput').addEventListener('input', renderStockManagement);
  byId('lowStockOnlyToggle').addEventListener('change', renderStockManagement);
  byId('stockMinusBtn').addEventListener('click', () => bumpStockValue(-1));
  byId('stockPlusBtn').addEventListener('click', () => bumpStockValue(1));
  document.querySelectorAll('.stock-quick').forEach(button => button.addEventListener('click', () => bumpStockValue(Number(button.dataset.add) || 0)));
  byId('saveStockBtn').addEventListener('click', saveStockEditor);
  byId('addProductBtn').addEventListener('click', () => openProductEditor());
  byId('saveProductBtn').addEventListener('click', saveProduct);
  byId('deleteProductBtn').addEventListener('click', deleteProduct);
  byId('addSectionBtn').addEventListener('click', () => openSectionEditor());
  byId('saveSectionBtn').addEventListener('click', saveSection);
  byId('deleteSectionBtn').addEventListener('click', deleteSection);
  byId('sectionsEnabledToggle').addEventListener('change', async event => {
    sectionsEnabled = event.target.checked;
    await db.setSetting('sectionsEnabled', String(sectionsEnabled));
    renderDynamicUI();
  });
  byId('stockTrackingEnabledToggle').addEventListener('change', async event => {
    stockTrackingEnabled = event.target.checked;
    await db.setSetting('stockTrackingEnabled', String(stockTrackingEnabled));
    await refreshStockAlertBadge();
    renderDynamicUI();
    if (currentScreen === 'stock') await renderStockManagement();
  });
  byId('exportProductsCsvBtn').addEventListener('click', exportProductsCsv);
  byId('importProductsBtn').addEventListener('click', () => byId('productsCsvInput').click());
  byId('productsCsvInput').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try { prepareImportPreview(core.parseProductsCsv(await file.text())); }
    catch (_) { showToast(t('CSV میں Name اور Price کالم چیک کریں۔', 'Check the Name and Price columns in the CSV.')); }
  });
  byId('confirmCsvImportBtn').addEventListener('click', applyCsvImport);
  byId('stockHistoryBtn').addEventListener('click', async () => { await renderStockHistory(); openTask('stockHistoryTask'); });

  document.querySelectorAll('[data-settings-panel]').forEach(button => button.addEventListener('click', () => openSettingsPanel(button.dataset.settingsPanel)));
  byId('productOrganizationShortcut').addEventListener('click', () => {
    sectionShortcutOrigin = 'more';
    showMainScreen('products');
    switchProductTab('sections');
  });
  byId('openRenewalBtn').addEventListener('click', () => openSettingsPanel('license'));
  byId('saveShopDetailsBtn').addEventListener('click', saveShopDetails);
  byId('uploadLogoBtn').addEventListener('click', () => byId('shopLogoInput').click());
  byId('shopLogoInput').addEventListener('change', handleLogoFileChosen);
  byId('removeLogoBtn').addEventListener('click', () => { pendingShopLogo = ''; renderLogoPreview(''); });
  byId('testPrintBtn').addEventListener('click', runTestPrint);
  byId('printerReconnectBtn').addEventListener('click', reconnectPrinterAction);
  byId('printerDisconnectBtn').addEventListener('click', disconnectPrinterAction);
  byId('printerChangeBtn').addEventListener('click', changePrinterAction);
  byId('printerTransportBtBtn').addEventListener('click', async () => { printerSettingsTab = 'bluetooth'; await renderPrinterSettingsPanel(); });
  byId('printerTransportUsbBtn').addEventListener('click', async () => { printerSettingsTab = 'usb'; await renderPrinterSettingsPanel(); });
  byId('printer58Btn').addEventListener('click', async () => { await setPaperWidth(58); await renderPrinterSettingsPanel(); });
  byId('printer80Btn').addEventListener('click', async () => { await setPaperWidth(80); await renderPrinterSettingsPanel(); });
  byId('printerAutoPrintToggle').addEventListener('change', event => setAutoPrint(event.target.checked));
  byId('exportBackupBtn').addEventListener('click', exportBackup);
  byId('restoreBackupBtn').addEventListener('click', () => byId('backupFileInput').click());
  byId('backupFileInput').addEventListener('change', event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) restoreBackupFile(file); });
  byId('externalBackupsList').addEventListener('click', event => {
    const button = event.target.closest('[data-restore-external]');
    if (button) restoreExternalBackupByPath(button.dataset.restoreExternal);
  });
  byId('renewLicenseBtn').addEventListener('click', () => activateLicense('renewalKeyInput', 'licenseMsg', async () => {
    licenseState.expired = false;
    await updateLicenseUI();
    hideBanner();
    renderDynamicUI();
    showMainScreen('billing');
  }));
  byId('changePasswordBtn').addEventListener('click', changePin);

  byId('persistentBannerAction').addEventListener('click', () => bannerAction && bannerAction());
  byId('dismissBannerBtn').addEventListener('click', hideBanner);
  document.querySelectorAll('[data-close-task]').forEach(button => button.addEventListener('click', requestCloseTask));
  window.addEventListener('popstate', closeTopTask);
  Capacitor.Plugins.App.addListener('backButton', handleHardwareBack);

  setupPagerShifters();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      scheduleDraftSave();
    } else if (appReady && hiddenAt && Date.now() - hiddenAt > 120000) {
      clearTaskStack();
      showLoginScreen();
    }
  });
}

const MAIN_SCREENS = ['billing', 'reports', 'products', 'stock', 'more'];
let sectionShortcutOrigin = null;

function setupPagerShifters() {
  const attachSwipe = (elementId, onNext, onPrev) => {
    const el = byId(elementId);
    if (!el) return;
    let startX = 0;
    let startY = 0;
    el.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }
    }, { passive: true });

    el.addEventListener('touchend', e => {
      if (e.changedTouches.length === 1) {
        const diffX = e.changedTouches[0].clientX - startX;
        const diffY = Math.abs(e.changedTouches[0].clientY - startY);
        if (Math.abs(diffX) > 60 && diffY < 45) {
          const isRTL = document.documentElement.dir === 'rtl';
          if ((diffX < 0 && !isRTL) || (diffX > 0 && isRTL)) {
            onNext();
          } else {
            onPrev();
          }
        }
      }
    }, { passive: true });
  };

  attachSwipe('productsScreen', () => switchProductTab('sections'), () => switchProductTab('products'));
  attachSwipe('reportsScreen', () => loadReportTab('month'), () => loadReportTab('today'));

  // Main Screens Touch Pager Shifter (Swiping across Sale -> Reports -> Products -> Stock -> More)
  const mainContent = document.querySelector('main.content');
  if (mainContent) {
    let startX = 0;
    let startY = 0;
    mainContent.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }
    }, { passive: true });

    mainContent.addEventListener('touchend', e => {
      if (e.changedTouches.length === 1) {
        const diffX = e.changedTouches[0].clientX - startX;
        const diffY = Math.abs(e.changedTouches[0].clientY - startY);
        if (Math.abs(diffX) > 75 && diffY < 45 && taskStack.length === 0) {
          const isRTL = document.documentElement.dir === 'rtl';
          const currentIndex = MAIN_SCREENS.indexOf(currentScreen);
          if (currentIndex !== -1) {
            let nextIndex = currentIndex;
            if ((diffX < 0 && !isRTL) || (diffX > 0 && isRTL)) {
              nextIndex = Math.min(MAIN_SCREENS.length - 1, currentIndex + 1);
            } else {
              nextIndex = Math.max(0, currentIndex - 1);
            }
            if (nextIndex !== currentIndex) {
              showMainScreen(MAIN_SCREENS[nextIndex]);
            }
          }
        }
      }
    }, { passive: true });
  }
}

const runBoot = () => {
  boot().catch(() => {
    byId('activationScreen')?.classList.remove('hidden');
    const err = byId('activationError');
    if (err) err.textContent = t('ایپ شروع نہیں ہو سکی۔ دوبارہ کھولیں۔', 'The app could not start. Please reopen it.');
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runBoot);
} else {
  runBoot();
}
