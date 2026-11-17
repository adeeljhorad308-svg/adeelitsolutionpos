# POS Mobile Solution

A mobile Point of Sale (POS) solution built for Android devices. Designed for retail and small businesses to manage sales, products, inventory, and receipt printing efficiently.

## 📱 Features

- **Fast POS Checkout**: Simple and intuitive touch interface for quick billing and checkout.
- **Product & Inventory Management**: Manage stock levels, categories, pricing, and product lists.
- **Thermal Receipt Printing**: Native support for Bluetooth and USB ESC/POS thermal printers.
- **Offline Mode**: Works seamlessly without an active internet connection using localized data storage.
- **Reports & Insights**: Track daily sales, transaction history, and summary reports.

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3, JavaScript
- **Mobile Runtime**: Capacitor for Android
- **Target Platform**: Android (API 24+)
- **Printer Integration**: Native Java Plugins for ESC/POS Thermal Printers (USB & Bluetooth)

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [Android Studio](https://developer.android.com/studio) with Android SDK

### Building the App

1. Navigate to the `App` directory:
   ```bash
   cd App
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the Android project:
   ```bash
   cd android
   ./gradlew assembleDebug
   ```

The compiled APK will be generated in `App/android/app/build/outputs/apk/debug/`.

## 📄 License

This project is proprietary software. All rights reserved.
