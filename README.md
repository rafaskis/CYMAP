# CYMAP

A static MapLibre GL JS + Supabase map website for the five Cyprus KML layers.

## Features in this starter

- Satellite-only Esri World Imagery basemap, so background place labels (including unwanted Turkish labels) are not displayed.
- Public map viewing.
- Per-browser layer visibility: all layers visible by default except `kd`.
- Authorized editor sign-in using a username mapped to a Supabase email.
- Shared layer renaming; no layer creation/deletion controls.
- Add points and polygons; edit feature names and descriptions; delete individual features.
- Polygon geometry editing through Mapbox GL Draw.

## Before publishing

1. Open `config.js`.
2. Replace `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` with your project's URL and publishable/anon key from Supabase Project Settings → API.
3. Keep only a publishable/anon key in this file. Never add the database password or `service_role` key.
4. Ensure your Supabase `map_layers`, `map_features`, and `map_editors` tables and RLS policies have been created.
5. Run `CYMAP_editor_membership_policy.sql` once in Supabase SQL Editor. It lets a signed-in user read only their own editor-membership row, which the website uses to show editing controls.
6. Enable email/password sign-in in Supabase Authentication.
7. In Authentication → URL Configuration, add your GitHub Pages URL to Site URL / Redirect URLs after publishing.

## Publish with GitHub Pages

1. Upload `index.html`, `style.css`, `config.js`, `app.js`, and this README to the root of your `CYMAP` repository.
2. In GitHub, open Settings → Pages.
3. Under Build and deployment, choose `Deploy from a branch`, select `main` and `/(root)`, then Save.
4. Wait for the Pages URL to become available. For a repository named `CYMAP`, it is normally `https://YOUR-GITHUB-USERNAME.github.io/CYMAP/`.
5. Add that exact URL to Supabase Authentication URL Configuration.

## Important notes

- Esri imagery is subject to Esri's terms and attribution requirements. This demo uses the World Imagery tile endpoint and is not a guarantee of unlimited production usage.
- Layer visibility is stored in localStorage on the current browser. It is not synced between users.
- Layer renaming is shared through Supabase.
- Public visitors can read all map features. Do not store sensitive or confidential locations in a publicly readable table.
- For multiple editor usernames, add a mapping in `config.js` for each actual Supabase email and add each Supabase user UUID to `public.map_editors`.
- The initial login mapping includes `mjpo` → `mjpo@mjpo.gov.cy`.
