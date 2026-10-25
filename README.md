# Obedience → Chastify

A Chastify-native iframe and Node.js backend that connects Obedience rewards to lock-time reductions and Obedience punishments to lock-time additions.

## Project status

Initial conversion scaffold committed. The code has **not** yet been validated against live Chastify or Obedience accounts. Test with a non-production lock before relying on it.

## Quick links

- [Setup and deployment](docs/SETUP.md)
- [Chastify Developer API overview](https://docs.chastify.net/developer-api/overview/)
- [Chastify iframe quickstart](https://docs.chastify.net/developer-api/iframe-quickstart/)
- [Chastify API examples](https://docs.chastify.net/developer-api/api-examples/)

## How it works

1. Configure the extension with Obedience credentials and choose reward/punishment mappings.
2. Obedience webhook events are verified and queued in Firestore.
3. When the Chastify extension is open with a valid launch token, the backend applies queued actions.
4. Rewards use `remove_time`; punishments use `add_time`.

Chastify's installed-extension API requires an app-scoped Developer API key plus a current launch token for mutations. Events are queued while the extension is closed; unattended background changes are not promised.

See [docs/SETUP.md](docs/SETUP.md) before deployment. Never commit API keys, launch tokens, service-account credentials, or `.env` files.
