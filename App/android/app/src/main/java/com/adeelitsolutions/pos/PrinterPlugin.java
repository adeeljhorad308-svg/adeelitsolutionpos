package com.adeelitsolutions.pos;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PrinterPlugin")
public class PrinterPlugin extends Plugin {

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html");
        if (html == null) {
            call.reject("No HTML provided");
            return;
        }

        getActivity().runOnUiThread(() -> {
            WebView webView = new WebView(getContext());
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    createPrintJob(view);
                }
            });
            webView.loadDataWithBaseURL(null, html, "text/HTML", "UTF-8", null);
        });

        call.resolve();
    }

    private void createPrintJob(WebView webView) {
        PrintManager printManager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
        String jobName = "Adeel_POS_Receipt";
        PrintDocumentAdapter printAdapter = webView.createPrintDocumentAdapter(jobName);
        printManager.print(jobName, printAdapter, new PrintAttributes.Builder().build());
    }
}