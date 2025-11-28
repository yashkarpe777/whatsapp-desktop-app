# Bulk_whatsapp_Sender_DesktopApp

## Local Database Mode

- The application now runs entirely against the PgAdmin/PostgreSQL instance that is configured through the desktop setup wizard or `backend/database_config.json`.
- Cloud/Hostinger connectivity has been disabled by default. If you ever need to re-enable a remote database set `ENABLE_HOST_DB=true` in `backend/.env`, otherwise leave it unset to stay in local-only mode.
- Admins can log into the desktop app with their username/password and use the **Coin Management** screen to manually credit coins to end users. Credits are applied directly to the local database and recorded in `coin_transactions`.
- Campaign launches verify that the initiating user has enough coins locally; unused coins are automatically refunded when a campaign is paused, stopped, or finishes.
