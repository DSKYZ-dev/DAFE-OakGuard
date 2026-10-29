# Sales site — DAFE Charts Mobile

## What's here
- `index.html` — product page: features, pricing, FAQ, install guide
- `download.html` — post-payment download page (the "success URL")
- `style.css` — dark theme matching the app
- `apk/` — drop the built APK here (see below)

## Launch checklist (do these once)

### 1. Gumroad
1. Create a free account at gumroad.com → "Create a product"
2. Name: `DAFE Charts Mobile` — price `$19.99` — "Digital product"
3. Upload `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` as the product file
   (or better: the release APK — see signing below)
4. Set the "After payment" success URL to your site's `download.html`
   (optional — Gumroad already emails the download link automatically)
5. Copy the product URL into `index.html` (already stubbed as
   `https://dafecharts.gumroad.com/l/mobile`)

### 2. Stripe (own site option)
1. Create a Stripe account → Dashboard → Payments → **Payment Links**
2. Create a payment link for the product, price `$19.99`
3. Set "After payment → Redirect" to `https://YOUR-DOMAIN/download.html`
4. Copy the `https://buy.stripe.com/...` URL into `index.html`
   (replacing `PASTE_YOUR_PAYMENT_LINK_HERE`)

### 3. Hosting
Free options: Netlify Drop (drag the `site/` folder), GitHub Pages, or Cloudflare Pages.
Upload the whole `site/` folder. The `apk/dafe-mobile.apk` file must be included.

### 4. Build the APK (one time, any PC with Android Studio)
```bash
npm run android:apk -w @dafe/mobile
```
Debug APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`

> **Before selling, sign a release build** so Android doesn't warn "unknown developer":
> Android Studio → Build → Generate Signed Bundle/APK → create a keystore (save it safely!)
> — output: `app-release.apk`. Upload that one. Re-sign with the SAME keystore for every
> future update, or users must uninstall first.

## Update flow for existing customers
1. Bump version in `apps/mobile/src/settingscreen.ts` (version line)
2. Rebuild + re-sign with the same keystore
3. Replace the APK in Gumroad AND `site/apk/` + re-upload the site
4. Email existing buyers the new link (Gumroad lets you message customers)

## Legal note
Put your disclaimer (trading risk) on the product page and in Gumroad's "terms"
field. Keep the download behind a payment wall only — no accounts needed.