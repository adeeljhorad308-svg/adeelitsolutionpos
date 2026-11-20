// Offline mobile license verification.
//
// This customer app contains only the Ed25519 public key. License signing is
// performed by the separate Adeel IT Solutions owner tool and cannot be done
// from the APK or customer source package.
(function () {
  const PRODUCT = 'ADEEL_POS_MOBILE';
  const PUBLIC_KEY_SPKI_BASE64 = 'MCowBQYDK2VwAyEADPlTh+o4usDF8HybH/WTkvnZIx31EoMPplFv7m1G7ks=';
  const PUBLIC_KEY_RAW_BASE64 = 'DPlTh+o4usDF8HybH/WTkvnZIx31EoMPplFv7m1G7ks=';
  let importedPublicKey = null;

  async function getMachineId() {
    try {
      const pluginDev = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Device;
      if (pluginDev && typeof pluginDev.getId === 'function') {
        const info = await pluginDev.getId();
        if (info && info.identifier) {
          return String(info.identifier).toUpperCase().replace(/-/g, '').slice(0, 16);
        }
      }
    } catch (_) {}
    let fallbackId = localStorage.getItem('adeel_fallback_machine_id');
    if (!fallbackId) {
      fallbackId = 'ADEEL' + Math.random().toString(36).substring(2, 10).toUpperCase();
      localStorage.setItem('adeel_fallback_machine_id', fallbackId);
    }
    return fallbackId.toUpperCase().replace(/-/g, '').slice(0, 16);
  }

  function decodeBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  }

  function decodeBase64Url(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    return decodeBase64(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  }

  async function getPublicKey() {
    if (!importedPublicKey) {
      importedPublicKey = crypto.subtle.importKey(
        'spki',
        decodeBase64(PUBLIC_KEY_SPKI_BASE64),
        { name: 'Ed25519' },
        false,
        ['verify']
      );
    }
    return importedPublicKey;
  }

  async function verifySignature(payloadBytes, signature) {
    try {
      return await crypto.subtle.verify(
        { name: 'Ed25519' },
        await getPublicKey(),
        signature,
        payloadBytes
      );
    } catch (_) {
      const verifier = window.nacl && window.nacl.sign && window.nacl.sign.detached && window.nacl.sign.detached.verify;
      if (typeof verifier !== 'function') return false;
      return verifier(payloadBytes, signature, decodeBase64(PUBLIC_KEY_RAW_BASE64));
    }
  }

  function localTodayYYYYMMDD(date = new Date()) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  }

  function validCalendarDate(value) {
    if (!/^\d{8}$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6));
    const day = Number(value.slice(6, 8));
    const parsed = new Date(year, month - 1, day);
    return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
  }

  async function checkLicense(machineId, rawKey) {
    try {
      const normalizedMachineId = String(machineId || '').toUpperCase().replace(/-/g, '').trim();
      const key = String(rawKey || '').trim();
      if (!/^[A-F0-9]{16}$/.test(normalizedMachineId) || !key.startsWith('AP2.')) {
        return { valid: false, reason: 'invalid', expiry: null, version: 2 };
      }

      const parts = key.split('.');
      if (parts.length !== 3 || !parts[1] || !parts[2]) {
        return { valid: false, reason: 'invalid', expiry: null, version: 2 };
      }

      const payloadBytes = decodeBase64Url(parts[1]);
      const payload = new TextDecoder().decode(payloadBytes);
      const payloadParts = payload.split('|');
      if (payloadParts.length !== 4) return { valid: false, reason: 'invalid', expiry: null, version: 2 };
      const [version, product, licensedMachineId, expiry] = payloadParts;
      if (version !== '2' || product !== PRODUCT || licensedMachineId !== normalizedMachineId || !validCalendarDate(expiry)) {
        return { valid: false, reason: 'invalid', expiry: null, version: 2 };
      }

      const signature = decodeBase64Url(parts[2]);
      if (signature.length !== 64) return { valid: false, reason: 'invalid', expiry: null, version: 2 };
      const verified = await verifySignature(payloadBytes, signature);
      if (!verified) return { valid: false, reason: 'invalid', expiry: null, version: 2 };

      const readable = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
      if (localTodayYYYYMMDD() > Number(expiry)) {
        return { valid: false, reason: 'expired', expiry: readable, version: 2 };
      }
      return { valid: true, reason: 'ok', expiry: readable, version: 2 };
    } catch (_) {
      return { valid: false, reason: 'invalid', expiry: null, version: 2 };
    }
  }

  async function verifyLicenseKey(machineId, key) {
    return (await checkLicense(machineId, key)).valid;
  }

  window.license = { getMachineId, verifyLicenseKey, checkLicense };
})();
