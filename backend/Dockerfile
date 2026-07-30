FROM python:3.12-slim

WORKDIR /app

# libgomp1: required by onnxruntime/ctranslate2 (faster-whisper STT) or they fail to import.
# ca-certificates: TLS trust store for outbound HTTPS (Mongo Atlas, Gemini, Groq, Google Cloud TTS).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# requirements-local.txt adds the on-device TTS stack (kokoro-onnx + onnxruntime),
# which only this image needs — Dockerfile.gemini builds the hosted backend, and
# that one uses Cloud TTS and shouldn't carry ~250 MB of ONNX it never loads.
COPY requirements-docker.txt requirements-local.txt ./
RUN pip install --no-cache-dir -r requirements-docker.txt -r requirements-local.txt

COPY . .

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]
