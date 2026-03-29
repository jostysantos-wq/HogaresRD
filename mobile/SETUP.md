# HogaresRD Mobile App

React Native (Expo) app for iOS and Android.

## Prerequisites

- Node.js 18+
- [Expo Go](https://apps.apple.com/app/expo-go/id982107779) installed on your iPhone

## Quick start

```bash
cd mobile
npm install
npx expo start
```

Scan the QR code with your iPhone camera (or Expo Go app) to open the app.

## Connect to your backend

Open `constants/api.ts` and set `API_BASE` to your server:

```ts
// Local development — find your Mac's IP in System Settings > Wi-Fi
export const API_BASE = 'http://192.168.1.XXX:3000/api';

// Production
export const API_BASE = 'https://your-deployed-site.onrender.com/api';
```

Your iPhone must be on the **same Wi-Fi network** as your Mac for local testing.

## App icons / splash screen

Replace the placeholder files in `assets/`:
- `icon.png` — 1024×1024 px app icon
- `splash.png` — 1284×2778 px splash image
- `adaptive-icon.png` — 1024×1024 px Android adaptive icon

## Build for App Store

```bash
npm install -g eas-cli
eas login
eas build --platform ios
```

Requires an Apple Developer account ($99/year).

## Screens

| Screen | Route | Description |
|--------|-------|-------------|
| Home | `/` (tab) | Trending listings + quick links |
| Comprar | `/comprar` (tab) | All sale listings with filters |
| Alquilar | `/alquilar` (tab) | All rental listings with filters |
| Proyectos | `/proyectos` (tab) | New construction + off-plan |
| Buscar | `/buscar` (tab) | Full-text search + filters |
| Listing detail | `/listing/:id` | Photos, specs, blueprints, inquiry form |
| Inmobiliaria | `/inmobiliaria/:slug` | Agency portfolio |
