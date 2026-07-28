FROM python:3.12-slim

WORKDIR /app

# libgomp1: required by onnxruntime/ctranslate2 (faster-whisper STT) or they fail to import.
# ca-certificates: TLS trust store for outbound HTTPS (Mongo Atlas, Gemini, Groq, Google Cloud TTS).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-docker.txt .
RUN pip install --no-cache-dir -r requirements-docker.txt

COPY . .

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]
