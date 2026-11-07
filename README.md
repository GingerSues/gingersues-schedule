# Ginger Sue's Schedule (schedule.gingersues.com)

The scheduling app from Claude, rebuilt on Firebase so every employee can sign in on their phone.

- **Sign-in:** texted 6-digit code (Firebase phone sign-in). Only cell numbers on a Team profile get in.
- **Roles:** set automatically on sign-in. Team members marked *Manager* get the full app; everyone else gets
  *My shifts*, the published schedule, messages, time-off requests, pickups, drops and cover asks.
  Owner numbers (the `OWNER_PHONES` secret) always get the full app plus **Owner tools**.
- **Privacy:** pay rates and cell numbers live in a managers-only collection. Employees never receive them.
- **Texts (Twilio):** when a week is published (each person gets their own shifts), when a published shift
  changes, when time off is decided, and for cover asks. Every text is logged in Owner tools → Recent texts.

## Layout

| Path | What it is |
|---|---|
| `tools/artifact-source.html` | The Claude artifact's page, the source of truth for the screens |
| `tools/port.py` | Makes the Firebase edits to that page and writes `public/index.html` + `public/admin.html` |
| `src/` | Firebase sign-in and data layer (`fb.js`), owner tools (`admin.js`) |
| `functions/` | Cloud Functions: `linkAccount`, role sync, texting |
| `firestore.rules` | Who can read and write what |
| `.github/workflows/deploy.yml` | Deploys on every push to `main` |

## One-time setup

1. **Firebase project** (Blaze plan, budget alert set).
   - Build → Firestore Database → Create (production mode, `us-central1`).
   - Build → Authentication → Get started → Sign-in method → **Phone** → Enable.
     Settings → SMS region policy → Allow only **United States**.
     Settings → Authorized domains → add `schedule.gingersues.com`.
   - Build → Hosting → Get started (just click through), then **Add custom domain** `schedule.gingersues.com`
     and add the DNS records it shows at your domain host.
2. **Let GitHub deploy (no key file):** open Google Cloud Shell on this project and run
   `tools/setup-github-deploy.sh` (paste it in). It creates a `github-deploy` account with Owner on this project
   only, which only this repository's GitHub Actions can use, and prints the two values for step 3.
3. **GitHub repo settings → Secrets and variables → Actions**
   - Variables `FIREBASE_PROJECT_ID` and `WIF_PROVIDER` = the values the setup script printed
   - Secret `OWNER_PHONES` = your cell, e.g. `8165550123` (comma-separate more than one)
   - Secrets `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` once Twilio approves texting
     (`TWILIO_FROM` can be the phone number or a Messaging Service SID starting `MG`).
     Until then texts are logged as "Texting not set up" and nothing is sent.
4. Push to `main` (or Actions → Deploy → Run workflow). The first deploy takes ~5 minutes.
5. Open schedule.gingersues.com, sign in with your own cell → **Owner tools**:
   import `gss-export.json`, paste `Name, cell` lines for the team, and send a test text.

## Changing the app later

Edit the screens in the Claude artifact as before, save its source over `tools/artifact-source.html`, then
`npm run port && npm test` and push. If `port.py` stops with "expected 1 match", the artifact changed a line it
edits; adjust that one rule.

## Tests

`npm test` runs the Cloud Functions unit tests and browser tests (Playwright) against an in-memory stand-in for
Firebase that also enforces the employee read rules. `firestore.rules` itself is checked by Firebase at deploy.
