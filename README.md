# TDS LLM Analysis Agent

This is an automated quiz-solver agent for the TDS LLM Analysis quiz, built with Express and Puppeteer.

## Running Locally

1.  **Create a `.env` file:**

    ```bash
    echo "APP_SECRET=your_secret_here" > .env
    ```

2.  **Install dependencies and run:**

    ```bash
    npm install
    npm sta\rt
    ```

    The server will start on port 3000.

## Running with Docker

1.  **Build the Docker image:**

    ```bash
    docker build -t tds-llm-analysis-agent .
    ```

2.  **Run the Docker container:**

    ```bash
    docker run -p 3000:3000 -e APP_SECRET=your_secret_here tds-llm-analysis-agent
    ```

## Deployment to Cloud Run (Example)

```bash
gcloud run deploy tds-llm-analysis-agent \
  --image gcr.io/your-gcp-project/tds-llm-analysis-agent \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars="APP_SECRET=your_secret_from_secret_manager"
```
