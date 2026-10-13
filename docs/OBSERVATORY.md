# Optional website observatory

The Worker includes a password-protected `/observatory` with separate monitor credentials. Configure `MONITOR_PASSWORD` and an independent random `MONITOR_SECRET` as encrypted secrets in each deployment. These credentials grant monitoring access only and cannot authorize points, minting, or admin anchor operations. Reports and CSV exports require a valid secure session; logins are origin-bound and rate-limited.

Browser analytics require opt-in and respect DNT/GPC. Collection excludes raw sleep records, wallet/account linkage, full IP addresses, raw user-agent strings, query strings, input text, and raw error messages. Network-derived daily visitor summaries are estimates, not verified individuals. Test/probe traffic is separated from the default reports. Existing business-record totals are prototype inventory, not customer or revenue metrics.

Apply migration `0006_observatory.sql` before enabling the module. The Worker cron (`*/5 * * * *`) checks public endpoints and cleans records beyond their configured retention. Migration `0007_mint_recovery.sql` adds the private chain-submission ledger used by the same scheduled entry point. A configured cron or manual probe does not prove uninterrupted availability; verify actual scheduled records in your deployment. This observatory sends no external notifications.

Run `pnpm test` from `server/` for authentication, privacy, SQLite queries, CSV safety, retention, failed checks, and bundled browser-script regression coverage. Tests do not replace production HTTPS/browser acceptance or a privacy/security review.
