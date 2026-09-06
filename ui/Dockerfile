FROM node:20-alpine AS build
WORKDIR /app
# Live DigitalOcean cloud API (devices / sales / SSE) — ends with /api
ARG VITE_API_BASE_URL=http://157.230.215.93:8000/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
# Local FastAPI auth/admin/twin (empty = same-origin via gateway Nginx)
ARG VITE_APP_API_BASE_URL=
ENV VITE_APP_API_BASE_URL=$VITE_APP_API_BASE_URL
ARG VITE_USE_MOCK_DATA=false
ENV VITE_USE_MOCK_DATA=$VITE_USE_MOCK_DATA
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
