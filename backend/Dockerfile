FROM python:3.12-slim

WORKDIR /app

# libgomp1: required by onnxruntime (kokoro-onnx TTS) or it fails to import.
# wget/ca-certificates: used below to fetch the Kokoro model files.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-docker.txt .
RUN pip install --no-cache-dir -r requirements-docker.txt

RUN mkdir -p /app/kokoro_models && \
    wget -q -O /app/kokoro_models/kokoro-v1.0.onnx \
        https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx && \
    wget -q -O /app/kokoro_models/voices-v1.0.bin \
        https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

COPY . .

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]
