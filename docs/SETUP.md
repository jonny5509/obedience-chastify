# Setup and deployment

## Requirements
- Node.js 20+
- Firebase project with Firestore enabled
- Public HTTPS hosting URL
- Chastify extension and app-scoped Developer API key with required locks:read and locks:write scopes
- Obedience extension ID and secret

## Deploy
1. Enable Firestore in a Firebase project.
2. Configure Firebase Application Default Credentials, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file kept outside this repository.
3. Copy .env.example to .env. Set PUBLIC_BASE_URL and CHASTIFY_APP_DEVELOPER_KEY.
4. Run npm install, then npm start.
5. Deploy to a Node host with outbound HTTPS and Firebase credentials. Configure environment secrets in the host dashboard; do not commit them.
6. Set the deployed URL as both the main iframe URL and setup iframe URL for the Chastify extension, then test on a non-production lock. The setup view acknowledges Chastify's setup handshake; Obedience mapping is currently configured from the installed extension's runtime view.
7. Open the extension from Chastify, enter the Obedience extension ID and secret, load options, select reward/punishment mappings and minutes, then save.
8. Trigger a test event and open the extension to sync the queued action.

## Behavior and important limitations
A reward removes configured minutes; a punishment adds configured minutes. Events are queued in Firestore and processed only when the extension is open with a valid Chastify launch token. Chastify installed-extension mutations require an app-scoped Developer API key and current mainToken; the token can expire or be revoked, so unattended background mutations are not promised. See https://docs.chastify.net/developer-api/overview/.

This is an initial scaffold and has not been validated against live Chastify and Obedience services. Confirm the iframe launch payload against https://docs.chastify.net/developer-api/iframe-quickstart/ and verify the Obedience webhook payload/registration behavior before production use. The page expects sessionId and mainToken in a JSON or base64url payload in the URL hash. This integration handles rewards and punishments, not habits.

## Security
- Keep CHASTIFY_APP_DEVELOPER_KEY on the backend; never place it in browser code.
- Obedience secret is stored in Firestore to authenticate webhooks. Restrict database and service-account access.
- A timeout can happen after Chastify accepts a mutation. Such actions are marked needs_review and are not automatically retried, to avoid duplicate time changes.
- Test with a non-production lock. Role, scopes, trust, lock settings, and time limits can reject actions.

## Routes
- GET /health — health check
- POST /api/obedience/options — load available rewards and punishments
- POST /api/configure — save configuration and register webhook
- POST /api/obedience/webhook — queue events
- POST /api/sync — process queued events
