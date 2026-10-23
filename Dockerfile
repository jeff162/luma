FROM node:22-alpine AS interface
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
# Without the package's own install step, which sets up this repository's git hooks.
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY LICENSE /app/LICENSE
COPY backend /app/backend
# Where the launcher looks for the interface it serves (`backend/spa.py`).
COPY --from=interface /app/frontend/dist /app/frontend/dist

# Declares the image, so the installation details in Settings -> About can say it runs in a container.
ENV RUNNING_IN_CONTAINER=1

# The launcher in server mode: the one process serves the interface and the API, as a downloaded build does.
CMD ["python", "-m", "backend.desktop", "--server"]
