FROM python:3.12-slim

LABEL org.opencontainers.image.title="intelipump-api"
LABEL org.opencontainers.image.source="DigitalTwin/backend"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
