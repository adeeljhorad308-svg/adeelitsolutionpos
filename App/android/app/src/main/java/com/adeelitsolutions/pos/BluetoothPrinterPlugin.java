package com.adeelitsolutions.pos;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "BluetoothPrinterPlugin",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class BluetoothPrinterPlugin extends Plugin {
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private final Object socketLock = new Object();

    private BluetoothSocket socket;
    private String connectedAddress;
    private String connectedName;

    private boolean permissionGranted() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || getPermissionState("bluetooth") == PermissionState.GRANTED;
    }

    private BluetoothAdapter getAdapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    @PluginMethod
    public void listPairedPrinters(PluginCall call) {
        if (!permissionGranted()) {
            requestPermissionForAlias("bluetooth", call, "listPairedPrintersCallback");
            return;
        }
        doListPairedPrinters(call);
    }

    @PermissionCallback
    private void listPairedPrintersCallback(PluginCall call) {
        if (permissionGranted()) doListPairedPrinters(call);
        else call.reject("permission_denied");
    }

    private void doListPairedPrinters(PluginCall call) {
        try {
            BluetoothAdapter adapter = getAdapter();
            if (adapter == null) { call.reject("bluetooth_unsupported"); return; }
            if (!adapter.isEnabled()) { call.reject("bluetooth_off"); return; }

            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            JSArray devices = new JSArray();
            if (bonded != null) {
                for (BluetoothDevice device : bonded) {
                    try {
                        JSObject entry = new JSObject();
                        String address = device.getAddress();
                        String name = device.getName();
                        entry.put("name", name == null || name.trim().isEmpty() ? address : name);
                        entry.put("address", address);
                        devices.put(entry);
                    } catch (SecurityException ignored) {
                        // Skip an inaccessible device instead of terminating the app/list.
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("devices", devices);
            call.resolve(result);
        } catch (SecurityException e) {
            call.reject("permission_denied", e);
        } catch (Throwable t) {
            call.reject("list_failed", safeMessage(t));
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!permissionGranted()) {
            requestPermissionForAlias("bluetooth", call, "connectCallback");
            return;
        }
        doConnect(call);
    }

    @PermissionCallback
    private void connectCallback(PluginCall call) {
        if (permissionGranted()) doConnect(call);
        else call.reject("permission_denied");
    }

    private void doConnect(PluginCall call) {
        final String address = call.getString("address");
        if (address == null || address.trim().isEmpty()) { call.reject("no_address"); return; }

        final BluetoothAdapter adapter;
        try {
            adapter = getAdapter();
            if (adapter == null) { call.reject("bluetooth_unsupported"); return; }
            if (!adapter.isEnabled()) { call.reject("bluetooth_off"); return; }
        } catch (SecurityException e) {
            call.reject("permission_denied", e);
            return;
        } catch (Throwable t) {
            call.reject("connect_failed", safeMessage(t));
            return;
        }

        closeSocketQuietly();
        new Thread(() -> {
            BluetoothSocket newSocket = null;
            try {
                BluetoothDevice device = adapter.getRemoteDevice(address);
                try { adapter.cancelDiscovery(); } catch (Throwable ignored) { }

                Throwable last = null;
                try {
                    newSocket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                    newSocket.connect();
                } catch (Throwable first) {
                    last = first;
                    closeQuietly(newSocket);
                    newSocket = null;
                    try {
                        newSocket = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
                        newSocket.connect();
                    } catch (Throwable second) {
                        last = second;
                        closeQuietly(newSocket);
                        newSocket = null;
                        try {
                            newSocket = (BluetoothSocket) device.getClass()
                                .getMethod("createRfcommSocket", int.class)
                                .invoke(device, 1);
                            newSocket.connect();
                        } catch (Throwable third) {
                            last = third;
                            closeQuietly(newSocket);
                            newSocket = null;
                        }
                    }
                }

                if (newSocket == null || !newSocket.isConnected()) {
                    call.reject("connect_failed", safeMessage(last));
                    return;
                }

                String name;
                try { name = device.getName(); } catch (Throwable ignored) { name = null; }
                synchronized (socketLock) {
                    socket = newSocket;
                    connectedAddress = address;
                    connectedName = name == null || name.trim().isEmpty() ? address : name;
                }

                JSObject result = new JSObject();
                result.put("connected", true);
                result.put("name", connectedName);
                result.put("address", connectedAddress);
                call.resolve(result);
            } catch (SecurityException e) {
                closeQuietly(newSocket);
                call.reject("permission_denied", e);
            } catch (IllegalArgumentException e) {
                closeQuietly(newSocket);
                call.reject("invalid_address", e);
            } catch (Throwable t) {
                closeQuietly(newSocket);
                call.reject("connect_failed", safeMessage(t));
            }
        }, "AdeelPos-BluetoothConnect").start();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeSocketQuietly();
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        try {
            JSObject result = new JSObject();
            synchronized (socketLock) {
                result.put("connected", socket != null && socket.isConnected());
                result.put("name", connectedName);
                result.put("address", connectedAddress);
            }
            call.resolve(result);
        } catch (Throwable t) {
            closeSocketQuietly();
            call.reject("status_failed", safeMessage(t));
        }
    }

    // Image-based receipts (used for correct Urdu shaping and logos) can be
    // tens of KB — much bigger than the old few-hundred-byte text receipts.
    // Some inexpensive thermal printers have a small internal receive buffer
    // and corrupt or drop data sent in one giant burst, so large payloads are
    // paced out in chunks with a short pause between them. Small payloads
    // (plain text commands, test prints) go out in a single write exactly as
    // before — this only changes behavior once a payload is actually large.
    private static final int BT_CHUNK_SIZE = 4096;
    private static final int BT_CHUNK_DELAY_MS = 20;

    @PluginMethod
    public void printRaw(PluginCall call) {
        final String base64 = call.getString("bytes");
        if (base64 == null || base64.isEmpty()) { call.reject("no_data"); return; }

        new Thread(() -> {
            try {
                byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                BluetoothSocket activeSocket;
                synchronized (socketLock) { activeSocket = socket; }
                if (activeSocket == null || !activeSocket.isConnected()) {
                    call.reject("not_connected");
                    return;
                }
                OutputStream out = activeSocket.getOutputStream();
                if (data.length <= BT_CHUNK_SIZE) {
                    out.write(data);
                } else {
                    for (int offset = 0; offset < data.length; offset += BT_CHUNK_SIZE) {
                        int length = Math.min(BT_CHUNK_SIZE, data.length - offset);
                        out.write(data, offset, length);
                        out.flush();
                        if (offset + length < data.length) {
                            try { Thread.sleep(BT_CHUNK_DELAY_MS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                        }
                    }
                }
                out.flush();
                call.resolve();
            } catch (IllegalArgumentException e) {
                call.reject("invalid_data", e);
            } catch (SecurityException e) {
                closeSocketQuietly();
                call.reject("permission_denied", e);
            } catch (Throwable t) {
                closeSocketQuietly();
                call.reject("print_failed", safeMessage(t));
            }
        }, "AdeelPos-BluetoothPrint").start();
    }

    @Override
    protected void handleOnDestroy() {
        closeSocketQuietly();
        super.handleOnDestroy();
    }

    private void closeQuietly(BluetoothSocket value) {
        if (value != null) try { value.close(); } catch (IOException ignored) { }
    }

    private void closeSocketQuietly() {
        synchronized (socketLock) {
            closeQuietly(socket);
            socket = null;
            connectedAddress = null;
            connectedName = null;
        }
    }

    private String safeMessage(Throwable t) {
        if (t == null) return "";
        String message = t.getMessage();
        return message == null ? t.getClass().getSimpleName() : message;
    }
}
