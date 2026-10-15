/*
 * CYMAP public configuration.
 * Replace both placeholders with values from Supabase > Project Settings > API.
 * Use the publishable/anon key only. NEVER place a service_role/secret key here.
 */
window.CYMAP_CONFIG = {
  SUPABASE_URL: "https://tcjvzztkzgyplpdezxei.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_wO7rt6LMbu4HgsXyfEHlLg_IoMFpFp8",
  // Username-to-email convenience mapping for the current editor account.
  // Add other usernames here only if they map to actual authorized Supabase users.
  USER_EMAILS: {
    "mjpo": "mjpo@mjpo.gov.cy"
  },
  // Esri World Imagery attribution must remain visible.
  MAP_CENTER: [33.2, 35.1],
  MAP_ZOOM: 8
};
