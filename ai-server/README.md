# Local AI server

Requires Node.js 22.19 or newer. Install the separate server dependencies once:

```sh
npm --prefix ai-server ci --ignore-scripts
npm run start:ai
```

Start the frontend with `yarn start`. Its development configuration uses `http://127.0.0.1:3016`. Open **AI settings** in the main menu, choose **Connect ChatGPT**, then open the sign-in link. Complete the login yourself. Pi's temporary OAuth callback listens on `127.0.0.1:1455`; this port must be free. A manual callback URL fallback is available in the settings dialog. Login expires after five minutes.

Choose a model, then use **Text to diagram**. The default is **GPT-6.1 Sol** with **Medium** reasoning. If that model is absent from the account's catalog, the first supported model is selected instead. The model catalog is fetched from OpenAI for the connected account and intersected with models supported by Pi. Availability in that catalog does not guarantee subscription entitlement; generation errors and usage limits are shown in the diagram dialog. The existing Mermaid preview validates the result and offers syntax repair.

Credentials, installation ID, model selection and model cache are stored in the ignored `ai-server/.state/` directory. Keep it private. Tokens stay on the server; the browser receives only connection status and model metadata. Disconnect removes the locally stored credential; it does not revoke the grant at OpenAI. No API-key fallback is used. Requests to generate diagrams send the current diagram chat to OpenAI through Pi. Sessions are in memory, with no tools, skills, extensions or project file discovery.

For a production build used locally, set this in `.env.production.local` and rebuild:

```dotenv
VITE_APP_AI_BACKEND=http://127.0.0.1:3016
```

The server binds only to `127.0.0.1`. By default it accepts browser requests from `http://127.0.0.1:3000` and `http://localhost:3000`. For another local frontend port, set `AI_ALLOWED_ORIGINS` to a comma-separated list of exact origins when starting the server. Do not expose this server publicly. Text to diagram and native object proposals are implemented; Diagram to code is not supported.

**Draw with AI** in the main menu creates native rectangles, ellipses, diamonds, text, lines, arrows and editable polygon contours. Select objects first to request edits. Selected geometry, text and styling are sent as context. The app validates the operation list, builds native objects and arrow bindings, and displays a preview before applying. Updates preserve IDs and attached arrows. Application is one undoable change and is refused if the original scene has changed. Editing elbow arrows, images, frames, groups and special shape metadata is not implemented. The model has no filesystem or terminal tools.

Run the HTTP contract and cancellation tests with `npm run test:ai`.
