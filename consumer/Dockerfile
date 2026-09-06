FROM python:3.12-slim

LABEL org.opencontainers.image.title="intelipump-consumer"
LABEL org.opencontainers.image.source="DigitalTwin/consumer"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY main.py .

CMD ["python", "main.py"]
