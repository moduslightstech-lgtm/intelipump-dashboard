FROM node:20-alpine AS build
WORKDIR /app
# Same-origin FastAPI via nginx — never bake a droplet IP into the Hub image.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ARG VITE_APP_API_BASE_URL=
ENV VITE_APP_API_BASE_URL=$VITE_APP_API_BASE_URL
ARG VITE_USE_MOCK_DATA=false
ENV VITE_USE_MOCK_DATA=$VITE_USE_MOCK_DATA
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
LABEL org.opencontainers.image.title="intelipump-dashboard"
LABEL org.opencontainers.image.source="DigitalTwin/ui"
RUN apk add --no-cache wget
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
