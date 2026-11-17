// Adeel POS — Image-based receipt renderer.
//
// WHY THIS FILE EXISTS:
// Thermal printers only have an English/Latin font built in. Sending Urdu
// TEXT to the printer makes it hunt for a matching character in its English
// font table and print whatever it finds — that's the "garbage" output.
// The fix used here is standard for POS software: draw the whole receipt on
// a canvas (where the phone's own Urdu font renders correctly, joined-up
// letters and all), turn that drawing into a black/white dot pattern, and
// send the printer *dots*, never text. The printer never needs to know
// Urdu exists — it just prints a picture, same as a photo would.
//
// This also means logo, English and Urdu text all go through one pipeline,
// and whatever the app screen shows is exactly what gets printed.
//
// SIZES BELOW ARE IN PRINTER DOTS, NOT SCREEN PIXELS. At the standard 203
// DPI thermal print head resolution, 1mm ≈ 8 dots. A 14-dot font is only
// ~1.75mm tall — unreadably small on paper even though it looks fine in a
// code editor. Every size here is picked to be a normal, comfortably
// readable receipt size (roughly 3-3.5mm body text, matching a typical
// ESC/POS "font A" receipt), not an arbitrary number.
(function (global) {
  'use strict';

  const RTL_REGEX = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
  function isRtlText(str) {
    return RTL_REGEX.test(String(str || ''));
  }

  // 203 DPI is the near-universal thermal print head resolution.
  // 58mm paper -> 384 dots wide, 80mm -> 576 dots wide (both an exact
  // multiple of 8, which matters for clean byte-packing below).
  const PAPER_DOTS = { 58: 384, 80: 576 };

  // Font sizes in dots. Kept fixed regardless of 58mm/80mm — a wider paper
  // gets more side margin and room per column, not smaller text; the print
  // resolution (203 DPI) doesn't change with paper width.
  const FONT = {
    shopName: 44,      // ~5.5mm — the shop name is the biggest thing on the receipt
    subHeader: 24,      // phone / address lines
    meta: 26,           // Invoice / Date / Customer / Payment rows
    colHeader: 24,       // "Item  Qty  Price  Total" header
    itemName: 28,        // product name
    itemNumbers: 26,     // qty / price / total figures
    totalsLine: 26,      // Subtotal / Discount / Tendered / Change
    grandTotal: 38,      // TOTAL — the one number that should jump out
    footer: 24,          // "Thank you", invoice number repeat
    footerBold: 26,      // "Software by Adeel Jhorad"
    tiny: 16             // small diagnostic version stamp at the very bottom
  };
  const LOGO_SIZE = 190; // ~24mm square box — large and unmistakable on the receipt
  // Bump this string whenever this file changes. It prints in tiny text at
  // the very bottom of every receipt, purely so a real test print can
  // prove — with certainty, no guessing — exactly which build produced it.
  const ENGINE_VERSION = '2026-09-19.1';

  function money(shopConfig, value) {
    return `${Math.round(Number(value) || 0).toLocaleString('en-PK')} ${shopConfig.currency}`;
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  // Draws text respecting whatever script it's actually written in — Urdu
  // strings shape and align right-to-left, English/numbers stay left-to-right
  // — without changing the receipt's overall column layout.
  // IMPORTANT: y is a required argument. An earlier version of this function
  // hardcoded y to 0, which silently drew Invoice/Date/Customer/Payment
  // VALUES at the very top of the receipt instead of next to their labels —
  // they were never missing, just invisibly mis-positioned. Every caller
  // below now passes the row's real y position explicitly.
  function directionalFillText(ctx, text, x, y, alignHint) {
    const rtl = isRtlText(text);
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = alignHint || (rtl ? 'right' : 'left');
    ctx.fillText(text, x, y);
  }

  function buildLayout(invoice, shopConfig) {
    // A fixed line-height plan computed BEFORE drawing, so the canvas can be
    // created at exactly the right height — no wasted blank paper, no
    // content cut off at the bottom. Heights are sized to comfortably fit
    // the FONT sizes above (roughly 1.3-1.5x font size per line).
    const lines = [];
    const push = (kind, data, height) => lines.push({ kind, data, height });

    if (shopConfig.shopLogo) push('logo', shopConfig.shopLogo, LOGO_SIZE + 16);
    push('shopName', shopConfig.shopName, 58);
    if (shopConfig.shopPhone) push('centerSmall', `Phone: ${shopConfig.shopPhone}`, 32);
    if (shopConfig.shopAddress) push('centerSmall', `Address: ${shopConfig.shopAddress}`, 32);
    push('hr', null, 18);
    push('meta', ['Invoice', invoice.invoiceNumber], 34);
    push('meta', ['Date/Time', invoice.dateTimeLabel], 34);
    if (invoice.customer_name) push('meta', ['Customer', invoice.customer_name], 34);
    push('meta', ['Payment', invoice.payment_method || 'Cash'], 34);
    push('hr', null, 18);
    push('colHeader', null, 34);
    push('hr', null, 14);

    (invoice.items || []).forEach(item => {
      push('itemName', item.name, 0); // height computed at draw time (can wrap)
      push('itemNumbers', item, 32);
    });

    push('hr', null, 18);
    push('total', ['Subtotal', money(shopConfig, invoice.subtotal), false], 32);
    if (invoice.discount > 0) push('total', ['Discount', '-' + money(shopConfig, invoice.discount), false], 32);
    push('total', ['TOTAL', money(shopConfig, invoice.total), true], 46);
    if (invoice.tendered > 0) {
      push('total', ['Tendered', money(shopConfig, invoice.tendered), false], 32);
      push('total', ['Change', money(shopConfig, invoice.change), false], 32);
    }
    push('hr', null, 18);
    push('centerSmall', 'Thank you! Visit again.', 34);
    push('gap', null, 14);
    push('centerBold', 'Software by Adeel Jhorad', 30);
    push('centerSmall', invoice.invoiceNumber, 28);
    push('gap', null, 28); // feed margin before cut

    return lines;
  }

  async function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('logo_load_failed'));
      img.src = dataUrl;
    });
  }

  async function renderReceiptCanvas(invoice, shopConfig, paperWidthMm) {
    const width = PAPER_DOTS[paperWidthMm] || PAPER_DOTS[58];
    const margin = Math.round(width * 0.05);
    const contentWidth = width - margin * 2;

    // Pass 1: measure. A throwaway canvas/context is enough to call
    // measureText and work out how many lines each item name will need,
    // so the real canvas can be created at its exact final height.
    const measure = document.createElement('canvas').getContext('2d');
    let height = 30; // top margin
    const layout = buildLayout(invoice, shopConfig);
    for (const line of layout) {
      if (line.kind === 'itemName') {
        measure.font = `${FONT.itemName}px sans-serif`;
        const wrapped = wrapText(measure, line.data, contentWidth);
        line.wrapped = wrapped;
        line.height = wrapped.length * (FONT.itemName + 8);
      }
      if (line.kind === 'meta') {
        measure.font = `${FONT.meta}px sans-serif`;
        const [label, rawValue] = line.data;
        const value = (rawValue === undefined || rawValue === null || rawValue === '') ? '—' : String(rawValue);
        const gap = FONT.meta * 0.8; // minimum breathing room between label and value
        const combined = measure.measureText(String(label)).width + measure.measureText(value).width + gap;
        // A long value (a full date/time, a long customer name) can be wider
        // than the space left after the label — cramming both onto one line
        // then makes them print on top of each other. When that would
        // happen, the value moves to its own line underneath instead.
        if (combined > contentWidth) {
          line.stacked = true;
          line.height = (FONT.meta + 6) * 2;
        }
      }
      height += line.height;
    }
    height += 30; // bottom margin

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'top';

    let y = 30;

    if (shopConfig.shopLogo) {
      try {
        const img = await loadImage(shopConfig.shopLogo);
        const scale = Math.min(1, LOGO_SIZE / Math.max(img.width, img.height));
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (width - w) / 2, y + (LOGO_SIZE - h) / 2, w, h);
      } catch (_) {
        // A broken/undecodable logo must never stop the rest of the receipt
        // from printing — the sale itself is what matters.
      }
    }

    for (const line of layout) {
      if (line.kind === 'logo') { y += line.height; continue; }
      if (line.kind === 'gap') { y += line.height; continue; }
      if (line.kind === 'hr') {
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(margin, y + line.height / 2);
        ctx.lineTo(width - margin, y + line.height / 2);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        y += line.height;
        continue;
      }
      if (line.kind === 'shopName') {
        ctx.font = `bold ${FONT.shopName}px sans-serif`;
        ctx.direction = isRtlText(line.data) ? 'rtl' : 'ltr';
        ctx.textAlign = 'center';
        ctx.fillText(line.data, width / 2, y);
        y += line.height;
        continue;
      }
      if (line.kind === 'centerSmall' || line.kind === 'centerBold' || line.kind === 'centerTiny') {
        ctx.font = line.kind === 'centerBold' ? `bold ${FONT.footerBold}px sans-serif`
          : line.kind === 'centerTiny' ? `${FONT.tiny}px sans-serif`
          : `${FONT.footer}px sans-serif`;
        ctx.direction = isRtlText(line.data) ? 'rtl' : 'ltr';
        ctx.textAlign = 'center';
        ctx.fillText(line.data, width / 2, y);
        y += line.height;
        continue;
      }
      if (line.kind === 'meta') {
        try {
          const [label, rawValue] = line.data;
          const value = (rawValue === undefined || rawValue === null || rawValue === '') ? '—' : String(rawValue);
          ctx.font = `${FONT.meta}px sans-serif`;
          if (line.stacked) {
            ctx.direction = 'ltr'; ctx.textAlign = 'left';
            ctx.fillText(String(label), margin, y);
            directionalFillText(ctx, value, width - margin, y + FONT.meta + 6, 'right');
          } else {
            ctx.direction = 'ltr'; ctx.textAlign = 'left';
            ctx.fillText(String(label), margin, y);
            directionalFillText(ctx, value, width - margin, y, 'right');
          }
        } catch (_) { /* Never let one bad field blank the whole receipt. */ }
        y += line.height;
        continue;
      }
      if (line.kind === 'colHeader') {
        ctx.font = `bold ${FONT.colHeader}px sans-serif`;
        ctx.direction = 'ltr';
        ctx.textAlign = 'left'; ctx.fillText('Item', margin, y);
        ctx.textAlign = 'right';
        ctx.fillText('Qty', margin + contentWidth * 0.55, y);
        ctx.fillText('Price', margin + contentWidth * 0.78, y);
        ctx.fillText('Total', width - margin, y);
        y += line.height;
        continue;
      }
      if (line.kind === 'itemName') {
        ctx.font = `${FONT.itemName}px sans-serif`;
        // Always anchored from the left, same edge as the "Item" column
        // header — this keeps every row's starting point consistent and
        // lined up under the header, whether the name is English or Urdu.
        // direction='rtl' still makes Urdu text shape and flow correctly
        // (letters joined, right-to-left order) — only the anchor point is
        // fixed, not the internal script direction.
        ctx.direction = isRtlText(line.data) ? 'rtl' : 'ltr';
        ctx.textAlign = 'left';
        (line.wrapped || [line.data]).forEach((text, index) => {
          ctx.fillText(text, margin, y + index * (FONT.itemName + 8));
        });
        y += line.height;
        continue;
      }
      if (line.kind === 'itemNumbers') {
        const item = line.data;
        ctx.font = `${FONT.itemNumbers}px sans-serif`;
        ctx.direction = 'ltr';
        ctx.textAlign = 'right';
        ctx.fillText(String(item.quantity), margin + contentWidth * 0.55, y);
        ctx.fillText(String(Math.round(item.price)), margin + contentWidth * 0.78, y);
        ctx.fillText(String(Math.round(item.price * item.quantity)), width - margin, y);
        y += line.height;
        continue;
      }
      if (line.kind === 'total') {
        const [label, value, bold] = line.data;
        ctx.font = bold ? `bold ${FONT.grandTotal}px sans-serif` : `${FONT.totalsLine}px sans-serif`;
        ctx.direction = 'ltr';
        ctx.textAlign = 'left'; ctx.fillText(label, margin, y);
        ctx.textAlign = 'right'; ctx.fillText(value, width - margin, y);
        y += line.height;
        continue;
      }
    }

    return canvas;
  }

  // Converts a canvas to 1-bit (black/white) packed bytes and wraps them in
  // the ESC/POS "GS v 0" raster image command, ready to send to any ESC/POS
  // printer regardless of what fonts or codepages it supports.
  function canvasToRasterBytes(canvas) {
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, width, height);
    const bytesPerRow = width / 8; // guaranteed whole number: 384/8=48, 576/8=72

    const header = [
      0x1D, 0x76, 0x30, 0x00,
      bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF,
      height & 0xFF, (height >> 8) & 0xFF
    ];

    const body = new Uint8Array(bytesPerRow * height);
    for (let row = 0; row < height; row++) {
      for (let byteIndex = 0; byteIndex < bytesPerRow; byteIndex++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = byteIndex * 8 + bit;
          const pixelIndex = (row * width + x) * 4;
          const r = data[pixelIndex], g = data[pixelIndex + 1], b = data[pixelIndex + 2];
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          const isDark = luminance < 160; // simple threshold; receipts are pure black/white so this is not sensitive
          if (isDark) byte |= (1 << (7 - bit));
        }
        body[row * bytesPerRow + byteIndex] = byte;
      }
    }

    const full = new Uint8Array(header.length + body.length);
    full.set(header, 0);
    full.set(body, header.length);
    return full;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  const INIT_BYTES = [0x1B, 0x40]; // ESC @ — reset printer state before the image
  const FEED_AND_CUT = [0x1B, 0x64, 0x02, 0x1D, 0x56, 0x01]; // feed 2 lines then partial cut

  async function buildReceiptRasterBase64(invoice, shopConfig, paperWidthMm) {
    const canvas = await renderReceiptCanvas(invoice, shopConfig, paperWidthMm);
    const imageBytes = canvasToRasterBytes(canvas);
    const full = new Uint8Array(INIT_BYTES.length + imageBytes.length + FEED_AND_CUT.length);
    full.set(INIT_BYTES, 0);
    full.set(imageBytes, INIT_BYTES.length);
    full.set(FEED_AND_CUT, INIT_BYTES.length + imageBytes.length);
    return bytesToBase64(full);
  }

  global.ReceiptImage = { isRtlText, buildReceiptRasterBase64, renderReceiptCanvas, canvasToRasterBytes, wrapText, FONT, LOGO_SIZE };
})(typeof window !== 'undefined' ? window : this);
