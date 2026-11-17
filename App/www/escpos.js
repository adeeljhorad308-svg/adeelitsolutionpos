// Adeel POS — ESC/POS command builder for direct Bluetooth thermal printing.
// Pure formatting only. Every number printed here comes from the invoice
// object passed in — nothing here recalculates totals, discounts, or tax.
(function (global) {
  'use strict';

  const ESC = 0x1B;
  const GS = 0x1D;

  const ALIGN = { LEFT: 0x00, CENTER: 0x01, RIGHT: 0x02 };

  // Characters-per-line at normal font size for common thermal paper widths.
  const COLUMNS = { 58: 32, 80: 48 };

  function bytes(...values) {
    return values;
  }

  class ReceiptBuilder {
    constructor(paperWidthMm) {
      this.width = COLUMNS[paperWidthMm] || COLUMNS[58];
      this.chunks = [];
      this._push(bytes(ESC, 0x40)); // initialize printer
    }

    _push(arr) {
      this.chunks.push(...arr);
      return this;
    }

    _text(str) {
      const encoded = new TextEncoder().encode(String(str));
      this.chunks.push(...encoded);
      return this;
    }

    align(mode) {
      return this._push(bytes(ESC, 0x61, ALIGN[mode] ?? ALIGN.LEFT));
    }

    bold(on) {
      return this._push(bytes(ESC, 0x45, on ? 0x01 : 0x00));
    }

    doubleSize(on) {
      // GS ! n — bit0+bit4 set = double height + double width
      return this._push(bytes(GS, 0x21, on ? 0x11 : 0x00));
    }

    line(str = '') {
      this._text(str);
      this.chunks.push(0x0A);
      return this;
    }

    hr(char = '-') {
      return this.line(char.repeat(this.width));
    }

    feed(lines = 3) {
      return this._push(bytes(ESC, 0x64, lines));
    }

    // Cut command is appended into the same byte stream as everything
    // else. On printers without a cutter this is simply an unrecognized
    // command that gets ignored by the firmware — it does not throw or
    // block the rest of the print, so a missing cutter can never fail
    // the whole receipt.
    cut() {
      return this._push(bytes(GS, 0x56, 0x01));
    }

    // Two-column line: label left-aligned, value right-aligned.
    twoCol(left, right) {
      const l = String(left);
      const r = String(right);
      const space = Math.max(this.width - l.length - r.length, 1);
      return this.line(l + ' '.repeat(space) + r);
    }

    // Wraps text to the given width, returning an array of lines.
    _wrap(str, width) {
      const words = String(str).split(' ');
      const lines = [];
      let current = '';
      for (const word of words) {
        const candidate = current ? current + ' ' + word : word;
        if (candidate.length > width) {
          if (current) lines.push(current);
          // A single word longer than the column also gets hard-split.
          current = word.length > width ? word.slice(0, width) : word;
          if (word.length > width) lines.push(current), (current = word.slice(width));
        } else {
          current = candidate;
        }
      }
      if (current) lines.push(current);
      return lines.length ? lines : [''];
    }

    // Item row: name / qty / amount, matching the same proportions as the
    // existing HTML receipt (roughly 60% / 12% / 28%). Long names wrap
    // onto extra lines instead of being cut off or breaking alignment.
    itemRow(name, qty, amount) {
      const qtyWidth = Math.max(4, Math.round(this.width * 0.12));
      const amtWidth = Math.max(6, Math.round(this.width * 0.26));
      const nameWidth = this.width - qtyWidth - amtWidth;

      const qtyStr = String(qty).padStart(qtyWidth - 1) + ' ';
      const amtStr = String(amount).padStart(amtWidth);
      const nameLines = this._wrap(name, nameWidth);

      nameLines.forEach((nameLine, index) => {
        if (index === 0) {
          const padded = nameLine.padEnd(nameWidth);
          this.line(padded + qtyStr + amtStr);
        } else {
          // Continuation lines for a wrapped name: keep qty/amount blank.
          this.line(nameLine.padEnd(nameWidth) + ' '.repeat(qtyWidth + amtWidth));
        }
      });
      return this;
    }

    toBase64() {
      const arr = new Uint8Array(this.chunks);
      let binary = '';
      for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
      return btoa(binary);
    }
  }

  global.EscPos = { ReceiptBuilder, COLUMNS };
})(typeof window !== 'undefined' ? window : this);
