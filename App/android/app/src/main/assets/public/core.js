(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AdeelCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function productIdentity(item) {
    if (item && item.productId) return `id:${item.productId}`;
    if (item && item.id) return `id:${item.id}`;
    return `manual:${normalizeText(item && item.name)}|${Number(item && item.price) || 0}`;
  }

  function addCartItem(cart, product, quantity = 1) {
    const next = Array.isArray(cart) ? cart.map(item => ({ ...item })) : [];
    const qty = Math.max(1, Math.trunc(Number(quantity) || 1));
    const candidate = {
      productId: product.id || product.productId || '',
      name: String(product.name || '').trim().slice(0, 80),
      price: Number(product.price) || 0,
      quantity: qty
    };
    const identity = productIdentity(candidate);
    const existing = next.find(item => productIdentity(item) === identity);
    if (existing) existing.quantity += qty;
    else next.push(candidate);
    return next;
  }

  function changeCartQuantity(cart, identity, delta) {
    const next = Array.isArray(cart) ? cart.map(item => ({ ...item })) : [];
    const item = next.find(entry => productIdentity(entry) === identity);
    if (!item) return next;
    item.quantity = Math.trunc(Number(item.quantity) || 0) + Math.trunc(Number(delta) || 0);
    return next.filter(entry => entry.quantity > 0);
  }

  function removeCartItem(cart, identity) {
    return (Array.isArray(cart) ? cart : []).filter(item => productIdentity(item) !== identity).map(item => ({ ...item }));
  }

  function calculateTotals(cart, discountInput) {
    const subtotal = (Array.isArray(cart) ? cart : []).reduce((sum, item) => {
      return sum + (Number(item.price) || 0) * Math.max(0, Number(item.quantity) || 0);
    }, 0);
    const requestedDiscount = Math.max(0, Number(discountInput) || 0);
    const discount = Math.min(requestedDiscount, subtotal);
    return { subtotal, discount, total: Math.max(0, subtotal - discount) };
  }

  function totalQuantity(cart) {
    return (Array.isArray(cart) ? cart : []).reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
  }

  function parseCsvRow(line) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === ',' && !quoted) {
        fields.push(field.trim());
        field = '';
      } else {
        field += char;
      }
    }
    fields.push(field.trim());
    return fields;
  }

  // One CSV format handles the full product record: name, price and section
  // (required to build the catalogue) plus optional stock and cost columns,
  // so a single Export/Import on the Products screen also covers stocktakes
  // \u2014 there is no separate stock-only CSV path anymore.
  function parseProductsCsv(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) throw new Error('CSV is empty');
    const headers = parseCsvRow(lines[0]).map(value => value.toLowerCase().replace(/[^a-z]/g, ''));
    const nameIndex = headers.findIndex(value => ['name', 'product', 'item', 'productname', 'itemname'].includes(value));
    const priceIndex = headers.findIndex(value => ['price', 'rate', 'amount', 'saleprice'].includes(value));
    const sectionIndex = headers.findIndex(value => ['section', 'category', 'group'].includes(value));
    const stockIndex = headers.findIndex(value => ['stock', 'qty', 'quantity'].includes(value));
    const costIndex = headers.findIndex(value => ['cost', 'purchaseprice', 'buyprice', 'costprice'].includes(value));
    const hasHeader = nameIndex !== -1 && priceIndex !== -1;
    const indexes = {
      name: hasHeader ? nameIndex : 0,
      price: hasHeader ? priceIndex : 1,
      section: hasHeader ? sectionIndex : 2,
      stock: hasHeader ? stockIndex : -1,
      cost: hasHeader ? costIndex : -1
    };
    const rows = hasHeader ? lines.slice(1) : lines;
    const products = [];
    const rejected = [];

    rows.forEach((line, index) => {
      const fields = parseCsvRow(line);
      const name = String(fields[indexes.name] || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const price = Number(String(fields[indexes.price] || '').replace(/[\s,]/g, ''));
      const section = indexes.section >= 0 ? String(fields[indexes.section] || '').trim().replace(/\s+/g, ' ').slice(0, 40) : '';
      const rowNumber = index + (hasHeader ? 2 : 1);
      if (!name) { rejected.push({ rowNumber, reason: 'missing_name' }); return; }
      if (!Number.isFinite(price) || price <= 0 || price > 1000000000) { rejected.push({ rowNumber, reason: 'invalid_price', name }); return; }
      const product = { name, price, section, rowNumber };
      if (indexes.stock >= 0 && fields[indexes.stock] !== undefined && fields[indexes.stock] !== '') {
        const stock = Number(String(fields[indexes.stock]).replace(/[\s,]/g, ''));
        if (Number.isFinite(stock) && stock >= 0) product.stock = Math.trunc(stock);
      }
      if (indexes.cost >= 0 && fields[indexes.cost] !== undefined && fields[indexes.cost] !== '') {
        const cost = Number(String(fields[indexes.cost]).replace(/[\s,]/g, ''));
        if (Number.isFinite(cost) && cost >= 0) product.cost = cost;
      }
      products.push(product);
    });

    if (!products.length) throw new Error('No valid products found');
    return {
      products: products.slice(0, 500),
      rejected,
      hasHeader,
      hasSectionColumn: sectionIndex !== -1,
      hasStockColumn: stockIndex !== -1,
      hasCostColumn: costIndex !== -1
    };
  }

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function currentLocalYearMonth(date = new Date()) {
    return localDateString(date).slice(0, 7);
  }

  return {
    normalizeText,
    escapeHTML,
    productIdentity,
    addCartItem,
    changeCartQuantity,
    removeCartItem,
    calculateTotals,
    totalQuantity,
    parseCsvRow,
    parseProductsCsv,
    localDateString,
    currentLocalYearMonth
  };
});
