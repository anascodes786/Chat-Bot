# Imagine Studio

A local chatbot that asks your Azure GPT-4o deployment to draw illustrations and describe them. Each new image appears with its description and can be downloaded as SVG or PNG. Requires Node.js 22 or newer.

## Setup

Create a `.env` file in the project folder and add these five settings (your local `.env` is excluded from Git):

```env
API_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com
API_KEY=your-secret-key
DEPLOYMENT=your-gpt-4o-deployment-name
API_VERSION=2024-10-21
PORT=3000
```

Use the endpoint and key from the same Azure resource. `DEPLOYMENT` is the deployment name shown in Azure. A resource endpoint ending in `/openai/v1` is also accepted; the backend builds the versioned Chat Completions request automatically.

Run `npm install` once, then `npm start`. Open http://localhost:3000 (or your selected port).

Credential changes apply on the next request. Restart after changing `PORT`. Keep `.env` private; the browser never receives your key.

Enter an image prompt, such as “Draw a dog in a park.” The reply includes the image and a description. You can then ask “Describe that image” to receive a text reply about the latest image. The app sends the previous drawing and its description along with your follow-up so the model can refer to what it actually created.

## Troubleshooting

Run `npm run check-auth` to check your connection without generating an image. A 401 means Azure rejected the key or its endpoint; copy a current matching pair from your resource's **Keys and Endpoint** page. A 404 can indicate the deployment name or API version is incorrect.

GPT-4o returns SVG drawing code, so this app creates illustrations, icons, and diagrams. Photographic generation requires a dedicated image model. The backend requests drawing code and description in a structured response, sanitizes drawings before displaying them, and accepts description-only replies without trying to parse the text as an image. Conversation history stays in your browser; download images before refreshing.

Run `npm test` for the local checks; these do not spend API credits.
