package com.adeelitsolutions.pos;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(PrinterPlugin.class);
    registerPlugin(BluetoothPrinterPlugin.class);
    registerPlugin(UsbPrinterPlugin.class);
    super.onCreate(savedInstanceState);

    // Force the WebView to always load the app's bundled www/ files fresh,
    // never a cached copy from a previous install. Without this, some
    // Android devices can keep serving an older version's JavaScript/CSS
    // out of the WebView's own HTTP cache even after installing a brand
    // new APK — which looks exactly like "my code changes aren't showing
    // up" and is very hard to tell apart from an actual stale build.
    if (getBridge() != null && getBridge().getWebView() != null) {
      WebSettings settings = getBridge().getWebView().getSettings();
      settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
      getBridge().getWebView().clearCache(true);
    }
  }
}