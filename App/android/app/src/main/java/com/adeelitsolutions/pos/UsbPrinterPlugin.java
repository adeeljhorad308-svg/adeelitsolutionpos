package com.adeelitsolutions.pos;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Map;

@CapacitorPlugin(name = "UsbPrinterPlugin")
public class UsbPrinterPlugin extends Plugin {
    private static final String ACTION_USB_PERMISSION = "com.adeelitsolutions.pos.USB_PERMISSION";
    private static final int USB_WRITE_TIMEOUT_MS = 7000;
    private static final int USB_CHUNK_SIZE = 16 * 1024;
    private final Object usbLock = new Object();

    private UsbDeviceConnection connection;
    private UsbInterface printerInterface;
    private UsbEndpoint outEndpoint;
    private String connectedName;
    private String connectedDeviceKey;
    private PluginCall pendingConnectCall;
    private BroadcastReceiver usbPermissionReceiver;

    private UsbManager getUsbManager() {
        return (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    private void ensureReceiverRegistered() {
        if (usbPermissionReceiver != null) return;
        usbPermissionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!ACTION_USB_PERMISSION.equals(intent.getAction())) return;
                PluginCall call;
                synchronized (usbLock) {
                    call = pendingConnectCall;
                    pendingConnectCall = null;
                }
                if (call == null) return;
                try {
                    UsbDevice device = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                        ? intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class)
                        : intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                    boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                    if (granted && device != null) doOpenDevice(device, call);
                    else call.reject("permission_denied");
                } catch (Throwable t) {
                    call.reject("connect_failed", safeMessage(t));
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(usbPermissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(usbPermissionReceiver, filter);
        }
    }

    @PluginMethod
    public void listUsbPrinters(PluginCall call) {
        try {
            UsbManager manager = getUsbManager();
            if (manager == null) { call.reject("usb_unsupported"); return; }
            Map<String, UsbDevice> deviceList = manager.getDeviceList();
            JSArray devices = new JSArray();
            for (UsbDevice device : deviceList.values()) {
                try {
                    if (findBulkOutInterface(device) == null) continue;
                    JSObject entry = new JSObject();
                    String productName = device.getProductName();
                    entry.put("name", productName == null || productName.trim().isEmpty()
                        ? "USB device " + device.getDeviceId() : productName);
                    entry.put("key", deviceKey(device));
                    devices.put(entry);
                } catch (Throwable ignored) {
                    // A malformed/inaccessible USB device must not break the entire list.
                }
            }
            JSObject result = new JSObject();
            result.put("devices", devices);
            call.resolve(result);
        } catch (Throwable t) {
            call.reject("list_failed", safeMessage(t));
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        try {
            String key = call.getString("key");
            if (key == null || key.trim().isEmpty()) { call.reject("no_device"); return; }
            UsbManager manager = getUsbManager();
            if (manager == null) { call.reject("usb_unsupported"); return; }

            UsbDevice target = null;
            for (UsbDevice device : manager.getDeviceList().values()) {
                if (key.equals(deviceKey(device))) { target = device; break; }
            }
            if (target == null) { call.reject("device_not_found"); return; }

            closeQuietly();
            if (manager.hasPermission(target)) {
                doOpenDevice(target, call);
                return;
            }

            ensureReceiverRegistered();
            synchronized (usbLock) {
                if (pendingConnectCall != null) pendingConnectCall.reject("connect_cancelled");
                pendingConnectCall = call;
            }
            saveCall(call);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
            Intent permissionRequest = new Intent(ACTION_USB_PERMISSION).setPackage(getContext().getPackageName());
            PendingIntent permissionIntent = PendingIntent.getBroadcast(getContext(), 1001, permissionRequest, flags);
            manager.requestPermission(target, permissionIntent);
        } catch (Throwable t) {
            synchronized (usbLock) { if (pendingConnectCall == call) pendingConnectCall = null; }
            call.reject("connect_failed", safeMessage(t));
        }
    }

    private void doOpenDevice(UsbDevice device, PluginCall call) {
        UsbDeviceConnection candidate = null;
        UsbInterface intf = null;
        try {
            UsbManager manager = getUsbManager();
            if (manager == null) { call.reject("usb_unsupported"); return; }
            intf = findBulkOutInterface(device);
            if (intf == null) { call.reject("no_printer_interface"); return; }
            UsbEndpoint endpoint = findBulkOutEndpoint(intf);
            if (endpoint == null) { call.reject("no_printer_interface"); return; }

            candidate = manager.openDevice(device);
            if (candidate == null) { call.reject("connect_failed"); return; }
            if (!candidate.claimInterface(intf, true)) {
                candidate.close();
                call.reject("connect_failed");
                return;
            }

            String productName;
            try { productName = device.getProductName(); } catch (Throwable ignored) { productName = null; }
            synchronized (usbLock) {
                connection = candidate;
                printerInterface = intf;
                outEndpoint = endpoint;
                connectedDeviceKey = deviceKey(device);
                connectedName = productName == null || productName.trim().isEmpty()
                    ? "USB device " + device.getDeviceId() : productName;
            }

            JSObject result = new JSObject();
            result.put("connected", true);
            result.put("name", connectedName);
            result.put("key", connectedDeviceKey);
            call.resolve(result);
        } catch (Throwable t) {
            if (candidate != null) {
                try { if (intf != null) candidate.releaseInterface(intf); } catch (Throwable ignored) { }
                try { candidate.close(); } catch (Throwable ignored) { }
            }
            closeQuietly();
            call.reject("connect_failed", safeMessage(t));
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeQuietly();
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (usbLock) {
            result.put("connected", connection != null && outEndpoint != null);
            result.put("name", connectedName);
            result.put("key", connectedDeviceKey);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void printRaw(PluginCall call) {
        final String base64 = call.getString("bytes");
        if (base64 == null || base64.isEmpty()) { call.reject("no_data"); return; }

        new Thread(() -> {
            try {
                byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                UsbDeviceConnection activeConnection;
                UsbEndpoint activeEndpoint;
                synchronized (usbLock) {
                    activeConnection = connection;
                    activeEndpoint = outEndpoint;
                }
                if (activeConnection == null || activeEndpoint == null) { call.reject("not_connected"); return; }

                int offset = 0;
                while (offset < data.length) {
                    int length = Math.min(USB_CHUNK_SIZE, data.length - offset);
                    byte[] chunk = new byte[length];
                    System.arraycopy(data, offset, chunk, 0, length);
                    int sent = activeConnection.bulkTransfer(activeEndpoint, chunk, length, USB_WRITE_TIMEOUT_MS);
                    if (sent <= 0) throw new IllegalStateException("USB bulk transfer failed");
                    offset += sent;
                }
                call.resolve();
            } catch (IllegalArgumentException e) {
                call.reject("invalid_data", e);
            } catch (Throwable t) {
                closeQuietly();
                call.reject("print_failed", safeMessage(t));
            }
        }, "AdeelPos-UsbPrint").start();
    }

    private UsbInterface findBulkOutInterface(UsbDevice device) {
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface intf = device.getInterface(i);
            if (findBulkOutEndpoint(intf) != null) return intf;
        }
        return null;
    }

    private UsbEndpoint findBulkOutEndpoint(UsbInterface intf) {
        for (int i = 0; i < intf.getEndpointCount(); i++) {
            UsbEndpoint endpoint = intf.getEndpoint(i);
            if (endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK
                && endpoint.getDirection() == UsbConstants.USB_DIR_OUT) return endpoint;
        }
        return null;
    }

    private String deviceKey(UsbDevice device) {
        return device.getVendorId() + ":" + device.getProductId() + ":" + device.getDeviceId();
    }

    private void closeQuietly() {
        synchronized (usbLock) {
            if (connection != null) {
                try { if (printerInterface != null) connection.releaseInterface(printerInterface); } catch (Throwable ignored) { }
                try { connection.close(); } catch (Throwable ignored) { }
            }
            connection = null;
            printerInterface = null;
            outEndpoint = null;
            connectedDeviceKey = null;
            connectedName = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (usbLock) {
            if (pendingConnectCall != null) {
                pendingConnectCall.reject("activity_destroyed");
                pendingConnectCall = null;
            }
        }
        if (usbPermissionReceiver != null) {
            try { getContext().unregisterReceiver(usbPermissionReceiver); } catch (Throwable ignored) { }
            usbPermissionReceiver = null;
        }
        closeQuietly();
        super.handleOnDestroy();
    }

    private String safeMessage(Throwable t) {
        if (t == null) return "";
        String message = t.getMessage();
        return message == null ? t.getClass().getSimpleName() : message;
    }
}
